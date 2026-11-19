/**
 * AgentHost：包一个 Pi SDK 会话，把 Pi 事件翻译成发给浏览器的消息。
 *
 * - 一轮对话 = 用户一次提问到 Pi `agent_settled`。期间的文字增量、工具调用实时推送。
 * - 一轮结束时汇总全部 assistant 文字，校验引用，连同数据字段一起推给浏览器。
 * - 自己维护对话记录（刷新页面后回放），Pi 会话本身用内存存储，不写磁盘。
 */
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { validateCitations, type CitationCheck, type FactsBook } from "../citations.ts";
import { PROJECT_ROOT, type SourceLibrary } from "../sources.ts";
import { resolveModel, type Thinking } from "./model.ts";

export type AgentName = "analyst" | "advisor";

export interface Suggestion {
  text: string;
  intent: string;
}

/** 服务端 → 浏览器 */
export type ServerEvent =
  | { type: "status"; agent: AgentName; busy: boolean }
  | { type: "turn_start"; agent: AgentName; turnId: string; user: TranscriptUser }
  | { type: "text_delta"; agent: AgentName; turnId: string; delta: string }
  | { type: "tool"; agent: AgentName; turnId: string; name: string; phase: "start" | "end"; label: string; ok?: boolean }
  | { type: "turn_end"; agent: AgentName; turnId: string; entry: TranscriptAssistant }
  | { type: "suggestions"; agent: AgentName; items: Suggestion[]; source: "ai" | "rules" }
  | { type: "analysis"; data: unknown; asof: string | null }
  | { type: "history"; agent: AgentName; entries: TranscriptEntry[] }
  | { type: "error"; agent: AgentName; message: string };

export interface TranscriptUser {
  role: "user";
  text: string;
  /** 附带的上下文（划选内容等），给界面显示。 */
  context?: string;
}

export interface TranscriptAssistant {
  role: "assistant";
  turnId: string;
  text: string;
  tools: { name: string; label: string; ok: boolean }[];
  checks: CitationCheck[];
  book: FactsBook | null;
  /** 回答这轮的模型（provider/id）。 */
  model?: string;
  aborted?: boolean;
}

export type TranscriptEntry = TranscriptUser | TranscriptAssistant;

export interface AgentHostOptions {
  name: AgentName;
  library: SourceLibrary;
  systemPrompt: () => string;
  tools: ToolDefinition[];
  thinking: Thinking;
  /** 当前设置的模型（provider/id）。每次提问前对照，变了就就地切换。 */
  modelSpec: () => string;
  emit: (event: ServerEvent) => void;
  /** 一轮结束时，本轮引用应该对照哪些数据字段。 */
  factsBook: () => FactsBook | null;
  /** 工具调用在界面上显示成什么（比如 "取数 NVDA"）。 */
  toolLabel?: (name: string, args: any) => string;
}

export class AgentHost {
  readonly name: AgentName;
  private session: AgentSession | null = null;
  private services: Awaited<ReturnType<typeof createAgentSessionServices>> | null = null;
  private transcript: TranscriptEntry[] = [];
  private busy = false;
  private turnSeq = 0;

  constructor(private opts: AgentHostOptions) {
    this.name = opts.name;
  }

  get history(): TranscriptEntry[] {
    return this.transcript;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  private async ensureSession(): Promise<AgentSession> {
    if (this.session) return this.session;
    const services = await createAgentSessionServices({
      cwd: PROJECT_ROOT,
      agentDir: getAgentDir(),
      // 不加载任何项目 / 用户资源：系统提示、工具全部由工作台提供
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        systemPrompt: this.opts.systemPrompt(), appendSystemPrompt: [],
      },
    });
    this.services = services;
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(PROJECT_ROOT),
      model: resolveModel(services.modelRuntime, this.opts.modelSpec()),
      thinkingLevel: this.opts.thinking,
      customTools: this.opts.tools,
      noTools: "builtin",
      tools: this.opts.tools.map((t) => t.name),
    });
    this.session = session;
    return session;
  }

  /** text 是发给模型的完整内容；display 是界面上显示的用户消息。 */
  async prompt(text: string, display: TranscriptUser): Promise<void> {
    if (this.busy) throw new Error("上一个问题还在回答中，请稍等或先中断");
    const { emit, name } = this.opts;
    this.busy = true;
    emit({ type: "status", agent: name, busy: true });
    const turnId = `${name}-${++this.turnSeq}`;
    this.transcript.push(display);
    emit({ type: "turn_start", agent: name, turnId, user: display });

    const parts: string[] = [];
    const tools: TranscriptAssistant["tools"] = [];
    let unsubscribe = () => {};
    let aborted = false;
    let modelUsed = this.opts.modelSpec();
    try {
      const session = await this.ensureSession();
      // 设置里换了模型：就地切换，保留对话上下文；只改本会话，不写 Pi 的全局默认
      const spec = this.opts.modelSpec();
      if (session.model && `${session.model.provider}/${session.model.id}` !== spec) {
        await session.setModel(resolveModel(this.services!.modelRuntime, spec), { persist: false });
      }
      modelUsed = spec;
      let current = "";
      const argsById = new Map<string, any>(); // 结束事件不带参数，按调用 id 记下来
      unsubscribe = session.subscribe((e: any) => {
        if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
          current += e.assistantMessageEvent.delta;
          emit({ type: "text_delta", agent: name, turnId, delta: e.assistantMessageEvent.delta });
        } else if (e.type === "message_end" && e.message?.role === "assistant") {
          const text = assistantText(e.message);
          if (text) parts.push(text);
          if (text && current) emit({ type: "text_delta", agent: name, turnId, delta: "\n\n" });
          current = "";
        } else if (e.type === "tool_execution_start") {
          argsById.set(e.toolCallId, e.args);
          const label = this.opts.toolLabel?.(e.toolName, e.args) ?? e.toolName;
          emit({ type: "tool", agent: name, turnId, name: e.toolName, phase: "start", label });
        } else if (e.type === "tool_execution_end") {
          const label = this.opts.toolLabel?.(e.toolName, argsById.get(e.toolCallId) ?? {}) ?? e.toolName;
          tools.push({ name: e.toolName, label, ok: !e.isError });
          emit({ type: "tool", agent: name, turnId, name: e.toolName, phase: "end", label, ok: !e.isError });
        } else if (e.type === "agent_settled") {
          aborted = e.aborted;
        }
      });
      await session.prompt(text);
      await session.waitForIdle();
    } catch (err) {
      emit({ type: "error", agent: name, message: err instanceof Error ? err.message : String(err) });
    } finally {
      unsubscribe();
      const full = parts.join("\n\n").trim();
      const book = this.opts.factsBook();
      const entry: TranscriptAssistant = {
        role: "assistant", turnId, text: full, tools,
        checks: validateCitations(full, this.opts.library, book), book, model: modelUsed, aborted: aborted || undefined,
      };
      this.transcript.push(entry);
      emit({ type: "turn_end", agent: name, turnId, entry });
      this.busy = false;
      emit({ type: "status", agent: name, busy: false });
    }
  }

  async abort(): Promise<void> {
    await this.session?.abort();
  }

  /** 新对话：丢掉 Pi 会话和记录。 */
  reset(): void {
    this.session?.dispose();
    this.session = null;
    this.services = null;
    this.transcript = [];
  }
}

/** 取 assistant 消息里的文字部分（忽略工具调用、思考过程）。 */
export function assistantText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p: any) => p?.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("")
    .trim();
}

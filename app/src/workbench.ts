/**
 * Workbench：服务进程里的"主进程"。持有两个 agent、动态问法生成器、当前页面视图，
 * 把浏览器发来的 WebSocket 消息分派出去，把事件广播给所有打开的页面。
 *
 * 单用户本地工具：两个会话全局共享，刷新页面后从记录里回放。
 */
import type { Analyzer } from "./analyze.ts";
import { bookOf, buildFacts } from "./citations.ts";
import { AgentHost, type AgentName, type ImageContent, type ServerEvent, type Suggestion, type TranscriptUser } from "./agents/host.ts";
import { resolveThinking } from "./agents/model.ts";
import { advisorContext, advisorPrompt, analystContext, analystPrompt, type PageView, type Selection } from "./agents/prompts.ts";
import { ruleSuggestions, Suggester } from "./agents/suggest.ts";
import { analyzeTool, FactsRegistry, sourceTools, suggestTool } from "./agents/tools.ts";
import { parseAttachments, withAttachments } from "./attachments.ts";
import { SettingsStore, type Settings } from "./settings.ts";
import type { SourceLibrary } from "./sources.ts";

/** 浏览器 → 服务端 */
export type ClientMessage =
  | { type: "hello" }
  | { type: "view"; ticker: string; asof: string | null; error?: string }
  | { type: "prompt"; agent: "analyst"; text: string; attachments?: unknown }
  | { type: "prompt"; agent: "advisor"; text: string; selection?: Selection | null; attachments?: unknown }
  | { type: "abort"; agent: AgentName }
  | { type: "reset"; agent: AgentName };

export interface WorkbenchOptions {
  settings?: SettingsStore;
  suggester?: Pick<Suggester, "suggest">;
}

export interface Client {
  send(data: string): void;
}

const MAX_TEXT = 2000;

export class Workbench {
  readonly analyst: AgentHost;
  readonly advisor: AgentHost;
  private clients = new Set<Client>();
  private registry = new FactsRegistry();
  private view: PageView = { ticker: null, asof: null };
  private viewSeq = 0; // 页面切换的序号：取数期间又切走了，旧的结果丢掉
  private advisorBook: ReturnType<typeof bookOf> | null = null;
  private suggestions: Record<AgentName, { items: Suggestion[]; source: "ai" | "rules" } | null> = { analyst: null, advisor: null };

  readonly settings: SettingsStore;
  private suggester: Pick<Suggester, "suggest">;

  constructor(
    private analyzer: Analyzer,
    private library: SourceLibrary,
    opts: WorkbenchOptions = {},
  ) {
    this.settings = opts.settings ?? new SettingsStore();
    const modelSpec = () => this.settings.get().model;
    this.suggester = opts.suggester ?? new Suggester(modelSpec);
    // 设置变了：告诉所有页面（显示当前模型、重新取数）
    this.settings.onChange((s) => this.broadcast({ type: "settings", settings: s }));
    const emit = (e: ServerEvent) => this.broadcast(e);
    const label = (name: string, args: any) =>
      name === "dma_analyze" ? `取数 ${args?.ticker ?? ""}${args?.asof ? ` @${args.asof}` : ""}` :
      name === "search_sources" ? `查原文：${args?.query ?? ""}` :
      name === "read_source" ? `读原文 ${args?.id ?? ""}` :
      name === "suggest_questions" ? "给出追问" : name;

    this.analyst = new AgentHost({
      name: "analyst", library,
      systemPrompt: () => analystPrompt(library),
      tools: [analyzeTool({ analyzer, registry: this.registry, emit }), ...sourceTools(library), suggestTool("analyst", emit)],
      thinking: resolveThinking(process.env.DMA_THINKING, "medium"), modelSpec,
      emit, factsBook: () => this.registry.book(), toolLabel: label,
    });
    this.advisor = new AgentHost({
      name: "advisor", library,
      systemPrompt: () => advisorPrompt(library),
      tools: [...sourceTools(library), suggestTool("advisor", emit)],
      thinking: resolveThinking(process.env.DMA_THINKING, "low"), modelSpec,
      emit, factsBook: () => this.advisorBook, toolLabel: label,
    });
  }

  connect(client: Client) {
    this.clients.add(client);
  }

  disconnect(client: Client) {
    this.clients.delete(client);
  }

  broadcast(e: ServerEvent | { type: "settings"; settings: Settings }) {
    if (e.type === "suggestions") this.suggestions[e.agent] = { items: e.items, source: e.source };
    const data = JSON.stringify(e);
    for (const c of this.clients) c.send(data);
  }

  private sendTo(client: Client, e: ServerEvent) {
    client.send(JSON.stringify(e));
  }

  async handle(client: Client, raw: string): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const host = (a: AgentName) => (a === "advisor" ? this.advisor : this.analyst);
    try {
      switch (msg.type) {
        case "hello":
          for (const h of [this.analyst, this.advisor]) {
            this.sendTo(client, { type: "history", agent: h.name, entries: h.history });
            this.sendTo(client, { type: "status", agent: h.name, busy: h.isBusy });
            const s = this.suggestions[h.name];
            if (s) this.sendTo(client, { type: "suggestions", agent: h.name, ...s });
          }
          return;
        case "view":
          return await this.setView(msg.ticker, msg.asof, typeof msg.error === "string" ? msg.error.slice(0, 500) : null);
        case "prompt": {
          const text = String(msg.text ?? "").trim().slice(0, MAX_TEXT);
          const att = withAttachments(text, parseAttachments(msg.attachments));
          if (!att.prompt) return;
          const display = { role: "user" as const, text, ...(att.names.length ? { attachments: att.names } : {}) };
          if (msg.agent === "analyst") {
            return await this.analyst.prompt(`${analystContext(this.view)}\n\n${att.prompt}`, display, att.images);
          }
          return await this.askAdvisor(att.prompt, display, att.images, msg.selection ?? null);
        }
        case "abort":
          return await host(msg.agent).abort();
        case "reset":
          host(msg.agent).reset();
          if (msg.agent === "analyst") this.registry.clear();
          this.broadcast({ type: "history", agent: msg.agent, entries: [] });
          return;
      }
    } catch (err) {
      const agent = "agent" in msg ? (msg.agent as AgentName) : "analyst";
      this.sendTo(client, { type: "error", agent, message: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * 页面切到某只股票：先推规则版问法，再异步换成 AI 生成的。
   * 页面说这只票取数失败（error）：照页面记下，不再取数（再取一次可能成功，就和页面对不上了），问法清空。
   */
  private async setView(ticker: string, asof: string | null, error: string | null) {
    const seq = ++this.viewSeq;
    if (error) {
      this.view = { ticker, asof, error };
      for (const agent of ["analyst", "advisor"] as const) {
        this.broadcast({ type: "suggestions", agent, items: [], source: "rules" });
      }
      return;
    }
    this.view = { ticker, asof }; // 先记下：取数期间到的提问也按新票，不沿用上一个（可能是失败的）视图
    const r = await this.analyzer.analyze(ticker, asof);
    if (seq !== this.viewSeq) return;
    const a = r.analysis;
    this.view = { ticker: a.label, asof };
    const rules = ruleSuggestions(a, asof);
    this.broadcast({ type: "suggestions", agent: "analyst", items: rules.analyst, source: "rules" });
    this.broadcast({ type: "suggestions", agent: "advisor", items: rules.advisor, source: "rules" });
    const ai = await this.suggester.suggest(a, buildFacts(a), asof);
    // 生成期间用户可能已经切走了
    if (!ai || seq !== this.viewSeq) return;
    this.broadcast({ type: "suggestions", agent: "analyst", items: ai.analyst, source: "ai" });
    this.broadcast({ type: "suggestions", agent: "advisor", items: ai.advisor, source: "ai" });
  }

  private async askAdvisor(text: string, display: TranscriptUser, images: ImageContent[], selection: Selection | null) {
    let snapshot = null;
    if (this.view.ticker && !this.view.error) {
      const r = await this.analyzer.analyze(this.view.ticker, this.view.asof);
      snapshot = { analysis: r.analysis, facts: buildFacts(r.analysis) };
      this.advisorBook = bookOf(r.analysis.label, snapshot.facts);
    } else {
      this.advisorBook = null;
    }
    const context = !selection ? undefined
      : selection.kind === "text" ? `划选：${selection.text.slice(0, 80)}${selection.text.length > 80 ? "…" : ""}`
      : selection.kind === "view" ? `来自卡片：${selection.what}`
      : `图表：${selection.time}`;
    await this.advisor.prompt(`${advisorContext(snapshot, selection, this.view)}\n\n【问题】${text}`, { ...display, context }, images);
  }
}

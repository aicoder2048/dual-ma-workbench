/**
 * Workbench：服务进程里的"主进程"。持有两个 agent、动态问法生成器、当前页面视图，
 * 把浏览器发来的 WebSocket 消息分派出去，把事件广播给所有打开的页面。
 *
 * 单用户本地工具：两个会话全局共享，刷新页面后从记录里回放。
 */
import type { Analyzer } from "./analyze.ts";
import { bookOf, buildFacts } from "./citations.ts";
import { AgentHost, type AgentName, type ServerEvent, type Suggestion } from "./agents/host.ts";
import { resolveThinking } from "./agents/model.ts";
import { advisorContext, advisorPrompt, analystContext, analystPrompt, type Selection } from "./agents/prompts.ts";
import { ruleSuggestions, Suggester } from "./agents/suggest.ts";
import { analyzeTool, FactsRegistry, sourceTools, suggestTool } from "./agents/tools.ts";
import type { SourceLibrary } from "./sources.ts";

/** 浏览器 → 服务端 */
export type ClientMessage =
  | { type: "hello" }
  | { type: "view"; ticker: string; asof: string | null }
  | { type: "prompt"; agent: "analyst"; text: string }
  | { type: "prompt"; agent: "advisor"; text: string; selection?: Selection | null }
  | { type: "abort"; agent: AgentName }
  | { type: "reset"; agent: AgentName };

export interface Client {
  send(data: string): void;
}

const MAX_TEXT = 2000;

export class Workbench {
  readonly analyst: AgentHost;
  readonly advisor: AgentHost;
  private clients = new Set<Client>();
  private registry = new FactsRegistry();
  private view: { ticker: string | null; asof: string | null } = { ticker: null, asof: null };
  private advisorBook: ReturnType<typeof bookOf> | null = null;
  private suggestions: Record<AgentName, { items: Suggestion[]; source: "ai" | "rules" } | null> = { analyst: null, advisor: null };

  constructor(
    private analyzer: Analyzer,
    private library: SourceLibrary,
    private suggester: Pick<Suggester, "suggest"> = new Suggester(),
  ) {
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
      thinking: resolveThinking(process.env.DMA_THINKING, "medium"),
      emit, factsBook: () => this.registry.book(), toolLabel: label,
    });
    this.advisor = new AgentHost({
      name: "advisor", library,
      systemPrompt: () => advisorPrompt(library),
      tools: [...sourceTools(library), suggestTool("advisor", emit)],
      thinking: resolveThinking(process.env.DMA_THINKING, "low"),
      emit, factsBook: () => this.advisorBook, toolLabel: label,
    });
  }

  connect(client: Client) {
    this.clients.add(client);
  }

  disconnect(client: Client) {
    this.clients.delete(client);
  }

  broadcast(e: ServerEvent) {
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
          return await this.setView(msg.ticker, msg.asof);
        case "prompt": {
          const text = String(msg.text ?? "").trim().slice(0, MAX_TEXT);
          if (!text) return;
          if (msg.agent === "analyst") {
            return await this.analyst.prompt(`${analystContext(this.view)}\n\n${text}`, { role: "user", text });
          }
          return await this.askAdvisor(text, msg.selection ?? null);
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

  /** 页面切到某只股票：先推规则版问法，再异步换成 AI 生成的。 */
  private async setView(ticker: string, asof: string | null) {
    const r = await this.analyzer.analyze(ticker, asof);
    const a = r.analysis;
    this.view = { ticker: a.label, asof };
    const rules = ruleSuggestions(a, asof);
    this.broadcast({ type: "suggestions", agent: "analyst", items: rules.analyst, source: "rules" });
    this.broadcast({ type: "suggestions", agent: "advisor", items: rules.advisor, source: "rules" });
    const ai = await this.suggester.suggest(a, buildFacts(a), asof);
    // 生成期间用户可能已经切走了
    if (!ai || this.view.ticker !== a.label || this.view.asof !== asof) return;
    this.broadcast({ type: "suggestions", agent: "analyst", items: ai.analyst, source: "ai" });
    this.broadcast({ type: "suggestions", agent: "advisor", items: ai.advisor, source: "ai" });
  }

  private async askAdvisor(text: string, selection: Selection | null) {
    let snapshot = null;
    if (this.view.ticker) {
      const r = await this.analyzer.analyze(this.view.ticker, this.view.asof);
      snapshot = { analysis: r.analysis, facts: buildFacts(r.analysis) };
      this.advisorBook = bookOf(r.analysis.label, snapshot.facts);
    } else {
      this.advisorBook = null;
    }
    const context = selection
      ? selection.kind === "text" ? `划选：${selection.text.slice(0, 80)}${selection.text.length > 80 ? "…" : ""}` : `图表：${selection.time}`
      : undefined;
    await this.advisor.prompt(`${advisorContext(snapshot, selection)}\n\n【问题】${text}`, { role: "user", text, context });
  }
}

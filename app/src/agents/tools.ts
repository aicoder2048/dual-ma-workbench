/**
 * 两个 agent 用的自定义工具。工具是服务进程里的闭包，可以直接把数据推给浏览器。
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Analyzer, AnalyzeResult } from "../analyze.ts";
import { buildFacts, factsForPrompt, type Facts } from "../citations.ts";
import { buildReport } from "../report.ts";
import type { SourceLibrary } from "../sources.ts";
import type { AgentName, ServerEvent, Suggestion } from "./host.ts";

const text = (t: string, details: Record<string, unknown> = {}) => ({
  content: [{ type: "text" as const, text: t }],
  details,
});

export const INTENTS = ["看状态", "要不要动手", "何时拐头", "回放练习", "复习概念"] as const;

export function sourceTools(library: SourceLibrary): ToolDefinition[] {
  const search = {
    name: "search_sources",
    label: "查原文",
    description: "在方法论引用库里按关键词搜原文片段，返回片段编号、标题和摘要。引用前不确定编号时先搜。",
    parameters: Type.Object({ query: Type.String({ description: "关键词，如 抵扣价 公式、双交叉、加速下跌" }) }),
    async execute(_id: string, p: { query: string }) {
      const hits = library.search(p.query, 6);
      if (!hits.length) return text(`没有找到和"${p.query}"相关的原文片段。`);
      const lines = hits.map(({ chunk }) => `[[S:${chunk.id}]] ${chunk.docTitle} · ${chunk.heading}\n  ${chunk.body.replace(/\s+/g, " ").slice(0, 160)}…`);
      return text(lines.join("\n"), { ids: hits.map((h) => h.chunk.id) });
    },
  };
  const read = {
    name: "read_source",
    label: "读原文",
    description: "读取一个原文片段的全文。解释概念、引用原文前先读。",
    parameters: Type.Object({ id: Type.String({ description: "片段编号，如 article#2.3" }) }),
    async execute(_id: string, p: { id: string }) {
      const c = library.get(p.id);
      if (!c) return text(`引用库里没有 ${p.id}。用 search_sources 查正确编号。`, { found: false });
      return text(`[[S:${c.id}]] ${c.docTitle} · ${c.heading}（${c.path}:${c.line}）\n\n${c.body}`, { found: true });
    },
  };
  return [search, read] as unknown as ToolDefinition[];
}

export function suggestTool(agent: AgentName, emit: (e: ServerEvent) => void): ToolDefinition {
  return {
    name: "suggest_questions",
    label: "给出追问",
    description: "回答结束前调用一次，给用户 2–4 个可以接着问的问题（会显示成按钮）。问题要具体到当前股票和数据，不要泛泛而谈。",
    parameters: Type.Object({
      items: Type.Array(
        Type.Object({
          text: Type.String({ description: "问题原文，用户点一下就会发出去" }),
          intent: Type.Union(INTENTS.map((i) => Type.Literal(i))),
        }),
        { minItems: 1, maxItems: 5 },
      ),
    }),
    async execute(_id: string, p: { items: Suggestion[] }) {
      emit({ type: "suggestions", agent, items: p.items, source: "ai" });
      return text("已显示给用户。");
    },
  } as unknown as ToolDefinition;
}

/** 分析师会话里拿到过的数据：按股票代码存最新一份，供引用校验。 */
export class FactsRegistry {
  byTicker: Record<string, Facts> = {};
  current: string | null = null;

  record(ticker: string, facts: Facts) {
    this.byTicker[ticker] = facts;
    this.current = ticker;
  }

  book() {
    return this.current ? { byTicker: { ...this.byTicker }, current: this.current } : null;
  }

  clear() {
    this.byTicker = {};
    this.current = null;
  }
}

/** 给模型看的分析结果：规则报告 + 可引用数据清单。 */
export function analysisForModel(r: AnalyzeResult, facts: Facts): string {
  const a = r.analysis;
  const report = buildReport(a);
  return [
    `# ${a.label}（${a.date} 收盘 ${a.close.toFixed(2)}，${a.source}）`,
    a.warning ? `⚠️ ${a.warning}` : "",
    "## 规则版三步报告（脚本算的，引用已核对）",
    ...report.steps.map((s) => `### ${s.title}\n${s.items.map((i) => `- ${i}`).join("\n")}`),
    "## 可引用数据（引用时原样复制键名，如 [[D:扣20.均值]]）",
    factsForPrompt(facts),
  ].filter(Boolean).join("\n");
}

export function analyzeTool(opts: {
  analyzer: Analyzer;
  registry: FactsRegistry;
  emit: (e: ServerEvent) => void;
}): ToolDefinition {
  return {
    name: "dma_analyze",
    label: "双均线取数",
    description:
      "运行 dual-moving-averages skill 的分析脚本（Polygon 复权日线，失败回退 yfinance）。返回规则版三步报告和可引用数据。" +
      "调用后网页中间的图表和报告会自动切到这只股票。回放历史时传 asof（YYYY-MM-DD）。",
    parameters: Type.Object({
      ticker: Type.String({ description: "股票代码，如 NVDA" }),
      asof: Type.Optional(Type.String({ description: "回放日期 YYYY-MM-DD；不传 = 最新" })),
    }),
    async execute(_id: string, p: { ticker: string; asof?: string }) {
      const r = await opts.analyzer.analyze(p.ticker, p.asof ?? null);
      const facts = buildFacts(r.analysis);
      opts.registry.record(r.analysis.label, facts);
      opts.emit({
        type: "analysis",
        data: { ...r, facts, report: buildReport(r.analysis) },
        asof: p.asof ?? null,
      });
      return text(analysisForModel(r, facts), { ticker: r.analysis.label, date: r.analysis.date });
    },
  } as unknown as ToolDefinition;
}

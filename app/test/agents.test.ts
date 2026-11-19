import { describe, expect, test } from "bun:test";
import { Analyzer } from "../src/analyze.ts";
import { buildFacts, type Analysis } from "../src/citations.ts";
import { assistantText, type ServerEvent } from "../src/agents/host.ts";
import { assertAllowedModel, parseModelSpec, resolveThinking } from "../src/agents/model.ts";
import { DEFAULT_SETTINGS, SettingsStore } from "../src/settings.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advisorContext, advisorPrompt, analystContext, analystPrompt, describeSelection } from "../src/agents/prompts.ts";
import { parseSuggestions, ruleSuggestions } from "../src/agents/suggest.ts";
import { analyzeTool, FactsRegistry, sourceTools } from "../src/agents/tools.ts";
import { SourceLibrary } from "../src/sources.ts";
import { Workbench } from "../src/workbench.ts";
import nvda from "./fixtures/nvda-analysis.json";

const analysis = nvda as Analysis;
const library = SourceLibrary.load();
const fakeAnalyzer = () =>
  new Analyzer(async (args) => JSON.stringify({ analysis: { ...analysis, label: args[0] }, chart: { candles: [], volume: [], lines: {}, drops: [] } }));

describe("模型守卫", () => {
  test("清单内放行，anthropic 拒绝", () => {
    expect(() => assertAllowedModel("openai-codex/gpt-6.1-sol")).not.toThrow();
    expect(() => assertAllowedModel("anthropic/claude-opus-5-5")).toThrow(/按量计费/);
  });
  test("解析 provider/model", () => {
    expect(parseModelSpec("openai-codex/gpt-6.1-sol")).toEqual({ provider: "openai-codex", id: "gpt-6.1-sol" });
    expect(() => parseModelSpec("gpt-6.1-sol")).toThrow();
  });
  test("思考强度", () => {
    expect(resolveThinking(undefined, "low")).toBe("low");
    expect(() => resolveThinking("max", "low")).toThrow();
  });
});

describe("动态问法", () => {
  test("规则版：分析师四种意图齐全，鸿雁都是概念题", () => {
    const s = ruleSuggestions(analysis);
    expect(s.analyst.map((x) => x.intent)).toEqual(["看状态", "要不要动手", "何时拐头", "回放练习"]);
    expect(s.advisor.every((x) => x.intent === "复习概念")).toBe(true);
  });
  test("规则版：乖离在 0% 分位时加一条乖离题", () => {
    expect(ruleSuggestions(analysis).advisor.some((x) => x.text.includes("乖离"))).toBe(true);
  });
  test("解析 AI 输出：容忍前后多余文字，过滤不合格项", () => {
    const raw = '好的：{"analyst":[{"text":"NVDA 能抄底吗？","intent":"要不要动手"},{"text":"20 线何时走平？","intent":"何时拐头"},{"text":"x","intent":"乱写"}],' +
      '"advisor":[{"text":"什么是乖离分位？","intent":"复习概念"},{"text":"双交叉是什么？","intent":"复习概念"}]} 完';
    const s = parseSuggestions(raw)!;
    expect(s.analyst.length).toBe(2);
    expect(s.advisor.length).toBe(2);
  });
  test("解析 AI 输出：太少就返回 null（用规则版兜底）", () => {
    expect(parseSuggestions('{"analyst":[],"advisor":[]}')).toBeNull();
    expect(parseSuggestions("不是 JSON")).toBeNull();
  });
});

describe("工具", () => {
  test("dma_analyze：推给浏览器、记录数据字段、返回可引用清单", async () => {
    const events: ServerEvent[] = [];
    const registry = new FactsRegistry();
    const tool = analyzeTool({ analyzer: fakeAnalyzer(), registry, emit: (e) => events.push(e) }) as any;
    const res = await tool.execute("id", { ticker: "nvda" });
    expect(events[0].type).toBe("analysis");
    expect(registry.current).toBe("NVDA");
    expect(registry.book()!.byTicker.NVDA["收盘"].value).toBe("150.96");
    expect(res.content[0].text).toContain("D:扣20.均值 = 209.97");
  });
  test("read_source：不存在的编号给出提示而不是报错", async () => {
    const [, read] = sourceTools(library) as any[];
    const res = await read.execute("id", { id: "article#99" });
    expect(res.content[0].text).toContain("没有");
  });
  test("search_sources：结果带可直接引用的编号", async () => {
    const [search] = sourceTools(library) as any[];
    const res = await search.execute("id", { query: "抵扣价 公式" });
    // 本地有抵扣价笔记时命中笔记，公开仓库里命中概念速查
    expect(res.content[0].text).toContain(`[[S:${library.get("dropoff#定义与公式")!.id}]]`);
  });
});

describe("提示词", () => {
  test("分析师提示里有 skill 方法论和引用库目录", () => {
    const p = analystPrompt(library);
    expect(p).toContain("[[S:skill#原则]]");
    expect(p).toContain("- concepts#抵扣价：");
    expect(p).not.toContain("网页报告");
  });
  test("鸿雁提示强调先查原文", () => expect(advisorPrompt(library)).toContain("search_sources"));
  test("页面上下文", () => {
    expect(analystContext({ ticker: "NVDA", asof: null })).toContain("NVDA，最新行情");
    expect(analystContext({ ticker: "TSLA", asof: "2021-04-14" })).toContain("回放日期 2021-04-14");
  });
  test("卡片入口：告诉鸿雁用户在看哪张卡", () => {
    expect(describeSelection({ kind: "view", what: "3. 看方向", detail: "NVDA 2026-11-18" })).toContain("「3. 看方向」（NVDA 2026-11-18）");
  });
  test("图表点选：标出小黄点", () => {
    const d = describeSelection({ kind: "chart", time: "2026-10-21", lines: { MA20: 210.5 }, drops: [20] });
    expect(d).toContain("MA20 要扣掉的抵扣价");
  });
  test("鸿雁上下文包含数据清单和划选文字", () => {
    const c = advisorContext({ analysis, facts: buildFacts(analysis) }, { kind: "text", text: "MA60 每天大约掉 1.19" });
    expect(c).toContain("D:MA60 = 212.35");
    expect(c).toContain("MA60 每天大约掉 1.19");
  });
});

test("assistantText 只取文字部分", () => {
  expect(assistantText({ content: [{ type: "toolCall" }, { type: "text", text: "你好" }, { type: "thinking", thinking: "x" }] })).toBe("你好");
});

const tmpSettings = () => new SettingsStore(join(mkdtempSync(join(tmpdir(), "wb-")), "settings.json"));

describe("Workbench", () => {
  test("切换视图：先推规则版问法，再推 AI 版", async () => {
    const sent: any[] = [];
    const wb = new Workbench(fakeAnalyzer(), library, { settings: tmpSettings(), suggester: {
      suggest: async () => ({
        analyst: [{ text: "AI 问题 1", intent: "看状态" }, { text: "AI 问题 2", intent: "何时拐头" }],
        advisor: [{ text: "AI 概念 1", intent: "复习概念" }, { text: "AI 概念 2", intent: "复习概念" }],
      }),
    } });
    const client = { send: (d: string) => sent.push(JSON.parse(d)) };
    wb.connect(client);
    await wb.handle(client, JSON.stringify({ type: "view", ticker: "NVDA", asof: null }));
    const sugg = sent.filter((e) => e.type === "suggestions");
    expect(sugg.map((e) => `${e.agent}:${e.source}`)).toEqual(["analyst:rules", "advisor:rules", "analyst:ai", "advisor:ai"]);
  });
  test("hello：回放两个会话的记录和最近的问法", async () => {
    const sent: any[] = [];
    const wb = new Workbench(fakeAnalyzer(), library, { settings: tmpSettings(), suggester: { suggest: async () => null } });
    const client = { send: (d: string) => sent.push(JSON.parse(d)) };
    wb.connect(client);
    await wb.handle(client, JSON.stringify({ type: "view", ticker: "NVDA", asof: null }));
    sent.length = 0;
    await wb.handle(client, JSON.stringify({ type: "hello" }));
    expect(sent.filter((e) => e.type === "history").map((e) => e.agent)).toEqual(["analyst", "advisor"]);
    expect(sent.filter((e) => e.type === "suggestions").length).toBe(2);
  });
  test("坏消息不崩溃", async () => {
    const wb = new Workbench(fakeAnalyzer(), library, { settings: tmpSettings(), suggester: { suggest: async () => null } });
    await wb.handle({ send() {} }, "not json");
  });
});

test("Workbench：改设置会广播给所有页面", () => {
  const sent: any[] = [];
  const settings = tmpSettings();
  const wb = new Workbench(fakeAnalyzer(), library, { settings, suggester: { suggest: async () => null } });
  wb.connect({ send: (d: string) => sent.push(JSON.parse(d)) });
  settings.update({ model: "deepseek/deepseek-flash" });
  expect(sent.at(-1)).toEqual({ type: "settings", settings: { ...DEFAULT_SETTINGS, model: "deepseek/deepseek-flash" } });
});

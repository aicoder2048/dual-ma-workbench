import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Analyzer, normalizeAsof, normalizeTicker, type Runner } from "../src/analyze.ts";
import { bookOf, buildFacts, validateCitations, type Analysis } from "../src/citations.ts";
import type { ModelCatalog } from "../src/agents/catalog.ts";
import { createHandler } from "../src/http.ts";
import { buildReport } from "../src/report.ts";
import { DEFAULT_SETTINGS, SettingsStore } from "../src/settings.ts";
import { Speaker } from "../src/tts.ts";
import { SourceLibrary } from "../src/sources.ts";
import { DEFAULT_WATCHLIST, Watchlist } from "../src/watchlist.ts";
import nvda from "./fixtures/nvda-analysis.json";

const analysis = nvda as Analysis;
const library = SourceLibrary.load();
const fakeChart = { candles: [], volume: [], lines: {}, drops: [] };

function fakeRunner(calls: string[][] = []): Runner {
  return async (args) => {
    calls.push(args);
    return JSON.stringify({ analysis: { ...analysis, label: args[0] }, chart: fakeChart });
  };
}

describe("规则报告", () => {
  const report = buildReport(analysis);

  test("每一条引用都能在引用库或数据字段里找到", () => {
    const facts = bookOf("NVDA", buildFacts(analysis));
    const text = report.steps.flatMap((s) => s.items).join("\n");
    const checks = validateCitations(text, library, facts);
    expect(checks.length).toBeGreaterThan(20);
    expect(checks.filter((c) => !c.ok).map((c) => c.citation.raw)).toEqual([]);
  });
  test("每一条要点都至少有一个引用", () => {
    for (const item of report.steps.flatMap((s) => s.items)) expect(item).toMatch(/\[\[(S|D):/);
  });
  test("三步齐全", () => expect(report.steps.map((s) => s.key)).toEqual(["big_picture", "strategy", "direction"]));
});

describe("输入校验", () => {
  test("股票代码统一大写", () => expect(normalizeTicker(" nvda ")).toBe("NVDA"));
  test("拒绝带空格或分号的代码", () => {
    expect(() => normalizeTicker("NVDA; rm")).toThrow();
    expect(() => normalizeTicker("")).toThrow();
  });
  test("日期格式", () => {
    expect(normalizeAsof("2021-04-14")).toBe("2021-04-14");
    expect(normalizeAsof("")).toBeNull();
    expect(() => normalizeAsof("2021/04/14")).toThrow();
  });
});

describe("Analyzer 缓存", () => {
  test("最新行情 10 分钟内复用，过期重算", async () => {
    const calls: string[][] = [];
    let now = 0;
    const a = new Analyzer(fakeRunner(calls), () => now);
    await a.analyze("NVDA");
    await a.analyze("nvda");
    expect(calls.length).toBe(1);
    now = 11 * 60 * 1000;
    await a.analyze("NVDA");
    expect(calls.length).toBe(2);
  });
  test("回放日期一直缓存，参数带上 --asof", async () => {
    const calls: string[][] = [];
    let now = 0;
    const a = new Analyzer(fakeRunner(calls), () => now);
    await a.analyze("TSLA", "2021-04-14");
    now = 1e9;
    await a.analyze("TSLA", "2021-04-14");
    expect(calls).toEqual([["TSLA", "--json", "--asof", "2021-04-14", "--source", "auto"]]);
  });
  test("失败不缓存", async () => {
    let n = 0;
    const a = new Analyzer(async () => (n++ === 0 ? Promise.reject(new Error("boom")) : JSON.stringify({ analysis, chart: fakeChart })));
    await expect(a.analyze("NVDA")).rejects.toThrow("boom");
    await expect(a.analyze("NVDA")).resolves.toBeDefined();
  });
});

describe("Watchlist", () => {
  const file = join(mkdtempSync(join(tmpdir(), "wl-")), "watchlist.json");
  const wl = new Watchlist(file);

  test("文件不存在时用默认列表", () => expect(wl.list()).toEqual(DEFAULT_WATCHLIST));
  test("添加去重、删除", () => {
    expect(wl.add("msft")).toEqual([...DEFAULT_WATCHLIST, "MSFT"]);
    expect(wl.add("MSFT")).toEqual([...DEFAULT_WATCHLIST, "MSFT"]);
    expect(wl.remove("NVDA")).not.toContain("NVDA");
  });
});

describe("HTTP", () => {
  const dir = mkdtempSync(join(tmpdir(), "wl-"));
  const handler = createHandler({
    analyzer: new Analyzer(fakeRunner()),
    watchlist: new Watchlist(join(dir, "watchlist.json")),
    library,
    publicDir: resolve(import.meta.dir, "../public"),
    settings: new SettingsStore(join(dir, "settings.json")),
  });
  const get = (path: string, init?: RequestInit) => handler(new Request(`http://x${path}`, init));

  test("/api/analyze 返回分析、图表、数据字段和报告", async () => {
    const body = await (await get("/api/analyze?ticker=nvda")).json();
    expect(Object.keys(body).sort()).toEqual(["analysis", "chart", "facts", "report"]);
    expect(body.facts["收盘"].value).toBe("150.96");
  });
  test("非法代码返回 400", async () => {
    const res = await get("/api/analyze?ticker=bad%20one");
    expect(res.status).toBe(400);
  });
  test("/api/source 读原文片段", async () => {
    const body = await (await get(`/api/source?id=${encodeURIComponent("article#2.3")}`)).json();
    expect(body.heading).toContain("抵扣价");
  });
  test("自选股增删", async () => {
    const add = await get("/api/watchlist", { method: "POST", body: JSON.stringify({ ticker: "amd" }) });
    expect(await add.json()).toContain("AMD");
    const del = await get("/api/watchlist", { method: "DELETE", body: JSON.stringify({ ticker: "AMD" }) });
    expect(await del.json()).not.toContain("AMD");
  });
  test("静态文件不能跳出 public 目录", async () => {
    expect((await get("/../src/server.ts")).status).toBe(404);
    expect((await get("/%2e%2e/src/server.ts")).status).toBe(404);
  });
});

/** 假清单：Codex（订阅）、DeepSeek flash（按量，没有 medium）、一个 anthropic（按量）。 */
const fakeCatalog = (): ModelCatalog => ({
  list: async () => [
    { id: "openai-codex/gpt-6.1-sol", provider: "openai-codex", name: "GPT-6.1 Sol", billing: "订阅", verified: true, image: true,
      thinking: ["minimal", "low", "medium", "high", "xhigh", "max"] },
    { id: "deepseek/deepseek-flash", provider: "deepseek", name: "DeepSeek Flash", billing: "按量计费", verified: true, image: true,
      thinking: ["off", "low", "high", "max"] },
    { id: "anthropic/claude-x", provider: "anthropic", name: "Claude X", billing: "按量计费", verified: false, image: true,
      thinking: ["off", "low", "medium", "high"] },
  ],
});

describe("HTTP 设置", () => {
  const handler = () => {
    const dir = mkdtempSync(join(tmpdir(), "set-"));
    return createHandler({
      analyzer: new Analyzer(fakeRunner()), watchlist: new Watchlist(join(dir, "w.json")), library,
      publicDir: resolve(import.meta.dir, "../public"), settings: new SettingsStore(join(dir, "s.json")),
      catalog: fakeCatalog(),
    });
  };
  const call = (h: ReturnType<typeof handler>, method: string, body?: unknown) =>
    h(new Request("http://x/api/settings", { method, body: body ? JSON.stringify(body) : undefined }));

  test("GET：当前设置、Pi 里登录过的全部模型、七档思考程度、实际用的档位", async () => {
    const b = await (await call(handler(), "GET")).json();
    expect(b.settings).toEqual(DEFAULT_SETTINGS);
    expect(b.models.map((m: any) => m.id)).toEqual(["openai-codex/gpt-6.1-sol", "deepseek/deepseek-flash", "anthropic/claude-x"]);
    expect(b.thinkingLevels).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(b.effective).toEqual({ analyst: "medium", advisor: "medium" });
    expect(b.voices.map((v: any) => v.label)).toEqual(["云希", "云扬", "云健", "晓晓", "晓伊", "晓臻"]);
    expect(b.dataSources.map((d: any) => d.id)).toEqual(["polygon", "yfinance"]);
    expect(JSON.stringify(b)).not.toContain("sk-"); // 不返回 key
  });
  test("PUT 切数据源", async () => {
    const b = await (await call(handler(), "PUT", { dataSource: "yfinance" })).json();
    expect(b.settings.dataSource).toBe("yfinance");
  });
  test("切到 DeepSeek：它没有 medium，实际用 low", async () => {
    const b = await (await call(handler(), "PUT", { model: "deepseek/deepseek-flash" })).json();
    expect(b.settings.model).toBe("deepseek/deepseek-flash");
    expect(b.effective).toEqual({ analyst: "low", advisor: "low" });
  });
  test("anthropic 不挡，能选", async () => {
    expect((await call(handler(), "PUT", { model: "anthropic/claude-x" })).status).toBe(200);
  });
  test("清单外（没在 pi 里登录）的模型拒绝，提示去 pi 登录", async () => {
    const res = await call(handler(), "PUT", { model: "openrouter/some-model" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/登录/);
  });
  test("provider 登录了、但没有这个模型：说「目录里没有」，不说没登录", async () => {
    const res = await call(handler(), "PUT", { model: "openai-codex/gpt-typo" });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toContain("没有");
    expect(error).not.toContain("没在 pi 里登录");
  });
  test("分析师、鸿雁的思考程度分开设；非法档位拒绝", async () => {
    const h = handler();
    const b = await (await call(h, "PUT", { thinkingAnalyst: "high", thinkingAdvisor: "low" })).json();
    expect(b.settings).toMatchObject({ thinkingAnalyst: "high", thinkingAdvisor: "low" });
    expect(b.effective).toEqual({ analyst: "high", advisor: "low" });
    expect((await call(h, "PUT", { thinkingAnalyst: "extreme" })).status).toBe(400);
  });
  test("当前模型不在清单里（在 pi 里退出了登录）：照样返回，实际档位未知", async () => {
    const dir = mkdtempSync(join(tmpdir(), "set-"));
    const s = new SettingsStore(join(dir, "s.json"));
    s.update({ model: "openrouter/gone" });
    const h2 = createHandler({
      analyzer: new Analyzer(fakeRunner()), watchlist: new Watchlist(join(dir, "w.json")), library,
      publicDir: resolve(import.meta.dir, "../public"), settings: s, catalog: fakeCatalog(),
    });
    const b = await (await call(h2, "GET")).json();
    expect(b.settings.model).toBe("openrouter/gone");
    expect(b.effective).toBeNull();
  });
});

describe("/api/tts", () => {
  const dir = mkdtempSync(join(tmpdir(), "dma-tts-"));
  const calls: { text: string; voice: string }[] = [];
  const handler = createHandler({
    analyzer: new Analyzer(fakeRunner()), watchlist: new Watchlist(join(dir, "w.json")), library,
    publicDir: resolve(import.meta.dir, "../public"), settings: new SettingsStore(join(dir, "s.json")),
    tts: new Speaker(async (text, voice) => { calls.push({ text, voice }); return new Uint8Array([1, 2, 3]); }),
  });
  const post = (body: unknown) => handler(new Request("http://x/api/tts", { method: "POST", body: JSON.stringify(body) }));

  test("返回 mp3", async () => {
    const res = await post({ text: "均线向上。", voice: "zh-CN-YunxiNeural" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3]);
  });
  test("同一段文字同一个声音只合成一次", async () => {
    const before = calls.length;
    await post({ text: "均线向上。", voice: "zh-CN-YunxiNeural" });
    expect(calls.length).toBe(before);
  });
  test("清单外的声音、空文字、过长文字都拒绝", async () => {
    expect((await post({ text: "hi", voice: "en-US-GuyNeural" })).status).toBe(400);
    expect((await post({ text: "  ", voice: "zh-CN-YunxiNeural" })).status).toBe(400);
    expect((await post({ text: "啊".repeat(2001), voice: "zh-CN-YunxiNeural" })).status).toBe(400);
  });
});

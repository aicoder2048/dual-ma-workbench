import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Analyzer, normalizeAsof, normalizeTicker, type Runner } from "../src/analyze.ts";
import { bookOf, buildFacts, validateCitations, type Analysis } from "../src/citations.ts";
import { createHandler } from "../src/http.ts";
import { buildReport } from "../src/report.ts";
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
    expect(calls).toEqual([["TSLA", "--json", "--asof", "2021-04-14"]]);
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
    expect(body.heading).toContain("底扣价");
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

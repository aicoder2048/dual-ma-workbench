import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advisorContext, analystContext } from "../src/agents/prompts.ts";
import { analysisForModel } from "../src/agents/tools.ts";
import { Analyzer, pythonRunner } from "../src/analyze.ts";
import { buildFacts } from "../src/citations.ts";
import { createHandler } from "../src/http.ts";
import { Journal, type JournalEntry } from "../src/journal.ts";
import { DATE_RE, parseCsv } from "../src/practice/blind.ts";
import { HORIZON } from "../src/practice/pool.ts";
import { Practice } from "../src/practice/service.ts";
import { SessionStore } from "../src/practice/session.ts";
import { RECORD } from "../src/record.ts";
import { SettingsStore } from "../src/settings.ts";
import { SourceLibrary } from "../src/sources.ts";
import { Watchlist } from "../src/watchlist.ts";
import { prices, REAL, REAL_TICKER } from "./fixtures/practice-prices.ts";

const NOW = "2026-11-20T00:00:00.000Z";

// ---------- HTTP：真的 dma_analyze.py，假的"真实"行情 ----------

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "dma-practice-"));
  const journal = new Journal(join(dir, "journal.json"));
  const practice = new Practice({ store: new SessionStore(join(dir, "sessions.json")), journal, prices, run: pythonRunner,
    dir: join(dir, "practice"), pool: [{ ticker: REAL_TICKER }], now: () => NOW });
  const analyzer = new Analyzer(async () => { throw new Error("练习不该取真股票"); });
  analyzer.mount(practice);
  const handler = createHandler({
    analyzer, journal, practice, library: SourceLibrary.load(), publicDir: dir,
    watchlist: new Watchlist(join(dir, "w.json")), settings: new SettingsStore(join(dir, "s.json")),
  });
  const call = async (path: string, body?: unknown) => {
    const res = await handler(new Request(`http://x${path}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }));
    return { status: res.status, text: await res.text() };
  };
  const json = async (path: string, body?: unknown) => {
    const r = await call(path, body);
    if (r.status !== 200) throw new Error(`${path} ${r.status} ${r.text}`);
    return { ...JSON.parse(r.text), raw: r.text };
  };
  return { dir, analyzer, practice, call, json };
}

/** 一份响应里有没有真实信息：代码、这段真实行情里的日期、真实价位（3000 ~ 6000）。 */
function leaks(text: string): string[] {
  const out: string[] = [];
  if (text.includes(REAL_TICKER)) out.push(`代码 ${REAL_TICKER}`);
  for (const d of text.match(DATE_RE) ?? []) if (d >= REAL[0].date && d <= REAL.at(-1)!.date) out.push(`日期 ${d}`);
  for (const n of text.match(/\d+(\.\d+)?/g) ?? []) {
    const x = Number(n);
    if (x >= 2500 && x <= 7000 && n.includes(".")) out.push(`价位 ${n}`);
  }
  return out;
}

describe("练习的接口", () => {
  test("蒙眼、不偷看、按计划成交、揭晓", async () => {
    const { json, call, analyzer, dir } = setup();
    const id = "sess-http-0001";
    const made = await json("/api/practice", { id, seed: 3 });
    expect(made).toMatchObject({ label: "练习 #1", phase: "deciding", t: 0, last: HORIZON });
    expect(leaks(made.raw)).toEqual([]);
    // 同一个编号开两次只算一次
    expect((await json("/api/practice", { id, seed: 99 })).no).toBe(1);

    const bars = parseCsv(readFileSync(join(dir, "practice", `${id}.csv`), "utf8"), "练习数据");
    const t0 = bars.findIndex((b) => b.date === made.t0);
    const cursorDate = (t: number) => bars[t0 + t].date;
    /** 不偷看：响应里出现的每个挪过的日期都不晚于现在那根，图表最后一根就是现在。 */
    const noLookahead = (text: string, t: number) => {
      for (const d of text.match(DATE_RE) ?? []) expect(d <= cursorDate(t)).toBe(true);
    };
    noLookahead(made.raw, 0);
    expect(made.chart.candles.at(-1).time).toBe(cursorDate(0));
    expect(made.chart.candles.length).toBe(260);

    // 页面、长风、鸿雁拿到的分析：日期是 T+n，没有真实信息，不能看之后
    const a = await json(`/api/analyze?ticker=${encodeURIComponent("练习 #1")}`);
    expect(a.analysis.date).toBe("T0");
    expect(a.analysis.weekly.bars).toBeGreaterThan(250); // 周线和实时取数一样用 5 年（约 261 周），不是 3 年
    expect(a.analysis.label).toBe("练习 #1");
    expect(JSON.stringify(a.analysis)).not.toMatch(DATE_RE);
    expect(leaks(a.raw)).toEqual([]);
    expect((await call(`/api/analyze?ticker=${encodeURIComponent("练习 #1")}&asof=T%2B1`)).status).toBe(400);
    const r = await analyzer.analyze("练习#1", null);
    const facts = buildFacts(r.analysis);
    const page = { ticker: "练习 #1", asof: "T0" };
    for (const text of [analysisForModel(r, facts), advisorContext({ analysis: r.analysis, facts }, null, page), analystContext(page)]) {
      expect(leaks(text)).toEqual([]);
      // 唯一的日期是回测记录的区间（每只票都一样的固定文字）
      expect(new Set(text.match(DATE_RE))).toEqual(new Set([RECORD.from, RECORD.to].filter((d) => text.includes(d))));
    }

    // 记计划：下一根开盘买；止损放在之后 40 根的最低收盘上方一点（测试看得到整段数据，保证会碰到）
    const close = bars[t0].close;
    const stop = Math.round((Math.min(...bars.slice(t0 + 1, t0 + 41).map((x) => x.close)) + 0.01) * 100) / 100;
    expect(stop).toBeLessThan(close);
    const planned = await json(`/api/practice/${id}`, { type: "plan", id: "jrnl-0001", mode: "now", trigger: null, stop, size: "1/3", reason: "试试" });
    expect(planned.phase).toBe("advancing");
    expect(planned.active).toMatchObject({ state: "planned", pending: "下一根开盘买入" });
    expect((await call(`/api/practice/${id}`, { type: "plan", id: "jrnl-0002", mode: "none", trigger: null, stop: null, size: "", reason: "" })).status).toBe(409);
    expect((await call(`/api/practice/${id}`, { type: "plan", id: "jrnl-0003", mode: "trigger", trigger: null, stop: null, size: "", reason: "" })).status).toBe(409);

    // 一根一根往后：每次只多一根；照独立算的规则成交
    let t = 0, view = planned, exitAt: number | null = null;
    const entryAt = 1;
    for (; view.phase !== "revealed" && t < HORIZON; t++) {
      view = await json(`/api/practice/${id}`, { type: "step", from: t });
      expect(view.t).toBe(t + 1);
      expect(view.delta.candle.time).toBe(cursorDate(t + 1));
      expect(view.chart).toBeUndefined();
      noLookahead(view.raw, t + 1);
      expect(leaks(view.raw)).toEqual([]);
      const i = t0 + t; // 刚看到的那根
      if (exitAt === null && i >= t0 + entryAt && bars[i].close < stop) exitAt = t + 1;
      if (exitAt !== null) break;
    }
    const j = (await json("/api/journal")).entries.find((e: JournalEntry) => e.id === "jrnl-0001");
    expect(j.entry).toEqual({ date: "T+1", price: bars[t0 + 1].open });
    expect(exitAt).not.toBeNull();
    expect(j.state).toBe("closed");
    expect(j.exit).toMatchObject({ date: `T+${exitAt}`, price: bars[t0 + exitAt!].open });
    expect(view.phase).toBe("deciding");
    expect(j.snapshot.ticker).toBe("练习 #1");
    expect(leaks(JSON.stringify(j))).toEqual([]);
    // 重复提交同一步：不动
    expect((await json(`/api/practice/${id}`, { type: "step", from: 0 })).t).toBe(view.t);
    // 页面不能替练习填进出场
    expect((await call("/api/journal/jrnl-0001", { type: "exit", date: "2200-02-01", price: 1, reason: "" })).status).toBe(409);

    // 揭晓：真实代码、日期、价格都回来了
    const shown = await json(`/api/practice/${id}`, { type: "reveal" });
    expect(shown.phase).toBe("revealed");
    expect(shown.reveal.ticker).toBe(REAL_TICKER);
    const real = REAL.findIndex((b) => b.date === shown.reveal.start);
    expect(real).toBeGreaterThan(0);
    expect(shown.reveal.chart.candles.find((c: { time: string }) => c.time === shown.reveal.start).close).toBeCloseTo(REAL[real].close, 1);
    expect(shown.reveal.chart.candles.at(-1).time).toBe(shown.reveal.end);
    expect(shown.reveal.result.hold).toBeCloseTo((bars[t0 + view.t].close / bars[t0 + 1].open - 1) * 100, 6);
    const after = (await json("/api/journal")).entries.find((e: JournalEntry) => e.id === "jrnl-0001");
    expect(after.snapshot.ticker).toBe(`练习 #1 · ${REAL_TICKER}`);
    expect(after.state).toBe("closed");
    expect(after.entry.date).toBe(REAL[real + 1].date);
    const overview = await json("/api/practice");
    expect(overview.stats.sessions).toEqual({ total: 1, revealed: 1, open: 0 });
    expect(overview.stats.trades.closed.all.n).toBe(1);
    expect((await json("/api/journal")).summary.closed.all.n).toBe(0); // 实盘的汇总不算练习
  }, 60_000);
});

import { describe, expect, test } from "bun:test";
import { earningsMarks, logicalOf } from "../public/earnings.js";
import { earningsLine } from "../public/viz.js";
import { buildFacts, earningsSoon, type Analysis, type Earnings } from "../src/citations.ts";
import { buildReport } from "../src/report.ts";
import nvda from "./fixtures/nvda-analysis.json";

const E: Earnings = { available: true, past: ["2026-04-22", "2026-07-22", "2026-10-21"], next: "2027-01-27", days_to_next: 48, source: "yfinance" };
const WARN = { EARNINGS_WARN_DAYS: { value: 10, source: "脚本自定" } };
const withEarnings = (e: Earnings | undefined, thresholds = WARN) =>
  ({ ...(nvda as Analysis), earnings: e, thresholds: { ...(nvda as Analysis).thresholds, ...thresholds } }) as Analysis;

describe("图上的财报日", () => {
  test("最新一天：过去的几次，加上下一次", () => {
    expect(earningsMarks(E, "2026-11-20")).toEqual([
      { date: "2026-04-22", next: false }, { date: "2026-07-22", next: false }, { date: "2026-10-21", next: false },
      { date: "2027-01-27", next: true },
    ]);
  });

  test("回放到 8 月：之后的财报不标成过去，只标下一次（不露出后面的）", () => {
    expect(earningsMarks(E, "2026-08-03")).toEqual([
      { date: "2026-04-22", next: false }, { date: "2026-07-22", next: false }, { date: "2026-10-21", next: true },
    ]);
  });

  test("取不到、练习里没有：不标", () => {
    expect(earningsMarks({ available: false, reason: "ETF" }, "2026-11-20")).toEqual([]);
    expect(earningsMarks(undefined, "2026-11-20")).toEqual([]);
  });

  test("第几根：有这根就是它；最后一根之后按工作日往后数；比第一根早不标", () => {
    const candles = ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"].map((time) => ({ time }));
    expect(logicalOf("2026-11-18", candles)).toBe(2);
    expect(logicalOf("2026-11-24", candles)).toBe(6); // 周五之后：周一、周二
    expect(logicalOf("2026-11-01", candles)).toBeNull();
  });
});

describe("财报提醒", () => {
  test("提醒窗口：10 个交易日内才提醒，第 10 天也算", () => {
    expect(earningsSoon(withEarnings({ ...E, days_to_next: 10 }))).toEqual({ next: "2027-01-27", days: 10 });
    expect(earningsSoon(withEarnings({ ...E, days_to_next: 11 }))).toBeNull();
    expect(earningsSoon(withEarnings({ ...E, next: null, days_to_next: null }))).toBeNull();
    expect(earningsSoon(withEarnings({ available: false, reason: "网络" }))).toBeNull();
    expect(earningsSoon(withEarnings(undefined))).toBeNull();
  });

  test("结论卡片一行：几天后财报、跳空可能越过止损价；按选的处境取止损", () => {
    const r = buildReport(withEarnings({ ...E, next: "2026-11-25", days_to_next: 3 }));
    const flat = earningsLine(r, { pos: "flat", cost: "" });
    expect(flat).toContain("3 天后财报（2026-11-25）：跳空可能越过止损价");
    expect(flat).toContain(r.plans.flat.stop!.price.toFixed(2));
    // NVDA 持仓这一行没有止损（反弹再减仓）：用空仓的进场后止损
    expect(r.plans.holding.stop).toBeNull();
    expect(earningsLine(r, { pos: "holding", cost: "" })).toContain(r.plans.flat.stop!.price.toFixed(2));
    const held = { ...r, plans: { ...r.plans, holding: { ...r.plans.holding, stop: { label: "止损", price: 111.11 } } } };
    expect(earningsLine(held, { pos: "holding", cost: "" })).toContain("111.11");
  });

  test("窗口外没有这一行；打法不变", () => {
    const far = withEarnings(E);
    const r = buildReport(far);
    expect(r.earnings).toBeNull();
    expect(earningsLine(r, { pos: "flat", cost: "" })).toBe("");
    const near = buildReport(withEarnings({ ...E, days_to_next: 2 }));
    expect(near.plans).toEqual(r.plans);
    expect(near.playKey).toBe(r.playKey);
  });

  test("长风能引用：下次财报、上一次；窗口内写明跳空风险", () => {
    const f = buildFacts(withEarnings({ ...E, days_to_next: 4, next: "2026-11-26" }));
    expect(f["财报.下次"].value).toBe("2026-11-26（4 个交易日后，在提醒窗口内：跳空可能越过止损价）");
    expect(f["财报.上次"].value).toBe("2026-10-21");
    expect(buildFacts(withEarnings({ available: false, reason: "yfinance 没有 SPY 的财报日（ETF、指数没有财报）" }))["财报.下次"].value).toContain("ETF");
    expect(Object.keys(buildFacts(withEarnings(undefined))).filter((k) => k.startsWith("财报"))).toEqual([]);
  });
});

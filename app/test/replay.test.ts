import { describe, expect, test } from "bun:test";
import { ema, forwardOutcome, ma20Check, renderReport, summarize, type Bar, type Sample } from "../src/replay.ts";

const bars = (closes: number[]): Bar[] => closes.map((close, i) => ({ date: `d${i}`, close }));

describe("回放：之后 20 天发生了什么", () => {
  test("20 日收益", () => {
    // 前 30 天都是 100，之后每天涨 1
    const b = bars([...Array(30).fill(100), ...Array.from({ length: 25 }, (_, k) => 101 + k)]);
    expect(forwardOutcome(b, 29, 20)!.ret).toBeCloseTo(120 / 100 - 1);
  });
  test("后面不够 20 天：没有结果", () => {
    expect(forwardOutcome(bars(Array(40).fill(100)), 25, 20)).toBeNull();
  });
  test("进场条件：收盘站上前一天的 EMA20，且高于 MA20 抵扣价（20 天前的收盘）；记第几天和之后 20 天的收益", () => {
    // 先跌（抵扣价高），再平，再涨：第一次同时满足两条的那天才算触发
    const closes = [...Array.from({ length: 30 }, (_, k) => 130 - k), ...Array(15).fill(100), ...Array.from({ length: 40 }, (_, k) => 101 + k)];
    const b = bars(closes);
    const i = 40;
    const o = forwardOutcome(b, i, 20)!;
    const e = ema(closes.map((c) => c), 20);
    const day = o.trigger!.day;
    const j = i + day;
    expect(closes[j]).toBeGreaterThan(e[j - 1]);
    expect(closes[j]).toBeGreaterThan(closes[j - 20]);
    for (let k = i + 1; k < j; k++) expect(closes[k] > e[k - 1] && closes[k] > closes[k - 20]).toBe(false);
    expect(o.trigger!.ret).toBeCloseTo(closes[j + 20] / closes[j] - 1);
    expect(o.trigger!.fromStart).toBeCloseTo(closes[j + 20] / closes[i] - 1); // 当天就买、同一天卖
  });
  test("只高于 MA20 抵扣价、没站上 EMA20：不算触发", () => {
    // 前 30 天 50，接着 10 天急涨到 200（EMA20 被拉到 140 多），之后 100：高于 20 天前的 50，但在 EMA20 下方
    const closes = [...Array(30).fill(50), ...Array(10).fill(200), ...Array(30).fill(100)];
    expect(forwardOutcome(bars(closes), 39, 20)!.trigger).toBeNull();
  });
  test("20 天内没触发：trigger 为 null", () => {
    const closes = Array.from({ length: 80 }, (_, k) => 200 - k); // 一路跌
    expect(forwardOutcome(bars(closes), 40, 20)!.trigger).toBeNull();
  });
  test("EMA 和 pandas ewm(span, adjust=False) 一样：第一天等于收盘", () => {
    const e = ema([10, 20, 30], 3); // alpha = 0.5
    expect(e).toEqual([10, 15, 22.5]);
  });
});

const s = (o: Partial<Sample>): Sample => ({
  ticker: "X", date: "2025-01-01", lean: "偏多", score: 0.4, play: "过渡态", flat: "条件不满足，不做。",
  buyTurn: false, ret: 0, ma20: null, trigger: null, ...o,
});

describe("看方向的 MA20 推演：和两个简单基准比", () => {
  // 前 20 天 100..119 一路涨（MA20 抵扣价低），第 20 天起一路跌
  const closes = [...Array.from({ length: 20 }, (_, k) => 100 + k), ...Array.from({ length: 30 }, (_, k) => 118 - k)];
  test("推演说向下 3 天：只看 3 天后；实际方向、抵扣价规则（价格不变）、当前斜率三者各自算", () => {
    const i = 24;
    const c = ma20Check(closes, i, { dir: -1, days: 3 })!;
    expect(c.k).toBe(3);
    const ma = (j: number) => closes.slice(j - 19, j + 1).reduce((a, b) => a + b, 0) / 20;
    expect<number>(c.actual).toBe(Math.sign(ma(i + 3) - ma(i)));
    // 价格不变：3 天后 MA20 = 去掉最早 3 天、补 3 个今天的价
    expect<number>(c.dropRule).toBe(Math.sign(3 * closes[i] - (closes[i - 19] + closes[i - 18] + closes[i - 17])));
    expect<number>(c.slope).toBe(Math.sign(closes[i] - closes[i - 20]));
  });
  test("没有推演（中间档、明天就变）：不算", () => {
    expect(ma20Check(closes, 24, null)).toBeNull();
  });
});

describe("回放汇总", () => {
  test("模糊判断：每档的样本数、平均 20 日收益、方向命中率（不明不算命中率）", () => {
    const sum = summarize([
      s({ lean: "偏多", ret: 0.05 }), s({ lean: "偏多", ret: -0.01 }),
      s({ lean: "明显偏空", score: -0.8, ret: -0.1 }), s({ lean: "不明", score: 0, ret: 0.02 }),
    ]);
    const bull = sum.byLean.find((r) => r.key === "偏多")!;
    expect(bull.n).toBe(2);
    expect(bull.mean).toBeCloseTo(0.02);
    expect(bull.hit).toBeCloseTo(0.5);
    expect(sum.byLean.find((r) => r.key === "不明")!.hit).toBeNull();
    expect(sum.all.n).toBe(4);
  });
  test("MA20 推演命中率，和抵扣价规则、当前斜率两个基准并列；没推演的不算", () => {
    const m = (claim: 1 | -1, actual: -1 | 0 | 1, dropRule: -1 | 0 | 1, slope: -1 | 0 | 1) => ({ k: 5, claim, actual, dropRule, slope });
    const sum = summarize([
      s({ ma20: m(1, 1, 1, 1) }), s({ ma20: m(1, -1, -1, 1) }), s({ ma20: m(-1, -1, -1, -1) }), s({ ma20: null }),
    ]);
    expect(sum.ma20.n).toBe(3);
    expect(sum.ma20.hit).toBeCloseTo(2 / 3);
    expect(sum.ma20.dropRule).toBeCloseTo(1);
    expect(sum.ma20.slope).toBeCloseTo(2 / 3);
  });
  test("每行带「不同日期数」：同一天几只票算一个日期", () => {
    const sum = summarize([s({ date: "2025-04-01" }), s({ date: "2025-04-01", ticker: "Y" }), s({ date: "2025-05-01" })]);
    expect(sum.all.dates).toBe(2);
  });
  test("打法：按打法键分组（含横盘破位、打架）", () => {
    const sum = summarize([s({ play: "横盘破位" }), s({ play: "横盘破位" }), s({ play: "健康上涨" })]);
    expect(sum.byPlay.find((r) => r.key === "横盘破位")!.n).toBe(2);
  });
  test("空仓做法：按计划那句话分组；进场条件触发率和触发后收益只算带进场条件的", () => {
    const sum = summarize([
      s({ flat: "不抄底，空仓等。", buyTurn: true, ret: -0.05, trigger: { day: 3, ret: 0.04, fromStart: 0.1 } }),
      s({ flat: "不抄底，空仓等。", buyTurn: true, ret: 0.01, trigger: null }),
      s({ flat: "等回调再买，不追高。", ret: 0.03 }),
    ]);
    const wait = sum.byFlat.find((r) => r.key === "不抄底，空仓等。")!;
    expect(wait.n).toBe(2);
    expect(wait.mean).toBeCloseTo(-0.02);
    expect(sum.entry.n).toBe(2);
    expect(sum.entry.triggered).toBe(1);
    expect(sum.entry.afterMean).toBeCloseTo(0.04);
    expect(sum.entry.startMean).toBeCloseTo(0.1); // 同样卖在触发后 20 天，当天就买
  });
  test("报告写明样本量，样本少（< 10）的行标出来", () => {
    const md = renderReport(summarize([s({ ret: 0.01 })]), { tickers: ["X"], from: "2025-01-01", to: "2025-01-01", horizon: 20, source: "CSV" });
    expect(md).toContain("样本 1");
    expect(md).toContain("日期少");
    expect(md).toContain("不独立");
  });
});

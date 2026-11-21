import { describe, expect, test } from "bun:test";
import { atrSeries, measure, measureLines } from "../public/measure.js";

// 和 tests 里 pandas 算的对照：skill 的 fullplan.atr（Wilder，ewm(alpha=1/14, adjust=False, min_periods=14)）
const H = Array.from({ length: 20 }, (_, i) => 10 + (i % 5) + i * 0.3);
const L = H.map((x, i) => x - 2 - (i % 3));
const day = (i: number) => new Date(Date.UTC(2026, 0, 5 + i)).toISOString().slice(0, 10);
const CANDLES = H.map((h, i) => ({ time: day(i), open: 0, high: h, low: L[i], close: (h + L[i]) / 2 + (i % 2 ? 0.5 : -0.5) }));
const PANDAS = [3.0984760745, 3.1628706406, 3.1655227377, 3.153699685, 3.2141497075, 3.1845675856, 3.1713841866];

describe("测量工具", () => {
  test("ATR(14) 和 skill 的 pandas 版一样；前 13 根没有", () => {
    const atr = atrSeries(CANDLES);
    expect(atr.slice(0, 13)).toEqual(Array(13).fill(null));
    atr.slice(13).forEach((x: number | null, i: number) => expect(x).toBeCloseTo(PANDAS[i], 9));
  });

  test("涨跌、涨跌幅按 B − A；根数、自然日不分左右；几个 ATR 用靠后那根当天的 ATR", () => {
    const m = measure({ index: 15, price: 20 }, { index: 19, price: 26 }, CANDLES);
    expect(m.change).toBe(6);
    expect(m.pct).toBeCloseTo(30, 9);
    expect([m.bars, m.days]).toEqual([4, 4]);
    expect(m.atr).toBeCloseTo(PANDAS[6], 9);
    expect(m.atrUnits).toBeCloseTo(6 / PANDAS[6], 9);
    const back = measure({ index: 19, price: 26 }, { index: 15, price: 20 }, CANDLES);
    expect([back.change, back.bars, back.days]).toEqual([-6, 4, 4]);
    expect(back.atr).toBe(m.atr); // 往左拉也用靠后那根
  });

  test("回放时不偷看：ATR 只用到靠后那根，后面的 K 线变了结果不变", () => {
    const changed = CANDLES.map((c, i) => (i > 16 ? { ...c, high: c.high + 50 } : c));
    expect(measure({ index: 14, price: 20 }, { index: 16, price: 21 }, changed)).toEqual(measure({ index: 14, price: 20 }, { index: 16, price: 21 }, CANDLES));
  });

  test("框里三行；不到 14 根写明没有 ATR", () => {
    expect(measureLines({ change: -6, pct: -23.0769, bars: 4, days: 6, atr: 3.17, atrUnits: 1.893 }))
      .toEqual(["−6.00（−23.08%）", "4 根 · 6 天", "1.9 ATR（ATR 3.17）"]);
    const early = measure({ index: 0, price: 10 }, { index: 5, price: 11 }, CANDLES);
    expect(early.atrUnits).toBeNull();
    expect(measureLines(early)[2]).toBe("不到 14 根，没有 ATR");
  });
});

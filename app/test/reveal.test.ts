import { describe, expect, test } from "bun:test";
import { bucketOf, crossDay, crossMarks, horizonOf, revealOf, turnDay, type Series } from "../src/practice/reveal.ts";

/** 31 根（T0…T+30）：close 从 100 走，MA20 从 50 起每天加 dma20，MA60 固定在 50；EMA 跟 MA 一样，另给 emaShift。 */
function series(opts: { close?: (k: number) => number; ma20?: (k: number) => number; ma60?: (k: number) => number; emaLag?: number }): Series {
  const ks = Array.from({ length: 31 }, (_, k) => k);
  const ma20 = ks.map(opts.ma20 ?? (() => 50)), ma60 = ks.map(opts.ma60 ?? (() => 50));
  const lag = opts.emaLag ?? 0;
  return {
    close: ks.map(opts.close ?? (() => 100)),
    ma20, ma60,
    ema20: ks.map((k) => ma20[Math.max(0, k - lag)]), ema60: ma60,
  };
}

describe("推演揭晓的对照", () => {
  test("双交叉按「两组都到了另一边」的那天算，落在哪一段", () => {
    // 20 在 60 上方，MA20 每天跌 1：第 11 天 MA20 到 60 下方；EMA20 晚 3 天
    const s = series({ ma20: (k) => 60.5 - k, ma60: () => 50, emaLag: 3 });
    expect(crossDay(s, "死叉")).toBe(14);
    expect(bucketOf(14)).toBe("11–20 天");
    expect(bucketOf(10)).toBe("10 天内");
    expect(bucketOf(30)).toBe("21–30 天");
    expect(bucketOf(null)).toBe("30 天内不会");
    expect(crossDay(s, "金叉")).toBeNull();
    expect(crossMarks(s)).toEqual([{ k: 11, text: "MA 死叉" }, { k: 14, text: "EMA 死叉" }, { k: 14, text: "双交叉（死叉）" }]);
  });

  test("拐头：第一天朝那边走的那天；期内没有就是 null", () => {
    const s = series({ ma20: (k) => (k < 6 ? 50 + k : 50 + 5 - (k - 5)) });
    expect(turnDay(s, 20, "下", 10)).toBe(6);
    expect(turnDay(s, 20, "下", 5)).toBeNull();
    expect(turnDay(s, 60, "上", 10)).toBeNull();
  });

  test("评分用的是推演；真实走势对不上时说价格没收平、涨跌了多少", () => {
    // 推演说第 5 天 MA20 下、MA60 上；真实里价格一路涨，MA20 第 5 天是向上的
    const s = series({ close: (k) => 100 + 2 * k, ma20: (k) => 50 + k, ma60: (k) => 50 + 0.1 * k });
    const [dir] = revealOf({ close: 100, parts: [{ q: "dir", n: 5 }] }, ["MA20 下、MA60 上"], s);
    expect(dir.system).toBe("MA20 下、MA60 上");
    expect(dir.real).toBe("T+5 当天 MA20 上、MA60 上");
    expect(dir.agree).toBe(false);
    expect(dir.why).toContain("价格没有收平");
    expect(dir.why).toContain("T+5 收盘 110.00，比 T0 的 100.00涨了 10.0%");
    const [same] = revealOf({ close: 100, parts: [{ q: "dir", n: 5 }] }, ["MA20 上、MA60 上"], s);
    expect(same).toMatchObject({ agree: true, why: null });
  });

  test("拐头那一问：收平会不会拐头和真实拐没拐头对照", () => {
    const s = series({ ma20: (k) => 50 + k }); // 真实一直向上，没拐头向下
    const spec = { close: 100, parts: [{ q: "turn" as const, period: 20 as const, way: "下" as const, days: 10, level: 103 }] };
    const [r] = revealOf(spec, ["103.00"], s);
    expect(r.system).toContain("收盘持平在 103.00 以下，10 天内 MA20 拐头向下");
    expect(r.system).toContain("会拐头"); // 收平 100 在 103 以下
    expect(r.real).toBe("10 天内 MA20 没有拐头向下");
    expect(r.agree).toBe(false);
  });

  test("揭晓要放出的根数：问到 30 天的双交叉就放 30 根", () => {
    expect(horizonOf({ close: 1, parts: [{ q: "dir", n: 5 }] })).toBe(5);
    expect(horizonOf({ close: 1, parts: [{ q: "dir", n: 5 }, { q: "turn", period: 60, way: "上", days: 20, level: 1 }] })).toBe(20);
    expect(horizonOf({ close: 1, parts: [{ q: "dir", n: 10 }, { q: "cross", way: "金叉" }] })).toBe(30);
  });
});

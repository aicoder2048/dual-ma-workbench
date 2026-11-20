import { describe, expect, test } from "bun:test";
import type { Kind } from "../src/practice/drillkinds.ts";
import { balancedPick, drillStats, kindWeights, median, weighted, type Answer } from "../src/practice/drillstats.ts";
import { seeded } from "../src/practice/pool.ts";

const ans = (kind: Kind, cls: string, correct: boolean, ms: number): Answer =>
  ({ drill: `${kind}-${cls}-${ms}`, kind, cls, picks: [0], answers: [correct ? 0 : 1], correct, ms, at: "2026-11-20T00:00:00Z" });

describe("统计（手算）", () => {
  // 时间顺序：对 对 错 对 对 对 错 错
  const answers = [
    ans("chart", "横盘", true, 3000), ans("chart", "失序", true, 5000), ans("chart", "失序", false, 9000),
    ans("signal", "都不是", true, 2000), ans("signal", "破线", true, 4000), ans("signal", "破线", true, 6000),
    ans("dropoff", "MA20 上、MA60 上", false, 1000), ans("chart", "失序", false, 7000),
  ];
  const s = drillStats(answers);

  test("总数、正确率", () => {
    expect(s.total).toEqual({ n: 8, correct: 5, accuracy: 5 / 8 });
  });

  test("每种题：正确率、答题时间中位数", () => {
    const by = Object.fromEntries(s.kinds.map((k) => [k.kind, k]));
    expect(by.chart).toEqual({ kind: "chart", n: 4, correct: 2, accuracy: 0.5, medianMs: 6000 }); // 3000 5000 7000 9000 → (5000+7000)/2
    expect(by.signal).toEqual({ kind: "signal", n: 3, correct: 3, accuracy: 1, medianMs: 4000 });
    expect(by.dropoff).toEqual({ kind: "dropoff", n: 1, correct: 0, accuracy: 0, medianMs: 1000 });
    expect(by.play).toEqual({ kind: "play", n: 0, correct: 0, accuracy: null, medianMs: null });
  });

  test("错得最多：题型要答满 3 题、有错；类别按错的次数", () => {
    expect(s.weakest).toEqual(["chart"]); // dropoff 只答了 1 题，signal 全对
    expect(s.missed[0]).toEqual({ kind: "chart", cls: "失序", misses: 2, n: 3 });
    expect(s.missed.length).toBe(2);
  });

  test("连对：对 对 错 | 对 对 对 | 错 错 → 现在 0，最长 3", () => {
    expect(s.streak).toEqual({ current: 0, best: 3 });
    expect(drillStats([ans("chart", "横盘", false, 1), ans("chart", "横盘", true, 1), ans("chart", "横盘", true, 1)]).streak).toEqual({ current: 2, best: 2 });
  });

  test("中位数：奇数个取中间，偶数个取中间两个的平均，空的为 null", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("按弱项挑题型", () => {
  test("权重 = (最近的错题数 + 1) / (题数 + 2)", () => {
    const answers = [
      ans("chart", "横盘", false, 1), ans("chart", "横盘", false, 1), ans("chart", "横盘", false, 1), ans("chart", "横盘", true, 1),
      ...Array.from({ length: 4 }, () => ans("dropoff", "MA20 上、MA60 上", true, 1)),
    ];
    const w = kindWeights(answers, ["chart", "signal", "dropoff"]);
    expect(w.get("chart")).toBeCloseTo(4 / 6);
    expect(w.get("signal")).toBeCloseTo(1 / 2); // 没答过
    expect(w.get("dropoff")).toBeCloseTo(1 / 6);
    expect(w.has("play")).toBe(false); // 题库里没有的不挑
  });

  test("只看每种最近 20 题：早先错的、后来全对，权重降下来", () => {
    const answers = [...Array.from({ length: 10 }, () => ans("chart", "横盘", false, 1)), ...Array.from({ length: 20 }, () => ans("chart", "横盘", true, 1))];
    expect(kindWeights(answers, ["chart"]).get("chart")).toBeCloseTo(1 / 22);
  });

  test("错得多的题型被挑中的次数多：大约按权重的比例", () => {
    const w = new Map<Kind, number>([["chart", 4 / 6], ["signal", 1 / 2], ["dropoff", 1 / 6]]);
    const rand = seeded(11);
    const n = new Map<Kind, number>();
    for (let i = 0; i < 6000; i++) { const k = weighted(w, rand)!; n.set(k, (n.get(k) ?? 0) + 1); }
    expect(n.get("chart")! / 6000).toBeCloseTo(4 / 8, 1);
    expect(n.get("signal")! / 6000).toBeCloseTo(3 / 8, 1);
    expect(n.get("dropoff")! / 6000).toBeCloseTo(1 / 8, 1);
    expect(weighted(new Map(), rand)).toBeNull();
  });
});

describe("按答案类别配平抽题", () => {
  test("八道「都不是」、一道破线、一道拐头：三类各约三分之一", () => {
    const items = [...Array.from({ length: 8 }, (_, i) => ({ id: i, cls: "都不是" })), { id: 8, cls: "破线" }, { id: 9, cls: "拐头" }];
    const rand = seeded(3);
    const n = new Map<string, number>();
    for (let i = 0; i < 3000; i++) { const x = balancedPick(items, rand)!; n.set(x.cls, (n.get(x.cls) ?? 0) + 1); }
    for (const cls of ["都不是", "破线", "拐头"]) expect(n.get(cls)! / 3000).toBeCloseTo(1 / 3, 1);
    expect(balancedPick([], rand)).toBeNull();
  });
});

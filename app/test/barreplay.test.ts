import { describe, expect, test } from "bun:test";
import { DEFAULT_SPEED, SPEEDS, earliestIndex, indexOnOrBefore, randomIndex, sliceAt, speedMs, step } from "../public/replay.js";

/** 200 根日线，前 119 根没有 MA120（和真数据一样：长均线晚开始）。drops 按 Python 的 close[-n] 写死。 */
const N = 200;
const days = Array.from({ length: N }, (_, i) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10));
const line = (from: number) => days.slice(from).map((time, k) => ({ time, value: 100 + from + k }));
const D = {
  candles: days.map((time, i) => ({ time, open: i, high: i + 1, low: i - 1, close: i })),
  volume: days.map((time, i) => ({ time, value: 1000 + i, spike: i % 7 === 0 })),
  lines: { MA20: line(19), EMA20: line(0), MA60: line(59), EMA60: line(0), MA120: line(119), EMA120: line(0) },
  drops: [{ time: days[N - 20], period: 20 }, { time: days[N - 60], period: 60 }, { time: days[N - 120], period: 120 }],
};

describe("回放状态机", () => {
  const off = { mode: "off" } as const;
  const select = { mode: "select" } as const;
  const at = (index: number, playing = false) => ({ mode: "replay", index, playing }) as const;

  test("关 → 选起点 → 选中某天就开始播放 → 暂停 → 播放", () => {
    let s: any = step(off, { type: "enter" }, N);
    expect(s).toEqual(select);
    s = step(s, { type: "pick", index: 50 }, N);
    expect(s).toEqual(at(50, true)); // 选好起点立刻动起来，用户不用再找播放键
    s = step(s, { type: "toggle" }, N);
    expect(s).toEqual(at(50));
    s = step(s, { type: "play" }, N);
    expect(s).toEqual(at(50, true));
    s = step(s, { type: "toggle" }, N);
    expect(s).toEqual(at(50));
    expect(step(s, { type: "pause" }, N)).toEqual(at(50));
  });

  test("前进一根；到最后一根停在那里并自动暂停", () => {
    expect(step(at(50, true), { type: "forward" }, N)).toEqual(at(51, true));
    expect(step(at(N - 2, true), { type: "forward" }, N)).toEqual(at(N - 1));
    expect(step(at(N - 1, true), { type: "forward" }, N)).toEqual(at(N - 1));
  });

  test("回退一根：退一根并停下播放；在第一根上不动；不在回放里不动", () => {
    expect(step(at(50, true), { type: "back" }, N)).toEqual(at(49));
    expect(step(at(50), { type: "back" }, N)).toEqual(at(49));
    expect(step(at(N - 1), { type: "back" }, N)).toEqual(at(N - 2));
    const first = at(0);
    expect(step(first, { type: "back" }, N)).toBe(first);
    expect(step(off, { type: "back" }, N)).toBe(off);
    expect(step(select, { type: "back" }, N)).toBe(select);
  });

  test("在最后一根上不能开始播放", () => {
    expect(step(at(N - 1), { type: "play" }, N)).toEqual(at(N - 1));
    expect(step(at(N - 1), { type: "toggle" }, N)).toEqual(at(N - 1));
  });

  test("回放中可以重选起点（enter 停下播放）、直接换一天（pick 接着播）、回到最新", () => {
    expect(step(at(50, true), { type: "enter" }, N)).toEqual(select);
    expect(step(at(50, true), { type: "pick", index: 10 }, N)).toEqual(at(10, true));
    expect(step(at(50, true), { type: "realtime" }, N)).toEqual(off);
    expect(step(select, { type: "exit" }, N)).toEqual(off);
  });

  test("最后一根也能选（没东西可放，不播放）；越界的选不了", () => {
    expect(step(select, { type: "pick", index: N - 1 }, N)).toEqual(at(N - 1));
    for (const index of [-1, N, 1.5, NaN]) expect(step(select, { type: "pick", index }, N)).toBe(select);
  });

  test("不合法的动作原样返回", () => {
    const s = at(5);
    for (const a of [{ type: "forward" }, { type: "play" }, { type: "pick", index: 3 }, { type: "exit" }] as const) {
      expect(step(off, a, N)).toBe(off);
    }
    for (const a of [{ type: "forward" }, { type: "play" }, { type: "enter" }] as const) expect(step(select, a, N)).toBe(select);
    expect(step(s, { type: "nonsense" } as any, N)).toBe(s);
    expect(step(at(5), { type: "pause" }, N)).toEqual(at(5));
  });

  test("速度按倍数：1x = 一秒一根，0.1x 到 10x，默认 1x", () => {
    expect(SPEEDS).toEqual([0.1, 0.3, 0.5, 1, 3, 5, 10]);
    expect(DEFAULT_SPEED).toBe(1);
    expect(speedMs(1)).toBe(1000);
    expect(speedMs(10)).toBe(100);
    expect(speedMs(0.1)).toBe(10000);
  });
});

describe("截到某一天的图表数据", () => {
  test("每个序列都只留到那一天", () => {
    const s = sliceAt(D, 130);
    const t = days[130];
    expect(s.candles).toHaveLength(131);
    expect(s.candles.at(-1)!.time).toBe(t);
    expect(s.volume).toHaveLength(131);
    expect(s.volume.at(-1)!.time).toBe(t);
    for (const [k, pts] of Object.entries(s.lines)) {
      expect(pts.at(-1)!.time).toBe(t);
      expect(pts.length).toBe((D.lines as any)[k].filter((p: any) => p.time <= t).length);
    }
  });

  test("长均线还没开始的那天：那条线是空的", () => {
    expect(sliceAt(D, 100).lines.MA120).toEqual([]);
  });

  test("抵扣价小黄点：第 i 天要扣的是第 i-n+1 根；不在图上的周期不画", () => {
    expect(sliceAt(D, 130).drops).toEqual([
      { time: days[111], period: 20 }, { time: days[71], period: 60 }, { time: days[11], period: 120 },
    ]);
    expect(sliceAt(D, 60).drops).toEqual([{ time: days[41], period: 20 }, { time: days[1], period: 60 }]);
    expect(sliceAt(D, 5).drops).toEqual([]);
  });

  test("截到最后一根 = 原样的抵扣价", () => {
    expect(sliceAt(D, N - 1).drops).toEqual(D.drops);
  });
});

describe("选起点的几种方式", () => {
  const candles = D.candles;
  test("选日期：落在那天或之前最近的一根；比第一根还早就选不了", () => {
    expect(indexOnOrBefore(candles, days[30])).toBe(30);
    expect(indexOnOrBefore(candles, "2099-01-01")).toBe(N - 1);
    expect(indexOnOrBefore(candles, "2024-12-31")).toBe(-1);
    // 周末这种不在 K 线里的日子：取前一根
    const gap = candles.filter((_, i) => i !== 31);
    expect(indexOnOrBefore(gap, days[31])).toBe(30);
  });
  test("最早一天：6 条线都有值的第一根（按数据算，不写死 120）", () => {
    expect(earliestIndex(D)).toBe(119); // 这份数据的 MA120 从第 119 根才有
    // 真数据：服务端用 3 年历史算线，图上 260 根从第一根起就都有值
    const full = { ...D, lines: Object.fromEntries(Object.keys(D.lines).map((k) => [k, line(0)])) };
    expect(earliestIndex(full)).toBe(0);
    // MA200 只是对照线，晚开始也不推迟回放的最早一天
    expect(earliestIndex({ ...full, lines: { ...full.lines, MA200: line(199) } })).toBe(0);
  });
  test("随机一天：在最早一天和倒数第二根之间", () => {
    expect(randomIndex(D, () => 0)).toBe(119);
    expect(randomIndex(D, () => 0.999999)).toBe(N - 2);
    const two = { ...D, candles: D.candles.slice(0, 2), lines: Object.fromEntries(Object.keys(D.lines).map((k) => [k, line(0)])) };
    expect(randomIndex(two, () => 0.5)).toBe(0);
  });
});

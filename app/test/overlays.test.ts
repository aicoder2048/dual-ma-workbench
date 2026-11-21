import { describe, expect, test } from "bun:test";
import { gapBands, SWING_PIVOTS, structureScene } from "../public/overlays.js";
import type { Analysis } from "../src/citations.ts";
import nvda from "./fixtures/nvda-analysis.json";

/** 2026-05-01 起的工作日 K 线，到 NVDA 替身的分析那天（2026-11-20）。 */
const CANDLES = (() => {
  const out: { time: string; open: number; high: number; low: number; close: number }[] = [];
  for (let d = new Date("2026-05-01T00:00:00Z"); d <= new Date("2026-11-20T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() % 6) out.push({ time: d.toISOString().slice(0, 10), open: 200, high: 210, low: 190, close: 200 });
  }
  return out;
})();
const at = (date: string) => CANDLES.findIndex((c) => c.time === date);
const LAST = CANDLES.length - 1;
const S = structuredClone((nvda as Analysis).structure);
// 替身是加 confirmed 之前录的：补上收盘越过颈线（前高）的那天，最后一个 M 顶改成还没确认
const CONFIRMED = ["2026-09-08", "2026-09-17", "2026-10-09", "2026-10-07", "2026-10-26"];
S.patterns!.forEach((p, k) => { p.confirmed = CONFIRMED[k]; });
S.patterns![2] = { ...S.patterns![2], state: "待确认", confirmed: null };

describe("结构标注：structure → 图上的线和标记", () => {
  const scene = structureScene(S, CANDLES);

  test("波段：最近 6 个端点依次连线（顶部构造的最高点连到底部构造的最低点）", () => {
    const swings = scene.segments.filter((s) => s.kind === "swing");
    const ends = S.pivots!.slice(-SWING_PIVOTS);
    expect(swings).toHaveLength(SWING_PIVOTS - 1);
    expect(swings.map((s) => [s.a.i, s.a.price])).toEqual(ends.slice(0, -1).map((p) => [at(p.date), p.price]));
    expect(swings.at(-1)!.b).toEqual({ i: at("2026-10-06"), price: 243.37 });
  });

  test("最后一个端点（高）到正在形成的底部构造：虚线，这一段还没走完", () => {
    expect(scene.segments.filter((s) => s.kind === "tentative")).toEqual([
      { kind: "tentative", a: { i: at("2026-10-06"), price: 243.37 }, b: { i: at("2026-11-12"), price: 148.8 } },
    ]);
  });

  test("形成中、只差一根：短虚线写下一根怎样就完成，从新低那根画到最新一根右边一点", () => {
    expect(scene.levels).toEqual([
      { a: { i: at("2026-11-12"), price: 170 }, b: { i: LAST + 2, price: 170 }, side: "bottom", text: "下一根高 > 170.00 底构造完成" },
    ]);
  });

  test("短虚线最多往回画 8 根：新低在很早以前也只画最近一小段", () => {
    const early = { ...S, bottom: { ...S.bottom!, pivot_date: "2026-10-01" } };
    expect(structureScene(early, CANDLES).levels[0].a.i).toBe(LAST - 8);
  });

  test("构造标记：最近的顶部、底部构造写状态，点开看对应的规则", () => {
    const cs = scene.marks.filter((m) => m.text.includes("·"));
    expect(cs.map(({ i, side, text, rule, tone }) => ({ i, side, text, rule, tone }))).toEqual([
      { i: at("2026-10-06"), side: "top", text: "顶·已完成", rule: "J20", tone: "down" },
      { i: at("2026-11-12"), side: "bottom", text: "底·形成中", rule: "J27", tone: "up" },
    ]);
    expect(cs[1].lead).toBe("底部构造 · 形成中：新低 2026-11-12 的 148.80；下一根最高价高于 170.00 就完成。最低价跌破 148.80 就作废。");
  });

  test("M 顶 / W 底和 2B 各标最近一个：标在收盘越过颈线（前高 A）的那根；没确认的带问号、颈线画到最新一根", () => {
    const ps = scene.marks.filter((m) => !m.text.includes("·"));
    expect(ps.map(({ i, text, rule }) => [i, text, rule])).toEqual([[at("2026-10-06"), "M顶?", "J25"], [at("2026-10-26"), "2B底", "J26"]]);
    expect(scene.segments.filter((s) => s.kind === "neck")).toEqual([
      { kind: "neck", a: { i: at("2026-09-14"), price: 208.93 }, b: { i: LAST, price: 208.93 }, label: "颈线" },
      { kind: "neck", a: { i: at("2026-10-15"), price: 212.85 }, b: { i: at("2026-10-26"), price: 212.85 }, label: "A" },
    ]);
    expect(ps[1].lead).toBe("2B 底 · 已形成：前低 A 2026-10-15 的 212.85，2026-10-23 越过它；2026-10-26 收盘升破 212.85。");
  });

  test("已确认的 M 顶：颈线从中间那个底画到跌破的那根", () => {
    const formed = structureScene({ ...S, patterns: S.patterns!.slice(0, 1) }, CANDLES);
    expect(formed.marks.find((m) => m.rule === "J25")!.text).toBe("M顶");
    expect(formed.segments.find((s) => s.kind === "neck")).toEqual(
      { kind: "neck", a: { i: at("2026-09-01"), price: 215.1 }, b: { i: at("2026-09-08"), price: 215.1 }, label: "颈线" });
  });

  test("同一根同一侧两个标记往外叠：顶部构造和没确认的 M 顶都在 10-06 上方", () => {
    const on = scene.marks.filter((m) => m.i === at("2026-10-06") && m.side === "top");
    expect(on.map((m) => m.stack)).toEqual([0, 1]);
  });

  test("不在图上的端点不连线、不标；没有结构（只有收盘价、练习里）什么都不画", () => {
    const late = CANDLES.slice(at("2026-09-02"));
    const s = structureScene(S, late);
    expect(s.segments.filter((x) => x.kind === "swing")).toHaveLength(2); // 09-04→09-14→10-06
    expect(s.marks.some((m) => m.i === 0)).toBe(false);
    expect(structureScene({ available: false }, CANDLES)).toEqual({ segments: [], levels: [], marks: [] });
    expect(structureScene(null, CANDLES)).toEqual({ segments: [], levels: [], marks: [] });
  });

  test("已破坏的构造灰掉，规则指向 J22", () => {
    const broken = { ...S, top: { ...S.top!, state: "已破坏" as const, broken_date: "2026-10-20" } };
    const m = structureScene(broken, CANDLES).marks.find((x) => x.text.startsWith("顶·"))!;
    expect([m.text, m.rule, m.tone]).toEqual(["顶·已破坏", "J22", "faint"]);
    expect(m.lead).toContain("2026-10-20 又创新高，构造作废");
  });
});

describe("缺口：gaps → 色带", () => {
  const GAPS = [{ date: "2026-04-10", top: 260, bottom: 251.5 }, { date: "2026-10-27", top: 232.4, bottom: 221.94 }];
  const TARGETS = [{ price: 221.94, kind: "缺口", rule: "P25", source: "视频" as const, date: "2026-10-27" }];

  test("从跳空那根画到最新一根；上沿是前一根最低价，下沿是没补的那段的底；被交易计划用作目标的标出来", () => {
    expect(gapBands(GAPS, TARGETS, CANDLES)[1]).toEqual({
      from: at("2026-10-27"), to: LAST, top: 232.4, bottom: 221.94, target: true, date: "2026-10-27", label: "缺口 221.94–232.40 · 目标位",
    });
  });

  test("跳空在图的第一根之前：从第一根画起，不当目标", () => {
    const b = gapBands(GAPS, TARGETS, CANDLES)[0];
    expect([b.from, b.target, b.label]).toEqual([0, false, "缺口 251.50–260.00"]);
  });

  test("同一天别的目标（均线密集、前高）不算缺口目标；没有缺口、练习里不画", () => {
    expect(gapBands(GAPS, [{ ...TARGETS[0], kind: "前高" }], CANDLES)[1].target).toBe(false);
    expect(gapBands([], TARGETS, CANDLES)).toEqual([]);
    expect(gapBands(null, TARGETS, CANDLES)).toEqual([]);
  });

  test("回放截到跳空之前：之后才出现的缺口不画", () => {
    expect(gapBands(GAPS, TARGETS, CANDLES.slice(0, at("2026-10-26") + 1))).toHaveLength(1);
  });
});

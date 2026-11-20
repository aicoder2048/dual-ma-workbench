/**
 * 盲测练习的「照打法」评分：揭晓后逐笔看纪律，不看盈亏。
 *
 * 每笔四项，每项 ✓ / ✗ / —（不评），都写出是哪一根、为什么：
 * - 打法：进场前一根收盘时，打法空仓买不买（skill 回测的 SETUPS，见 references/backtest-record.json）。不买还进场是 ✗。
 * - 条件：打法会买时，它的进场条件那一根满足没有（任一条满足就行；让位的不算）。P14 的小时线（P13）练习里看不到，按 P10–P12。
 * - 止损：计划的进场后止损（没有就用自己填的）。收盘跌破后下一根开盘就该走；拖到更晚是 ✗，两边都没有止损也是 ✗。
 * - 仓位：练习按整笔成交，只记下写了什么，不评。
 * 纪律分 = ✓ 的项数 / 评了的项数。一笔没有 ✗ 算纪律高，有 ✗ 算纪律低。
 *
 * 只在揭晓时算，每一根的分析都截到那一根（--asof），不会用到之后的行情。
 */
import { Type, type Static } from "typebox";
import type { Analysis, RuleResult } from "../citations.ts";
import { playKey } from "../plan.ts";
import { RECORD, type BacktestRecord } from "../record.ts";
import { tLabel } from "./blind.ts";

const Mark = Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("na")]);
export const CheckT = Type.Object({
  item: Type.Union([Type.Literal("打法"), Type.Literal("条件"), Type.Literal("止损"), Type.Literal("仓位")]),
  mark: Mark,
  /** 依据的那一根（相对开局），没有具体哪一根时为 null。 */
  t: Type.Union([Type.Integer(), Type.Null()]),
  why: Type.String(),
}, { additionalProperties: false });
export type Check = Static<typeof CheckT>;
export const TradeDisciplineT = Type.Object({ journalId: Type.String(), checks: Type.Array(CheckT) }, { additionalProperties: false });
export type TradeDiscipline = Static<typeof TradeDisciplineT>;

type Status = RuleResult["status"];
/** 进场前一根的打法和它的进场条件；entries 为 null 时这套打法空仓不买。 */
export interface EntryState { play: string; entries: { id: string; status: Status }[] | null }

const statusOf = (a: Analysis, id: string): Status => {
  const r = a.rules.find((x) => x.id === id);
  if (!r) throw new Error(`分析结果里没有规则 ${id}`);
  return r.yields_to ? "不满足" : r.status;
};

/** 某一根收盘时：打法、空仓买不买、进场条件的状态。 */
export function entryStateOf(a: Analysis, record: BacktestRecord = RECORD): EntryState {
  const play = playKey(a);
  const setup = record.setups[play];
  if (!setup) return { play, entries: null };
  return {
    play,
    entries: setup.entries.map((id) => {
      const s = statusOf(a, id);
      // 练习数据没有小时线，P13 永远需看图：吃回撤按前三条判（和回测的"不看小时线"一样）
      if (id === "P14" && s === "需看图" && ["P10", "P11", "P12"].every((p) => statusOf(a, p) === "满足")) return { id, status: "满足" as const };
      return { id, status: s };
    }),
  };
}

export interface TradeInput {
  mode: "trigger" | "now" | "none";
  size: string;
  /** 进场那一根（相对开局）；没进场为 null。 */
  entryT: number | null;
  /** 离场那一根；还没离场为 null。 */
  exitT: number | null;
  /** 进场前一根（entryT - 1）收盘时的打法和条件。 */
  decision: EntryState | null;
  stop: { price: number; whose: "计划" | "自己" } | null;
  /** 第 t 根的收盘（指数）。 */
  close: (t: number) => number;
}

const f2 = (x: number) => x.toFixed(2);
const na = (item: Check["item"], why: string): Check => ({ item, mark: "na", t: null, why });

function playCheck(d: EntryState, t: number): Check {
  return d.entries === null
    ? { item: "打法", mark: "fail", t, why: `打法「${d.play}」空仓不买，却进场了` }
    : { item: "打法", mark: "pass", t, why: `打法「${d.play}」空仓可以买` };
}

function entryCheck(d: EntryState, t: number): Check {
  if (d.entries === null) return na("条件", "打法不买，见上一项");
  const ids = (s: Status) => d.entries!.filter((e) => e.status === s).map((e) => e.id).join("、");
  if (ids("满足")) return { item: "条件", mark: "pass", t, why: `${ids("满足")} 满足` };
  if (ids("需看图")) return { item: "条件", mark: "na", t, why: `${ids("需看图")} 需看图，脚本判不了` };
  return { item: "条件", mark: "fail", t, why: `${ids("不满足")} 不满足，进场早了` };
}

function stopCheck(x: TradeInput, entryT: number, exitT: number): Check {
  if (!x.stop) return { item: "止损", mark: "fail", t: entryT, why: "计划和自己都没有止损" };
  const { price, whose } = x.stop;
  for (let t = entryT; t < exitT; t++) {
    if (x.close(t) >= price) continue;
    const late = exitT - (t + 1);
    return late > 0
      ? { item: "止损", mark: "fail", t, why: `收盘 ${f2(x.close(t))} 跌破${whose}止损 ${f2(price)}，${tLabel(exitT)} 才离场，晚了 ${late} 根` }
      : { item: "止损", mark: "pass", t, why: `收盘 ${f2(x.close(t))} 跌破${whose}止损 ${f2(price)}，下一根开盘就走了` };
  }
  return { item: "止损", mark: "pass", t: null, why: `持有期间收盘没跌破${whose}止损 ${f2(price)}` };
}

/** 一笔的四项。exitT 为 null（揭晓前不会出现）时按还没离场，止损只看到最后一根。 */
export function scoreTrade(x: TradeInput, lastT: number): Check[] {
  const size = na("仓位", x.size ? `写了「${x.size}」；练习按整笔成交，不评` : "没写；练习按整笔成交，不评");
  if (x.entryT === null) {
    const why = x.mode === "none" ? "只记判断，没下单" : "没进场";
    return [na("打法", why), na("条件", why), na("止损", why), size];
  }
  if (!x.decision) throw new Error("进场了却没有进场前一根的分析");
  const d = x.entryT - 1;
  return [playCheck(x.decision, d), entryCheck(x.decision, d), stopCheck(x, x.entryT, x.exitT ?? lastT + 1), size];
}

/** 一题的纪律分：✓ 的项数 / 评了的项数；一项都没评时为 null。 */
export function scoreOf(trades: TradeDiscipline[]): { passed: number; scored: number } | null {
  const marks = trades.flatMap((t) => t.checks.map((c) => c.mark)).filter((m) => m !== "na");
  return marks.length ? { passed: marks.filter((m) => m === "pass").length, scored: marks.length } : null;
}

/** 一笔纪律高不高：评了的项都是 ✓ 为高，有 ✗ 为低，一项都没评为 null。 */
export function levelOf(t: TradeDiscipline): "high" | "low" | null {
  const marks = t.checks.map((c) => c.mark).filter((m) => m !== "na");
  if (!marks.length) return null;
  return marks.includes("fail") ? "low" : "high";
}

import { describe, expect, test } from "bun:test";
import type { Analysis, RuleResult } from "../src/citations.ts";
import type { JournalEntry } from "../src/journal.ts";
import { entryStateOf, levelOf, scoreOf, scoreTrade, type EntryState, type TradeInput } from "../src/practice/discipline.ts";
import { next, practiceStats, type Prepared, type Session } from "../src/practice/session.ts";
import nvda from "./fixtures/nvda-analysis.json";

const NOW = "2026-11-20T00:00:00.000Z";

/** NVDA 的分析，换掉打法键和几条规则的状态。 */
function analysis(play: string, status: Record<string, RuleResult["status"]>, yielded: string[] = []): Analysis {
  const a = nvda as Analysis;
  // 脚本的打法键在 trade_plan.key；横盘里 P3 满足（埋伏的底线破了）时脚本给横盘破位
  const key = play === "横盘" && status.P3 === "满足" ? "横盘破位" : play;
  return {
    ...a,
    play: { ...a.play, key: play },
    trade_plan: { ...a.trade_plan, key },
    rules: a.rules.map((r) => ({ ...r, status: status[r.id] ?? r.status, yields_to: yielded.includes(r.id) ? "P17" : r.yields_to })),
  };
}

describe("进场前一根：打法买不买、条件满足没有", () => {
  test("加速下跌空仓不买：没有进场条件", () => {
    expect(entryStateOf(nvda as Analysis)).toEqual({ play: "加速下跌", entries: null });
  });
  test("稳定上涨看 P14；多头结构回撤中看 P19、P20", () => {
    expect(entryStateOf(analysis("稳定上涨", { P14: "满足" }))).toEqual({ play: "稳定上涨", entries: [{ id: "P14", status: "满足" }] });
    expect(entryStateOf(analysis("多头结构回撤中", { P19: "不满足", P20: "满足" })).entries)
      .toEqual([{ id: "P19", status: "不满足" }, { id: "P20", status: "满足" }]);
  });
  test("让位的规则不算满足", () => {
    expect(entryStateOf(analysis("多头结构回撤中", { P19: "满足", P20: "不满足" }, ["P19"])).entries![0].status).toBe("不满足");
  });
  test("P14 需看图（练习没有小时线）：P10–P12 都满足就算满足，否则照旧", () => {
    const met = { P14: "需看图", P10: "满足", P11: "满足", P12: "满足" } as const;
    expect(entryStateOf(analysis("稳定上涨", met)).entries).toEqual([{ id: "P14", status: "满足" }]);
    expect(entryStateOf(analysis("稳定上涨", { ...met, P12: "需看图" })).entries).toEqual([{ id: "P14", status: "需看图" }]);
  });
  test("横盘里 P3 满足（底线破了）是横盘破位：不买", () => {
    expect(entryStateOf(analysis("横盘", { P3: "满足" }))).toEqual({ play: "横盘破位", entries: null });
  });
});

// 收盘：T0..T9
const CLOSES = [100, 101, 103, 104, 102, 97, 96, 98, 99, 100];
const buys: EntryState = { play: "稳定上涨", entries: [{ id: "P14", status: "满足" }] };
const trade = (x: Partial<TradeInput>): TradeInput => ({
  mode: "now", size: "1/3", entryT: 2, exitT: 9, decision: buys, stop: { price: 95, whose: "计划" }, close: (t) => CLOSES[t], ...x,
});
const marks = (x: Partial<TradeInput>) => scoreTrade(trade(x), 9).map((c) => `${c.item}${c.mark}`);

describe("每一笔：四项 ✓ / ✗ / —，写出哪一根、为什么", () => {
  test("条件满足进场、止损没碰到：评了的三项都 ✓，仓位不评", () => {
    const checks = scoreTrade(trade({}), 9);
    expect(checks.map((c) => [c.item, c.mark, c.t])).toEqual([["打法", "pass", 1], ["条件", "pass", 1], ["止损", "pass", null], ["仓位", "na", null]]);
    expect(checks[1].why).toBe("P14 满足");
    expect(checks[2].why).toBe("持有期间收盘没跌破计划止损 95.00");
    expect(checks[3].why).toBe("写了「1/3」；练习按整笔成交，不评");
    expect(levelOf({ journalId: "j", checks })).toBe("high");
  });
  test("打法空仓不买却进场：打法 ✗，条件不再评", () => {
    const checks = scoreTrade(trade({ decision: { play: "加速下跌", entries: null } }), 9);
    expect(checks[0]).toEqual({ item: "打法", mark: "fail", t: 1, why: "打法「加速下跌」空仓不买，却进场了" });
    expect(checks[1].mark).toBe("na");
    expect(levelOf({ journalId: "j", checks })).toBe("low");
  });
  test("条件不满足就进场：条件 ✗；需看图：不评", () => {
    expect(scoreTrade(trade({ decision: { play: "稳定上涨", entries: [{ id: "P14", status: "不满足" }] } }), 9)[1])
      .toEqual({ item: "条件", mark: "fail", t: 1, why: "P14 不满足，进场早了" });
    expect(marks({ decision: { play: "稳定上涨", entries: [{ id: "P14", status: "需看图" }] } })[1]).toBe("条件na");
  });
  test("止损：T5 收盘 97 跌破 98，T6 开盘走是 ✓；拖到 T9 是 ✗，晚 3 根", () => {
    expect(scoreTrade(trade({ stop: { price: 98, whose: "计划" }, exitT: 6 }), 9)[2])
      .toEqual({ item: "止损", mark: "pass", t: 5, why: "收盘 97.00 跌破计划止损 98.00，下一根开盘就走了" });
    expect(scoreTrade(trade({ stop: { price: 98, whose: "自己" }, exitT: 9 }), 9)[2])
      .toEqual({ item: "止损", mark: "fail", t: 5, why: "收盘 97.00 跌破自己止损 98.00，T+9 才离场，晚了 3 根" });
  });
  test("进场之前的收盘不算跌破", () => {
    expect(marks({ entryT: 7, decision: buys, stop: { price: 97.5, whose: "计划" } })[2]).toBe("止损pass");
  });
  test("揭晓时还拿着（没有离场那根）：看到最后一根", () => {
    expect(marks({ stop: { price: 98, whose: "计划" }, exitT: null })[2]).toBe("止损fail");
  });
  test("计划和自己都没有止损：✗", () => {
    expect(scoreTrade(trade({ stop: null }), 9)[2]).toEqual({ item: "止损", mark: "fail", t: 2, why: "计划和自己都没有止损" });
  });
  test("只记判断、没进场：四项都不评，这一题没有纪律分", () => {
    const none = scoreTrade(trade({ mode: "none", entryT: null, exitT: null, decision: null }), 9);
    expect(none.map((c) => c.mark)).toEqual(["na", "na", "na", "na"]);
    expect(none[0].why).toBe("只记判断，没下单");
    expect(scoreOf([{ journalId: "j", checks: none }])).toBeNull();
    expect(levelOf({ journalId: "j", checks: none })).toBeNull();
  });
  test("一题的纪律分：✓ 项数 / 评了的项数", () => {
    const good = { journalId: "a", checks: scoreTrade(trade({}), 9) };
    const bad = { journalId: "b", checks: scoreTrade(trade({ stop: null, decision: { play: "加速下跌", entries: null } }), 9) };
    expect(scoreOf([good, bad])).toEqual({ passed: 3, scored: 5 });
  });
});

describe("练习汇总：按纪律高 / 低分开", () => {
  const posing: Session = { id: "sess-0001", no: 1, createdAt: NOW, updatedAt: NOW, trades: [], phase: "posing",
    secret: { ticker: "QQQ", start: "2018-01-02", shiftDays: 66000, priceFactor: 40 } };
  const deciding = next(posing, { type: "prepared", startIndex: 2, endIndex: 6 }, NOW) as Prepared;
  const snap = { ticker: "练习 #1", asof: null, date: "2200-01-04", close: 101, trend: "", playKey: "", situation: "flat" as const, cost: null,
    action: "", items: [], trigger: null, stop: null, risk: null, rules: [], source: "", record: "" };
  const closed = (id: string, from: number, to: number) => ({
    id, createdAt: NOW, updatedAt: NOW, snapshot: snap, size: "", reason: "", state: "closed", review: null,
    entry: { date: "2200-01-04", price: from }, exit: { date: "2200-01-07", price: to, reason: "" },
    practice: { session: "sess-0001", order: { mode: "now", trigger: null, stop: null } },
  }) as JournalEntry;

  test("没有 ✗ 的算纪律高，有 ✗ 的算纪律低；没评过的（旧题）不进这两组", () => {
    const high = { journalId: "j-high-0001", checks: scoreTrade(trade({}), 9) };
    const low = { journalId: "j-low-00001", checks: scoreTrade(trade({ stop: null }), 9) };
    const rev = next(deciding, { type: "reveal", result: { mine: 1, hold: 2, trades: 2, discipline: [high, low] } }, NOW);
    const old = next(deciding, { type: "reveal", result: { mine: 1, hold: 2, trades: 1 } }, NOW);
    const st = practiceStats([rev, old], [closed("j-high-0001", 100, 110), closed("j-low-00001", 100, 95), closed("j-old-00001", 100, 120)]);
    expect(st.discipline.high.n).toBe(1);
    expect(st.discipline.high.mean!).toBeCloseTo(10, 9);
    expect(st.discipline.low.n).toBe(1);
    expect(st.discipline.low.mean!).toBeCloseTo(-5, 9);
    expect(st.discipline.score).toEqual({ passed: 5, scored: 6 });
    expect(st.trades.closed.all.n).toBe(3);
  });
});

import { describe, expect, test } from "bun:test";
import type { JournalEntry } from "../src/journal.ts";
import { labeler, parseT, rebase, relabel, type Bar } from "../src/practice/blind.ts";
import { HORIZON, pickStart, seeded } from "../src/practice/pool.ts";
import { fillOn, next, practiceStats, PracticeError, resultOf, type Prepared, type Session } from "../src/practice/session.ts";
import { REAL } from "./fixtures/practice-prices.ts";

const NOW = "2026-11-20T00:00:00.000Z";

describe("蒙眼：换算、日期、标签", () => {
  const start = 900;
  const r = rebase(REAL.slice(100, start + 50), start - 100);

  test("第一根收盘换算成 100，价格整体乘同一个系数", () => {
    expect(r.bars[0].close).toBe(100);
    expect(r.bars[300].close).toBeCloseTo(REAL[400].close / r.priceFactor, 3);
    expect(r.bars[300].high / r.bars[300].low).toBeCloseTo(REAL[400].high / REAL[400].low, 4);
  });
  test("日期往后挪整数周：星期几不变，开局落在 2200 年第一周", () => {
    expect(r.shiftDays % 7).toBe(0);
    const day = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
    for (const i of [0, 333, start - 100]) expect(day(r.bars[i].date)).toBe(day(REAL[100 + i].date));
    expect(r.bars[start - 100].date.slice(0, 7)).toMatch(/^(2199-12|2200-01)$/);
  });
  test("T 标签：之前的按日历，之后的按工作日数，不看之后的 K 线", () => {
    const dates = r.bars.map((b) => b.date);
    const at = start - 100;
    const label = labeler(dates, at, at + 5);
    expect(label(dates[at])).toBe("T0");
    expect(label(dates[at - 30])).toBe("T-30");
    expect(label(dates[at + 5])).toBe("T+5");
    // 往后第 7 个日历日 = 第 5 个工作日
    const d = new Date(`${dates[at + 5]}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 7);
    expect(label(d.toISOString().slice(0, 10))).toBe("T+10");
  });
  test("relabel 换掉每一层字符串里的日期，数字不动", () => {
    const out = relabel({ a: "金叉 2200-01-05（3 根前）", b: [{ c: "2200-01-06" }], n: 2200 }, () => "T+1");
    expect(out).toEqual({ a: "金叉 T+1（3 根前）", b: [{ c: "T+1" }], n: 2200 });
  });
  test("parseT", () => {
    expect([parseT("T+5"), parseT("t5"), parseT("T-3"), parseT("T0"), parseT("2024-01-01")]).toEqual([5, 5, -3, 0, null]);
  });
  test("抽日子：之前至少 3 年、之后至少半年；同一个种子同一天", () => {
    const i = pickStart(REAL, seeded(7))!;
    expect(REAL[i].date >= "2017-01-02").toBe(true);
    expect(REAL.length - 1 - i).toBeGreaterThanOrEqual(HORIZON);
    expect(pickStart(REAL, seeded(7))).toBe(i);
  });
});

// ---------- 状态机、自动成交、统计 ----------

const SECRET = { ticker: "QQQ", start: "2018-01-02", shiftDays: 66000, priceFactor: 40 };
const posing: Session = { id: "sess-0001", no: 1, createdAt: NOW, updatedAt: NOW, secret: SECRET, trades: [], phase: "posing" };
const deciding = next(posing, { type: "prepared", startIndex: 2, endIndex: 6 }, NOW) as Prepared;

describe("一题的状态", () => {
  test("出题 → 决策中 → 推进中 → 决策中 → 揭晓", () => {
    expect(deciding).toMatchObject({ phase: "deciding", cursor: 2 });
    const adv = next(deciding, { type: "plan", journalId: "j-00000001" }, NOW);
    expect(adv).toMatchObject({ phase: "advancing", active: "j-00000001", trades: ["j-00000001"] });
    expect(next(adv, { type: "step", closed: false }, NOW)).toMatchObject({ phase: "advancing", cursor: 3 });
    expect(next(adv, { type: "step", closed: true }, NOW)).toMatchObject({ phase: "deciding", cursor: 3 });
    expect(next(adv, { type: "cancel" }, NOW)).toMatchObject({ phase: "deciding" });
    expect(next(deciding, { type: "reveal", result: { mine: 0, hold: 1, trades: 0 } }, NOW)).toMatchObject({ phase: "revealed" });
  });
  test("不合法的转移报 409", () => {
    const adv = next(deciding, { type: "plan", journalId: "j-00000001" }, NOW);
    const done = next(deciding, { type: "reveal", result: { mine: 0, hold: 1, trades: 0 } }, NOW);
    const bad = [
      () => next(adv, { type: "plan", journalId: "j-00000002" }, NOW),
      () => next(deciding, { type: "cancel" }, NOW),
      () => next(posing, { type: "step", closed: false }, NOW),
      () => next(done, { type: "step", closed: false }, NOW),
      () => next(done, { type: "reveal", result: { mine: 0, hold: 0, trades: 0 } }, NOW),
      () => next({ ...deciding, cursor: 6 }, { type: "step", closed: false }, NOW),
    ];
    for (const f of bad) expect(f).toThrow(PracticeError);
  });
});

const bar = (date: string, open: number, close: number): Bar => ({ date, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1 });
const BARS = [bar("2200-01-03", 100, 100), bar("2200-01-04", 100, 101), bar("2200-01-05", 101, 103), bar("2200-01-06", 104, 102), bar("2200-01-07", 101, 96), bar("2200-01-10", 95, 97)];
const idx = (d: string) => BARS.findIndex((b) => b.date === d);
const snap = { ticker: "练习 #1", asof: "2200-01-04", date: "2200-01-04", close: 101, trend: "", playKey: "", situation: "flat" as const, cost: null, action: "",
  items: [], trigger: null, stop: null, risk: null, rules: [], source: "", record: "" };
function entry(order: NonNullable<JournalEntry["practice"]>["order"], extra: Partial<JournalEntry> = {}): JournalEntry {
  return { id: "j-00000001", createdAt: NOW, updatedAt: NOW, snapshot: snap, size: "", reason: "", state: "planned",
    practice: { session: "sess-0001", order }, ...extra } as JournalEntry;
}

describe("自动成交：都在下一根开盘", () => {
  const trig = (price: number, side: "above" | "below" = "above") => entry({ mode: "trigger", trigger: { price, side }, stop: null });
  test("收盘站上触发价 → 下一根开盘买", () => {
    expect(fillOn(BARS, 1, trig(102), null, idx)).toBeNull(); // 收 101 没到
    expect(fillOn(BARS, 2, trig(102), null, idx)).toEqual({ type: "enter", date: "2200-01-06", price: 104 });
  });
  test("回落类：收盘跌到触发价以下才买", () => {
    expect(fillOn(BARS, 3, trig(97, "below"), null, idx)).toBeNull();
    expect(fillOn(BARS, 4, trig(97, "below"), null, idx)).toEqual({ type: "enter", date: "2200-01-10", price: 95 });
  });
  test("下一根开盘直接买；只记判断的不买；手动买", () => {
    expect(fillOn(BARS, 1, entry({ mode: "now", trigger: null, stop: null }), null, idx)).toEqual({ type: "enter", date: "2200-01-05", price: 101 });
    expect(fillOn(BARS, 1, entry({ mode: "none", trigger: null, stop: null }), null, idx)).toBeNull();
    expect(fillOn(BARS, 1, entry({ mode: "none", trigger: null, stop: null }), "enter", idx)?.type).toBe("enter");
  });
  test("收盘跌破止损 → 下一根开盘卖；进场那根之前的收盘不算", () => {
    const open = entry({ mode: "now", trigger: null, stop: 99 }, { state: "open", entry: { date: "2200-01-05", price: 101 } } as Partial<JournalEntry>);
    expect(fillOn(BARS, 3, open, null, idx)).toBeNull(); // 收 102
    expect(fillOn(BARS, 4, open, null, idx)).toMatchObject({ type: "exit", date: "2200-01-10", price: 95 });
    const late = entry({ mode: "now", trigger: null, stop: 101.5 }, { state: "open", entry: { date: "2200-01-06", price: 104 } } as Partial<JournalEntry>);
    expect(fillOn(BARS, 1, late, null, idx)).toBeNull(); // 第 1 根收 101 < 101.5，但还没进场
    expect(fillOn(BARS, 3, late, "exit", idx)).toMatchObject({ type: "exit", reason: "手动离场，下一根开盘卖出" });
  });
  test("没进场不能离场", () => {
    expect(() => fillOn(BARS, 1, trig(102), "exit", idx)).toThrow(PracticeError);
  });
});

describe("结果和统计（手算）", () => {
  const closed = (pnlFrom: number, pnlTo: number, followed: boolean | null): JournalEntry => entry({ mode: "now", trigger: null, stop: null }, {
    state: "closed", entry: { date: "2200-01-04", price: pnlFrom }, exit: { date: "2200-01-07", price: pnlTo, reason: "" },
    review: followed === null ? null : { followed, deviation: "", lesson: "" },
  } as Partial<JournalEntry>);
  test("自己这几笔复利，对比 T+1 开盘买、揭晓那根收盘卖", () => {
    const s = { ...deciding, startIndex: 0, cursor: 4 };
    const r = resultOf(BARS, s, [closed(100, 110, true), closed(100, 90, false)]);
    expect(r.mine).toBeCloseTo((1.1 * 0.9 - 1) * 100, 9); // -1%
    expect(r.hold).toBeCloseTo((96 / 100 - 1) * 100, 9); // T+1 开盘 100，T+4 收盘 96
    expect(r.trades).toBe(2);
  });
  test("跑赢持有的题数、平均超额；照计划 / 没照计划分开", () => {
    const rev = (mine: number, hold: number) => next(deciding, { type: "reveal", result: { mine, hold, trades: 1 } }, NOW);
    const st = practiceStats([rev(10, 4), rev(-2, 5), deciding], [closed(100, 110, true), closed(100, 95, true), closed(100, 103, false), closed(100, 99, null)]);
    expect(st.sessions).toEqual({ total: 3, revealed: 2, open: 1 });
    expect(st.vsHold).toEqual({ n: 2, beat: 1, meanExcess: (6 + -7) / 2, small: true });
    expect(st.trades.closed.all.n).toBe(4);
    const f = st.trades.closed.followed;
    expect([f.n, f.winRate]).toEqual([2, 0.5]);
    expect(f.mean!).toBeCloseTo(2.5, 9);
    expect(f.median!).toBeCloseTo(2.5, 9);
    expect(st.trades.closed.deviated.n).toBe(1);
    expect(st.trades.closed.deviated.mean!).toBeCloseTo(3, 9);
    expect(st.trades.closed.unreviewed).toBe(1);
  });
});


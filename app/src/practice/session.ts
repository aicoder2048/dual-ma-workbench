/**
 * 盲测练习的一题：状态、转移、自动成交、统计、读写 data/practice/sessions.json。
 *
 * 一题的状态：出题（posing）→ 决策中（deciding）→ 推进中（advancing）→ 揭晓（revealed）。
 * - 出题：票和日期已经抽好（secret），练习数据还没做好；做好了进入决策中。做数据失败就停在这里，下次打开重做。
 * - 决策中：手上没有单，可以记一个计划，也可以只往后看。
 * - 推进中：有一笔还在进行的单（active，日志编号）：计划等触发，或已进场等离场。这笔离场或放弃后回到决策中。
 * - 揭晓：终态。没成交的单放弃，持仓按最后一根收盘平掉。
 * cursor 是练习日线里"现在"那根的位置，startIndex 是开局（T0），endIndex 是最后一根（到了自动揭晓）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { group, outcomeOf, summarize, type Action, type Group, type JournalEntry, type Summary } from "../journal.ts";
import { PROJECT_ROOT } from "../sources.ts";
import type { Bar } from "./blind.ts";
import { levelOf, scoreOf, TradeDisciplineT, type TradeDiscipline } from "./discipline.ts";

const Day = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const Index = Type.Integer({ minimum: 0 });
const Strict = { additionalProperties: false } as const;

/** 揭晓前绝不出服务端：真实代码、开局的真实日期、日期挪了几天、价格系数（真实 = 指数 × priceFactor）。 */
const Secret = Type.Object({
  ticker: Type.String(),
  start: Day,
  shiftDays: Type.Integer({ multipleOf: 7 }),
  priceFactor: Type.Number({ exclusiveMinimum: 0 }),
}, Strict);
export type Secret = Static<typeof Secret>;

/**
 * 揭晓时算好存下：自己这几笔复利的收益、同一段买入持有（T+1 开盘买，揭晓那根收盘卖），都是 %；
 * discipline：每一笔的「照打法」评分（discipline.ts）。加这一项之前揭晓的题没有它。
 */
const Result = Type.Object({
  mine: Type.Number(), hold: Type.Number(), trades: Type.Integer({ minimum: 0 }),
  discipline: Type.Optional(Type.Array(TradeDisciplineT)),
}, Strict);
export type Result = Static<typeof Result>;

const common = {
  id: Type.String({ pattern: "^[A-Za-z0-9-]{8,64}$" }),
  no: Type.Integer({ minimum: 1 }),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  secret: Secret,
  /** 这一题记过的日志编号，先记的在前。 */
  trades: Type.Array(Type.String()),
};
const prepared = { startIndex: Index, endIndex: Index, cursor: Index };
const SessionT = Type.Union([
  Type.Object({ ...common, phase: Type.Literal("posing") }, Strict),
  Type.Object({ ...common, ...prepared, phase: Type.Literal("deciding") }, Strict),
  Type.Object({ ...common, ...prepared, phase: Type.Literal("advancing"), active: Type.String() }, Strict),
  Type.Object({ ...common, ...prepared, phase: Type.Literal("revealed"), revealedAt: Type.String(), result: Result }, Strict),
]);
export type Session = Static<typeof SessionT>;
export type Phase = Session["phase"];
export type Prepared = Exclude<Session, { phase: "posing" }>;
export const PHASE_LABEL: Record<Phase, string> = { posing: "出题", deciding: "决策中", advancing: "推进中", revealed: "揭晓" };

const SessionsFile = Type.Object({ version: Type.Literal(1), sessions: Type.Array(SessionT) });

/** status：HTTP 状态码。400 输入不对，404 没有这一题，409 当前状态不能这么做，500 文件坏了。 */
export class PracticeError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 500) {
    super(message);
  }
}

export type SessionEvent =
  | { type: "prepared"; startIndex: number; endIndex: number }
  | { type: "plan"; journalId: string }
  /** 往后一根。closed：这一根上进行中的单离场了。 */
  | { type: "step"; closed: boolean }
  | { type: "cancel" }
  | { type: "reveal"; result: Result };

const illegal = (s: Session, what: string) => new PracticeError(`这一题现在是「${PHASE_LABEL[s.phase]}」，不能${what}`, 409);

/** 状态转移。纯函数：日志怎么改由调用方按 fillOn 的结果去做。 */
export function next(s: Session, ev: SessionEvent, now: string): Session {
  const base = { id: s.id, no: s.no, createdAt: s.createdAt, updatedAt: now, secret: s.secret, trades: s.trades };
  switch (ev.type) {
    case "prepared":
      if (s.phase !== "posing") throw illegal(s, "重新出题");
      if (!(ev.startIndex < ev.endIndex)) throw new PracticeError(`练习数据不对：开局 ${ev.startIndex}，最后一根 ${ev.endIndex}`, 500);
      return { ...base, phase: "deciding", startIndex: ev.startIndex, endIndex: ev.endIndex, cursor: ev.startIndex };
    case "plan":
      if (s.phase !== "deciding") throw illegal(s, s.phase === "advancing" ? "再记一个计划（手上这笔还没结束）" : "记计划");
      return { ...base, trades: [...s.trades, ev.journalId], phase: "advancing", startIndex: s.startIndex, endIndex: s.endIndex, cursor: s.cursor, active: ev.journalId };
    case "step": {
      if (s.phase !== "deciding" && s.phase !== "advancing") throw illegal(s, "往后走");
      if (s.cursor >= s.endIndex) throw illegal(s, "往后走（已经是最后一根）");
      const pos = { startIndex: s.startIndex, endIndex: s.endIndex, cursor: s.cursor + 1 };
      return s.phase === "advancing" && !ev.closed ? { ...base, ...pos, phase: "advancing", active: s.active } : { ...base, ...pos, phase: "deciding" };
    }
    case "cancel":
      if (s.phase !== "advancing") throw illegal(s, "放弃计划");
      return { ...base, phase: "deciding", startIndex: s.startIndex, endIndex: s.endIndex, cursor: s.cursor };
    case "reveal":
      if (s.phase !== "deciding" && s.phase !== "advancing") throw illegal(s, "揭晓");
      return { ...base, phase: "revealed", startIndex: s.startIndex, endIndex: s.endIndex, cursor: s.cursor, revealedAt: now, result: ev.result };
  }
}

/** 手动操作：下一根开盘买 / 卖。 */
export type Manual = "enter" | "exit" | null;

/** 触发价碰到没有：站上类看收盘 ≥ 触发价，回落类看收盘 ≤ 触发价。 */
export function triggerHit(close: number, t: { price: number; side: "above" | "below" }): boolean {
  return t.side === "above" ? close >= t.price : close <= t.price;
}

/**
 * 从 cursor 往后走一根时这笔单要不要成交：都在下一根（cursor + 1）开盘成交，依据是已经看到的 cursor 那根收盘。
 * - 计划：手动买、"下一根开盘买"、或收盘碰到触发价 → 进场。
 * - 已进场：手动卖、或进场那根及以后收盘跌破止损 → 离场。
 * indexOf：练习日期 → 位置（找进场那根）。
 */
export function fillOn(bars: Bar[], cursor: number, e: JournalEntry, manual: Manual, indexOf: (d: string) => number): Action | null {
  const o = e.practice?.order;
  if (!o) throw new PracticeError(`日志 ${e.id} 不是练习下的单`, 500);
  const seen = bars[cursor], bar = bars[cursor + 1];
  if (e.state === "planned") {
    if (manual === "exit") throw new PracticeError("还没进场，不能离场；不想做了就放弃计划", 409);
    const buy = manual === "enter" || o.mode === "now" || (o.mode === "trigger" && o.trigger !== null && triggerHit(seen.close, o.trigger));
    return buy ? { type: "enter", date: bar.date, price: bar.open } : null;
  }
  if (e.state === "open") {
    if (manual === "enter") throw new PracticeError("已经进场了", 409);
    const stopped = o.stop !== null && cursor >= indexOf(e.entry.date) && seen.close < o.stop;
    if (manual !== "exit" && !stopped) return null;
    const reason = manual === "exit" ? "手动离场，下一根开盘卖出" : `收盘 ${seen.close.toFixed(2)} 跌破止损 ${o.stop!.toFixed(2)}，下一根开盘卖出`;
    return { type: "exit", date: bar.date, price: bar.open, reason };
  }
  throw new PracticeError(`日志 ${e.id} 已经「${e.state}」，不是进行中的单`, 500);
}

/** 揭晓时的结果。entries：这一题的日志（已离场的都算）；hold：T+1 开盘买，cursor 那根收盘卖。 */
export function resultOf(bars: Bar[], s: Prepared, entries: JournalEntry[]): Result {
  const closed = entries.flatMap((e) => (e.state === "closed" ? [outcomeOf(e)!] : []));
  const mine = (closed.reduce((g, o) => g * (1 + o.pnl / 100), 1) - 1) * 100;
  const buy = bars[Math.min(s.startIndex + 1, s.cursor)].open;
  return { mine, hold: (bars[s.cursor].close / buy - 1) * 100, trades: closed.length };
}

export const SMALL_SESSIONS = 10;

export interface PracticeStats {
  sessions: { total: number; revealed: number; open: number };
  /** 揭晓了的题：自己比买入持有多赚多少（百分点），几题跑赢。 */
  vsHold: { n: number; beat: number; meanExcess: number | null; small: boolean };
  /** 练习的每一笔（已离场）：照计划 / 没照计划，和交易日志的汇总一样算。 */
  trades: Summary;
  /** 已离场、评过纪律的每一笔：纪律高（没有 ✗）/ 纪律低；scored 是所有揭晓题加起来的 ✓ 项数 / 评了的项数。 */
  discipline: { high: Group; low: Group; score: { passed: number; scored: number } | null };
}

export function practiceStats(sessions: Session[], entries: JournalEntry[]): PracticeStats {
  const done = sessions.flatMap((s) => (s.phase === "revealed" ? [s.result] : []));
  const excess = done.map((r) => r.mine - r.hold);
  return {
    sessions: { total: sessions.length, revealed: done.length, open: sessions.length - done.length },
    vsHold: {
      n: done.length,
      beat: excess.filter((x) => x > 0).length,
      meanExcess: done.length ? excess.reduce((a, b) => a + b, 0) / done.length : null,
      small: done.length < SMALL_SESSIONS,
    },
    trades: summarize(entries.filter((e) => e.practice)),
    discipline: disciplineStats(done.flatMap((r) => r.discipline ?? []), entries),
  };
}

function disciplineStats(scored: TradeDiscipline[], entries: JournalEntry[]): PracticeStats["discipline"] {
  const level = new Map(scored.map((t) => [t.journalId, levelOf(t)]));
  const closed = entries.filter((e) => e.state === "closed");
  const pick = (l: "high" | "low") => group(closed.filter((e) => level.get(e.id) === l).map((e) => outcomeOf(e)!));
  return { high: pick("high"), low: pick("low"), score: scoreOf(scored) };
}

/** 读写 data/practice/sessions.json：每次从文件读，写入先写临时文件再改名；文件坏了报错，不覆盖。 */
export class SessionStore {
  constructor(readonly file = resolve(PROJECT_ROOT, "data/practice/sessions.json")) {}

  list(): Session[] {
    if (!existsSync(this.file)) return [];
    const bad = (why: string) => new PracticeError(`练习记录文件读不了（${this.file}）：${why}。文件没有改动；修好或移走它之后再刷新。`, 500);
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (err) {
      throw bad(`不是合法的 JSON（${err instanceof Error ? err.message : err}）`);
    }
    if (!Value.Check(SessionsFile, data)) {
      const e = [...Value.Errors(SessionsFile, data)][0] as { instancePath?: string; message?: string } | undefined;
      throw bad(`${e?.instancePath || "/"} ${e?.message ?? "格式不对"}`);
    }
    return data.sessions;
  }

  get(id: string): Session {
    const s = this.list().find((x) => x.id === id);
    if (!s) throw new PracticeError(`没有这一题：${id}`, 404);
    return s;
  }

  /** 新加或替换（按编号）。 */
  put(s: Session) {
    const all = this.list();
    const i = all.findIndex((x) => x.id === s.id);
    this.save(i < 0 ? [...all, s] : all.map((x, k) => (k === i ? s : x)));
  }

  private save(sessions: Session[]) {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, sessions }, null, 2) + "\n");
    renameSync(tmp, this.file);
  }
}

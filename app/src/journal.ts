/**
 * 交易日志：记下做决定时的计划，之后对照实际进出场和结果。存在 data/journal.json，只在本机。
 *
 * 一笔日志的状态：计划 → 已进场 → 已离场；计划也可以放弃。
 * - 快照（snapshot）是记入时从当时的分析里自动取的，之后任何操作都不改它，免得事后改计划。
 * - 之后只能填执行（进场、离场，填错了可以改）和复盘（照没照计划做、偏差、教训）。
 * - 文件读不了就报错，不覆盖、不丢；写入先写临时文件再改名。同一个操作做两次，结果一样。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { Analysis } from "./citations.ts";
import { COST, type Situation } from "./plan.ts";
import type { Report } from "./report.ts";
import { PROJECT_ROOT } from "./sources.ts";

const Day = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const Price = Type.Number({ exclusiveMinimum: 0 });
const Level = Type.Object({ label: Type.String(), price: Price });
const SituationT = Type.Union([Type.Literal("flat"), Type.Literal("holding"), Type.Literal("profit"), Type.Literal("loss")]);
// 和 plan.ts 的处境一一对应：那边加了一种，这里编译不过
const _sameSituations: [Static<typeof SituationT>, Situation] extends [Situation, Static<typeof SituationT>] ? true : never = true;
const Strict = { additionalProperties: false } as const;

const Snapshot = Type.Object({
  ticker: Type.String(),
  /** 回放的日期；看最新行情时是 null。 */
  asof: Type.Union([Day, Type.Null()]),
  /** 分析用的那根 K 线的日期和收盘。 */
  date: Day,
  close: Price,
  /** 类型 × 阶段，例如"稳定上涨·回撤中"。 */
  trend: Type.String(),
  playKey: Type.String(),
  situation: SituationT,
  /** 持仓浮盈 / 浮亏时的成本价，计划文字里的 {cost} 已经填好。 */
  cost: Type.Union([Price, Type.Null()]),
  action: Type.String(),
  items: Type.Array(Type.Object({ label: Type.String(), text: Type.String(), rules: Type.Optional(Type.Array(Type.String())) })),
  trigger: Type.Union([Level, Type.Null()]),
  stop: Type.Union([Level, Type.Null()]),
  /** 进场价到止损的距离，%。 */
  risk: Type.Union([Type.Number(), Type.Null()]),
  /** 用到的规则和当时的状态。 */
  rules: Type.Array(Type.Object({ id: Type.String(), name: Type.String(), status: Type.String() })),
  source: Type.String(),
  /** 结论卡片上那句回测记录。 */
  record: Type.String(),
});
export type Snapshot = Static<typeof Snapshot>;

const Fill = Type.Object({ date: Day, price: Price }, Strict);
const Exit = Type.Object({ date: Day, price: Price, reason: Type.String() }, Strict);
const Review = Type.Object({ followed: Type.Boolean(), deviation: Type.String(), lesson: Type.String() }, Strict);
export type Fill = Static<typeof Fill>;
export type Exit = Static<typeof Exit>;
export type Review = Static<typeof Review>;

const base = {
  id: Type.String({ pattern: "^[A-Za-z0-9-]{8,64}$" }),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  snapshot: Snapshot,
  /** 打算用多大仓位，自由填写。 */
  size: Type.String(),
  /** 自己的理由。 */
  reason: Type.String(),
};
const Entry = Type.Union([
  Type.Object({ ...base, state: Type.Literal("planned") }),
  Type.Object({ ...base, state: Type.Literal("open"), entry: Fill }),
  Type.Object({ ...base, state: Type.Literal("closed"), entry: Fill, exit: Exit, review: Type.Union([Review, Type.Null()]) }),
  Type.Object({ ...base, state: Type.Literal("cancelled"), note: Type.String() }),
]);
export type JournalEntry = Static<typeof Entry>;
export type EntryState = JournalEntry["state"];
export const STATES: EntryState[] = ["planned", "open", "closed", "cancelled"];
export const STATE_LABEL: Record<EntryState, string> = { planned: "计划", open: "已进场", closed: "已离场", cancelled: "放弃" };

const JournalFile = Type.Object({ version: Type.Literal(1), entries: Type.Array(Entry) });

/** 记入日志时页面发来的：哪只票、哪天、哪种处境，加上自己填的仓位和理由。快照由服务端按这些重新取。 */
const CreateInput = Type.Object({
  id: base.id,
  ticker: Type.String({ minLength: 1 }),
  asof: Type.Union([Day, Type.Null()]),
  situation: SituationT,
  cost: Type.Union([Price, Type.Null()]),
  size: Type.String({ maxLength: 200 }),
  reason: Type.String({ maxLength: 2000 }),
}, Strict);
export type CreateInput = Static<typeof CreateInput>;

/** 之后能做的操作：只碰执行和复盘，不碰快照。 */
const Action = Type.Union([
  Type.Object({ type: Type.Literal("enter"), date: Day, price: Price }, Strict),
  Type.Object({ type: Type.Literal("exit"), date: Day, price: Price, reason: Type.String({ maxLength: 500 }) }, Strict),
  Type.Object({ type: Type.Literal("cancel"), note: Type.String({ maxLength: 2000 }) }, Strict),
  Type.Object({ type: Type.Literal("review"), followed: Type.Boolean(), deviation: Type.String({ maxLength: 2000 }), lesson: Type.String({ maxLength: 2000 }) }, Strict),
]);
export type Action = Static<typeof Action>;

/** status：HTTP 状态码。400 输入不对，404 没有这笔，409 当前状态不能这么做，500 文件坏了。 */
export class JournalError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 500) {
    super(message);
  }
}

function firstError(schema: TSchema, value: unknown): string {
  const e = [...Value.Errors(schema, value)][0] as { instancePath?: string; message?: string } | undefined;
  return e ? `${e.instancePath || "/"} ${e.message}` : "格式不对";
}

/** 外面来的数据（请求体）→ 类型；不对就 400。 */
function parse<S extends TSchema>(schema: S, value: unknown, what: string): Static<S> {
  if (!Value.Check(schema, value)) throw new JournalError(`${what}不合法：${firstError(schema, value)}`, 400);
  return value as Static<S>;
}
export const parseCreate = (v: unknown) => {
  const c = parse(CreateInput, v, "记入日志的内容");
  if ((c.situation === "profit" || c.situation === "loss") && c.cost === null) {
    throw new JournalError("记入日志的内容不合法：浮盈 / 浮亏的处境要有成本价", 400);
  }
  return c;
};
export const parseAction = (v: unknown) => parse(Action, v, "日志操作");

const isRealDay = (d: string) => new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

/** 从当时的分析里取快照：结论卡片上这种处境的计划、价位、规则、数据来源和回测记录。 */
export function captureSnapshot(a: Analysis, r: Report, input: Pick<CreateInput, "asof" | "situation" | "cost">): Snapshot {
  const plan = r.plans[input.situation];
  const cost = input.situation === "profit" || input.situation === "loss" ? input.cost : null;
  const fill = (t: string) => t.replaceAll(COST, cost === null ? "成本" : cost.toFixed(2));
  const ids = [...new Set([...r.checklist.map((c) => c.id), ...plan.items.flatMap((i) => i.rules ?? [])])];
  return {
    ticker: a.label,
    asof: input.asof,
    date: a.date,
    close: a.close,
    trend: a.regime.name,
    playKey: r.playKey,
    situation: input.situation,
    cost,
    action: fill(plan.action),
    items: plan.items.map((i) => ({ ...i, text: fill(i.text) })),
    trigger: plan.trigger,
    stop: plan.stop,
    risk: plan.risk,
    rules: ids.flatMap((id) => {
      const rule = a.rules.find((x) => x.id === id);
      return rule ? [{ id, name: rule.name, status: rule.status }] : [];
    }),
    source: a.source,
    record: r.record.text,
  };
}

export function createEntry(input: CreateInput, snapshot: Snapshot, now: string): JournalEntry {
  return { id: input.id, createdAt: now, updatedAt: now, snapshot, size: input.size.trim(), reason: input.reason.trim(), state: "planned" };
}

const illegal = (e: JournalEntry, what: string) =>
  new JournalError(`这笔日志现在是「${STATE_LABEL[e.state]}」，不能${what}`, 409);

/**
 * 状态转移。进场、离场在已经进场 / 离场后再做，是改正填错的价位或日期；
 * 放弃只能从计划来；复盘只在离场后。快照不在任何分支里出现。
 */
export function transition(e: JournalEntry, a: Action, now: string): JournalEntry {
  switch (a.type) {
    case "enter": {
      if (!isRealDay(a.date)) throw new JournalError(`进场日期不合法：${a.date}`, 400);
      const entry = { date: a.date, price: a.price };
      if (e.state === "planned" || e.state === "open") {
        const { id, createdAt, snapshot, size, reason } = e;
        return { id, createdAt, updatedAt: now, snapshot, size, reason, state: "open", entry };
      }
      if (e.state === "closed") {
        if (e.exit.date < a.date) throw new JournalError(`进场日期 ${a.date} 晚于离场日期 ${e.exit.date}`, 400);
        return { ...e, entry, updatedAt: now };
      }
      throw illegal(e, "进场");
    }
    case "exit": {
      if (e.state !== "open" && e.state !== "closed") throw illegal(e, e.state === "planned" ? "离场（还没进场）" : "离场");
      if (!isRealDay(a.date)) throw new JournalError(`离场日期不合法：${a.date}`, 400);
      if (a.date < e.entry.date) throw new JournalError(`离场日期 ${a.date} 早于进场日期 ${e.entry.date}`, 400);
      const exit = { date: a.date, price: a.price, reason: a.reason.trim() };
      return { ...e, state: "closed", exit, review: e.state === "closed" ? e.review : null, updatedAt: now };
    }
    case "cancel": {
      if (e.state !== "planned" && e.state !== "cancelled") throw illegal(e, "放弃（已经进场了，要走就填离场）");
      const { id, createdAt, snapshot, size, reason } = e;
      return { id, createdAt, updatedAt: now, snapshot, size, reason, state: "cancelled", note: a.note.trim() };
    }
    case "review": {
      if (e.state !== "closed") throw illegal(e, "复盘（离场以后才复盘）");
      return { ...e, review: { followed: a.followed, deviation: a.deviation.trim(), lesson: a.lesson.trim() }, updatedAt: now };
    }
  }
}

/** 一笔已离场的结果：收益 %（做多）、持有天数（自然日）。 */
export interface Outcome { pnl: number; days: number }
export function outcomeOf(e: JournalEntry): Outcome | null {
  if (e.state !== "closed") return null;
  const days = Math.round((Date.parse(e.exit.date) - Date.parse(e.entry.date)) / 86_400_000);
  return { pnl: (e.exit.price / e.entry.price - 1) * 100, days };
}

/** 少于这么多笔，统计只当参考。 */
export const SMALL_SAMPLE = 10;

export interface Group { n: number; winRate: number | null; mean: number | null; median: number | null; avgDays: number | null; small: boolean }

function group(outcomes: Outcome[]): Group {
  const n = outcomes.length;
  if (!n) return { n, winRate: null, mean: null, median: null, avgDays: null, small: true };
  const pnl = outcomes.map((o) => o.pnl).sort((x, y) => x - y);
  const mid = Math.floor(n / 2);
  return {
    n,
    winRate: pnl.filter((p) => p > 0).length / n,
    mean: pnl.reduce((s, p) => s + p, 0) / n,
    median: n % 2 ? pnl[mid] : (pnl[mid - 1] + pnl[mid]) / 2,
    avgDays: outcomes.reduce((s, o) => s + o.days, 0) / n,
    small: n < SMALL_SAMPLE,
  };
}

export interface Summary {
  counts: Record<EntryState, number>;
  /** 已离场的：全部、照计划做的、没照计划做的；还没复盘的只算进全部。 */
  closed: { all: Group; followed: Group; deviated: Group; unreviewed: number };
}

export function summarize(entries: JournalEntry[]): Summary {
  const counts = Object.fromEntries(STATES.map((s) => [s, entries.filter((e) => e.state === s).length])) as Record<EntryState, number>;
  const closed = entries.filter((e) => e.state === "closed");
  const pick = (f: (e: Extract<JournalEntry, { state: "closed" }>) => boolean) => group(closed.filter(f).map((e) => outcomeOf(e)!));
  return {
    counts,
    closed: {
      all: pick(() => true),
      followed: pick((e) => e.review?.followed === true),
      deviated: pick((e) => e.review?.followed === false),
      unreviewed: closed.filter((e) => !e.review).length,
    },
  };
}

/** 读写 data/journal.json。每次操作都从文件读，没有内存副本，手改文件也不会被旧数据盖掉。 */
export class Journal {
  constructor(readonly file = resolve(PROJECT_ROOT, "data/journal.json")) {}

  list(): JournalEntry[] {
    if (!existsSync(this.file)) return [];
    const bad = (why: string) => new JournalError(
      `交易日志文件读不了（${this.file}）：${why}。文件没有改动；修好或移走它之后再刷新。`, 500);
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (err) {
      throw bad(`不是合法的 JSON（${err instanceof Error ? err.message : err}）`);
    }
    if (!Value.Check(JournalFile, data)) throw bad(firstError(JournalFile, data));
    const ids = new Set<string>();
    for (const e of data.entries) {
      if (ids.has(e.id)) throw bad(`编号 ${e.id} 重复`);
      ids.add(e.id);
    }
    return data.entries;
  }

  /** 同一个编号记两次：返回第一次的，不改。 */
  create(input: CreateInput, snapshot: Snapshot, now = new Date().toISOString()): JournalEntry {
    const entries = this.list();
    const found = entries.find((e) => e.id === input.id);
    if (found) return found;
    const entry = createEntry(input, snapshot, now);
    this.save([...entries, entry]);
    return entry;
  }

  /** 做完和原来一样（同一个操作做两次）：不写文件，更新时间也不变。 */
  apply(id: string, action: Action, now = new Date().toISOString()): JournalEntry {
    const entries = this.list();
    const i = entries.findIndex((e) => e.id === id);
    if (i < 0) throw new JournalError(`没有这笔日志：${id}`, 404);
    const next = transition(entries[i], action, now);
    if (Bun.deepEquals({ ...next, updatedAt: "" }, { ...entries[i], updatedAt: "" })) return entries[i];
    this.save(entries.map((e, k) => (k === i ? next : e)));
    return next;
  }

  private save(entries: JournalEntry[]) {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2) + "\n");
    renameSync(tmp, this.file);
  }
}

/** 给页面的：每笔带上结果，加汇总。最新的在前。 */
export function journalView(entries: JournalEntry[]) {
  return {
    entries: entries.map((e) => ({ ...e, outcome: outcomeOf(e) })).reverse(),
    summary: summarize(entries),
    smallSample: SMALL_SAMPLE,
  };
}

/**
 * 盲测练习的服务端：出题、做练习数据、逐根往后放、按计划自动成交、揭晓。
 *
 * 一题在工作台里就是一只"虚拟股票"：代码写成「练习 #3」，日期写成 T+5。Analyzer 遇到这种代码转到这里，
 * 所以中栏、长风的取数工具、鸿雁的页面数据、推荐问法拿到的都是蒙过眼的数据，而且只到"现在"那根（cursor）。
 * 真实代码、日期、价格系数只在 secret 里，揭晓前不出这个模块。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { AnalyzeResult, ChartData, Runner } from "../analyze.ts";
import { captureSnapshot, type Journal, type JournalEntry, type Order } from "../journal.ts";
import { buildReport } from "../report.ts";
import { PROJECT_ROOT } from "../sources.ts";
import { addDays, isPracticeLabel, labeler, labelOf, PRACTICE_LABEL, parseCsv, parseT, rebase, relabel, tLabel, toCsv, type Bar } from "./blind.ts";
import { DEFAULT_SINCE, HORIZON, pickStart, pickTicker, POOL, seeded, windowStart, type PoolEntry } from "./pool.ts";
import { fillOn, next, PHASE_LABEL, practiceStats, PracticeError, resultOf, type Manual, type Prepared, type Session, type SessionStore } from "./session.ts";

const pexec = promisify(execFile);
const BACKTEST = resolve(PROJECT_ROOT, ".agents/skills/dual-moving-averages/scripts/backtest.py");

const SOURCE = "练习数据（真实日线换算成指数：第一根收盘 = 100）";
/** 图上从开局往前显示多少根，和平时的日线图一样。 */
const CHART_BEFORE = 259;
/** 分析至少要这么多根（skill 的 MIN_BARS = 120 + 5 + 1）。 */
const MIN_BARS = 126;
const PERIODS = [20, 60, 120];

/** 真实日线从哪里来。 */
export interface PriceSource { load(entry: PoolEntry): Promise<Bar[]> }

/** yfinance 复权日线，交给 skill 的 backtest.py --fetch-only（有缓存，7 天内不重取）。 */
export function yfinancePrices(dir = resolve(PROJECT_ROOT, "data/practice/prices")): PriceSource {
  return {
    async load(entry) {
      await pexec("uv", ["run", "--quiet", "--script", BACKTEST, "--fetch-only", "--history-from", entry.since ?? DEFAULT_SINCE,
        "--data", dir, entry.ticker], { cwd: PROJECT_ROOT, timeout: 120_000 });
      return parseCsv(readFileSync(resolve(dir, `${entry.ticker}.csv`), "utf8"), `${entry.ticker} 日线`);
    },
  };
}

const Id = Type.String({ pattern: "^[A-Za-z0-9-]{8,64}$" });
const Strict = { additionalProperties: false } as const;
const CreateInput = Type.Object({ id: Id, seed: Type.Optional(Type.Integer()) }, Strict);
const From = Type.Integer({ minimum: -10000, maximum: 10000 });
const Positive = Type.Number({ exclusiveMinimum: 0 });
const ActionT = Type.Union([
  Type.Object({ type: Type.Literal("step"), from: From }, Strict),
  Type.Object({ type: Type.Literal("enter"), from: From }, Strict),
  Type.Object({ type: Type.Literal("exit"), from: From }, Strict),
  Type.Object({
    type: Type.Literal("plan"), id: Id,
    mode: Type.Union([Type.Literal("trigger"), Type.Literal("now"), Type.Literal("none")]),
    trigger: Type.Union([Positive, Type.Null()]),
    stop: Type.Union([Positive, Type.Null()]),
    size: Type.String({ maxLength: 200 }),
    reason: Type.String({ maxLength: 2000 }),
  }, Strict),
  Type.Object({ type: Type.Literal("cancel") }, Strict),
  Type.Object({ type: Type.Literal("reveal") }, Strict),
]);
export type PracticeAction = Static<typeof ActionT>;

function parse<S extends TSchema>(schema: S, v: unknown, what: string): Static<S> {
  if (Value.Check(schema, v)) return v as Static<S>;
  const e = [...Value.Errors(schema, v)][0] as { instancePath?: string; message?: string } | undefined;
  throw new PracticeError(`${what}不合法：${e?.instancePath || "/"} ${e?.message ?? "格式不对"}`, 400);
}
export const parseCreate = (v: unknown) => parse(CreateInput, v, "开题请求");
export const parseAction = (v: unknown) => parse(ActionT, v, "练习操作");

export interface PracticeOptions {
  store: SessionStore;
  journal: Journal;
  prices: PriceSource;
  /** 跑 dma_analyze.py，参数接在脚本后面（analyze.ts 的 pythonRunner）。 */
  run: Runner;
  /** 练习数据（换算后的 CSV）放哪。 */
  dir?: string;
  random?: () => number;
  pool?: PoolEntry[];
  now?: () => string;
}

/** 页面上的一题。chart 只到 cursor；揭晓前没有任何真实信息。 */
export interface PracticeView {
  id: string; no: number; label: string; phase: Session["phase"]; phaseLabel: string;
  /** 现在是 T 几、最后一根是 T 几（出题中为 null）。 */
  t: number | null; last: number | null;
  /** T0 那根在图表数据里的时间键，页面据此把时间写成 T+n。 */
  t0: string | null;
  close: number | null;
  active: ActiveView | null;
  trades: JournalEntry[];
  chart?: ChartData;
  reveal?: RevealView;
}
export interface ActiveView {
  id: string; state: "planned" | "open"; order: Order;
  entry: { t: string; price: number } | null;
  /** 浮动盈亏 %（按 cursor 那根收盘）。 */
  pnl: number | null;
  /** 已经确定下一根开盘要成交的：例如"收盘站上触发价，下一根开盘买入"。 */
  pending: string | null;
}
/** priceFactor：真实价格 = 指数 × priceFactor（日志里记的是指数）。 */
export interface RevealView { ticker: string; start: string; at: string; end: string; priceFactor: number; result: Extract<Session, { phase: "revealed" }>["result"]; chart: ChartData }

/** 往后一根时新增的图表数据。 */
export interface ChartDelta { candle: ChartData["candles"][number]; volume: ChartData["volume"]; lines: Record<string, { time: string; value: number }[]>; drops: ChartData["drops"] }

interface Raw { analysis: AnalyzeResult["analysis"] }

export class Practice {
  private readonly dir: string;
  private readonly random: () => number;
  private readonly pool: PoolEntry[];
  private readonly now: () => string;
  private chain: Promise<unknown> = Promise.resolve();
  private bars = new Map<string, Bar[]>();
  private charts = new Map<string, Promise<ChartData>>();
  private raws = new Map<string, Promise<Raw>>();

  constructor(private o: PracticeOptions) {
    this.dir = o.dir ?? resolve(PROJECT_ROOT, "data/practice");
    this.random = o.random ?? Math.random;
    this.pool = o.pool ?? POOL;
    this.now = o.now ?? (() => new Date().toISOString());
  }

  /** 改状态的操作一个接一个做（播放的定时器和手点可能同时到）。 */
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.chain.then(f, f);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // ---------- 出题、做数据 ----------

  /** 开一题。同一个编号开两次只算一次。seed：同一个种子出同一道题（测试用）。 */
  create(input: unknown): Promise<PracticeView> {
    const { id, seed } = parseCreate(input);
    return this.serial(async () => {
      const found = this.o.store.list().find((s) => s.id === id);
      if (found) return this.viewOf(await this.prepare(found), true);
      const rand = seed === undefined ? this.random : seeded(seed);
      let picked: { entry: PoolEntry; bars: Bar[]; start: number } | null = null;
      for (let tries = 0; !picked && tries < 5; tries++) {
        const entry = pickTicker(this.pool, rand);
        const bars = await this.o.prices.load(entry);
        const start = pickStart(bars, rand);
        if (start !== null) picked = { entry, bars, start };
      }
      if (!picked) throw new PracticeError("抽了 5 只票都没有够长的历史（之前 3 年、之后半年），检查行情数据", 500);
      const { entry, bars, start } = picked;
      const w0 = windowStart(bars, start);
      const r = rebase(bars.slice(w0, start + HORIZON + 1), start - w0);
      this.writeCsv(id, r.bars);
      const now = this.now();
      const no = Math.max(0, ...this.o.store.list().map((s) => s.no)) + 1;
      const posing: Session = {
        id, no, createdAt: now, updatedAt: now, trades: [], phase: "posing",
        secret: { ticker: entry.ticker, start: bars[start].date, shiftDays: r.shiftDays, priceFactor: r.priceFactor },
      };
      this.o.store.put(posing);
      return this.viewOf(await this.prepare(posing), true);
    });
  }

  /** 出题 → 决策中：跑一遍整段的图表数据（顺便验证数据能分析），开局那天的分析先算好。 */
  private async prepare(s: Session): Promise<Session> {
    if (s.phase !== "posing") return s;
    if (!existsSync(this.csvPath(s.id))) await this.rebuildCsv(s);
    const bars = this.barsOf(s.id);
    const startIndex = bars.findIndex((b) => b.date === addDays(s.secret.start, s.secret.shiftDays));
    if (startIndex < 0) throw new PracticeError(`练习 #${s.no} 的数据里找不到开局那天`, 500);
    await this.chartOf(s.id);
    const ready = next(s, { type: "prepared", startIndex, endIndex: bars.length - 1 }, this.now()) as Prepared;
    await this.rawAt(ready, startIndex);
    this.o.store.put(ready);
    return ready;
  }

  /** 出题时写的 CSV 不见了：按 secret 重新取、重新换算。 */
  private async rebuildCsv(s: Session) {
    const bars = await this.o.prices.load({ ticker: s.secret.ticker, since: this.pool.find((p) => p.ticker === s.secret.ticker)?.since });
    const start = bars.findIndex((b) => b.date === s.secret.start);
    if (start < 0) throw new PracticeError(`练习 #${s.no}：行情里没有开局那天`, 500);
    this.writeCsv(s.id, rebase(bars.slice(windowStart(bars, start), start + HORIZON + 1), start - windowStart(bars, start)).bars);
  }

  private csvPath = (id: string) => resolve(this.dir, `${id}.csv`);

  private writeCsv(id: string, bars: Bar[]) {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.csvPath(id), toCsv(bars));
    this.bars.set(id, bars);
  }

  private barsOf(id: string): Bar[] {
    let b = this.bars.get(id);
    if (!b) {
      const file = this.csvPath(id);
      if (!existsSync(file)) throw new PracticeError(`练习数据文件不见了：${file}`, 500);
      b = parseCsv(readFileSync(file, "utf8"), file);
      this.bars.set(id, b);
    }
    return b;
  }

  private async python(args: string[]): Promise<AnalyzeResult> {
    return JSON.parse(await this.o.run(args)) as AnalyzeResult;
  }

  /** 整段（含开局之后）的图表数据：只留在服务端，按 cursor 切给页面。均线、着色、放量都只看当天及以前，切开不会变。 */
  private chartOf(id: string): Promise<ChartData> {
    let c = this.charts.get(id);
    if (!c) {
      // 一定要给 --asof：不给的话 CSV 模式只取到今天，2200 年的日期全被切掉
      const last = this.barsOf(id).at(-1)!.date;
      c = this.python(["--csv", this.csvPath(id), "--asof", last, "--json", "--chart-bars", "100000"]).then((r) => r.chart);
      this.charts.set(id, c);
      c.catch(() => this.charts.delete(id));
    }
    return c;
  }

  /** 第 index 根收盘时的分析（挪过的日期、指数价格；代码和数据来源换成练习的）。 */
  private rawAt(s: Prepared, index: number): Promise<Raw> {
    const key = `${s.id}|${index}`;
    let r = this.raws.get(key);
    if (!r) {
      const date = this.barsOf(s.id)[index].date;
      r = this.python(["--csv", this.csvPath(s.id), "--asof", date, "--json"])
        .then(({ analysis }) => ({ analysis: { ...analysis, label: labelOf(s.no), source: SOURCE } }));
      this.raws.set(key, r);
      r.catch(() => this.raws.delete(key));
    }
    return r;
  }

  // ---------- 虚拟股票：Analyzer 遇到「练习 #n」转到这里 ----------

  owns(ticker: string): boolean {
    return isPracticeLabel(ticker);
  }

  /** 蒙过眼的分析：日期写成 T+n，图表只到那一根。asof 不传 = 现在；比现在晚的一律拒绝。 */
  async analyze(ticker: string, asof: string | null): Promise<AnalyzeResult> {
    const no = Number(ticker.match(PRACTICE_LABEL)?.[1]);
    const s = this.o.store.list().find((x) => x.no === no);
    if (!s) throw new PracticeError(`没有${labelOf(no)}`, 404);
    if (s.phase === "posing") throw new PracticeError(`${labelOf(no)}还在出题，稍后再看`, 409);
    let index = s.cursor;
    if (asof) {
      const k = parseT(asof);
      if (k === null) throw new PracticeError(`练习里的日期写成 T+5 这样（T0 是开局那天），不是 ${asof}`, 400);
      index = s.startIndex + k;
    }
    if (index > s.cursor) throw new PracticeError(`练习只能看到 ${tLabel(s.cursor - s.startIndex)} 及以前，${asof} 还没走到（不能看之后的 K 线）`, 400);
    if (index < MIN_BARS - 1) throw new PracticeError(`${asof} 之前的数据不够分析（至少要 ${MIN_BARS} 根）`, 400);
    const raw = await this.rawAt(s, index);
    const dates = this.barsOf(s.id).map((b) => b.date);
    return { analysis: relabel(raw.analysis, labeler(dates, s.startIndex, index)), chart: await this.sliceAt(s, index) };
  }

  private async sliceAt(s: Prepared, index: number): Promise<ChartData> {
    const full = await this.chartOf(s.id);
    const from = Math.max(0, Math.min(s.startIndex, index) - CHART_BEFORE);
    const candles = full.candles.slice(from, index + 1);
    const lo = candles[0].time, hi = candles.at(-1)!.time;
    const within = <P extends { time: string }>(xs: P[]) => xs.filter((p) => p.time >= lo && p.time <= hi);
    return {
      candles,
      volume: within(full.volume),
      lines: Object.fromEntries(Object.entries(full.lines).map(([k, xs]) => [k, within(xs)])),
      drops: PERIODS.filter((n) => index - n + 1 >= from).map((n) => ({ time: full.candles[index - n + 1].time, period: n })),
    };
  }

  /** 新走到的那一根：K 线、量、6 条线的点、新的抵扣价位置。 */
  private async deltaAt(s: Prepared): Promise<ChartDelta> {
    const slice = await this.sliceAt(s, s.cursor);
    const t = slice.candles.at(-1)!.time;
    return {
      candle: slice.candles.at(-1)!,
      volume: slice.volume.filter((v) => v.time === t),
      lines: Object.fromEntries(Object.entries(slice.lines).map(([k, xs]) => [k, xs.filter((p) => p.time === t)])),
      drops: slice.drops,
    };
  }

  // ---------- 操作 ----------

  overview() {
    const sessions = this.o.store.list();
    const entries = this.o.journal.list();
    return {
      sessions: sessions.map((s) => ({
        id: s.id, no: s.no, label: labelOf(s.no), phase: s.phase, phaseLabel: PHASE_LABEL[s.phase], createdAt: s.createdAt,
        t: s.phase === "posing" ? null : s.cursor - s.startIndex,
        reveal: s.phase === "revealed" ? { ticker: s.secret.ticker, start: s.secret.start, result: s.result } : null,
      })).reverse(),
      stats: practiceStats(sessions, entries),
    };
  }

  view(id: string): Promise<PracticeView> {
    return this.serial(async () => this.viewOf(await this.prepare(this.o.store.get(id)), true));
  }

  /** 一个操作。from：页面以为现在是 T 几；和服务端对不上（重复提交、另一个页面先走了）就不动，返回现状。 */
  act(id: string, input: unknown): Promise<PracticeView & { delta?: ChartDelta }> {
    const a = parseAction(input);
    return this.serial(async () => {
      const s = await this.prepare(this.o.store.get(id));
      if (s.phase === "posing") throw new PracticeError("还在出题", 409);
      switch (a.type) {
        case "step": case "enter": case "exit": {
          if (s.phase === "revealed" || a.from !== s.cursor - s.startIndex) return this.viewOf(s, true);
          const after = this.step(s, a.type === "step" ? null : a.type);
          return { ...(await this.viewOf(after, after.phase === "revealed")), delta: await this.deltaAt(after) };
        }
        case "plan": return this.viewOf(await this.plan(s, a), false);
        case "cancel": return this.viewOf(this.cancel(s), false);
        case "reveal": return this.viewOf(s.phase === "revealed" ? s : this.reveal(s), true);
      }
    });
  }

  private indexOf(s: Prepared) {
    const bars = this.barsOf(s.id);
    return (d: string) => bars.findIndex((b) => b.date === d);
  }

  /**
   * 往后一根：先按已经看到的那根收盘决定这笔单在下一根开盘成不成交，再往后走。走到最后一根自动揭晓。
   * 日志先写、练习后写：中途断了，再走一次会看到日志已经成交（进场后不再成交、已离场按结束算），结果一样。
   */
  private step(s: Prepared, manual: Manual): Prepared {
    if (s.phase === "revealed") throw new PracticeError("已经揭晓了", 409);
    if (s.cursor >= s.endIndex) throw new PracticeError("已经是最后一根", 409);
    let closed = false;
    if (s.phase === "advancing") {
      const e = this.o.journal.get(s.active);
      if (e.state === "closed" || e.state === "cancelled") closed = true;
      else {
        const act = fillOn(this.barsOf(s.id), s.cursor, e, manual, this.indexOf(s));
        if (act) this.o.journal.apply(e.id, act, this.now(), "practice");
        closed = act?.type === "exit";
      }
    } else if (manual) {
      throw new PracticeError("手上没有单：先记一个计划（可以选下一根开盘直接买）", 409);
    }
    let after = next(s, { type: "step", closed }, this.now()) as Prepared;
    if (after.cursor === after.endIndex) after = this.reveal(after);
    this.o.store.put(after);
    return after;
  }

  private async plan(s: Prepared, a: Extract<PracticeAction, { type: "plan" }>): Promise<Prepared> {
    if (s.phase === "advancing" && s.active === a.id) return s; // 同一个计划提交两次
    const after = next(s, { type: "plan", journalId: a.id }, this.now()) as Prepared; // 不在决策中就在这里报错
    const bars = this.barsOf(s.id);
    const close = bars[s.cursor].close;
    if (a.mode === "trigger" && a.trigger === null) throw new PracticeError("等触发要填触发价", 400);
    const buyAt = a.mode === "trigger" ? a.trigger! : close;
    if (a.stop !== null && a.stop >= buyAt) throw new PracticeError(`止损 ${a.stop.toFixed(2)} 要低于进场价（${buyAt.toFixed(2)}）`, 400);
    const order: Order = {
      mode: a.mode,
      trigger: a.mode === "trigger" ? { price: a.trigger!, side: a.trigger! >= close ? "above" : "below" } : null,
      stop: a.stop,
    };
    const { analysis } = await this.rawAt(s, s.cursor);
    const snapshot = captureSnapshot(analysis, buildReport(analysis), { asof: bars[s.cursor].date, situation: "flat", cost: null });
    this.o.journal.create({ id: a.id, size: a.size, reason: a.reason }, snapshot, this.now(), { session: s.id, order });
    this.o.store.put(after);
    return after;
  }

  private cancel(s: Prepared): Prepared {
    const after = next(s, { type: "cancel" }, this.now()) as Prepared; // 不在推进中就在这里报错
    if (s.phase !== "advancing") return after;
    const e = this.o.journal.get(s.active);
    if (e.state === "open") throw new PracticeError("已经进场了，要走就离场（下一根开盘卖出）", 409);
    if (e.state === "planned") this.o.journal.apply(e.id, { type: "cancel", note: "练习中放弃" }, this.now(), "practice");
    this.o.store.put(after);
    return after;
  }

  /** 揭晓：没成交的计划放弃，持仓按最后一根收盘平掉，算好结果存下。 */
  private reveal(s: Prepared): Prepared {
    const bars = this.barsOf(s.id);
    if (s.phase === "advancing") {
      const e = this.o.journal.get(s.active);
      const last = bars[s.cursor];
      if (e.state === "planned") this.o.journal.apply(e.id, { type: "cancel", note: "揭晓时还没成交" }, this.now(), "practice");
      if (e.state === "open") {
        this.o.journal.apply(e.id, { type: "exit", date: last.date, price: last.close, reason: "揭晓时按最后一根收盘平仓" }, this.now(), "practice");
      }
    }
    const entries = s.trades.map((t) => this.o.journal.get(t));
    const after = next(s, { type: "reveal", result: resultOf(bars, s, entries) }, this.now()) as Prepared;
    this.o.store.put(after);
    return after;
  }

  // ---------- 给页面的 ----------

  /** 练习的日志：揭晓前日期写成 T+n、代码写成「练习 #n」；揭晓后换回真实日期，代码后面加上真实代码。 */
  displayEntry(e: JournalEntry): JournalEntry {
    if (!e.practice) return e;
    const s = this.o.store.list().find((x) => x.id === e.practice!.session);
    if (!s || s.phase === "posing") return e;
    const fn = s.phase === "revealed" ? (d: string) => addDays(d, -s.secret.shiftDays) : labeler(this.barsOf(s.id).map((b) => b.date), s.startIndex, s.cursor);
    const ticker = s.phase === "revealed" ? `${labelOf(s.no)} · ${s.secret.ticker}` : labelOf(s.no);
    const shown = relabel({ snapshot: e.snapshot, ...("entry" in e ? { entry: e.entry } : {}), ...("exit" in e ? { exit: e.exit } : {}) }, fn);
    return { ...e, ...shown, snapshot: { ...shown.snapshot, ticker } } as JournalEntry;
  }

  private async viewOf(s: Session, withChart: boolean): Promise<PracticeView> {
    const base = { id: s.id, no: s.no, label: labelOf(s.no), phase: s.phase, phaseLabel: PHASE_LABEL[s.phase] };
    if (s.phase === "posing") return { ...base, t: null, last: null, t0: null, close: null, active: null, trades: [] };
    const bars = this.barsOf(s.id);
    const trades = s.trades.map((t) => this.displayEntry(this.o.journal.get(t)));
    const view: PracticeView = {
      ...base, t: s.cursor - s.startIndex, last: s.endIndex - s.startIndex, t0: bars[s.startIndex].date, close: bars[s.cursor].close,
      active: s.phase === "advancing" ? this.activeOf(s, bars) : null, trades,
    };
    if (withChart) view.chart = await this.sliceAt(s, s.cursor);
    if (s.phase === "revealed") view.reveal = await this.revealOf(s, bars);
    return view;
  }

  private activeOf(s: Extract<Session, { phase: "advancing" }>, bars: Bar[]): ActiveView | null {
    const e = this.o.journal.get(s.active);
    if (e.state !== "planned" && e.state !== "open") return null;
    const label = labeler(bars.map((b) => b.date), s.startIndex, s.cursor);
    let pending: string | null = null;
    if (s.cursor < s.endIndex) {
      const act = fillOn(bars, s.cursor, e, null, this.indexOf(s));
      pending = act?.type === "enter" ? "下一根开盘买入" : act?.type === "exit" ? "收盘跌破止损：下一根开盘卖出" : null;
    }
    const close = bars[s.cursor].close;
    return {
      id: e.id, state: e.state, order: e.practice!.order,
      entry: e.state === "open" ? { t: label(e.entry.date), price: e.entry.price } : null,
      pnl: e.state === "open" ? (close / e.entry.price - 1) * 100 : null,
      pending,
    };
  }

  /** 揭晓：真实代码和日期，整段图表（到最后一根）换回真实日期和价格。 */
  private async revealOf(s: Extract<Session, { phase: "revealed" }>, bars: Bar[]): Promise<RevealView> {
    const full = await this.chartOf(s.id);
    const { shiftDays, priceFactor: k } = s.secret;
    const day = (t: string) => addDays(t, -shiftDays);
    const from = Math.max(0, s.startIndex - CHART_BEFORE);
    const lo = full.candles[from].time;
    const within = <P extends { time: string }>(xs: P[]) => xs.filter((p) => p.time >= lo);
    return {
      ticker: s.secret.ticker, start: s.secret.start, at: day(bars[s.cursor].date), end: day(bars[s.endIndex].date), priceFactor: k, result: s.result,
      chart: {
        candles: full.candles.slice(from).map((c) => ({ ...c, time: day(c.time), open: c.open * k, high: c.high * k, low: c.low * k, close: c.close * k })),
        volume: within(full.volume).map((v) => ({ ...v, time: day(v.time) })),
        lines: Object.fromEntries(Object.entries(full.lines).map(([n, xs]) => [n, within(xs).map((p) => ({ time: day(p.time), value: p.value * k }))])),
        drops: [],
      },
    };
  }
}

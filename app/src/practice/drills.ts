/**
 * 识别题库：出题、存题、给页面一题、判答案、统计。都存在 data/practice/drills/（不进仓库）。
 *
 * 出题（fill）：照盲测练习的办法抽一只票、一天（pool.ts），往后连着 REGION 根都当候选题目那一根。
 * 这段真实日线换算成指数、日期整周平移（blind.ts 的 rebase），交给 skill 的 scan.py 逐根分析
 * （每根都等于 dma_analyze.py --csv --asof 那一天），每根的分析交给 GENERATORS 的每个出题函数。
 *
 * 配平：草稿按「题型 + 答案类别」入库，每类最多 PER_CLASS 道，同一段行情每类最多 1 道（相邻几根出的题几乎一样）。
 * 一种题型要攒够 TARGET 道，就得凑出至少 TARGET / PER_CLASS 个不同的答案，常见的答案（例如「都不是」）占不满。
 * 给题时先等概率挑答案类别、再挑题（drillstats.balancedPick），题库偏了，看到的也是配平的。
 *
 * 页面只拿到题目那一根及以前的图、题干和选项；答案、依据在交卷后才给。答过的题从题库删掉。
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type { ChartData, Runner } from "../analyze.ts";
import type { Analysis } from "../citations.ts";
import { PROJECT_ROOT } from "../sources.ts";
import { labeler, rebase, relabel, toCsv } from "./blind.ts";
import { GENERATORS, KIND_LABEL, KINDS, shuffle, type Draft, type Kind } from "./drillkinds.ts";
import { balancedPick, drillStats, kindWeights, weighted, type Answer, type DrillStats } from "./drillstats.ts";
import { pickStart, pickTicker, POOL, windowStart, type PoolEntry } from "./pool.ts";
import type { PriceSource } from "./service.ts";
import { PracticeError } from "./session.ts";

const pexec = promisify(execFile);
const SCAN = resolve(PROJECT_ROOT, ".agents/skills/dual-moving-averages/scripts/scan.py");

/** 跑 skill 的 scan.py：一个 CSV、很多天，一次出每天的分析和整段图表。 */
export const scanRunner: Runner = async (args) => {
  const { stdout } = await pexec("uv", ["run", "--quiet", "--script", SCAN, ...args], {
    cwd: PROJECT_ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 300_000,
  });
  return stdout;
};

/** 一段行情里连着多少根当候选题目。 */
export const REGION = 60;
export const PER_CLASS = 3;
export const TARGET = 9;
/** 一种题型少于这么多道就在后台补。 */
export const LOW = 4;
/** 一轮补题最多抽几段行情。 */
export const MAX_WINDOWS = 8;
const LINE_KEYS = ["MA20", "EMA20", "MA60", "EMA60", "MA120", "EMA120"];

const Strict = { additionalProperties: false } as const;
const KindT = Type.Union([Type.Literal("chart"), Type.Literal("signal"), Type.Literal("dropoff"), Type.Literal("construct"), Type.Literal("play")]);
const DrillT = Type.Object({
  id: Type.String(), kind: KindT, cls: Type.String(),
  /** 出自哪一段行情（windows/<window>.json），题目那一根在这段图表里的位置。 */
  window: Type.String({ pattern: "^[a-f0-9-]{36}$" }), index: Type.Integer({ minimum: 0 }), createdAt: Type.String(),
  view: Type.Object({ bars: Type.Integer({ minimum: 1 }), lines: Type.Boolean(), drops: Type.Boolean() }, Strict),
  marks: Type.Array(Type.Object({ t: Type.Integer({ maximum: 0 }), text: Type.String() }, Strict)),
  context: Type.Union([Type.String(), Type.Null()]),
  parts: Type.Array(Type.Object({ prompt: Type.String(), choices: Type.Array(Type.String(), { minItems: 2 }), answer: Type.Integer({ minimum: 0 }) }, Strict), { minItems: 1 }),
  evidence: Type.Array(Type.String()),
  rules: Type.Array(Type.Object({ id: Type.String(), name: Type.String() }, Strict)),
  hint: Type.Union([Type.String(), Type.Null()]),
}, Strict);
export type Drill = Static<typeof DrillT>;
const BankFile = Type.Object({ version: Type.Literal(1), drills: Type.Array(DrillT) }, Strict);
const AnswerT = Type.Object({
  drill: Type.String(), kind: KindT, cls: Type.String(), picks: Type.Array(Type.Integer()), answers: Type.Array(Type.Integer()),
  correct: Type.Boolean(), ms: Type.Number({ minimum: 0 }), at: Type.String(),
}, Strict);
const AnswersFile = Type.Object({ version: Type.Literal(1), answers: Type.Array(AnswerT) }, Strict);
const Point = Type.Object({ time: Type.String(), value: Type.Number() });
const ChartT = Type.Object({
  candles: Type.Array(Type.Object({ time: Type.String(), open: Type.Number(), high: Type.Number(), low: Type.Number(), close: Type.Number() }), { minItems: 1 }),
  volume: Type.Array(Type.Object({ time: Type.String(), value: Type.Number(), spike: Type.Boolean() })),
  lines: Type.Record(Type.String(), Type.Array(Point)),
  drops: Type.Array(Type.Object({ time: Type.String(), period: Type.Integer() })),
});
const MAX_MS = 10 * 60_000;
const AnswerInput = Type.Object({ picks: Type.Array(Type.Integer({ minimum: 0, maximum: 20 }), { minItems: 1, maxItems: 4 }), ms: Type.Number({ minimum: 0 }) }, Strict);
const NextInput = Type.Union([KindT, Type.Null()]);

function parse<S extends TSchema>(schema: S, v: unknown, what: string, status: 400 | 500): Static<S> {
  if (Value.Check(schema, v)) return v as Static<S>;
  const e = [...Value.Errors(schema, v)][0] as { instancePath?: string; message?: string } | undefined;
  throw new PracticeError(`${what}不合法：${e?.instancePath || "/"} ${e?.message ?? "格式不对"}`, status);
}

/** 读一个自己写的 JSON 文件：没有就用 empty；坏了报错、不覆盖。 */
function readJson<S extends TSchema>(file: string, schema: S, empty: Static<S>): Static<S> {
  if (!existsSync(file)) return empty;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new PracticeError(`练习文件读不了（${file}）：不是合法的 JSON（${err instanceof Error ? err.message : err}）。文件没有改动；修好或移走它之后再刷新。`, 500);
  }
  return parse(schema, data, `练习文件（${file}）`, 500);
}

/** 先写临时文件再改名：中途断了，旧文件还在。 */
function writeAtomic(file: string, data: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data) + "\n");
  renameSync(tmp, file);
}

/**
 * 入库：按顺序看每份草稿，「题型 + 类别」在库里（连同这次收下的）不满 perClass、这段行情里还没有，就收下。
 * 纯函数，测试直接调。
 */
export function admit<T extends { kind: Kind; cls: string }>(bank: T[], drafts: T[], perClass = PER_CLASS): T[] {
  const count = new Map<string, number>();
  for (const d of bank) count.set(`${d.kind}|${d.cls}`, (count.get(`${d.kind}|${d.cls}`) ?? 0) + 1);
  const taken = new Set<string>();
  const out: T[] = [];
  for (const d of drafts) {
    const key = `${d.kind}|${d.cls}`;
    if (taken.has(key) || (count.get(key) ?? 0) >= perClass) continue;
    taken.add(key);
    count.set(key, (count.get(key) ?? 0) + 1);
    out.push(d);
  }
  return out;
}

/** 给页面的一题：没有答案。t0 是题目那一根在图表里的时间键，页面据此把时间写成 T+n。 */
export interface DrillView {
  id: string; kind: Kind; label: string; context: string | null;
  parts: { prompt: string; choices: string[] }[];
  chart: ChartData; t0: string; marks: { time: string; text: string }[];
}
export interface Feedback {
  correct: boolean;
  parts: { prompt: string; choices: string[]; pick: number; answer: number }[];
  evidence: string[]; rules: Drill["rules"]; hint: string | null; ms: number;
  stats: DrillStats;
}
export interface Overview { stats: DrillStats; counts: Record<Kind, number>; building: boolean; error: string | null }

export interface DrillOptions {
  prices: PriceSource;
  scan?: Runner;
  dir?: string;
  pool?: PoolEntry[];
  random?: () => number;
  now?: () => string;
  /** 给题、交卷后题少了就在后台补（服务端开；测试关掉，自己调 fill）。 */
  autoFill?: boolean;
}

export class DrillBank {
  private readonly dir: string;
  private readonly scan: Runner;
  private readonly pool: PoolEntry[];
  private readonly random: () => number;
  private readonly now: () => string;
  private chain: Promise<unknown> = Promise.resolve();
  private filling: Promise<void> | null = null;
  private lastError: string | null = null;
  private lastServed: string | null = null;

  constructor(private o: DrillOptions) {
    this.dir = o.dir ?? resolve(PROJECT_ROOT, "data/practice/drills");
    this.scan = o.scan ?? scanRunner;
    this.pool = o.pool ?? POOL;
    this.random = o.random ?? Math.random;
    this.now = o.now ?? (() => new Date().toISOString());
  }

  private get bankFile() { return resolve(this.dir, "bank.json"); }
  private get answersFile() { return resolve(this.dir, "answers.json"); }
  private windowFile = (id: string, ext: "json" | "csv") => resolve(this.dir, "windows", `${id}.${ext}`);

  drills(): Drill[] { return readJson(this.bankFile, BankFile, { version: 1, drills: [] }).drills; }
  answers(): Answer[] { return readJson(this.answersFile, AnswersFile, { version: 1, answers: [] }).answers; }

  /** 改文件的操作一个接一个做（补题在后台跑，交卷随时会来）。 */
  private serial<T>(f: () => T | Promise<T>): Promise<T> {
    const run = this.chain.then(f, f);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private counts(drills = this.drills()): Record<Kind, number> {
    return Object.fromEntries(KINDS.map((k) => [k, drills.filter((d) => d.kind === k).length])) as Record<Kind, number>;
  }

  overview(): Overview {
    return { stats: drillStats(this.answers()), counts: this.counts(), building: this.filling !== null, error: this.lastError };
  }

  // ---------- 补题 ----------

  /** 有题型少于 LOW 道就在后台补（同时只补一轮）。返回这一轮（测试和启动时可以等它）。 */
  topUp(): Promise<void> {
    if (this.filling) return this.filling;
    if (Object.values(this.counts()).every((n) => n >= LOW)) return Promise.resolve();
    this.filling = this.fill().catch((err) => { this.lastError = `补题失败：${err instanceof Error ? err.message : err}`; })
      .finally(() => { this.filling = null; });
    return this.filling;
  }

  /** 抽行情、出题、入库，直到每种题型都有 TARGET 道或抽满 MAX_WINDOWS 段。 */
  async fill(windows = MAX_WINDOWS): Promise<void> {
    for (let i = 0; i < windows; i++) {
      if (Object.values(this.counts()).every((n) => n >= TARGET)) break;
      const { id, drafts } = await this.buildWindow();
      const kept = await this.serial(() => {
        const bank = this.drills();
        const full = new Set(KINDS.filter((k) => bank.filter((d) => d.kind === k).length >= TARGET));
        const added = admit(bank, drafts.filter((d) => !full.has(d.kind)));
        if (added.length) writeAtomic(this.bankFile, { version: 1, drills: [...bank, ...added] });
        return added.length;
      });
      if (!kept) this.dropWindow(id);
      this.lastError = null;
    }
  }

  /** 抽一段行情，换算、逐根分析、每根出草稿（打乱顺序，入库时不总是偏向前面几根）。 */
  async buildWindow(): Promise<{ id: string; drafts: Drill[] }> {
    const rand = this.random;
    let picked: { bars: Awaited<ReturnType<PriceSource["load"]>>; q0: number } | null = null;
    for (let tries = 0; !picked && tries < 5; tries++) {
      const bars = await this.o.prices.load(pickTicker(this.pool, rand));
      const q0 = pickStart(bars, rand);
      if (q0 !== null) picked = { bars, q0 };
    }
    if (!picked) throw new PracticeError("抽了 5 只票都没有够长的历史（之前 5 年、之后半年），检查行情数据", 500);
    const { bars, q0 } = picked;
    const w0 = windowStart(bars, q0);
    const r = rebase(bars.slice(w0, q0 + REGION), q0 - w0);
    const id = randomUUID();
    const csv = this.windowFile(id, "csv");
    mkdirSync(dirname(csv), { recursive: true });
    writeFileSync(csv, toCsv(r.bars));
    const days = r.bars.slice(q0 - w0).map((b) => b.date);
    try {
      return { id, drafts: shuffle(await this.draftsOf(id, csv, days), rand) };
    } catch (err) {
      this.dropWindow(id);
      throw err;
    }
  }

  /** 逐根分析这段行情，存下整段图表，每根交给每个出题函数；草稿里的日期换成 T+n。 */
  private async draftsOf(id: string, csv: string, days: string[]): Promise<Drill[]> {
    const out: { chart: ChartData; analyses: Analysis[] } = JSON.parse(await this.scan(["--csv", csv, "--dates", days.join(",")]));
    const chart = { ...out.chart, lines: Object.fromEntries(LINE_KEYS.map((k) => [k, out.chart.lines[k] ?? []])) };
    writeAtomic(this.windowFile(id, "json"), chart);
    const times = chart.candles.map((c) => c.time);
    const createdAt = this.now();
    const drafts: Drill[] = [];
    for (const a of out.analyses) {
      const index = times.indexOf(a.date);
      if (index < 0) throw new PracticeError(`scan.py 的图表里没有 ${a.date}`, 500);
      const label = labeler(times, index, index);
      for (const kind of KINDS) {
        for (const d of GENERATORS[kind]({ a, dates: times.slice(0, index + 1), rand: this.random })) {
          drafts.push({ ...blind(d, label), id: randomUUID(), window: id, index, createdAt });
        }
      }
    }
    return drafts;
  }

  private dropWindow(id: string) {
    for (const ext of ["csv", "json"] as const) rmSync(this.windowFile(id, ext), { force: true });
  }

  // ---------- 给题、判题 ----------

  /** 下一题。kind 不给：按弱项挑题型。题库空了返回 null，后台在补。 */
  async next(kindInput: unknown = null): Promise<{ drill: DrillView | null; building: boolean; error: string | null }> {
    const kind = parse(NextInput, kindInput, "题型", 400);
    return this.serial(() => {
      const bank = this.drills();
      const kinds = KINDS.filter((k) => (kind === null || k === kind) && bank.some((d) => d.kind === k));
      const chosen = kind ?? weighted(kindWeights(this.answers(), kinds), this.random);
      const pool = bank.filter((d) => d.kind === chosen);
      const fresh = pool.length > 1 ? pool.filter((d) => d.id !== this.lastServed) : pool;
      const d = balancedPick(fresh, this.random);
      if (this.o.autoFill) void this.topUp();
      if (d) this.lastServed = d.id;
      return { drill: d ? this.viewOf(d) : null, building: this.filling !== null, error: this.lastError };
    });
  }

  private viewOf(d: Drill): DrillView {
    const full = parse(ChartT, JSON.parse(readFileSync(this.windowFile(d.window, "json"), "utf8")), "题目的图表", 500) as ChartData;
    const from = Math.max(0, d.index - d.view.bars + 1);
    const candles = full.candles.slice(from, d.index + 1);
    const lo = candles[0].time, hi = candles.at(-1)!.time;
    const within = <P extends { time: string }>(xs: P[]) => xs.filter((p) => p.time >= lo && p.time <= hi);
    const at = (t: number) => full.candles[d.index + t]?.time;
    return {
      id: d.id, kind: d.kind, label: KIND_LABEL[d.kind], context: d.context,
      parts: d.parts.map(({ prompt, choices }) => ({ prompt, choices })),
      t0: hi,
      marks: d.marks.flatMap((m) => (at(m.t) ? [{ time: at(m.t)!, text: m.text }] : [])),
      chart: {
        candles: candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })),
        volume: d.view.lines ? within(full.volume) : [],
        lines: d.view.lines ? Object.fromEntries(Object.entries(full.lines).map(([k, xs]) => [k, within(xs)])) : {},
        drops: d.view.drops ? [20, 60, 120].filter((n) => d.index - n + 1 >= from).map((n) => ({ time: full.candles[d.index - n + 1].time, period: n })) : [],
      },
    };
  }

  /** 交卷：每一问都对才算对。答过的题从题库删掉；同一题交两次第二次拒绝。 */
  async answer(id: string, input: unknown): Promise<Feedback> {
    const { picks, ms: rawMs } = parse(AnswerInput, input, "答案", 400);
    return this.serial(() => {
      const bank = this.drills();
      const d = bank.find((x) => x.id === id);
      const answers = this.answers();
      if (!d) throw new PracticeError(answers.some((x) => x.drill === id) ? "这一题已经答过了" : `没有这一题：${id}`, answers.some((x) => x.drill === id) ? 409 : 404);
      if (picks.length !== d.parts.length) throw new PracticeError(`这一题有 ${d.parts.length} 问，交了 ${picks.length} 个答案`, 400);
      picks.forEach((p, i) => { if (p >= d.parts[i].choices.length) throw new PracticeError(`第 ${i + 1} 问没有第 ${p + 1} 个选项`, 400); });
      const ms = Math.min(rawMs, MAX_MS);
      const record: Answer = { drill: id, kind: d.kind, cls: d.cls, picks, answers: d.parts.map((p) => p.answer), correct: d.parts.every((p, i) => p.answer === picks[i]), ms, at: this.now() };
      const all = [...answers, record];
      writeAtomic(this.answersFile, { version: 1, answers: all });
      const rest = bank.filter((x) => x.id !== id);
      writeAtomic(this.bankFile, { version: 1, drills: rest });
      if (!rest.some((x) => x.window === d.window)) this.dropWindow(d.window);
      if (this.o.autoFill) void this.topUp();
      return {
        correct: record.correct, ms,
        parts: d.parts.map((p, i) => ({ prompt: p.prompt, choices: p.choices, pick: picks[i], answer: p.answer })),
        evidence: d.evidence, rules: d.rules, hint: d.hint, stats: drillStats(all),
      };
    });
  }
}

/** 草稿里的日期（挪过的）一律换成 T+n：T0 是题目那一根。 */
function blind(d: Draft, label: (date: string) => string): Draft {
  return { ...relabel(d, label), view: d.view, marks: d.marks };
}

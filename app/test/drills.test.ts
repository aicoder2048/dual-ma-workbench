import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Analysis } from "../src/citations.ts";
import { buildPlans } from "../src/plan.ts";
import { entryStateOf } from "../src/practice/discipline.ts";
import { parseCsv, rebase, toCsv } from "../src/practice/blind.ts";
import {
  DROPOFF_CHOICES, GENERATORS, gradeClicks, KINDS, PLAY_CHOICES, playClass, REGIME_NAMES, SIGNAL_CHOICES, STEP_TOLERANCE, stepMeaning, STOP_CHOICES,
  TWO_B_CHOICES, type Draft, type Kind,
} from "../src/practice/drillkinds.ts";
import { bucketOf } from "../src/practice/reveal.ts";
import { FILL_CELLS, FILL_PHRASES, keyOfRegime } from "../src/practice/fill.ts";
import { PLAY_KEYS } from "../src/plan.ts";
import { admit, DrillBank, scanRunner, type Drill, type DrillView } from "../src/practice/drills.ts";
import { seeded } from "../src/practice/pool.ts";
import { Analyzer } from "../src/analyze.ts";
import { createHandler } from "../src/http.ts";
import { Journal } from "../src/journal.ts";
import { SettingsStore } from "../src/settings.ts";
import { PROJECT_ROOT, SourceLibrary } from "../src/sources.ts";
import { Watchlist } from "../src/watchlist.ts";
import { prices, REAL, REAL_TICKER } from "./fixtures/practice-prices.ts";
import nvda from "./fixtures/nvda-analysis.json";

const NOW = "2026-11-20T00:00:00.000Z";
const SCAN_BARS = 60;

/** 一段行情逐根的 skill 分析（真的 scan.py）。rebased：照题库的办法换算过（假"真实"行情）；TSLA：skill 的真实行情片段，类型多一些。 */
async function scanned(csvText: string, name: string): Promise<{ a: Analysis; dates: string[] }[]> {
  const dir = mkdtempSync(join(tmpdir(), `dma-drill-${name}-`));
  const csv = join(dir, `${name}.csv`);
  writeFileSync(csv, csvText);
  const bars = parseCsv(csvText, name);
  const days = bars.slice(-SCAN_BARS).map((b) => b.date);
  const out = JSON.parse(await scanRunner(["--csv", csv, "--dates", days.join(",")]));
  const times: string[] = out.chart.candles.map((c: { time: string }) => c.time);
  return out.analyses.map((a: Analysis) => ({ a, dates: times.slice(0, times.indexOf(a.date) + 1) }));
}

let cases: { a: Analysis; dates: string[] }[] = [];
beforeAll(async () => {
  const start = REAL.length - 400;
  const blinded = toCsv(rebase(REAL.slice(start - 1300, start), 1299).bars);
  const tsla = readFileSync(resolve(PROJECT_ROOT, ".agents/skills/dual-moving-averages/tests/fixtures/TSLA.csv"), "utf8");
  cases = [...(await scanned(blinded, "rebased")), ...(await scanned(tsla, "TSLA"))];
}, 60_000);

const draftsOf = (kind: Kind) => cases.flatMap(({ a, dates }) => GENERATORS[kind]({ a, dates, rand: seeded(1) }).map((d) => ({ a, d })));
const partsOf = (d: Draft) => (d.kind === "steps" ? [] : d.parts);
const picked = (d: Draft, part = 0) => partsOf(d)[part].choices[partsOf(d)[part].answer];

describe("出题函数：答案就是分析里的字段", () => {
  test("每种题都出得来，每道题的答案在选项里、选项不重复", () => {
    for (const kind of KINDS) {
      const ds = draftsOf(kind);
      expect({ kind, some: ds.length > 0 }).toEqual({ kind, some: true });
      for (const { d } of ds) {
        expect(d.kind).toBe(kind);
        for (const p of partsOf(d)) {
          expect(p.answer).toBeGreaterThanOrEqual(0);
          expect(p.answer).toBeLessThan(p.choices.length);
          expect(new Set(p.choices).size).toBe(p.choices.length);
        }
        expect(d.evidence.length).toBeGreaterThan(0);
        expect(d.rules.length).toBeGreaterThan(0);
        expect(d.rules.every((r) => r.name)).toBe(true); // 编号都在分析的规则清单里
      }
    }
  });

  test("看图：答案 = regime.name，六个选项都在类型 × 阶段的词表里", () => {
    for (const { a, d } of draftsOf("chart")) {
      expect(picked(d)).toBe(a.regime.name);
      expect(partsOf(d)[0].choices.length).toBe(6);
      expect(partsOf(d)[0].choices.every((c) => (REGIME_NAMES as readonly string[]).includes(c))).toBe(true);
      expect(d.hint).toContain(a.regime.clock60.hour);
    }
  });

  test("看信号：答案 = 20/60 这次转折里日期是这一根的、最靠后的进度点；没有就是「都不是」", () => {
    const order = ["破线", "EMA 拐头", "MA 拐头", "第一个交叉", "双交叉"];
    const ds = draftsOf("signal");
    for (const { a, d } of ds) {
      const today = a.steps[0].current!.steps.filter((s) => s.date === a.date).map((s) => order.indexOf(s.step));
      expect(picked(d)).toBe(today.length ? order[Math.max(...today)] : "都不是");
      expect(partsOf(d)[0].choices).toEqual([...SIGNAL_CHOICES]);
      expect(d.marks).toEqual([{ t: 0, text: "这根" }]);
    }
    expect(ds.some(({ d }) => d.cls !== "都不是")).toBe(true);
  });

  test("看抵扣价：方向 = drops 的 direction；门槛 = MA20 门槛路径的最高价", () => {
    for (const { a, d } of draftsOf("dropoff")) {
      const dir = (n: number) => a.drops.find((x) => x.period === n)!.direction;
      expect(picked(d)).toBe(`MA20 ${dir(20)}、MA60 ${dir(60)}`);
      expect(partsOf(d)[0].choices).toEqual([...DROPOFF_CHOICES]);
      if (partsOf(d)[1]) expect(picked(d, 1)).toBe(a.projection.hurdles.find((h) => h.period === 20)!.max_price.toFixed(2));
    }
  });

  test("看构造：状态 = structure 里那一侧的 state；下一根 = complete_at；2B 跟 J26 的状态走", () => {
    const ds = draftsOf("construct");
    for (const { a, d } of ds) {
      const s = a.structure;
      if (d.cls.startsWith("状态:")) {
        const k = partsOf(d)[0].prompt.includes("顶部构造") ? s.top! : s.bottom!;
        expect(picked(d)).toBe(k.state);
      } else if (d.cls === "下一根") {
        const k = partsOf(d)[0].prompt.startsWith("顶部构造") ? s.top! : s.bottom!;
        expect(picked(d)).toBe(k.complete_at!.toFixed(2));
      } else {
        const j = a.rules.find((r) => r.id === "J26")!;
        expect(picked(d)).toBe(j.status === "满足" ? j.basis.slice(0, 4) : "没有");
        expect(partsOf(d)[0].choices).toEqual([...TWO_B_CHOICES]);
      }
      expect(d.view.lines).toBe(false); // 只看 K 线
    }
    expect(new Set(ds.map(({ d }) => d.cls.split(":")[0])).size).toBeGreaterThanOrEqual(2);
  });

  test("看打法：打法类别跟回测打法的进场条件走；止损 = 空仓计划的止损", () => {
    for (const { a, d } of draftsOf("play")) {
      expect(picked(d)).toBe(playClass(a)!);
      expect(picked(d)).not.toBe("反弹卖");
      expect(partsOf(d)[0].choices).toEqual([...PLAY_CHOICES]);
      const stop = buildPlans(a).flat.stop;
      const buys = entryStateOf(a).entries !== null;
      // 蒙眼：交易计划是换算后那段行情算的（不带账户，没有股数），价位和题目里的收盘同一个量级
      expect(a.trade_plan.flat.size?.shares ?? null).toBeNull();
      const prices = [a.trade_plan.flat.entry?.price, a.trade_plan.flat.stop?.price, ...a.trade_plan.flat.targets.map((t) => t.price)];
      for (const x of prices) if (x != null) expect(x / a.close).toBeGreaterThan(0.2), expect(x / a.close).toBeLessThan(5);
      expect(picked(d, 1)).toBe(stop && buys ? STOP_CHOICES.find((c) => stop.label.startsWith(c.slice(0, 5)))! : "不设（这时不进场）");
    }
  });
});


describe("打法补全：先判类型，再按找打法的格子逐格选", () => {
  const sitOf = (cls: string) => (cls.endsWith("·空仓") ? "flat" : cls.endsWith("·浮盈") ? "profit" : "loss") as "flat" | "profit" | "loss";

  test("短语表覆盖每套打法 × 处境 × 格：缺一项就失败；同一格不同打法的短语有区分", () => {
    expect(Object.keys(FILL_PHRASES).sort()).toEqual([...PLAY_KEYS].sort());
    for (const key of PLAY_KEYS) {
      const t = FILL_PHRASES[key];
      for (const v of [t.flat.signal, t.flat.entry, t.flat.stop, t.holding.signal, t.holding.stop, t.holding.pnl.profit, t.holding.pnl.loss]) {
        expect({ key, ok: typeof v === "string" && v.length > 0 }).toEqual({ key, ok: true });
      }
    }
    // 等什么信号：每套打法一句，不全是同一句（否则这格考不出东西）
    expect(new Set(PLAY_KEYS.map((k) => FILL_PHRASES[k].flat.signal)).size).toBeGreaterThanOrEqual(7);
    expect(FILL_CELLS.flat.map((c) => c.title)).toEqual(["能不能做", "等什么信号", "在哪进", "止损放哪", "目标看哪"]);
    expect(FILL_CELLS.holding.map((c) => c.title)).toEqual(["拿着还是走", "盯什么信号", "在哪走", "目标看哪", "浮盈 / 浮亏怎么办"]);
  });

  test("类型名换成打法：稳定、加速照类型；转折中和三种过渡状态是过渡；多头回撤、空头反弹各自一套", () => {
    expect(keyOfRegime("稳定上涨·回撤中")).toBe("稳定上涨");
    expect(keyOfRegime("加速下跌·延伸")).toBe("加速下跌");
    expect(keyOfRegime("加速上涨·顶部转折中")).toBe("过渡");
    expect(keyOfRegime("横盘")).toBe("横盘");
    expect(keyOfRegime("多头结构回撤中")).toBe("多头结构回撤中");
    expect(keyOfRegime("空头结构反弹中")).toBe("空头结构反弹中");
    for (const n of ["顶部转折中", "底部转折中", "失序"]) expect(keyOfRegime(n)).toBe("过渡");
  });

  test("答案从当天的交易计划取：第 0 问 = 类型；① = 计划的结论词；止损、目标看交易计划；其余是这套打法的短语；空仓、持仓都出", () => {
    const ds = draftsOf("fill");
    expect(ds.length).toBeGreaterThan(0);
    const sits = new Set(ds.map(({ d }) => sitOf(d.cls) === "flat" ? "flat" : "holding"));
    expect([...sits].sort()).toEqual(["flat", "holding"]);
    for (const { a, d } of ds) {
      if (d.kind !== "fill") throw new Error("kind");
      const key = a.trade_plan.key;
      const sit = sitOf(d.cls);
      const flat = sit === "flat";
      const plan = buildPlans(a)[sit];
      expect(d.parts).toHaveLength(6);
      expect(picked(d, 0)).toBe(a.regime.name);
      expect(picked(d, 1)).toBe(plan.verdict);
      expect(d.cls.startsWith(`${key}·`)).toBe(true);
      const t = FILL_PHRASES[key];
      const target = plan.trade.targets[0]?.kind;
      if (flat) {
        expect(picked(d, 2)).toBe(t.flat.signal);
        expect(picked(d, 3)).toBe(t.flat.entry);
        if (plan.trade.entry === null) expect(picked(d, 4).startsWith("—")).toBe(true);
        else expect(picked(d, 4)).toBe((plan.stop?.label ?? t.flat.stop).replace("（守住）", ""));
      } else {
        expect(picked(d, 2)).toBe(t.holding.signal);
        expect(picked(d, 3)).toBe(t.holding.stop);
        expect(picked(d, 5)).toBe(t.holding.pnl[sit as "profit" | "loss"]);
      }
      // 目标格：持仓题不出"不进场"这种空仓才有的选项
      if (!flat) expect(d.parts[4].choices.some((c) => c.includes("不进场"))).toBe(false);
      if (target) expect(picked(d, 5 - (flat ? 0 : 1))).toContain({ 缺口: "缺口", 前高: "前高" }[target] ?? (target.includes("全部汇聚") ? "全部汇聚" : "均线密集"));
      else expect(picked(d, 5 - (flat ? 0 : 1)).startsWith("—")).toBe(true);
      // 类型判错时每格按你选的类型该填什么：选对的那一行是 null
      expect(d.alts).toHaveLength(d.parts[0].choices.length);
      expect(d.alts[d.parts[0].answer]).toBeNull();
      for (const row of d.alts) if (row) expect(row).toHaveLength(5);
      // 不给类型：题干不能说出类型名
      expect(d.context ?? "").not.toContain(a.regime.name);
    }
  });
});

describe("推演揭晓、五步点图：答案也从分析的字段来", () => {
  test("推演揭晓：方向 = 第 n 天扣掉的收盘和收平价比；双交叉 = 持平情景两组都交叉的那天；拐头价位 = 门槛路径前几天的最高（最低）价", () => {
    const ds = draftsOf("project");
    expect(ds.length).toBeGreaterThan(0);
    for (const { a, d } of ds) {
      if (d.kind !== "project") throw new Error("kind");
      expect(d.parts.length).toBeGreaterThanOrEqual(2);
      expect(d.reveal.parts.length).toBe(d.parts.length);
      expect(d.reveal.close).toBe(a.close);
      expect(d.context).toContain("收平");
      expect(d.context).toContain("不算分");
      d.reveal.parts.forEach((r, i) => {
        const h = (n: number) => a.projection.hurdles.find((x) => x.period === n)!;
        if (r.q === "dir") {
          const w = (n: number) => (a.close > h(n).prices[r.n - 1] ? "上" : "下");
          expect(picked(d, i)).toBe(`MA20 ${w(20)}、MA60 ${w(60)}`);
          expect(r.n).not.toBe(20); // MA20 第 20 天扣的是 T0 自己，收平一定走平
        } else if (r.q === "cross") {
          const day = (kind: string) => a.projection.scenarios[0].crosses.find((x) => x.kind === kind && x.pair === "20/60")!.cross_day;
          const both = day("MA") !== null && day("EMA") !== null ? Math.max(day("MA")!, day("EMA")!) : null;
          expect(picked(d, i)).toBe(bucketOf(both));
          const ma = (n: number) => a.lines.find((l) => l.period === n)!.ma;
          expect(r.way).toBe(ma(20) > ma(60) ? "死叉" : "金叉");
        } else {
          const path = h(r.period).prices.slice(0, r.days);
          expect(picked(d, i)).toBe((r.way === "下" ? Math.max(...path) : Math.min(...path)).toFixed(2));
          expect(picked(d, i)).toBe(r.level.toFixed(2));
          expect(Math.abs(r.level / a.close - 1)).toBeGreaterThan(0.003); // 答案不是现价本身
        }
      });
    }
    const classes = new Set(ds.map(({ d }) => d.cls));
    expect([...classes].some((c) => c.startsWith("交叉:"))).toBe(true);
    expect(classes.size).toBeGreaterThanOrEqual(3);
  });

  test("五步点图：要点的 = 这一轮转折前 k 步，位置换回去就是分析里的日期；图在 40–80 根、盖得住第一步", () => {
    const ds = draftsOf("steps");
    expect(ds.length).toBeGreaterThan(0);
    const order = ["破线", "EMA 拐头", "MA 拐头", "第一个交叉", "双交叉"];
    for (const { a, d } of ds) {
      if (d.kind !== "steps") throw new Error("kind");
      const { click } = d;
      const pair = a.steps.find((p) => p.pair === `${click.fast}/${click.slow}`)!;
      const turn = [pair.completed, pair.current].find((t) => t?.direction === click.direction && t.progress === click.steps.length)!;
      expect(click.steps.map((s) => s.step)).toEqual(order.slice(0, click.steps.length) as never);
      const dates = cases.find((x) => x.a === a)!.dates;
      expect(click.steps.map((s) => dates[dates.length - 1 + s.t])).toEqual(turn.steps.slice(0, click.steps.length).map((s) => s.date!));
      expect(d.view.bars).toBeGreaterThanOrEqual(40);
      expect(d.view.bars).toBeLessThanOrEqual(80);
      expect(-Math.min(...click.steps.map((s) => s.t))).toBeLessThan(d.view.bars);
      expect(click.tolerance).toBe(STEP_TOLERANCE);
      expect(d.cls).toBe(`${click.fast}/${click.slow}·${click.direction}·${click.steps.length}步`);
      expect(d.rules.map((r) => r.id)).toEqual(expect.arrayContaining(["J15", "J16"]));
    }
    const classes = new Set(ds.map(({ d }) => d.cls));
    for (const want of ["20/60", "60/120", "向上", "向下"]) expect({ want, some: [...classes].some((c) => c.includes(want)) }).toEqual({ want, some: true });
    expect(new Set([...classes].map((c) => c.split("·")[2])).size).toBeGreaterThanOrEqual(3);
  });

  test("点图判分：差 tolerance 根以内算对，多一根就错；少点一步那步算错", () => {
    const task = { steps: [{ step: "破线" as const, t: -20 }, { step: "EMA 拐头" as const, t: -18 }], tolerance: 1 };
    expect(gradeClicks(task, [-20, -18])).toEqual([true, true]);
    expect(gradeClicks(task, [-21, -17])).toEqual([true, true]);
    expect(gradeClicks(task, [-22, -18])).toEqual([false, true]);
    expect(gradeClicks(task, [-20])).toEqual([true, false]);
  });

  test("看信号的「步骤」说明和点图题共用一份定义：20/60 的写法没变", () => {
    expect(stepMeaning("MA 拐头", 20, 60)).toEqual({ text: "MA20 当天朝反方向走（收盘越过 20 日抵扣价）", rule: "A1" });
    expect(stepMeaning("双交叉", 60, 120)).toEqual({ text: "MA60 穿过 MA120、EMA60 穿过 EMA120，两组都交叉", rule: "J16" });
  });
});

describe("入库配平", () => {
  const d = (kind: Kind, cls: string) => ({ kind, cls });
  test("同一类最多 perClass 道；同一段行情同一类只收一道", () => {
    const bank = [d("signal", "都不是"), d("signal", "都不是")];
    const got = admit(bank, [d("signal", "都不是"), d("signal", "都不是"), d("signal", "破线"), d("signal", "破线"), d("chart", "横盘")], 3);
    expect(got).toEqual([d("signal", "都不是"), d("signal", "破线"), d("chart", "横盘")]);
    expect(admit([...bank, ...got], [d("signal", "都不是")], 3)).toEqual([]);
  });
});

// ---------- 题库：真的 scan.py，假的"真实"行情 ----------

function bank(dir = mkdtempSync(join(tmpdir(), "dma-drills-"))) {
  return { dir, b: new DrillBank({ prices, dir, pool: [{ ticker: REAL_TICKER }], random: seeded(5), now: () => NOW }) };
}

/** 这段行情图表的时间键（题目那一根是 times[d.index]）。 */
const windowTimes = (dir: string, d: Drill): string[] =>
  JSON.parse(readFileSync(join(dir, "windows", `${d.window}.json`), "utf8")).candles.map((c: { time: string }) => c.time);

/** 对的答案：选择题选对的选项；点图题点答案那几根，shift 是故意点偏几根。 */
function rightInput(dir: string, d: Drill, shift = 0) {
  if (d.kind !== "steps") return { picks: d.parts.map((p) => p.answer), ms: 1 };
  const times = windowTimes(dir, d);
  return { clicks: d.click.steps.map((s) => times[d.index + s.t - shift]), ms: 1 };
}

/** 一段 JSON 里有没有真实代码、这段真实行情里的日期、真实价位（3000 ~ 6000）。 */
function leaks(v: unknown): string[] {
  const text = JSON.stringify(v, (k, x) => (k === "id" || k === "window" ? undefined : x));
  const out: string[] = [];
  if (text.includes(REAL_TICKER)) out.push(REAL_TICKER);
  for (const m of text.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []) if (m >= REAL[0].date && m <= REAL.at(-1)!.date) out.push(m);
  for (const m of text.match(/\b\d{4}\.\d+\b/g) ?? []) if (Number(m) >= 2500 && Number(m) <= 7000) out.push(m);
  return out;
}

describe("题库", () => {
  let shared: ReturnType<typeof bank>;
  beforeAll(async () => {
    shared = bank();
    await shared.b.fill(2);
  }, 60_000);

  test("给页面的题：没有真实代码、日期、价格，图只到题目那一根，没有答案", async () => {
    const { b } = shared;
    expect(leaks({ p: REAL[9].close, d: REAL[9].date, t: REAL_TICKER })).toHaveLength(3); // 查得出来
    expect(b.drills().length).toBeGreaterThan(0);
    for (const kind of KINDS) {
      const { drill } = await b.next(kind);
      if (!drill) continue;
      expect(leaks(drill)).toEqual([]);
      const c = drill.chart;
      expect(c.candles.at(-1)!.time).toBe(drill.t0);
      const after = [...c.volume, ...Object.values(c.lines).flat(), ...c.drops, ...drill.marks].filter((p) => p.time > drill.t0);
      expect(after).toEqual([]);
      expect(JSON.stringify(drill)).not.toContain('"answer"');
      expect(JSON.stringify(drill)).not.toContain("evidence");
      if (kind === "construct") expect(Object.keys(c.lines)).toEqual([]);
    }
    // 存下来的题（依据里的日期）也已经换成 T+n
    for (const d of b.drills()) {
      expect(leaks(d)).toEqual([]);
      expect(JSON.stringify(d.evidence)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });

  test("题目那一根之后的 K 线一根都不给：和行情文件对照", async () => {
    const { b, dir } = shared;
    const { drill } = await b.next("chart");
    const d = b.drills().find((x) => x.id === drill!.id)!;
    const csv = parseCsv(readFileSync(join(dir, "windows", `${d.window}.csv`), "utf8"), "window");
    const i = csv.findIndex((x) => x.date === drill!.t0);
    expect(i).toBeGreaterThan(0);
    expect(drill!.chart.candles.at(-1)!.close).toBe(csv[i].close);
    expect(drill!.chart.candles.some((c) => c.time === csv[i + 1]?.date)).toBe(false);
  });

  test("交卷：每问都对才算对；答过的题删掉，再交一次 409；交的个数不对 400", async () => {
    const { b } = shared;
    const { drill } = await b.next("dropoff");
    const stored = b.drills().find((x) => x.id === drill!.id)!;
    const right = partsOf(stored).map((p) => p.answer);
    const fb = await b.answer(drill!.id, { picks: right, ms: 2400 });
    expect(fb.correct).toBe(true);
    expect(fb.evidence).toEqual(stored.evidence);
    expect(fb.rules.map((r) => r.id)).toEqual(stored.rules.map((r) => r.id));
    expect(fb.parts.map((p) => p.answer)).toEqual(right);
    expect(b.drills().some((x) => x.id === drill!.id)).toBe(false);
    expect(b.answers().at(-1)).toMatchObject({ drill: drill!.id, kind: "dropoff", correct: true, ms: 2400 });
    await expect(b.answer(drill!.id, { picks: right, ms: 1 })).rejects.toMatchObject({ status: 409 });

    const next = (await b.next("chart")).drill!;
    await expect(b.answer(next.id, { picks: [0, 0], ms: 1 })).rejects.toMatchObject({ status: 400 });
    await expect(b.answer(next.id, { picks: [9], ms: 1 })).rejects.toMatchObject({ status: 400 });
    const wrong = (partsOf(b.drills().find((x) => x.id === next.id)!)[0].answer + 1) % 6;
    const fb2 = await b.answer(next.id, { picks: [wrong], ms: 999_999_999 });
    expect(fb2.correct).toBe(false);
    expect(fb2.ms).toBe(600_000); // 走开了：按 10 分钟算
    expect(fb2.stats.total).toEqual({ n: 2, correct: 1, accuracy: 0.5 });
  });

  test("推演揭晓：给题时 T0 之后一根都不给；交卷后才放出之后的真实 K 线，评分按推演", async () => {
    const { b, dir } = shared;
    const { drill } = await b.next("project");
    expect(drill).not.toBeNull();
    expect(JSON.stringify(drill)).not.toContain("reveal");
    const stored = b.drills().find((x) => x.id === drill!.id)!;
    if (stored.kind !== "project") throw new Error("kind");
    const csv = parseCsv(readFileSync(join(dir, "windows", `${stored.window}.csv`), "utf8"), "window");
    const i = csv.findIndex((x) => x.date === drill!.t0);
    expect(drill!.chart.candles.some((c) => c.time > drill!.t0)).toBe(false);

    const fb = await b.answer(drill!.id, rightInput(dir, stored));
    expect(fb.correct).toBe(true); // 选推演的答案就算对，不管真实走势
    const r = fb.reveal!;
    const horizon = Math.max(...stored.reveal.parts.map((p) => (p.q === "dir" ? p.n : p.q === "cross" ? 30 : p.days)));
    expect(r.horizon).toBe(horizon);
    expect(r.level).toBe(stored.reveal.close);
    expect(r.chart.candles.map((c) => [c.time, c.close])).toEqual(csv.slice(i + 1, i + 1 + horizon).map((x) => [x.date, x.close]));
    for (const xs of [...Object.values(r.chart.lines), r.chart.volume]) expect(xs.every((p) => p.time > drill!.t0 && p.time <= r.chart.candles.at(-1)!.time)).toBe(true);
    expect(r.parts.length).toBe(stored.parts.length);
    stored.reveal.parts.forEach((p, k) => {
      if (p.q !== "turn") expect(r.parts[k].system).toBe(stored.parts[k].choices[stored.parts[k].answer]);
      expect(r.parts[k].why === null).toBe(r.parts[k].agree);
      if (!r.parts[k].agree) expect(r.parts[k].why).toContain("价格没有收平");
    });
    expect(leaks(fb)).toEqual([]);
  });

  test("五步点图：给题不给答案位置；点偏 1 根算对、2 根算错；交错格式或点到图外 400", async () => {
    const { b, dir } = shared;
    const { drill } = await b.next("steps");
    expect(drill!.parts).toEqual([]);
    expect(drill!.click!.steps.length).toBeGreaterThan(0);
    expect(JSON.stringify(drill)).not.toContain('"t":');
    const stored = b.drills().find((x) => x.id === drill!.id)!;
    if (stored.kind !== "steps") throw new Error("kind");
    expect(drill!.click!.steps).toEqual(stored.click.steps.map((s) => s.step));
    const times = windowTimes(dir, stored);
    await expect(b.answer(drill!.id, { picks: [0], ms: 1 })).rejects.toMatchObject({ status: 400 });
    await expect(b.answer(drill!.id, { clicks: [drill!.t0, drill!.t0, drill!.t0, drill!.t0, drill!.t0, drill!.t0], ms: 1 })).rejects.toMatchObject({ status: 400 });
    const outside = stored.click.steps.map(() => times[stored.index + 1] ?? "2999-01-01");
    await expect(b.answer(drill!.id, { clicks: outside, ms: 1 })).rejects.toMatchObject({ status: 400 });

    const fb = await b.answer(drill!.id, rightInput(dir, stored, 1));
    expect(fb.correct).toBe(true);
    expect(fb.steps!.map((s) => s.step)).toEqual(stored.click.steps.map((s) => s.step));
    expect(fb.steps!.map((s) => s.answer)).toEqual(stored.click.steps.map((s) => times[stored.index + s.t]));
    expect(fb.steps!.every((s) => s.ok && s.meaning && /^[AJ]\d+$/.test(s.rule))).toBe(true);
    expect(b.answers().at(-1)).toMatchObject({ kind: "steps", correct: true, answers: stored.click.steps.map((s) => s.t) });

    const { b: b2, dir: dir2 } = bank();
    await b2.fill(1);
    const other = b2.drills().find((x) => x.kind === "steps")!;
    const fb2 = await b2.answer(other.id, rightInput(dir2, other, 2));
    expect(fb2.correct).toBe(false);
    expect(fb2.steps!.every((s) => !s.ok)).toBe(true);
  }, 30_000);

  test("答完一段行情的最后一题，这段的文件删掉", async () => {
    const { b, dir } = bank();
    await b.fill(1);
    const windows = () => readdirSync(join(dir, "windows")).length;
    expect(windows()).toBe(2); // csv + json
    for (const d of b.drills()) await b.answer(d.id, rightInput(dir, d));
    expect(windows()).toBe(0);
  }, 30_000);

  test("记录文件坏了：报错，不覆盖", async () => {
    const { b, dir } = bank();
    writeFileSync(join(dir, "answers.json"), "{oops");
    expect(() => b.overview()).toThrow(/不是合法的 JSON/);
    expect(readFileSync(join(dir, "answers.json"), "utf8")).toBe("{oops");
    writeFileSync(join(dir, "answers.json"), JSON.stringify({ version: 1, answers: [{ drill: "x" }] }));
    expect(() => b.overview()).toThrow(/不合法/);
  });


  test("打法补全：类型选错，揭晓时每格写出按你选的类型该填什么；选对不写", async () => {
    const { b } = shared;
    const { drill } = await b.next("fill");
    expect(drill).not.toBeNull();
    const d = b.drills().find((x) => x.id === drill!.id)!;
    if (d.kind !== "fill") throw new Error("kind");
    const right = d.parts.map((p) => p.answer);
    const wrongType = d.parts[0].choices.findIndex((c, i) => i !== d.parts[0].answer && d.alts[i] !== null);
    expect(wrongType).toBeGreaterThanOrEqual(0);
    const fb = await b.answer(drill!.id, { picks: [wrongType, ...right.slice(1)], ms: 3000 });
    expect(fb.correct).toBe(false);
    expect(fb.fill).toEqual({ type: d.parts[0].choices[wrongType], key: keyOfRegime(d.parts[0].choices[wrongType]), cells: d.alts[wrongType]! });
    expect(fb.evidence.some((e) => e.startsWith("归雁判的类型"))).toBe(true);
    const { drill: again } = await b.next("fill");
    if (!again) return;
    const d2 = b.drills().find((x) => x.id === again.id)! as Extract<Drill, { kind: "fill" }>;
    const fb2 = await b.answer(again.id, { picks: d2.parts.map((p) => p.answer), ms: 3000 });
    expect(fb2.correct).toBe(true);
    expect(fb2.fill).toBeNull();
  });

  test("题型参数不对：400", async () => {
    await expect(shared.b.next("nope")).rejects.toMatchObject({ status: 400 });
  });

  test("页面拿到的题型和标签对得上", async () => {
    const { drill } = await shared.b.next("signal");
    if (drill) expect((drill as DrillView).label).toBe("看信号");
  });
});

describe("接口", () => {
  test("GET /api/drills、GET /api/drills/next?kind=、POST /api/drills/:id/answer", async () => {
    const { b, dir } = bank();
    await b.fill(1);
    const handler = createHandler({
      analyzer: new Analyzer(async () => { throw new Error("不该取真股票"); }), journal: new Journal(join(dir, "j.json")), drills: b,
      library: SourceLibrary.load(), publicDir: dir, watchlist: new Watchlist(join(dir, "w.json")), settings: new SettingsStore(join(dir, "s.json")),
    });
    const call = async (path: string, body?: unknown) => {
      const res = await handler(new Request(`http://x${path}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }));
      return { status: res.status, data: await res.json() };
    };
    const o = await call("/api/drills");
    expect(o.status).toBe(200);
    expect(Object.keys(o.data.counts)).toEqual([...KINDS]);
    const n = await call("/api/drills/next?kind=construct");
    expect(n.data.drill.kind).toBe("construct");
    const stored = b.drills().find((x) => x.id === n.data.drill.id)!;
    const a = await call(`/api/drills/${n.data.drill.id}/answer`, { picks: partsOf(stored).map((p) => p.answer), ms: 1500 });
    expect(a.status).toBe(200);
    expect(a.data.correct).toBe(true);
    expect((await call(`/api/drills/${n.data.drill.id}/answer`, { picks: [0], ms: 1 })).status).toBe(409);
    expect((await call("/api/drills/next?kind=bogus")).status).toBe(400);
    expect((await call("/api/drills/next")).data.drill).not.toBeNull(); // 不指定题型：按弱项挑
  }, 30_000);
});

describe("看图题的依据：加速说的是出现在趋势哪一头，不和阶段打架", () => {
  test("NVDA 加速下跌·延伸、加速起点：依据写「出现在趋势刚开始」，不写裸的「起点」", () => {
    const a = nvda as Analysis;
    const [d] = GENERATORS.chart({ a, dates: [], rand: seeded(1) });
    expect(picked(d)).toBe("加速下跌·延伸");
    expect(d.evidence).toContain("加速：按乖离判，出现在趋势刚开始");
    expect(d.evidence.join("\n")).not.toContain("在起点");
  });
});

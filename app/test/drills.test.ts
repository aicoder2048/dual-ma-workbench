import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Analysis } from "../src/citations.ts";
import { buildPlans } from "../src/plan.ts";
import { entryStateOf } from "../src/practice/discipline.ts";
import { parseCsv, rebase, toCsv } from "../src/practice/blind.ts";
import {
  DROPOFF_CHOICES, GENERATORS, KINDS, PLAY_CHOICES, playClass, REGIME_NAMES, SIGNAL_CHOICES, STOP_CHOICES, TWO_B_CHOICES,
  type Draft, type Kind,
} from "../src/practice/drillkinds.ts";
import { admit, DrillBank, scanRunner, type DrillView } from "../src/practice/drills.ts";
import { seeded } from "../src/practice/pool.ts";
import { Analyzer } from "../src/analyze.ts";
import { createHandler } from "../src/http.ts";
import { Journal } from "../src/journal.ts";
import { SettingsStore } from "../src/settings.ts";
import { PROJECT_ROOT, SourceLibrary } from "../src/sources.ts";
import { Watchlist } from "../src/watchlist.ts";
import { prices, REAL, REAL_TICKER } from "./fixtures/practice-prices.ts";

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
const picked = (d: Draft, part = 0) => d.parts[part].choices[d.parts[part].answer];

describe("出题函数：答案就是分析里的字段", () => {
  test("每种题都出得来，每道题的答案在选项里、选项不重复", () => {
    for (const kind of KINDS) {
      const ds = draftsOf(kind);
      expect({ kind, some: ds.length > 0 }).toEqual({ kind, some: true });
      for (const { d } of ds) {
        expect(d.kind).toBe(kind);
        for (const p of d.parts) {
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
      expect(d.parts[0].choices.length).toBe(6);
      expect(d.parts[0].choices.every((c) => (REGIME_NAMES as readonly string[]).includes(c))).toBe(true);
      expect(d.hint).toContain(a.regime.clock60.hour);
    }
  });

  test("看信号：答案 = 20/60 这次转折里日期是这一根的、最靠后的进度点；没有就是「都不是」", () => {
    const order = ["破线", "EMA 拐头", "MA 拐头", "第一个交叉", "双交叉"];
    const ds = draftsOf("signal");
    for (const { a, d } of ds) {
      const today = a.steps[0].current!.steps.filter((s) => s.date === a.date).map((s) => order.indexOf(s.step));
      expect(picked(d)).toBe(today.length ? order[Math.max(...today)] : "都不是");
      expect(d.parts[0].choices).toEqual([...SIGNAL_CHOICES]);
      expect(d.marks).toEqual([{ t: 0, text: "这根" }]);
    }
    expect(ds.some(({ d }) => d.cls !== "都不是")).toBe(true);
  });

  test("看抵扣价：方向 = drops 的 direction；门槛 = MA20 门槛路径的最高价", () => {
    for (const { a, d } of draftsOf("dropoff")) {
      const dir = (n: number) => a.drops.find((x) => x.period === n)!.direction;
      expect(picked(d)).toBe(`MA20 ${dir(20)}、MA60 ${dir(60)}`);
      expect(d.parts[0].choices).toEqual([...DROPOFF_CHOICES]);
      if (d.parts[1]) expect(picked(d, 1)).toBe(a.projection.hurdles.find((h) => h.period === 20)!.max_price.toFixed(2));
    }
  });

  test("看构造：状态 = structure 里那一侧的 state；下一根 = complete_at；2B 跟 J26 的状态走", () => {
    const ds = draftsOf("construct");
    for (const { a, d } of ds) {
      const s = a.structure;
      if (d.cls.startsWith("状态:")) {
        const k = d.parts[0].prompt.includes("顶部构造") ? s.top! : s.bottom!;
        expect(picked(d)).toBe(k.state);
      } else if (d.cls === "下一根") {
        const k = d.parts[0].prompt.startsWith("顶部构造") ? s.top! : s.bottom!;
        expect(picked(d)).toBe(k.complete_at!.toFixed(2));
      } else {
        const j = a.rules.find((r) => r.id === "J26")!;
        expect(picked(d)).toBe(j.status === "满足" ? j.basis.slice(0, 4) : "没有");
        expect(d.parts[0].choices).toEqual([...TWO_B_CHOICES]);
      }
      expect(d.view.lines).toBe(false); // 只看 K 线
    }
    expect(new Set(ds.map(({ d }) => d.cls.split(":")[0])).size).toBeGreaterThanOrEqual(2);
  });

  test("看打法：打法类别跟回测打法的进场条件走；止损 = 空仓计划的止损", () => {
    for (const { a, d } of draftsOf("play")) {
      expect(picked(d)).toBe(playClass(a)!);
      expect(picked(d)).not.toBe("反弹卖");
      expect(d.parts[0].choices).toEqual([...PLAY_CHOICES]);
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
    const right = stored.parts.map((p) => p.answer);
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
    const wrong = (b.drills().find((x) => x.id === next.id)!.parts[0].answer + 1) % 6;
    const fb2 = await b.answer(next.id, { picks: [wrong], ms: 999_999_999 });
    expect(fb2.correct).toBe(false);
    expect(fb2.ms).toBe(600_000); // 走开了：按 10 分钟算
    expect(fb2.stats.total).toEqual({ n: 2, correct: 1, accuracy: 0.5 });
  });

  test("答完一段行情的最后一题，这段的文件删掉", async () => {
    const { b, dir } = bank();
    await b.fill(1);
    const windows = () => readdirSync(join(dir, "windows")).length;
    expect(windows()).toBe(2); // csv + json
    for (const d of b.drills()) await b.answer(d.id, { picks: d.parts.map((p) => p.answer), ms: 1 });
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
    const a = await call(`/api/drills/${n.data.drill.id}/answer`, { picks: stored.parts.map((p) => p.answer), ms: 1500 });
    expect(a.status).toBe(200);
    expect(a.data.correct).toBe(true);
    expect((await call(`/api/drills/${n.data.drill.id}/answer`, { picks: [0], ms: 1 })).status).toBe(409);
    expect((await call("/api/drills/next?kind=bogus")).status).toBe(400);
    expect((await call("/api/drills/next")).data.drill).not.toBeNull(); // 不指定题型：按弱项挑
  }, 30_000);
});

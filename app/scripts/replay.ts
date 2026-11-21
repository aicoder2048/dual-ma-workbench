/**
 * 回放验证：在历史日期上生成当时的判断和空仓计划，对照之后 20 个交易日的真实走势。
 *
 *   cd app && bun scripts/replay.ts [NVDA TSLA ...] [--years 2] [--step 20] [--horizon 20] [--jobs 6] [--refresh]
 *                                   [--compare reports/replay/<改造前>.json]
 *
 * 每只票取一次日线（yfinance 开高低收量，只按拆股复权，只取到昨天，存 reports/replay/data/<票>.csv），取数交给
 * skill 的 backtest.py --fetch-only（缓存覆盖不到所需历史、超过 7 天没更新、或给了 --refresh 就重新取）。
 * 每个回放点切出"当天往前 5 年"交给 dma_analyze.py --csv --asof --json，和工作台实时取数一样（日线看最近 3 年，周线用 5 年）。
 * 报告写到 reports/replay/<今天>-20d.md（不进仓库）；--compare 给另一次回放的样本 JSON，报告末尾加一节前后对照。
 * 逐笔回测（按打法进出场、和买入持有比）在 backtest.py，报告是 reports/replay/<今天>.md。
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { SCRIPT } from "../src/analyze.ts";
import type { Analysis } from "../src/citations.ts";
import { buildPlans, ma20Claim, playKey } from "../src/plan.ts";
import { forwardOutcome, ma20Check, renderCompare, renderReport, summarize, type Bar, type Sample } from "../src/replay.ts";
import { PROJECT_ROOT } from "../src/sources.ts";

const pexec = promisify(execFile);
/** 空仓进场条件是"站上 EMA20 + MA20 抵扣价"的打法（plan.ts 的 BUY_TURN）。 */
const BUY_TURN_PLAYS = ["稳定下跌", "加速下跌"];
const OUT = resolve(PROJECT_ROOT, "reports/replay");
const DATA = resolve(OUT, "data");
const CUT = resolve(OUT, "cut");
const HISTORY_YEARS = 5; // 和 dma_analyze.py 的 HISTORY_YEARS（实时取数、周线用的历史）一致
const DAILY_YEARS = 3; // dma_analyze.py 的 DAILY_YEARS（日线分析窗口）

const DEFAULT = ["NVDA", "TSLA", "AAPL", "GOOG", "META", "MSFT", "AMZN", "SPY", "QQQ"];
const argv = process.argv.slice(2);
const VALUED = ["years", "step", "horizon", "jobs", "compare"];
const opt = (name: string, d: number, min: number) => {
  const i = argv.indexOf(`--${name}`);
  const v = i < 0 ? d : Number(argv[i + 1]);
  if (!Number.isFinite(v) || v < min) throw new Error(`--${name} 要一个 ≥ ${min} 的数，收到 ${argv[i + 1]}`);
  return v;
};
const tickers = argv.filter((a, i) => !a.startsWith("--") && !VALUED.includes(argv[i - 1]?.slice(2) ?? ""));
const TICKERS = tickers.length ? tickers.map((t) => t.toUpperCase()) : DEFAULT;
// horizon 至少 5：MA20 推演看 5 天后
const YEARS = opt("years", 2, 0.1), STEP = opt("step", 20, 1), HORIZON = opt("horizon", 20, 5), JOBS = opt("jobs", 6, 1);
const REFRESH = argv.includes("--refresh");
const COMPARE = argv.includes("--compare") ? argv[argv.indexOf("--compare") + 1] : null;
const BACKTEST = resolve(SCRIPT, "../backtest.py");

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** 需要的最早一天：最早的回放点再往前 3 年（留 10 天余量）。 */
const NEED_FROM = iso(Date.now() - (YEARS * 366 + HISTORY_YEARS * 366 + 10) * DAY);
const MIN_ROWS = Math.round((YEARS + HISTORY_YEARS) * 240);

function parse(csv: string): { rows: string[]; bars: Bar[] } {
  const [head, ...rows] = readFileSync(csv, "utf8").trim().split("\n");
  const col = head.split(",").indexOf("Close");
  if (!head.startsWith("Date") || col < 0) throw new Error(`${csv} 格式不对：${head}`);
  const bars = rows.map((r) => {
    const cells = r.split(",");
    return { date: cells[0].slice(0, 10), close: Number(cells[col]) };
  });
  if (bars.some((b) => !Number.isFinite(b.close))) throw new Error(`${csv} 里有不是数字的收盘价`);
  return { rows: [head, ...rows], bars };
}

/** 取日线：backtest.py --fetch-only 决定用缓存还是重取（结构判断要最高价、最低价，缓存只有收盘价也会重取）。 */
async function load(t: string): Promise<{ rows: string[]; bars: Bar[] }> {
  await pexec("uv", ["run", "--quiet", "--script", BACKTEST, "--fetch-only", "--history-from", NEED_FROM, "--data", DATA,
    ...(REFRESH ? ["--refresh"] : []), t], { cwd: PROJECT_ROOT });
  const got = parse(resolve(DATA, `${t}.csv`));
  if (got.bars.length < MIN_ROWS) throw new Error(`${t}：只有 ${got.bars.length} 根日线，至少要 ${MIN_ROWS} 根`);
  return got;
}

/** 第 i 天的分析：切出当天往前 5 年的 CSV，交给 dma_analyze.py。 */
async function analyzeAt(t: string, rows: string[], bars: Bar[], i: number): Promise<Analysis> {
  const date = bars[i].date;
  const yearsBack = (n: number) => {
    const d = new Date(date);
    d.setFullYear(d.getFullYear() - n);
    return d.toISOString().slice(0, 10);
  };
  const cut = resolve(CUT, `${t}-${date}.csv`);
  const kept = rows.slice(1).filter((r) => r.slice(0, 10) >= yearsBack(HISTORY_YEARS) && r.slice(0, 10) <= date);
  // 日线不够 3 年就停：乖离率分位会被短历史带偏，和工作台不一致
  const lo = yearsBack(DAILY_YEARS);
  if (!kept.length || kept[0].slice(0, 10) > iso(Date.parse(lo) + 7 * DAY)) throw new Error(`${t} ${date}：历史从 ${kept[0]?.slice(0, 10)} 起，不够 ${DAILY_YEARS} 年`);
  writeFileSync(cut, [rows[0], ...kept].join("\n"));
  const { stdout } = await pexec("uv", ["run", "--quiet", "--script", SCRIPT, "--csv", cut, "--asof", date, "--json"],
    { cwd: PROJECT_ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 90_000 });
  return (JSON.parse(stdout) as { analysis: Analysis }).analysis;
}

/** 并发跑，最多 jobs 个同时进行。 */
async function pool<T, R>(xs: T[], jobs: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  await Promise.all(Array.from({ length: jobs }, async () => {
    while (next < xs.length) {
      const k = next++;
      out[k] = await f(xs[k]);
    }
  }));
  return out;
}

mkdirSync(DATA, { recursive: true });
mkdirSync(CUT, { recursive: true });
const series = new Map(await Promise.all(TICKERS.map(async (t) => [t, await load(t)] as const)));

// 回放点：最近 YEARS 年里每 STEP 个交易日一个，留出之后 HORIZON 天看结果
const points = [...series].flatMap(([t, { bars }]) => {
  const last = bars.length - 1 - HORIZON;
  const first = Math.max(bars.length - 1 - Math.round(YEARS * 252), 0);
  const idx: number[] = [];
  for (let i = last; i >= first; i -= STEP) idx.push(i);
  return idx.reverse().map((i) => ({ t, i }));
});
console.error(`回放 ${TICKERS.length} 只票、${points.length} 个点，并发 ${JOBS}……`);

let done = 0;
const samples = (await pool(points, JOBS, async ({ t, i }): Promise<Sample | null> => {
  const { rows, bars } = series.get(t)!;
  const o = forwardOutcome(bars, i, HORIZON);
  if (!o) return null;
  const a = await analyzeAt(t, rows, bars, i);
  if (a.date !== bars[i].date) throw new Error(`${t} ${bars[i].date}：分析日期对不上（${a.date}）`);
  const flat = buildPlans(a).flat;
  if (++done % 20 === 0) console.error(`  ${done}/${points.length}`);
  return {
    ticker: t, date: a.date, lean: a.lean.label, score: a.lean.score, play: playKey(a), stage: a.regime.stage, flat: flat.action,
    buyTurn: BUY_TURN_PLAYS.includes(playKey(a)),
    ma20: ma20Check(bars.map((b) => b.close), i, ma20Claim(a)),
    ...o,
  };
})).filter((s): s is Sample => s !== null);

if (!samples.length) throw new Error("一个回放点都没有：检查股票代码和数据");
const dates = samples.map((s) => s.date).sort();
const meta = { tickers: TICKERS, from: dates[0], to: dates.at(-1)!, horizon: HORIZON, source: "yfinance 日线，只按拆股复权（每个点只用当天往前 3 年）" };
let md = renderReport(summarize(samples), meta);
if (COMPARE) md += "\n" + renderCompare(JSON.parse(readFileSync(resolve(COMPARE), "utf8")) as Sample[], samples, HORIZON);
const file = resolve(OUT, `${new Date().toISOString().slice(0, 10)}-20d.md`);
writeFileSync(file, md);
writeFileSync(file.replace(/\.md$/, ".json"), JSON.stringify(samples, null, 1));
console.log(md);
console.error(`报告：${file}`);

/**
 * 回放验证：在历史日期上生成当时的判断和空仓计划，对照之后 20 个交易日的真实走势。
 *
 *   cd app && bun scripts/replay.ts [NVDA TSLA ...] [--years 2] [--step 20] [--horizon 20] [--jobs 6]
 *
 * 每只票只取一次日线（yfinance 复权，存 reports/replay/data/<票>.csv），每个回放点切出"当天往前 3 年"交给
 * dma_analyze.py --csv --asof --json，和工作台实时取数的历史长度一致。报告写到 reports/replay/<今天>.md（不进仓库）。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { SCRIPT } from "../src/analyze.ts";
import type { Analysis } from "../src/citations.ts";
import { buildPlans, playKey } from "../src/plan.ts";
import { forwardOutcome, renderReport, summarize, type Bar, type Sample } from "../src/replay.ts";
import { PROJECT_ROOT } from "../src/sources.ts";

const pexec = promisify(execFile);
/** 空仓进场条件是"站上 EMA20 + MA20 抵扣价"的打法（plan.ts 的 BUY_TURN）。 */
const BUY_TURN_PLAYS = ["健康下跌", "极度超卖"];
const OUT = resolve(PROJECT_ROOT, "reports/replay");
const DATA = resolve(OUT, "data");
const CUT = resolve(OUT, "cut");
const HISTORY_YEARS = 3; // 和 dma_analyze.py 的 HISTORY_YEARS 一致

const DEFAULT = ["NVDA", "TSLA", "AAPL", "GOOG", "META", "MSFT", "AMZN", "SPY", "QQQ"];
const argv = process.argv.slice(2);
const opt = (name: string, d: number) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? d : Number(argv[i + 1]);
};
const tickers = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const TICKERS = tickers.length ? tickers.map((t) => t.toUpperCase()) : DEFAULT;
const YEARS = opt("years", 2), STEP = opt("step", 20), HORIZON = opt("horizon", 20), JOBS = opt("jobs", 6);

const FETCH = `
import sys, yfinance as yf, pandas as pd
t, out, years = sys.argv[1], sys.argv[2], float(sys.argv[3])
start = (pd.Timestamp.today() - pd.DateOffset(days=int(years * 366))).strftime("%Y-%m-%d")
df = yf.download(t, start=start, auto_adjust=True, progress=False)
if isinstance(df.columns, pd.MultiIndex):
    df.columns = df.columns.get_level_values(0)
df = df[["Close", "Volume"]].dropna()
df.index.name = "Date"
df.to_csv(out)
`;

/** 取日线（有缓存就用缓存）：回放年数 + 3 年历史 + 一点余量。 */
async function load(t: string): Promise<{ csv: string; rows: string[]; bars: Bar[] }> {
  const csv = resolve(DATA, `${t}.csv`);
  if (!existsSync(csv)) {
    await pexec("uv", ["run", "--quiet", "--with", "yfinance", "--with", "pandas", "python", "-c", FETCH, t, csv, String(YEARS + HISTORY_YEARS + 0.2)]);
  }
  const [head, ...rows] = readFileSync(csv, "utf8").trim().split("\n");
  if (!head.startsWith("Date")) throw new Error(`${csv} 格式不对：${head}`);
  const bars = rows.map((r) => {
    const [date, close] = r.split(",");
    return { date: date.slice(0, 10), close: Number(close) };
  });
  return { csv, rows: [head, ...rows], bars };
}

/** 第 i 天的分析：切出当天往前 3 年的 CSV，交给 dma_analyze.py。 */
async function analyzeAt(t: string, rows: string[], bars: Bar[], i: number): Promise<Analysis> {
  const date = bars[i].date;
  const from = new Date(date);
  from.setFullYear(from.getFullYear() - HISTORY_YEARS);
  const lo = from.toISOString().slice(0, 10);
  const cut = resolve(CUT, `${t}-${date}.csv`);
  writeFileSync(cut, [rows[0], ...rows.slice(1).filter((r) => r.slice(0, 10) >= lo && r.slice(0, 10) <= date)].join("\n"));
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
    ticker: t, date: a.date, lean: a.lean.label, score: a.lean.score, play: playKey(a), flat: flat.action,
    buyTurn: BUY_TURN_PLAYS.includes(playKey(a)),
    ...o,
  };
})).filter((s): s is Sample => s !== null);

const dates = samples.map((s) => s.date).sort();
const md = renderReport(summarize(samples), {
  tickers: TICKERS, from: dates[0], to: dates.at(-1)!, horizon: HORIZON, source: "yfinance 复权日线（每个点只用当天往前 3 年）",
});
const file = resolve(OUT, `${new Date().toISOString().slice(0, 10)}.md`);
writeFileSync(file, md);
writeFileSync(file.replace(/\.md$/, ".json"), JSON.stringify(samples, null, 1));
console.log(md);
console.error(`报告：${file}`);

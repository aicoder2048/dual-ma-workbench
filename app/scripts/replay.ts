/**
 * 回放验证：在历史日期上生成当时的判断和空仓计划，对照之后 20 个交易日的真实走势。
 *
 *   cd app && bun scripts/replay.ts [NVDA TSLA ...] [--years 2] [--step 20] [--horizon 20] [--jobs 6] [--refresh]
 *
 * 每只票取一次日线（yfinance 复权，只取到昨天，存 reports/replay/data/<票>.csv）；缓存覆盖不到所需历史、
 * 超过 7 天没更新、或给了 --refresh 就重新取。每个回放点切出"当天往前 3 年"交给
 * dma_analyze.py --csv --asof --json，和工作台实时取数的历史长度一致。报告写到 reports/replay/<今天>.md（不进仓库）。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { SCRIPT } from "../src/analyze.ts";
import type { Analysis } from "../src/citations.ts";
import { buildPlans, ma20Claim, playKey } from "../src/plan.ts";
import { forwardOutcome, ma20Check, renderReport, summarize, type Bar, type Sample } from "../src/replay.ts";
import { PROJECT_ROOT } from "../src/sources.ts";

const pexec = promisify(execFile);
/** 空仓进场条件是"站上 EMA20 + MA20 抵扣价"的打法（plan.ts 的 BUY_TURN）。 */
const BUY_TURN_PLAYS = ["健康下跌", "极度超卖"];
const OUT = resolve(PROJECT_ROOT, "reports/replay");
const DATA = resolve(OUT, "data");
const CUT = resolve(OUT, "cut");
const HISTORY_YEARS = 3; // 和 dma_analyze.py 的 DAILY_YEARS（日线分析窗口）一致

const DEFAULT = ["NVDA", "TSLA", "AAPL", "GOOG", "META", "MSFT", "AMZN", "SPY", "QQQ"];
const argv = process.argv.slice(2);
const VALUED = ["years", "step", "horizon", "jobs"];
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

// end 取今天（不含）：只要已经收盘的日线。行数不够（限流、代码写错时 yfinance 常常不报错、只给空表）就报错，不写缓存。
const FETCH = `
import sys, yfinance as yf, pandas as pd
t, out, start, min_rows = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
df = yf.download(t, start=start, end=pd.Timestamp.today().strftime("%Y-%m-%d"), auto_adjust=True, progress=False)
if isinstance(df.columns, pd.MultiIndex):
    df.columns = df.columns.get_level_values(0)
df = df[["Close", "Volume"]].dropna() if len(df) else df
if len(df) < min_rows:
    sys.exit(f"{t}：只取到 {len(df)} 根日线，至少要 {min_rows} 根")
df.index.name = "Date"
df.to_csv(out)
`;

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** 需要的最早一天：最早的回放点再往前 3 年（留 10 天余量）。 */
const NEED_FROM = iso(Date.now() - (YEARS * 366 + HISTORY_YEARS * 366 + 10) * DAY);
const MIN_ROWS = Math.round((YEARS + HISTORY_YEARS) * 240);

function parse(csv: string): { rows: string[]; bars: Bar[] } {
  const [head, ...rows] = readFileSync(csv, "utf8").trim().split("\n");
  if (!head.startsWith("Date")) throw new Error(`${csv} 格式不对：${head}`);
  const bars = rows.map((r) => {
    const [date, close] = r.split(",");
    return { date: date.slice(0, 10), close: Number(close) };
  });
  if (bars.some((b) => !Number.isFinite(b.close))) throw new Error(`${csv} 里有不是数字的收盘价`);
  return { rows: [head, ...rows], bars };
}

/** 取日线：缓存覆盖得到、7 天内更新过、没给 --refresh，就用缓存；否则重新取。 */
async function load(t: string): Promise<{ rows: string[]; bars: Bar[] }> {
  const csv = resolve(DATA, `${t}.csv`);
  if (!REFRESH && existsSync(csv)) {
    const got = parse(csv);
    const first = got.bars[0]?.date ?? "9999", last = got.bars.at(-1)?.date ?? "0000";
    if (first <= iso(Date.parse(NEED_FROM) + 7 * DAY) && last >= iso(Date.now() - 7 * DAY) && got.bars.length >= MIN_ROWS) return got;
    console.error(`${t}：缓存 ${first} ~ ${last}（${got.bars.length} 根）不够用，重新取`);
  }
  await pexec("uv", ["run", "--quiet", "--with", "yfinance", "--with", "pandas", "python", "-c", FETCH, t, csv, NEED_FROM, String(MIN_ROWS)]);
  return parse(csv);
}

/** 第 i 天的分析：切出当天往前 3 年的 CSV，交给 dma_analyze.py。 */
async function analyzeAt(t: string, rows: string[], bars: Bar[], i: number): Promise<Analysis> {
  const date = bars[i].date;
  const from = new Date(date);
  from.setFullYear(from.getFullYear() - HISTORY_YEARS);
  const lo = from.toISOString().slice(0, 10);
  const cut = resolve(CUT, `${t}-${date}.csv`);
  const kept = rows.slice(1).filter((r) => r.slice(0, 10) >= lo && r.slice(0, 10) <= date);
  // 历史不够 3 年就停：乖离率分位会被短历史带偏，和工作台不一致
  if (!kept.length || kept[0].slice(0, 10) > iso(Date.parse(lo) + 7 * DAY)) throw new Error(`${t} ${date}：历史从 ${kept[0]?.slice(0, 10)} 起，不够 ${HISTORY_YEARS} 年`);
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
    ticker: t, date: a.date, lean: a.lean.label, score: a.lean.score, play: playKey(a), flat: flat.action,
    buyTurn: BUY_TURN_PLAYS.includes(playKey(a)),
    ma20: ma20Check(bars.map((b) => b.close), i, ma20Claim(a)),
    ...o,
  };
})).filter((s): s is Sample => s !== null);

if (!samples.length) throw new Error("一个回放点都没有：检查股票代码和数据");
const dates = samples.map((s) => s.date).sort();
const md = renderReport(summarize(samples), {
  tickers: TICKERS, from: dates[0], to: dates.at(-1)!, horizon: HORIZON, source: "yfinance 复权日线（每个点只用当天往前 3 年）",
});
const file = resolve(OUT, `${new Date().toISOString().slice(0, 10)}.md`);
writeFileSync(file, md);
writeFileSync(file.replace(/\.md$/, ".json"), JSON.stringify(samples, null, 1));
console.log(md);
console.error(`报告：${file}`);

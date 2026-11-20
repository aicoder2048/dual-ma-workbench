/**
 * 出题范围：EVALUATION_PLAN 2.1 的指数 / ETF 和大盘股（2016 年初市值靠前的，加上之后大跌的），
 * 抽一只票、再在它的历史里抽一天：之前至少 5 年、之后至少半年（HORIZON 根）。可以给种子，测试用。
 */
import type { Bar } from "./blind.ts";

/** since：从哪天开始取日线（yfinance）。晚上市的票写上市后的日子，免得取数时嫌"根数不够"。 */
export interface PoolEntry { ticker: string; since?: string }

const ETF = "SPY QQQ IWM DIA XLK XLF XLE XLV XLY XLP XLI XLB XLU EFA EEM GLD TLT IEF".split(" ");
const STOCKS = ("AAPL MSFT GOOG AMZN XOM JNJ GE WFC JPM BRK-B T PG WMT CVX VZ PFE KO ORCL MRK INTC CSCO HD DIS PEP BAC C IBM "
  + "CMCSA MO AMGN MDT UNH GILD MMM BA NKE WBA VFC").split(" ");
const LATE: PoolEntry[] = [
  { ticker: "XLRE", since: "2016-01-01" }, { ticker: "XLC", since: "2018-07-01" }, { ticker: "SLV", since: "2006-06-01" },
  { ticker: "USO", since: "2006-05-01" }, { ticker: "HYG", since: "2007-05-01" }, { ticker: "UUP", since: "2007-04-01" },
  { ticker: "META", since: "2012-06-01" }, { ticker: "V", since: "2008-04-01" }, { ticker: "MA", since: "2006-06-01" },
  { ticker: "ABBV", since: "2013-02-01" }, { ticker: "PYPL", since: "2015-08-01" },
];
export const POOL: PoolEntry[] = [...[...ETF, ...STOCKS].map((ticker) => ({ ticker })), ...LATE];
export const DEFAULT_SINCE = "2006-01-01";

/** 开局之前要有几年、之后要有几根。5 年和工作台实时取数一样：日线分析看最近 3 年，周线用 5 年。 */
export const HISTORY_YEARS = 5;
export const HORIZON = 126;

/** 确定的伪随机数（mulberry32），同一个种子出同一道题。 */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pickTicker = (pool: PoolEntry[], rand: () => number) => pool[Math.floor(rand() * pool.length)];

const yearsBefore = (d: string, n: number) => `${Number(d.slice(0, 4)) - n}${d.slice(4)}`;

/** 开局位置：之前至少 HISTORY_YEARS 年、之后至少 HORIZON 根。没有这样的日子返回 null。 */
export function pickStart(bars: Bar[], rand: () => number): number | null {
  const lo = bars.findIndex((b) => yearsBefore(b.date, HISTORY_YEARS) >= bars[0].date);
  const hi = bars.length - 1 - HORIZON;
  if (lo < 0 || hi < lo) return null;
  return lo + Math.floor(rand() * (hi - lo + 1));
}

/** 练习数据从哪一根开始：开局往前 HISTORY_YEARS 年（和工作台实时取数一样）。 */
export function windowStart(bars: Bar[], start: number): number {
  const from = yearsBefore(bars[start].date, HISTORY_YEARS);
  return bars.findIndex((b) => b.date >= from);
}

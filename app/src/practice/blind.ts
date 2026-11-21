/**
 * 盲测练习的"蒙眼"：价格换算成指数、日期整周平移、对外的日期一律写成相对交易日（T+12）。
 *
 * - 价格乘一个系数，让第一根收盘 = 100；成交量也乘一个系数（开局前平均 = 100 万）。均线、抵扣价、规则都是
 *   线性的或者比例，结论不变（skill 的 tests/test_rebase.py 用真实行情验证过）。
 * - 日期往后挪整数周，落在 2200 年附近：星期几、节假日空档都不变，周线和真实的一样分组。
 *   挪过的日期只在服务端和 Python 之间用；给页面、agent、日志的都换成 T+n。
 */

/** 练习的一题在工作台里的"代码"。长风传进来时可能少了空格或 #，都认。 */
export const labelOf = (no: number) => `练习 #${no}`;
export const PRACTICE_LABEL = /^\s*练习\s*#?\s*(\d{1,6})\s*$/;
export const isPracticeLabel = (ticker: string | null | undefined) => PRACTICE_LABEL.test(ticker ?? "");

export interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number }

const DAY_MS = 86_400_000;
/** 平移后的开局日落在这一周。 */
const ANCHOR = Date.UTC(2200, 0, 1);
/** 第一根收盘换算成多少。 */
export const INDEX_BASE = 100;
const VOLUME_BASE = 1_000_000;

export const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const addDays = (d: string, n: number) => new Date(utc(d) + n * DAY_MS).toISOString().slice(0, 10);

/** 开局日挪到 2200 年第一周要挪几天：7 的整数倍。 */
export function shiftFor(start: string): number {
  return Math.round((ANCHOR - utc(start)) / (7 * DAY_MS)) * 7;
}

export interface Rebased { bars: Bar[]; priceFactor: number; shiftDays: number }

/**
 * 真实日线 → 练习用的日线。start：开局那根在 bars 里的位置。
 * priceFactor：真实价格 = 指数 × priceFactor（揭晓时换回去）。
 */
export function rebase(bars: Bar[], start: number): Rebased {
  if (start < 1 || start >= bars.length) throw new Error(`开局位置不对：${start}/${bars.length}`);
  const priceFactor = bars[0].close / INDEX_BASE;
  const before = bars.slice(0, start);
  const meanVol = before.reduce((s, b) => s + b.volume, 0) / before.length || 1;
  const shiftDays = shiftFor(bars[start].date);
  const px = (x: number) => Math.round((x / priceFactor) * 1e4) / 1e4;
  return {
    priceFactor,
    shiftDays,
    bars: bars.map((b) => ({
      date: addDays(b.date, shiftDays),
      open: px(b.open), high: px(b.high), low: px(b.low), close: px(b.close),
      volume: Math.round((b.volume / meanVol) * VOLUME_BASE),
    })),
  };
}

export function toCsv(bars: Bar[]): string {
  return ["Date,Open,High,Low,Close,Volume", ...bars.map((b) => `${b.date},${b.open},${b.high},${b.low},${b.close},${b.volume}`)].join("\n") + "\n";
}

/** 按表头读 Date/Open/High/Low/Close/Volume（列的顺序不管）。 */
export function parseCsv(text: string, what: string): Bar[] {
  const [head, ...rows] = text.trim().split("\n");
  const cols = head.split(",");
  const at = (name: string) => {
    const i = cols.indexOf(name);
    if (i < 0) throw new Error(`${what} 缺 ${name} 列：${head}`);
    return i;
  };
  const [d, o, h, l, c, v] = ["Date", "Open", "High", "Low", "Close", "Volume"].map(at);
  const bars = rows.map((r) => {
    const x = r.split(",");
    return { date: x[d].slice(0, 10), open: Number(x[o]), high: Number(x[h]), low: Number(x[l]), close: Number(x[c]), volume: Number(x[v]) };
  });
  const bad = bars.find((b) => ![b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite));
  if (bad) throw new Error(`${what} 在 ${bad.date} 有不是数字的值`);
  return bars;
}

/** 相对交易日：开局那天 T0，之后 T+1，之前 T-1。 */
export const tLabel = (k: number) => (k === 0 ? "T0" : k > 0 ? `T+${k}` : `T${k}`);

/** "T+5"、"T5"、"T-3"、"T0" → 数字；写错返回 null。 */
export function parseT(s: string): number | null {
  const m = s.trim().toUpperCase().match(/^T\s*([+-]?)\s*(\d{1,4})$/);
  if (!m) return null;
  return m[1] === "-" ? -Number(m[2]) : Number(m[2]);
}

function weekdaysBetween(from: string, to: string): number {
  let n = 0;
  for (let t = utc(from) + DAY_MS; t <= utc(to); t += DAY_MS) {
    const w = new Date(t).getUTCDay();
    if (w !== 0 && w !== 6) n++;
  }
  return n;
}

/**
 * 平移后的日期 → T+n。dates：练习日线的日期；start：开局那根；upTo：只用到这一根为止的日历。
 * 晚于 upTo 的日期（推演的未来几天）按工作日数，和 Python 的 bdate 一样，不看之后真实的 K 线。
 */
export function labeler(dates: string[], start: number, upTo: number): (d: string) => string {
  const last = dates[upTo];
  return (d) => {
    if (d > last) return tLabel(upTo - start + weekdaysBetween(last, d));
    let lo = 0, hi = upTo;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (dates[mid] <= d) lo = mid; else hi = mid - 1;
    }
    return tLabel(lo - start);
  };
}

/**
 * 练习拿到的分析里去掉财报日：财报日是真实日期，平移不掉，几次财报的间隔就能认出是哪只票。
 * Python 那边 --csv 本来就不取，这里再拿掉一次，不靠那边的约定。
 */
export function blindAnalysis<A extends { earnings?: unknown }>(a: A): Omit<A, "earnings"> {
  const { earnings: _, ...rest } = a;
  return rest;
}

/** 把一份 JSON 里所有字符串中的日期换掉（对象、数组逐层走；数字、布尔不动）。 */
export function relabel<T>(value: T, fn: (date: string) => string): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.replace(DATE_RE, fn);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

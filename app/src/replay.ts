/**
 * 回放验证的评估逻辑（纯函数）：拿历史某天的判断，对照之后 horizon 个交易日的真实走势。
 * 取数、跑 dma_analyze.py 在 scripts/replay.ts；这里只算和汇总，方便单元测试。
 */
import type { LeanLabel } from "./citations.ts";

export interface Bar { date: string; close: number }

/** 和 pandas ewm(span=n, adjust=False) 一样：第一天等于收盘，之后按 alpha = 2/(n+1) 递推。 */
export function ema(closes: number[], n: number): number[] {
  const k = 2 / (n + 1);
  const out: number[] = [];
  closes.forEach((c, i) => out.push(i === 0 ? c : out[i - 1] + k * (c - out[i - 1])));
  return out;
}

const ma20At = (closes: number[], i: number) => closes.slice(i - 19, i + 1).reduce((x, y) => x + y, 0) / 20;

export interface Outcome {
  /** 之后 horizon 天的收益（小数）。 */
  ret: number;
  /** 5 天后 MA20 比当天高（1）、低（-1）、一样（0）。 */
  ma20Dir5: -1 | 0 | 1;
  /** 进场条件（收盘站上前一天的 EMA20，且高于 MA20 抵扣价 = 20 天前的收盘）在 horizon 天内第一次满足：第几天、之后 horizon 天收益（数据不够为 null）。 */
  trigger: { day: number; ret: number | null } | null;
}

/** 第 i 天之后发生了什么；后面不够 horizon 天返回 null。 */
export function forwardOutcome(bars: Bar[], i: number, horizon: number): Outcome | null {
  const closes = bars.map((b) => b.close);
  if (i < 19 || i + horizon >= closes.length) return null;
  const e = ema(closes, 20);
  const d = ma20At(closes, i + 5) - ma20At(closes, i);
  let trigger: Outcome["trigger"] = null;
  for (let j = i + 1; j <= i + horizon; j++) {
    if (closes[j] > e[j - 1] && closes[j] > closes[j - 20]) {
      trigger = { day: j - i, ret: j + horizon < closes.length ? closes[j + horizon] / closes[j] - 1 : null };
      break;
    }
  }
  return { ret: closes[i + horizon] / closes[i] - 1, ma20Dir5: d > 0 ? 1 : d < 0 ? -1 : 0, trigger };
}

/** 一个回放点：当时的判断 + 之后的结果。 */
export interface Sample extends Outcome {
  ticker: string;
  date: string;
  lean: LeanLabel;
  score: number;
  /** 当时用的打法（plan.ts 的 playKey：六种趋势类型、横盘破位、过渡态里的两种打架）。 */
  play: string;
  /** 当时空仓计划的那句话（buildPlans(a).flat.action）。 */
  flat: string;
  /** 空仓计划的进场条件是不是"站上 EMA20 + MA20 抵扣价"。 */
  buyTurn: boolean;
}

export interface Row { key: string; n: number; mean: number; median: number; up: number; hit: number | null }

const LEAN_ORDER: LeanLabel[] = ["明显偏多", "偏多", "不明", "偏空", "明显偏空"];
const leanSign = (l: LeanLabel) => (l.includes("多") ? 1 : l.includes("空") ? -1 : 0);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function row(key: string, xs: Sample[], sign = 0): Row {
  const r = xs.map((x) => x.ret);
  return {
    key, n: xs.length, mean: mean(r), median: median(r), up: r.filter((x) => x > 0).length / r.length,
    hit: sign === 0 ? null : r.filter((x) => Math.sign(x) === sign).length / r.length,
  };
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
}

export interface Summary {
  all: Row;
  byLean: Row[];
  /** 看方向的推演：分数 ≤ -0.25 说 MA20 向下、≥ 0.25 说向上；5 天后对了几成。 */
  ma20: { n: number; hit: number };
  byPlay: Row[];
  byFlat: Row[];
  /** 空仓计划带"站上 EMA20 + MA20 抵扣价"进场条件的：horizon 天内触发几次、触发后 horizon 天平均收益。 */
  entry: { n: number; triggered: number; afterN: number; afterMean: number | null; afterUp: number | null };
}

export function summarize(samples: Sample[]): Summary {
  const byLean = LEAN_ORDER.flatMap((l) => {
    const xs = samples.filter((s) => s.lean === l);
    return xs.length ? [row(l, xs, leanSign(l))] : [];
  });
  const said = samples.filter((s) => Math.abs(s.score) >= 0.25);
  const rows = (m: Map<string, Sample[]>) => [...m].map(([k, xs]) => row(k, xs)).sort((a, b) => b.n - a.n);
  const entries = samples.filter((s) => s.buyTurn);
  const after = entries.flatMap((s) => (s.trigger?.ret == null ? [] : [s.trigger.ret]));
  return {
    all: row("全部", samples),
    byLean,
    ma20: { n: said.length, hit: said.filter((s) => s.ma20Dir5 === Math.sign(s.score)).length / said.length },
    byPlay: rows(groupBy(samples, (s) => s.play)),
    byFlat: rows(groupBy(samples, (s) => s.flat)),
    entry: {
      n: entries.length, triggered: entries.filter((s) => s.trigger).length, afterN: after.length,
      afterMean: after.length ? mean(after) : null, afterUp: after.length ? after.filter((x) => x > 0).length / after.length : null,
    },
  };
}

const pc = (x: number | null) => (x === null || Number.isNaN(x) ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);
const pct0 = (x: number | null) => (x === null || Number.isNaN(x) ? "—" : `${Math.round(x * 100)}%`);
const FEW = 10;

function table(rows: Row[], head: string, withHit = false) {
  const lines = [
    `| ${head} | 样本 | 平均 | 中位数 | 上涨占比 |${withHit ? " 方向命中 |" : ""}`,
    `|---|---:|---:|---:|---:|${withHit ? "---:|" : ""}`,
    ...rows.map((r) => `| ${r.key}${r.n < FEW ? "（样本少）" : ""} | ${r.n} | ${pc(r.mean)} | ${pc(r.median)} | ${pct0(r.up)} |${withHit ? ` ${pct0(r.hit)} |` : ""}`),
  ];
  return lines.join("\n");
}

export interface ReportMeta { tickers: string[]; from: string; to: string; horizon: number; source: string }

export function renderReport(sum: Summary, m: ReportMeta): string {
  const h = m.horizon;
  return [
    `# 回放验证：${m.from} ~ ${m.to}`,
    "",
    `股票：${m.tickers.join(" ")}。样本 ${sum.all.n} 个（每个是"某只票在某一天"），对照之后 ${h} 个交易日。数据：${m.source}。`,
    `全部样本 ${h} 日平均 ${pc(sum.all.mean)}、上涨占比 ${pct0(sum.all.up)}，是下面各行的基准。样本少于 ${FEW} 的行标"样本少"，别当结论。`,
    "样本之间不独立：同一天的几只票常常一起涨跌，整段时间的大盘方向也会压过一切，百分比只当方向参考。",
    "",
    `## 模糊判断 → 之后 ${h} 日涨跌`,
    "",
    "方向命中：偏多一侧算涨对、偏空一侧算跌对；不明不算。",
    "",
    table(sum.byLean, "模糊判断", true),
    "",
    "## 看方向：MA20 推演",
    "",
    `分数 ≤ -0.25 时看方向说 MA20 向下（逆风），≥ 0.25 说向上（顺风）。5 个交易日后 MA20 真的朝那边走：${pct0(sum.ma20.hit)}（样本 ${sum.ma20.n}）。`,
    "推演的前提是\"价格不变\"，这里用的是真实价格，所以命中率也包含了价格本身的延续。",
    "",
    `## 打法 → 之后 ${h} 日涨跌`,
    "",
    "打法是六种趋势类型，加上横盘破位（横盘但 20/60 已经死叉）和过渡态里的两种打架。",
    "",
    table(sum.byPlay, "打法"),
    "",
    `## 空仓计划 → 之后 ${h} 日涨跌`,
    "",
    "\"不买 / 不做\"类计划之后跌得多、涨得少，才说明不买是对的。",
    "",
    table(sum.byFlat, "空仓做法"),
    "",
    "## 进场条件：站上 EMA20 + MA20 抵扣价",
    "",
    sum.entry.n
      ? `带这条进场条件的空仓计划 ${sum.entry.n} 个，${h} 天内触发 ${sum.entry.triggered} 个（${pct0(sum.entry.triggered / sum.entry.n)}）。` +
        `触发后 ${h} 日（数据够的 ${sum.entry.afterN} 个）平均 ${pc(sum.entry.afterMean)}、上涨占比 ${pct0(sum.entry.afterUp)}。`
      : "没有带这条进场条件的样本。",
    "",
  ].join("\n");
}

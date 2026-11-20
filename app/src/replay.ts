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
  /**
   * 进场条件（收盘站上前一天的 EMA20，且高于 MA20 抵扣价 = 20 天前的收盘，和 dma_analyze 的 drops[20].tomorrow 一致）
   * 在 horizon 天内第一次满足：第几天；之后 horizon 天收益；同样卖在那天、但回放当天就买的收益（数据不够都为 null）。
   */
  trigger: { day: number; ret: number | null; fromStart: number | null } | null;
}

type Sign = -1 | 0 | 1;
const sign = (x: number): Sign => (x > 0 ? 1 : x < 0 ? -1 : 0);

/**
 * 看方向对 MA20 的推演，和一个不看抵扣价的基准，在 k = min(5, 推演天数) 天后各自对不对。
 * 推演的方向和天数本来就是按抵扣价算的（first_low / firstHigh），分数只决定说不说，所以不再拿"按抵扣价推"当基准。
 */
export interface Ma20Check {
  k: number;
  /** 推演的方向（plan.ts 的 ma20Claim）。 */
  claim: 1 | -1;
  /** k 天后 MA20 实际比当天高 / 低。 */
  actual: Sign;
  /** 基准：MA20 当前的方向（今天的价比 20 天前高还是低），接着朝那边走。 */
  slope: Sign;
}

export function ma20Check(closes: number[], i: number, claim: { dir: 1 | -1; days: number } | null): Ma20Check | null {
  if (!claim || i < 20) return null;
  const k = Math.min(5, claim.days);
  if (i + k >= closes.length) return null;
  return {
    k, claim: claim.dir,
    actual: sign(ma20At(closes, i + k) - ma20At(closes, i)),
    slope: sign(closes[i] - closes[i - 20]),
  };
}

/** 第 i 天之后发生了什么；后面不够 horizon 天返回 null。 */
export function forwardOutcome(bars: Bar[], i: number, horizon: number): Outcome | null {
  const closes = bars.map((b) => b.close);
  if (i < 19 || i + horizon >= closes.length) return null;
  const e = ema(closes, 20);
  let trigger: Outcome["trigger"] = null;
  for (let j = i + 1; j <= i + horizon; j++) {
    if (closes[j] > e[j - 1] && closes[j] > closes[j - 20]) {
      const end = j + horizon < closes.length ? closes[j + horizon] : null;
      trigger = { day: j - i, ret: end === null ? null : end / closes[j] - 1, fromStart: end === null ? null : end / closes[i] - 1 };
      break;
    }
  }
  return { ret: closes[i + horizon] / closes[i] - 1, trigger };
}

/** 一个回放点：当时的判断 + 之后的结果。 */
export interface Sample extends Outcome {
  ticker: string;
  date: string;
  lean: LeanLabel;
  score: number;
  /** 当时用的打法（plan.ts 的 playKey：五种类型、空头结构反弹中、多头结构回撤中、过渡、横盘破位）。 */
  play: string;
  /** 当时空仓计划的那句话（buildPlans(a).flat.action）。 */
  flat: string;
  /** 空仓计划的进场条件是不是"站上 EMA20 + MA20 抵扣价"。 */
  buyTurn: boolean;
  /** 看方向的 MA20 推演对不对（没推演为 null）。 */
  ma20: Ma20Check | null;
}

/** dates：不同日期数。同一天几只票常一起涨跌，它比样本数更接近"独立的几次"。 */
export interface Row { key: string; n: number; dates: number; mean: number; median: number; up: number; hit: number | null }

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
    key, n: xs.length, dates: new Set(xs.map((x) => x.date)).size, mean: mean(r), median: median(r), up: r.filter((x) => x > 0).length / r.length,
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
  /** 看方向的 MA20 推演命中率，和基准（当前斜率）在同一批样本上的命中率。 */
  ma20: { n: number; hit: number; slope: number };
  byPlay: Row[];
  byFlat: Row[];
  /** 空仓计划带"站上 EMA20 + MA20 抵扣价"进场条件的：horizon 天内触发几次、触发后 horizon 天平均收益。 */
  entry: { n: number; triggered: number; afterN: number; afterMean: number | null; afterUp: number | null; startMean: number | null };
}

export function summarize(samples: Sample[]): Summary {
  const byLean = LEAN_ORDER.flatMap((l) => {
    const xs = samples.filter((s) => s.lean === l);
    return xs.length ? [row(l, xs, leanSign(l))] : [];
  });
  const checks = samples.flatMap((s) => (s.ma20 ? [s.ma20] : []));
  const rate = (f: (c: Ma20Check) => boolean) => checks.filter(f).length / checks.length;
  const rows = (m: Map<string, Sample[]>) => [...m].map(([k, xs]) => row(k, xs)).sort((a, b) => b.n - a.n);
  const entries = samples.filter((s) => s.buyTurn);
  const done = entries.filter((s) => s.trigger?.ret != null);
  const after = done.map((s) => s.trigger!.ret!);
  const start = done.map((s) => s.trigger!.fromStart!);
  return {
    all: row("全部", samples),
    byLean,
    ma20: { n: checks.length, hit: rate((c) => c.actual === c.claim), slope: rate((c) => c.actual === c.slope) },
    byPlay: rows(groupBy(samples, (s) => s.play)),
    byFlat: rows(groupBy(samples, (s) => s.flat)),
    entry: {
      n: entries.length, triggered: entries.filter((s) => s.trigger).length, afterN: after.length,
      afterMean: after.length ? mean(after) : null, afterUp: after.length ? after.filter((x) => x > 0).length / after.length : null,
      startMean: start.length ? mean(start) : null,
    },
  };
}

const pc = (x: number | null) => (x === null || Number.isNaN(x) ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);
const pct0 = (x: number | null) => (x === null || Number.isNaN(x) ? "—" : `${Math.round(x * 100)}%`);
const FEW = 10;

function table(rows: Row[], head: string, withHit = false) {
  const lines = [
    `| ${head} | 样本 | 日期数 | 平均 | 中位数 | 上涨占比 |${withHit ? " 方向命中 |" : ""}`,
    `|---|---:|---:|---:|---:|---:|${withHit ? "---:|" : ""}`,
    ...rows.map((r) => `| ${r.key}${r.dates < FEW ? "（日期少）" : ""} | ${r.n} | ${r.dates} | ${pc(r.mean)} | ${pc(r.median)} | ${pct0(r.up)} |${withHit ? ` ${pct0(r.hit)} |` : ""}`),
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
    `全部样本 ${h} 日平均 ${pc(sum.all.mean)}、上涨占比 ${pct0(sum.all.up)}，是下面各行的基准。`,
    `"日期数"是不同日期的个数：同一天几只票常一起涨跌，它比样本数更接近独立的几次。日期数少于 ${FEW} 的行标"日期少"，别当结论。`,
    "样本之间不独立：同一天的几只票常常一起涨跌，整段时间的大盘方向也会压过一切，百分比只当方向参考。",
    "复权价会用之后的分红、拆股回溯调整历史价，工作台也一样，对均线方向的影响可以忽略。",
    "",
    `## 模糊判断 → 之后 ${h} 日涨跌`,
    "",
    "方向命中：偏多一侧算涨对、偏空一侧算跌对；不明不算。",
    "",
    table(sum.byLean, "模糊判断", true),
    "",
    "## 看方向：MA20 推演",
    "",
    `看方向的结论说"MA20 还要向下 / 向上 N 天"时，看 min(5, N) 个交易日后 MA20 实际朝哪边（${sum.ma20.n} 个；中间档、"明天起就变"不下结论，不算）：`,
    "",
    `| 怎么推 | 命中 |`,
    `|---|---:|`,
    `| 看方向的结论（价格不变时按抵扣价推） | ${pct0(sum.ma20.hit)} |`,
    `| 基准：MA20 现在朝哪边，就说接着朝哪边 | ${pct0(sum.ma20.slope)} |`,
    "",
    "推演的方向和天数本来就是按抵扣价算的，模糊判断的分数只决定说不说（中间档不说）。所以这里检验的是\"价格不变\"这个前提在 5 天内站不站得住，以及它比只看斜率多出多少。",
    "",
    `## 打法 → 之后 ${h} 日涨跌`,
    "",
    "打法是五种类型、空头结构反弹中、多头结构回撤中、过渡，加上横盘破位（横盘但 20/60 已经死叉）。",
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
        `触发后 ${h} 日（数据够的 ${sum.entry.afterN} 个）平均 ${pc(sum.entry.afterMean)}、上涨占比 ${pct0(sum.entry.afterUp)}；` +
        `同样卖在那天、但回放当天就买，平均 ${pc(sum.entry.startMean)}。两者的差就是"等拐头"付出的代价（或省下的亏损）。` +
        `最后 ${h} 天内才触发的样本数据不够，不算。触发按"同一天两条都满足"算（比"先站上 EMA20、之后再站上抵扣价"严）。`
      : "没有带这条进场条件的样本。",
    "",
  ].join("\n");
}

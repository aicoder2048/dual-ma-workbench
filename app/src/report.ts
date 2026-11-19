/**
 * 规则版三步报告：完全由脚本的分析结果生成，不经过 LLM。
 *
 * 两部分：
 * - visual：给前端画图用的结构化数据（均线状态、价位梯子、乖离分位、交叉表、趋势判定表、底扣价路径、推演）。
 * - steps[].items：按 ASD-STE100 简明中文写的短句，一句一事，每句带引用。
 */
import type { Analysis } from "./citations.ts";

export type Stance = "bullish" | "bearish" | "neutral";

export interface CrossInfo {
  kind: "金叉" | "死叉" | null;
  date: string | null;
  barsAgo: number | null;
}

export interface Projection {
  days: number;
  ma: Record<string, { now: number; after: number }>;
  ema: Record<string, { now: number; after: number }>;
  arrNow: { ma: string; ema: string };
  arrAfter: { ma: string; ema: string };
}

export interface ReportVisual {
  close: number;
  lines: Analysis["lines"];
  bias: { value: number; pctl: number };
  crosses: { pair: string; ma: CrossInfo; ema: CrossInfo; verdict: string }[];
  trendTable: { type: string; look: string; play: string; current: boolean }[];
  drops: Analysis["drops"];
  projection: Projection;
}

export interface ReportStep {
  key: "big_picture" | "strategy" | "direction";
  title: string;
  subtitle: string;
  items: string[];
}

export interface Report {
  headline: string;
  stance: Stance;
  steps: ReportStep[];
  visual: ReportVisual;
}

const STANCE: Record<string, Stance> = {
  健康上涨: "bullish", 极度超买: "bullish", 健康下跌: "bearish", 极度超卖: "bearish",
};

/** 趋势类型判定表（SKILL.md 第 1 步 / 学习文章第 4 节的简写）。 */
export const TREND_TABLE: { type: string; look: string; play: string[] }[] = [
  { type: "横盘震荡", look: "均线走平、缠绕；量能低", play: ["基本不做。", "等大量、缺口或假跌破。", "突破前已多头排列，才小仓位埋伏。", "多头排列被破坏，就离场。"] },
  { type: "健康上涨", look: "多头排列，都向上，间距适中", play: ["持有。", "回调到均线获支撑时，加仓。", "加仓前，切到 1 小时图看结构。", "不追高。"] },
  { type: "极度超买", look: "多头排列，价格远离均线", play: ["不追，只看不做。", "有仓位就分批止盈，或上移止损。"] },
  { type: "健康下跌", look: "空头排列，都向下", play: ["不抄底。", "反弹到均线附近，减仓或离场。"] },
  { type: "极度超卖", look: "空头排列，价格远离均线", play: ["不抢反弹。", "均线理顺成多头排列前，不买。"] },
  { type: "过渡态", look: "排列混乱，或方向不一致", play: ["条件不满足，就不做。", "看底扣价：均线多久能理顺。", "中长期线压着反弹时，反弹多半是假动作。"] },
];

export const shortTrend = (t: string) => t.replace("（排列或方向不一致）", "");

export function parseCross(text: string): CrossInfo {
  const m = text.match(/^(金叉|死叉) (\d{4}-\d{2}-\d{2})（(\d+) 根前）/);
  return m ? { kind: m[1] as "金叉" | "死叉", date: m[2], barsAgo: Number(m[3]) } : { kind: null, date: null, barsAgo: null };
}

export function crossVerdict(ma: CrossInfo, ema: CrossInfo): string {
  if (!ma.kind || !ema.kind) return "数据不足";
  if (ma.kind === ema.kind) return `双${ma.kind}`;
  return "不一致";
}

function arrangementOf(values: number[]): string {
  const [a, b, c] = values;
  if (a > b && b > c) return "多头";
  if (a < b && b < c) return "空头";
  return "混乱";
}

/** 价格保持不变 days 天后的均线。MA 由底扣价推出；EMA 有精确解：EMA' = c + (EMA − c)(1 − α)^days。 */
export function project(a: Analysis, days = 10): Projection {
  const c = a.close;
  const ma: Projection["ma"] = {};
  const ema: Projection["ema"] = {};
  for (const ln of a.lines) {
    const d = a.drops.find((x) => x.period === ln.period)!;
    ma[`MA${ln.period}`] = { now: ln.ma, after: ln.ma * (1 + d.ma_flat_change_pct / 100) };
    const alpha = 2 / (ln.period + 1);
    ema[`EMA${ln.period}`] = { now: ln.ema, after: c + (ln.ema - c) * (1 - alpha) ** days };
  }
  const order = [20, 60, 120];
  return {
    days,
    ma, ema,
    arrNow: { ma: a.arr_ma, ema: a.arr_ema },
    arrAfter: {
      ma: arrangementOf(order.map((n) => ma[`MA${n}`].after)),
      ema: arrangementOf(order.map((n) => ema[`EMA${n}`].after)),
    },
  };
}

const pct = (x: number, d = 1) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}%`;
const DIR = (s: number) => (Math.abs(s) < 0.05 ? "走平" : s > 0 ? "向上" : "向下");

function directionSentence(a: Analysis): string {
  const groups = new Map<string, number[]>();
  for (const ln of a.lines) {
    const k = DIR(ln.slope);
    groups.set(k, [...(groups.get(k) ?? []), ln.period]);
  }
  const cites = a.lines.map((ln) => `[[D:MA${ln.period}.方向]]`).join(" ");
  if (groups.size === 1) return `三条 MA 都${[...groups.keys()][0]} ${cites}。`;
  const parts = [...groups.entries()].map(([k, ns]) => `MA${ns.join("、MA")} ${k}`);
  return `${parts.join("；")} ${cites}。`;
}

function positionSentence(a: Analysis): string {
  const above = a.lines.filter((l) => l.above).map((l) => l.period);
  if (above.length === 3) return "价格在三条 MA 上方 [[D:MA20.位置]]。";
  if (above.length === 0) return "价格在三条 MA 下方 [[D:MA20.位置]]。";
  const below = a.lines.filter((l) => !l.above).map((l) => l.period);
  return `价格在 ${above.join("、")} 线上方，在 ${below.join("、")} 线下方 [[D:MA20.位置]]。`;
}

export function buildReport(a: Analysis): Report {
  const projection = project(a);
  const crosses = a.crosses.map((c) => {
    const ma = parseCross(c.ma);
    const ema = parseCross(c.ema);
    return { pair: c.pair, ma, ema, verdict: crossVerdict(ma, ema) };
  });
  const trend = shortTrend(a.trend);
  const row = TREND_TABLE.find((r) => r.type === trend) ?? TREND_TABLE[TREND_TABLE.length - 1];

  // ---------- 1. 看大局 ----------
  const big: string[] = [
    `${directionSentence(a)}均线方向是最小阻力方向 [[S:article#1]]。`,
    `MA 排列：${a.arr_ma} [[D:排列.MA]]。EMA 排列：${a.arr_ema} [[D:排列.EMA]]。`,
    positionSentence(a),
    `价格离 20 线 ${pct(a.bias20)} [[D:乖离20]]。这在历史上排 ${Math.round(a.bias_pctl * 100)}% 分位 [[D:乖离分位]]。`,
  ];
  if (a.bias_pctl <= 0.05 || a.bias_pctl >= 0.95) big.push("大幅乖离是趋势的最后一步 [[S:article#3.2]]。");
  for (const c of crosses) {
    if (c.verdict.startsWith("双")) big.push(`${c.pair}：${c.verdict} [[D:交叉.${c.pair}]]。两组都交叉，才算确认 [[S:article#2.2]]。`);
    else if (c.verdict === "不一致") big.push(`${c.pair}：MA ${c.ma.kind}，EMA ${c.ema.kind} [[D:交叉.${c.pair}]]。只有一组交叉，可能是假动作 [[S:article#2.2]]。`);
  }
  if (a.volume) {
    big.push(`今日量是 50 日均量的 ${a.volume.ratio.toFixed(1)} 倍 [[D:量比]]。`);
    if (a.volume.spikes.length) big.push(`近 20 日有 ${a.volume.spikes.length} 天大量 [[D:放量日]]。大量是标志性动作 [[S:article#2.7]]。`);
  }
  big.push(`规则初判：${trend} [[D:趋势初判]]。边界情况要看图复核 [[S:skill#第1步]]。`);

  // ---------- 2. 定策略 ----------
  const strategy = [
    `按「${trend}」查表 [[S:article#4]]。`,
    ...row.play.map((s, i) => (i === 0 ? `${s.replace(/。$/, "")} [[S:skill#第2步]]。` : s)),
    "先认趋势类型，再看信号 [[S:skill#原则]]。",
    "仓位以心态稳得住为准 [[S:article#7.3]]。",
  ];
  // 只有第一句带引用的打法句，后面几句补上同一出处
  for (let i = 2; i < 1 + row.play.length; i++) strategy[i] = `${strategy[i].replace(/。$/, "")} [[S:article#4]]。`;

  // ---------- 3. 看方向 ----------
  const direction = a.drops.map((d) => {
    const n = d.period;
    const kind = d.below === 0 ? "都扣高值" : d.below === d.count ? "都扣低值" : d.below * 2 >= d.count ? "多数扣低值" : "多数扣高值";
    const first = d.first_low ? `第 ${d.first_low} 天开始扣低值` : `${n} 天内扣不到低值`;
    return `MA${n}：未来 ${d.count} 天${kind} [[D:扣${n}.扣低天数]]。价格不变时，变化 ${pct(d.ma_flat_change_pct)} [[D:扣${n}.价平变化]]。${first} [[D:扣${n}.首次扣低]]。`;
  });
  const p = projection;
  direction.push(
    `价格不变 ${p.days} 天后：MA 排列 ${p.arrAfter.ma} [[D:推演.排列.MA]]，EMA 排列 ${p.arrAfter.ema} [[D:推演.排列.EMA]]。`,
    "收盘价高于底扣价，MA 就上升 [[S:article#2.3]]。推演链：底扣价 → 方向 → 排列 [[S:skill#第3步]]。",
  );

  return {
    headline: `${a.label} · ${trend}`,
    stance: STANCE[trend] ?? "neutral",
    steps: [
      { key: "big_picture", title: "看大局", subtitle: "现在是什么趋势", items: big },
      { key: "strategy", title: "定策略", subtitle: "该怎么做", items: strategy },
      { key: "direction", title: "看方向", subtitle: "底扣价推演", items: direction },
    ],
    visual: {
      close: a.close,
      lines: a.lines,
      bias: { value: a.bias20, pctl: a.bias_pctl },
      crosses,
      trendTable: TREND_TABLE.map((r) => ({ type: r.type, look: r.look, play: r.play.join(""), current: r.type === row.type })),
      drops: a.drops,
      projection,
    },
  };
}

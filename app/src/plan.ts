/**
 * 定策略、看方向的输出（规则生成，不经过模型）。
 *
 * - buildPlans：按"趋势类型 × 有没有仓位"给一句做法 + 两三条带价位的条件。规则取自
 *   skill 的 references/playbooks.md，价位取自模糊判断的门槛（EMA20、MA20 抵扣价）和均线值。
 * - buildOutlook：看方向的结论。抵扣价推演出 20 线组还会朝原方向走多久、最早什么时候会变，
 *   再翻译成"对空仓 / 持仓意味着什么"。
 */
import type { Analysis } from "./citations.ts";

export type Position = "flat" | "holding";
export interface PlanItem { label: string; text: string }
export interface Plan { action: string; items: PlanItem[] }
export interface Outlook { verdict: string; change: string; forYou: Record<Position, string> }

const f2 = (x: number) => x.toFixed(2);

/** 价位和它离现价多远，例如 "183.08（+21.3%）"。 */
function at(price: number, close: number) {
  const d = (price / close - 1) * 100;
  return `${f2(price)}（${d >= 0 ? "+" : ""}${d.toFixed(1)}%）`;
}

function levels(a: Analysis) {
  const line = (n: number) => a.lines.find((l) => l.period === n)!;
  const drop = (n: number) => a.drops.find((d) => d.period === n)!;
  return {
    close: a.close,
    ema20: line(20).ema, ma20: line(20).ma, ma60: line(60).ma, ema60: line(60).ema,
    drop20: drop(20).tomorrow, drop60: drop(60).tomorrow,
    p: (x: number) => at(x, a.close),
  };
}
type L = ReturnType<typeof levels>;

const BUY_TURN = (l: L) => `收盘先站上 EMA20 ${l.p(l.ema20)}，EMA20 拐头向上；再站上 MA20 抵扣价 ${l.p(l.drop20)}，MA20 跟着拐头。`;
const SIZE: PlanItem = { label: "仓位", text: "浮亏影响心情，就是仓位太大，减到睡得着为止。" };

/** 趋势类型 → 空仓 / 持仓的打法。来源：playbooks.md 各节。 */
const PLAYS: Record<string, Record<Position, (l: L) => Plan>> = {
  横盘震荡: {
    flat: () => ({ action: "基本不做，等埋伏信号。", items: [
      { label: "等什么", text: "均线收拢（最高最低相差 < 2%）后向上张嘴，形成多头排列。" },
      { label: "加分", text: "此前出现大量、缺口，或跌破后很快收回。" },
      { label: "怎么进", text: "小仓位埋伏，不在箱体中间追。" },
    ] }),
    holding: (l) => ({ action: "拿着，但守住底线。", items: [
      { label: "离场", text: `20 线组和 60 线组死叉（MA60 ${f2(l.ma60)} 附近），或即将死叉，就走。` },
      { label: "软规则", text: "进场后磨蹭不涨，没到止损也先出来。" },
      SIZE,
    ] }),
  },
  健康上涨: {
    flat: (l) => ({ action: "等回调再买，不追高。", items: [
      { label: "等什么", text: `回踩 MA20 ${l.p(l.ma20)} 附近，价格仍在 MA20 抵扣价 ${f2(l.drop20)} 上方。` },
      { label: "确认", text: "日线止跌，切到 1 小时图走出多头排列，再买。" },
      { label: "最好", text: "趋势确立后第一次回到 20 / 60 / 120 线组，胜率最高。" },
    ] }),
    holding: (l) => ({ action: "持有，回调可以加仓。", items: [
      { label: "加仓", text: `回踩 MA20 ${l.p(l.ma20)} 附近获支撑，小级别确认后加。` },
      { label: "减仓", text: `60 线组拐头向下，或 20/60 双死叉才减。只是碰到 MA60 ${f2(l.ma60)} 不算。` },
      SIZE,
    ] }),
  },
  极度超买: {
    flat: (l) => ({ action: "不追，只看不做。", items: [
      { label: "等什么", text: `等价格回落、靠近 MA20 ${l.p(l.ma20)}，均线重新组织后再看。` },
      { label: "为什么", text: "价格离成本太远，必然回归：要么急跌，要么横盘等均线。" },
    ] }),
    holding: (l) => ({ action: "拿着，分批止盈或上移止损。", items: [
      { label: "警惕", text: "出现顶部构造（如放量滞涨）就提高警惕，先止盈一部分。" },
      { label: "离场", text: `收盘跌破 EMA20 ${l.p(l.ema20)}、20 线组拐头向下，就走。` },
      SIZE,
    ] }),
  },
  健康下跌: {
    flat: (l) => ({ action: "不抄底，空仓等。", items: [
      { label: "等什么", text: BUY_TURN(l) },
      { label: "再等", text: "排列理顺成多头，才算底部确认。" },
    ] }),
    holding: (l) => ({ action: "反弹到均线附近，减仓或离场。", items: [
      { label: "减仓位", text: `反弹到 EMA20 ${l.p(l.ema20)}、MA20 ${f2(l.ma20)} 附近。` },
      { label: "别指望", text: "连涨几天改变不了空头排列，涨回成本要很久。" },
      SIZE,
    ] }),
  },
  极度超卖: {
    flat: (l) => ({ action: "不抢反弹，等均线拐头。", items: [
      { label: "等什么", text: BUY_TURN(l) },
      { label: "再等", text: "排列理顺成多头之前，不买。" },
    ] }),
    holding: (l) => ({ action: "不在急跌里割最低点，反弹再减仓。", items: [
      { label: "减仓位", text: `反弹到 EMA20 ${l.p(l.ema20)} 附近，是减仓机会。` },
      { label: "为什么", text: "跌太急会均值回归，常有反弹；但趋势没变，反弹是卖点。" },
      SIZE,
    ] }),
  },
  过渡态: {
    flat: (l) => ({ action: "条件不满足，不做。", items: [
      { label: "等什么", text: `排列理顺：20 线组站上 60 线组（MA60 ${f2(l.ma60)}），多数线一起向上。` },
      { label: "小心", text: "中长期线压着的反弹，多半是假动作。" },
    ] }),
    holding: (l) => ({ action: "不加仓，减到心态稳得住。", items: [
      { label: "离场", text: `收盘跌破 EMA20 ${l.p(l.ema20)}，20 线组拐头向下，就减。` },
      SIZE,
    ] }),
  },
};

const short = (t: string) => t.replace("（排列或方向不一致）", "");

export function buildPlans(a: Analysis): Record<Position, Plan> {
  const play = PLAYS[short(a.trend)] ?? PLAYS["过渡态"];
  const l = levels(a);
  return { flat: play.flat(l), holding: play.holding(l) };
}

/** 抵扣价路径里第一次高于现价是第几天（1 起）。偏多时，从那天起回调容易让 MA 拐头。 */
const firstHigh = (path: { close: number }[], close: number) => {
  const i = path.findIndex((p) => p.close > close);
  return i < 0 ? null : i + 1;
};

export function buildOutlook(a: Analysis): Outlook {
  const l = levels(a);
  const d20 = a.drops.find((d) => d.period === 20)!;
  const after = `价格不变 ${a.lean.after.days} 天后，模糊判断是${a.lean.after.label}。`;
  if (a.lean.score <= -0.25) {
    const turn = d20.first_low; // MA20 第几天起扣低值（20 天内）
    return {
      verdict: turn === null ? `逆风：价格不涨的话，20 天内 MA20 都会向下。${after}`
        : turn <= 1 ? `逆风可能快过去：明天起 MA20 就扣到低值。${after}`
        : `逆风：价格不涨的话，MA20 还要向下 ${turn - 1} 天。${after}`,
      change: turn === null ? `想提前转向，${BUY_TURN(l)}`
        : `第 ${turn} 天起 MA20 扣低值，价格不跌就会拐头向上。更早的信号是收盘站上 EMA20 ${l.p(l.ema20)}。`,
      forYou: {
        flat: turn === null ? `进场条件短期内不会出现，不用盯盘。收盘站上 ${f2(l.ema20)} 时再来看。`
          : `第 ${turn} 天前不用急。之后看 MA20 能不能拐头向上。`,
        holding: `逆风期间，反弹到 EMA20 ${f2(l.ema20)} 附近是减仓机会，不要指望很快涨回来。`,
      },
    };
  }
  if (a.lean.score >= 0.25) {
    const high = firstHigh(d20.path, a.close);
    return {
      verdict: high === null ? `顺风：未来 ${d20.path.length} 天 MA20 都扣低值，价格不跌就继续向上。${after}`
        : high <= 1 ? `顺风在减弱：明天起 MA20 就扣到高值。${after}`
        : `顺风：未来 ${high - 1} 天 MA20 扣低值，价格不跌就继续向上。${after}`,
      change: high === null ? `要转向，收盘得先跌破 EMA20 ${l.p(l.ema20)}，再跌破 MA20 抵扣价 ${l.p(l.drop20)}。`
        : `第 ${high} 天起 MA20 扣高值，那时一回调就容易拐头向下。先盯 EMA20 ${l.p(l.ema20)}。`,
      forYou: {
        flat: high === null ? `回调到 MA20 ${f2(l.ma20)} 附近有支撑，是等回调买的窗口。`
          : `第 ${high} 天前回调有 MA20 托着，是买点窗口；之后再买要更小心。`,
        holding: high === null ? `拿着。收盘跌破 EMA20 ${f2(l.ema20)} 才需要警惕。`
          : `拿着。第 ${high} 天后回调更容易破位，盯住 EMA20 ${f2(l.ema20)}。`,
      },
    };
  }
  return {
    verdict: `没有明确方向：几条线方向不一致。${after}`,
    change: a.lean.flips[0] ? `${a.lean.flips[0].text}，方向才会清楚。` : "等均线理顺，方向才会清楚。",
    forYou: { flat: "不做，等方向出来。", holding: "不加仓，减到心态稳得住。" },
  };
}

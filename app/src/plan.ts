/**
 * 定策略、看方向的输出（规则生成，不经过模型）。
 *
 * - buildPlans：按"趋势类型 × 你的处境"给一句做法 + 两三条带价位的条件。规则取自
 *   skill 的 references/playbooks.md，价位取自模糊判断的门槛（EMA20、MA20 抵扣价）和均线值。
 *   处境分四种：空仓、持仓（没填成本）、持仓浮盈、持仓浮亏。成本只在浏览器里，文字里写 {cost}，由页面填上。
 * - buildOutlook：看方向的结论（只按模糊判断分三档：≤ -0.25、中间、≥ 0.25）。classify 只在分数 ≥ 0.6 时
 *   给上涨一侧、≤ -0.6 时给下跌一侧，所以只有横盘和过渡态会配上任意一档。抵扣价推演出 20 线组还会朝原方向走多久、
 *   最早什么时候会变，再翻译成"对空仓 / 持仓意味着什么"。方向和排布打架（反弹受压、回调有撑）时，影响服从结构。
 */
import type { Analysis } from "./citations.ts";

export type Position = "flat" | "holding";
/** 你的处境：空仓；持仓但没填成本；持仓浮盈；持仓浮亏。页面按"空仓/持仓"和成本价选一个。 */
export type Situation = "flat" | "holding" | "profit" | "loss";
export const SITUATIONS: Situation[] = ["flat", "holding", "profit", "loss"];
/** 计划文字里成本价的占位，页面填上用户输入的成本。 */
export const COST = "{cost}";
export interface PlanItem { label: string; text: string }
export interface Plan { action: string; items: PlanItem[] }
export type EffectTag = "支持" | "调整时机" | "不变";
/** 看方向对上面策略的影响：支持原做法、调整执行时机，或方向不明、策略不变。 */
export interface Effect { tag: EffectTag; text: string }
export interface Outlook { verdict: string; change: string; effect: Record<Situation, Effect> }

const f2 = (x: number) => x.toFixed(2);

/** 价位和它离现价多远，例如 "183.08（+21.3%）"。 */
function at(price: number, close: number) {
  const d = (price / close - 1) * 100;
  return `${f2(price)}（${d >= 0 ? "+" : ""}${d.toFixed(1)}%）`;
}

/**
 * 当下的均线状态（和 dma_analyze.py 的判据一致）：止损、失效的条件可能现在就已经成立，那时要照实说"已经"。
 * - death / gold：MA20/MA60 和 EMA20/EMA60 两对都在下方 / 上方（相差不到价格 0.5% 算贴着，不算）。
 * - ema20Down：EMA20 在向下（20 线组里先拐的那条）。
 * - maLo / maHi / spread：三条 MA 的最低、最高和相差（占价格 %），classify 用 < 4% 判缠绕。
 */
function stateOf(a: Analysis) {
  const rel = (pair: string) => a.lean.pairs.find((x) => x.pair === pair)?.rel ?? 0;
  const mas = a.lines.map((l) => l.ma);
  const maLo = Math.min(...mas), maHi = Math.max(...mas);
  return {
    death: rel("MA20/MA60") < 0 && rel("EMA20/EMA60") < 0,
    /** 已经死叉或即将死叉：两对都不在上方，至少一对已在下方（playbooks 横盘的硬止损）。 */
    nearDeath: rel("MA20/MA60") <= 0 && rel("EMA20/EMA60") <= 0 && rel("MA20/MA60") + rel("EMA20/EMA60") < 0,
    gold: rel("MA20/MA60") > 0 && rel("EMA20/EMA60") > 0,
    ema20Down: (a.lean.dirs.EMA20 ?? 0) < 0,
    maLo, maHi, spread: ((maHi - maLo) / a.close) * 100,
    score: a.lean.score,
    flip: a.lean.flips.find((f) => !f.crossed)?.text ?? null,
  };
}

function levels(a: Analysis) {
  const line = (n: number) => a.lines.find((l) => l.period === n)!;
  const drop = (n: number) => a.drops.find((d) => d.period === n)!;
  return {
    close: a.close,
    ema20: line(20).ema, ma20: line(20).ma, ma60: line(60).ma, ema60: line(60).ema,
    drop20: drop(20).tomorrow, drop60: drop(60).tomorrow,
    p: (x: number) => at(x, a.close),
    ...stateOf(a),
  };
}
type L = ReturnType<typeof levels>;

/** "收盘站上 X"；现价已经在 X 上方时说"已经在 X 上方"。 */
const above = (l: L, name: string, x: number) => (l.close >= x ? `已经在 ${name} ${l.p(x)} 上方` : `收盘站上 ${name} ${l.p(x)}`);

const BUY_TURN = (l: L) => `${above(l, "EMA20", l.ema20)}，EMA20 拐头向上；再${above(l, "MA20 抵扣价", l.drop20).replace(/^收盘/, "")}，MA20 跟着拐头。`;
const SIZE: PlanItem = { label: "仓位", text: "盈亏影响心情，就是仓位太大，减到睡得着为止。" };
const DEATH = (l: L) => l.death ? `20/60 已经双死叉（MA20、EMA20 都在 MA60 ${f2(l.ma60)}、EMA60 ${f2(l.ema60)} 下方）`
  : `20/60 双死叉（MA20 落到 MA60 ${f2(l.ma60)} 下方、EMA20 落到 EMA60 ${f2(l.ema60)} 下方）`;
const GOLD = (l: L) => l.gold ? `20/60 已经双金叉（MA20、EMA20 都在 MA60 ${f2(l.ma60)}、EMA60 ${f2(l.ema60)} 上方）`
  : `20/60 双金叉（MA20 升过 MA60 ${f2(l.ma60)}、EMA20 升过 EMA60 ${f2(l.ema60)}）`;
/** 持仓的 EMA20 止损：收盘跌破 EMA20、EMA20 拐头向下就 {act}。两半都已成立时说"已经满足"，反弹到 EMA20 附近执行。 */
function ema20Stop(l: L, act: string): string {
  if (l.close < l.ema20 && l.ema20Down) return `止损条件已经满足（在 EMA20 ${l.p(l.ema20)} 下方、EMA20 向下）：还没${act}的，反弹到 EMA20 附近${act}掉，别再等。`;
  if (l.close < l.ema20) return `已经在 EMA20 ${l.p(l.ema20)} 下方；EMA20 再拐头向下，就${act}。`;
  return `收盘跌破 EMA20 ${l.p(l.ema20)}、EMA20 拐头向下，就${act}。`;
}
/** 横盘的失效：均线散开（classify 的判据，横盘时按定义还没发生）。 */
const TANGLE_END = (l: L, up: string, down: string) =>
  `三条 MA 现在相差 ${l.spread.toFixed(1)}%（${f2(l.maLo)} ~ ${f2(l.maHi)}）；超过 4%、或 MA60 不再走平，就不是横盘了：向上散开${up}，向下散开${down}。`;
/** 过渡态的失效：模糊判断到 ±0.6（classify 的判据，过渡态时按定义还没到）。 */
const TRANSITION_END = (l: L, up: string, down: string) =>
  `过渡态说的是"还没理顺"。模糊判断现在 ${(Math.abs(l.score) < 0.005 ? 0 : l.score).toFixed(2)}，升到 0.6 以上${up}，降到 -0.6 以下${down}；` +
  (l.flip ? `最近的变化门槛：${l.flip}。` : `价位上先看 EMA20 ${f2(l.ema20)} 和 MA20 抵扣价 ${f2(l.drop20)}：两条线最先拐。`);
/**
 * 空仓计划进场之后的止损：重新跌回 EMA20 下方、EMA20 再拐头向下就走。下跌类的进场条件是站上 EMA20（反过来就是止损）；
 * 过渡态、两种打架的进场条件是排列理顺，理顺时价格必然在 EMA20 上方，同一条也适用。
 */
const ENTRY_STOP = (l: L): PlanItem =>
  ({ label: "止损", text: `按条件进场后，收盘重新跌回 EMA20 下方（EMA20 现在 ${f2(l.ema20)}）、EMA20 再拐头向下，就走。` });

/**
 * 打法键 → 空仓 / 持仓的打法。键是六种趋势类型，加上过渡态里方向和排布打架的两种（反弹受压、回调有撑）。
 * 每份计划都有「止损」（空仓时指按计划进场之后）和「失效」（判断错了的标志，以及接下来改用哪套打法）。
 * 来源：playbooks.md 各节（硬止损、软离场、假突破、关键性波动）；打架的两种来自 SKILL.md 模糊判断一节、
 * 原则 8「排列不合理不做」、TSLA 2021-04-14 案例，回调有撑的离场底线来自 playbooks「20/60 双死叉」。
 */
const PLAYS: Record<string, Record<Position, (l: L) => Plan>> = {
  横盘震荡: {
    flat: (l) => ({ action: "基本不做，等埋伏信号。", items: [
      { label: "等什么", text: "均线收拢（最高最低相差 < 2%）后向上张嘴，形成多头排列。" },
      { label: "加分", text: "此前出现大量、缺口，或跌破后很快收回。" },
      { label: "怎么进", text: "小仓位埋伏，不在箱体中间追。" },
      { label: "止损", text: `埋伏后 20/60 死叉或即将死叉（MA20 落到 MA60 ${f2(l.ma60)} 下方）就走；突破前高后很快跌回、20 线组拐头向下（假突破的两个动作），也走。` },
      { label: "失效", text: TANGLE_END(l, "多半转上涨", "多半转下跌") },
    ] }),
    holding: (l) => ({ action: "拿着，但守住底线。", items: [
      { label: "软规则", text: "进场后磨蹭不涨，没到止损也先出来。" },
      { label: "止损", text: `20 线组和 60 线组死叉（MA60 ${f2(l.ma60)} 附近），或即将死叉，就走。` },
      { label: "失效", text: TANGLE_END(l, "多半转上涨，可以拿着", "多半转下跌，减仓") },
      SIZE,
    ] }),
  },
  // 横盘、但 20/60 已经双死叉：埋伏仓位的硬止损已经触发（playbooks 横盘一节）
  横盘破位: {
    flat: (l) => ({ action: "基本不做，等埋伏信号。", items: [
      { label: "等什么", text: "均线收拢（最高最低相差 < 2%）后向上张嘴，形成多头排列。" },
      { label: "止损", text: `现在 20/60 已经死叉或即将死叉（MA20 ${f2(l.ma20)} / MA60 ${f2(l.ma60)}、EMA20 ${f2(l.ema20)} / EMA60 ${f2(l.ema60)}），不满足埋伏条件，别进；等多头排列再埋伏，之后一死叉就走。` },
      { label: "失效", text: TANGLE_END(l, "多半转上涨", "多半转下跌") },
    ] }),
    holding: (l) => ({ action: "底线已经破了：离场。", items: [
      { label: "止损", text: `20/60 已经死叉或即将死叉（MA20 ${f2(l.ma20)} / MA60 ${f2(l.ma60)}、EMA20 ${f2(l.ema20)} / EMA60 ${f2(l.ema60)}）：埋伏仓位的硬止损已经触发，离场；条件重新满足再进。` },
      { label: "失效", text: TANGLE_END(l, "多半转上涨，按上涨的打法重新进", "多半转下跌，更不该拿") },
      SIZE,
    ] }),
  },
  健康上涨: {
    flat: (l) => ({ action: "等回调再买，不追高。", items: [
      { label: "等什么", text: l.close >= l.drop20 ? `回踩 MA20 ${l.p(l.ma20)} 附近，价格仍在 MA20 抵扣价 ${f2(l.drop20)} 上方。`
        : `价格已经在 MA20 抵扣价 ${l.p(l.drop20)} 下方，MA20 要拐头向下：等重新站上、回踩企稳再说。` },
      { label: "确认", text: "日线止跌，切到 1 小时图走出多头排列，再买。" },
      { label: "最好", text: "趋势确立后第一次回到 20 / 60 / 120 线组，胜率最高。" },
      { label: "止损", text: l.close >= l.drop20
        ? `买进后 1 小时图的多头排列被破坏就走；日线价格低于 MA20 抵扣价（现在 ${f2(l.drop20)}）、MA20 拐头向下，也走。`
        : `现在价格已经在 MA20 抵扣价 ${f2(l.drop20)} 下方，MA20 要拐头向下：先别买。买进后的止损是 1 小时图多头排列被破坏，或日线 MA20 拐头向下。` },
      { label: "失效", text: `${DEATH(l)}，或 60 线组拐头向下：不再是健康上涨，不再等回调买。` },
    ] }),
    holding: (l) => ({ action: "持有，回调可以加仓。", items: [
      { label: "加仓", text: `回踩 MA20 ${l.p(l.ma20)} 附近获支撑，小级别确认后加。` },
      { label: "止损", text: `60 线组拐头向下，或 20/60 双死叉才走。只是碰到 MA60 ${f2(l.ma60)} 不算。` },
      { label: "失效", text: `出现上面的止损信号（60 线组拐头向下，或 MA20、EMA20 落到 MA60 ${f2(l.ma60)}、EMA60 ${f2(l.ema60)} 下方），就不是健康上涨了：不再回调加仓，改按过渡态 / 下跌的打法。` },
      SIZE,
    ] }),
  },
  极度超买: {
    flat: (l) => ({ action: "不追，只看不做。", items: [
      { label: "等什么", text: `等价格回落、靠近 MA20 ${l.p(l.ma20)}，均线重新组织后再看。` },
      { label: "为什么", text: "价格离成本太远，必然回归：要么急跌，要么横盘等均线。" },
      { label: "止损", text: `没仓位，不用止损。回落后按健康上涨的买法进，止损跟着那套走：MA20 拐头向下（价格低于 MA20 抵扣价，现在 ${f2(l.drop20)}）就走。` },
      { label: "失效", text: `回落很浅、20 线组一直向上：回归是靠横盘等均线完成的，按健康上涨的打法等回踩 MA20 ${f2(l.ma20)}；${DEATH(l)}：上涨结束。` },
    ] }),
    holding: (l) => ({ action: "拿着，分批止盈或上移止损。", items: [
      { label: "警惕", text: "出现顶部构造（如放量滞涨）就提高警惕，先止盈一部分。" },
      { label: "止损", text: ema20Stop(l, "走").replace(/。$/, "（关键性波动）。") },
      { label: "失效", text: `跌到 EMA20 下方后很快收回、20 线组继续向上：回归已经完成，按健康上涨拿着；${DEATH(l)}：上涨结束。` },
      SIZE,
    ] }),
  },
  健康下跌: {
    flat: (l) => ({ action: "不抄底，空仓等。", items: [
      { label: "等什么", text: BUY_TURN(l) },
      { label: "再等", text: "排列理顺成多头，才算底部确认。" },
      ENTRY_STOP(l),
      { label: "失效", text: `${above(l, "MA20 抵扣价", l.drop20)}，${GOLD(l)}：下跌判断失效，按过渡态 / 上涨的打法看。` },
    ] }),
    holding: (l) => ({ action: "反弹到均线附近，减仓或离场。", items: [
      { label: "减仓位", text: l.close >= l.ema20 ? `已经在 EMA20 ${l.p(l.ema20)} 上方，现在就是减仓位（MA20 ${f2(l.ma20)} 附近也是）。`
        : `反弹到 EMA20 ${l.p(l.ema20)}、MA20 ${f2(l.ma20)} 附近。` },
      { label: "别指望", text: "连涨几天改变不了空头排列，跌下去的价格要很久才回来。" },
      { label: "止损", text: `下跌趋势里下方没有均线托底，止损不靠均线：${l.close >= l.ema20 ? `现在已经在 EMA20 ${f2(l.ema20)} 上方，就是离场点` : `反弹到 EMA20 ${f2(l.ema20)} 一带就是离场点`}；没等到反弹，也别把"心理价"一路往下挪。` },
      { label: "失效", text: `${above(l, "MA20 抵扣价", l.drop20)}，${GOLD(l)}：下跌判断失效，剩下的仓位可以按上涨拿着。` },
      SIZE,
    ] }),
  },
  极度超卖: {
    flat: (l) => ({ action: "不抢反弹，等均线拐头。", items: [
      { label: "等什么", text: BUY_TURN(l) },
      { label: "再等", text: "排列理顺成多头之前，不买。" },
      ENTRY_STOP(l),
      { label: "失效", text: `${GOLD(l)}：下跌判断失效，按过渡态 / 上涨的打法看。` },
    ] }),
    holding: (l) => ({ action: "不在急跌里割最低点，反弹再减仓。", items: [
      { label: "减仓位", text: l.close >= l.ema20 ? `已经在 EMA20 ${l.p(l.ema20)} 上方，现在就是减仓机会。` : `反弹到 EMA20 ${l.p(l.ema20)} 附近，是减仓机会。` },
      { label: "为什么", text: "跌太急会均值回归，常有反弹；但趋势没变，反弹是卖点。" },
      { label: "止损", text: `下方没有均线托底，止损不靠均线：${l.close >= l.ema20 ? `现在已经在 EMA20 ${f2(l.ema20)} 上方，就是离场点` : `反弹到 EMA20 ${f2(l.ema20)} 一带就是离场点`}；不在急跌里割最低点，但也不把"心理价"一路往下挪。` },
      { label: "失效", text: `${above(l, "EMA20", l.ema20)}、EMA20 拐头向上，再加上 ${GOLD(l)}：下跌判断失效，剩下的仓位可以拿着。` },
      SIZE,
    ] }),
  },
  过渡态: {
    flat: (l) => ({ action: "条件不满足，不做。", items: [
      { label: "等什么", text: l.gold ? `20 线组已经在 60 线组上方（MA60 ${f2(l.ma60)}）；还差多数线一起向上，模糊判断到明显偏多。`
        : `排列理顺：20 线组升到 60 线组上方（MA60 ${f2(l.ma60)}），多数线一起向上。` },
      { label: "小心", text: "中长期线压着的反弹，多半是假动作。" },
      ENTRY_STOP(l),
      { label: "失效", text: TRANSITION_END(l, "（明显偏多）按上涨打", "（明显偏空）按下跌打") },
    ] }),
    holding: (l) => ({ action: "不加仓，减到心态稳得住。", items: [
      { label: "止损", text: ema20Stop(l, "减") },
      { label: "失效", text: TRANSITION_END(l, "可以按上涨拿着", "按下跌减仓") },
      SIZE,
    ] }),
  },
  反弹受压: {
    flat: (l) => ({ action: "不买：中长期线压着的反弹，多半是假动作。", items: [
      { label: "等什么", text: `20 线组升到 60 线组上方（MA20 过 MA60 ${f2(l.ma60)}、EMA20 过 EMA60 ${f2(l.ema60)}），排列理顺再看。` },
      { label: "推演", text: "用抵扣价算 20 线组多久能站上 60 线组；要很多天、价格得一直很强，就别等。" },
      ENTRY_STOP(l),
      { label: "失效", text: `${GOLD(l)}、60 线组拐头向上：不再受压，这次反弹是真的，按上涨的打法看。` },
    ] }),
    holding: (l) => ({ action: "逢高减仓。", items: [
      { label: "减仓位", text: l.close >= l.ma60
        ? `已经在 MA60 ${l.p(l.ma60)} 上方，现在就是减仓机会。`
        : `反弹到 MA60 ${l.p(l.ma60)} 附近，是减仓机会。` },
      { label: "为什么", text: "排列不合理时的强反弹，多半撑不住（TSLA 2021-04-14 就是这样）。" },
      { label: "止损", text: l.close >= l.ma60 ? ema20Stop(l, "走") : `没到减仓位就转头：${ema20Stop(l, "走")}` },
      { label: "失效", text: `${GOLD(l)}、60 线组拐头向上：不再受压，剩下的仓位可以按上涨拿着。` },
      SIZE,
    ] }),
  },
  回调有撑: {
    flat: (l) => ({ action: "等回调结束再买，不在下跌途中接。", items: [
      { label: "等什么", text: l.close < l.ema20 ? `20 线组重新拐头向上：收盘站上 EMA20 ${l.p(l.ema20)}。`
        : l.close < l.drop20 ? `已经在 EMA20 ${l.p(l.ema20)} 上方；再等 MA20 拐头向上：收盘高于 MA20 抵扣价 ${l.p(l.drop20)}。`
        : `已经在 EMA20 ${l.p(l.ema20)} 和 MA20 抵扣价 ${l.p(l.drop20)} 上方：守住几天、MA20 拐头向上，回调就结束了。` },
      { label: "位置", text: l.close >= l.ma60
        ? `回踩到 MA60 ${l.p(l.ma60)} 附近止跌，更好。`
        : `已经跌到 MA60 ${l.p(l.ma60)} 下方：很快收回来才算有撑，收不回来就等 20/60 怎么交叉。` },
      ENTRY_STOP(l),
      { label: "失效", text: `${DEATH(l)}：结构坏了，不再有撑，按过渡态 / 下跌的打法看。` },
    ] }),
    holding: (l) => ({ action: "持有观察，不在急跌里卖。", items: [
      { label: "止损", text: `${DEATH(l)}才算结构坏，那时再走。` },
      { label: "失效", text: `出现上面的止损信号就不再有撑：结构转空，剩下没走的仓位按过渡态 / 下跌的打法处理（MA60 ${f2(l.ma60)}、EMA60 ${f2(l.ema60)} 是分界）。` },
      SIZE,
    ] }),
  },
};

const short = (t: string) => t.replace("（排列或方向不一致）", "");

/**
 * 浮盈 / 浮亏时持仓计划怎么改：多一行「盈亏」，必要时换掉做法、去掉不再成立的条目。
 * 每种趋势类型各写一条，和同一张计划里的其他条目说同一件事（偏多浮亏不说"再加"配"不加仓"这种话）。
 * 来源：资金原则（文章 7.3）、"有仓位分批止盈或上移止损"（playbooks 极度超买）、各类型的离场条件。
 */
interface PnlTweak { line: string; action?: string; omit?: string[] }
const PNL: Record<string, Record<"profit" | "loss", PnlTweak>> = {
  横盘震荡: {
    profit: { line: `还有浮盈：把止损提到成本 ${COST} 附近保本；磨蹭不涨就先走。` },
    loss: { line: "已经浮亏：守住止损（20/60 死叉），不在箱体里加仓摊低，也不死等回本。" },
  },
  横盘破位: {
    profit: { line: `还有浮盈：底线已经破了，带着利润走（成本 ${COST}），别让它变成亏损。` },
    loss: { line: "已经浮亏：底线破了就认，不加仓摊低，不等回本。" },
  },
  健康上涨: {
    profit: { line: `还有浮盈：成本 ${COST} 在下方是安全垫，按趋势规则拿着，不因小回调卖掉。` },
    loss: { line: "暂时浮亏：趋势还向上，不急着割；不在浮亏时急着加仓摊低，等回踩获支撑、小级别确认后再加。" },
  },
  极度超买: {
    profit: { line: `浮盈不少：先分批止盈一部分，剩下的把止损上移到成本 ${COST} 以上。` },
    loss: {
      action: "追在高位、暂时浮亏：不加仓，跌破 EMA20 就走。",
      line: "已经浮亏：多半是追高买的。不加仓摊低，按止损走，不等回本。",
      omit: ["警惕"], // 亏着钱谈不上"先止盈一部分"
    },
  },
  健康下跌: {
    profit: { line: `还有浮盈：先把止损提到成本 ${COST} 附近保本，反弹到减仓位先减一部分，别让盈利变成亏损。` },
    loss: { line: "已经浮亏：不等回本。反弹到减仓位就执行，减到浮亏不影响心情为止。" },
  },
  极度超卖: {
    profit: { line: `还有浮盈：先把止损提到成本 ${COST} 附近保本，反弹到减仓位先减一部分，别让盈利变成亏损。` },
    loss: { line: "已经浮亏：不等回本。反弹到减仓位就执行，减到浮亏不影响心情为止。" },
  },
  过渡态: {
    profit: { line: `还有浮盈：把止损提到成本 ${COST} 附近保本；排列理顺前不加仓。` },
    loss: { line: "已经浮亏：不加仓摊低；按止损减，不等回本。" },
  },
  反弹受压: {
    profit: { line: `还有浮盈：把止损提到成本 ${COST} 附近保本，到减仓位先锁住一部分利润。` },
    loss: { line: "已经浮亏：不等回本。到减仓位就减，这种反弹多半撑不住。" },
  },
  回调有撑: {
    profit: { line: `还有浮盈：成本 ${COST} 在下方是安全垫，结构还是多头，不在回调里卖。` },
    loss: { line: "暂时浮亏：结构还是多头，不急着割；但不加仓摊低，20/60 双死叉就走。" },
  },
};

/**
 * 这份分析该用哪套打法：按趋势类型，认不出来按过渡态；过渡态里方向和排布打架时用打架的打法。
 * 横盘（以及分数正好 ±0.6 的上涨 / 下跌）也可能带冲突，那时听趋势类型：页面顶部显示的就是它。
 */
function playKey(a: Analysis): string {
  const t = PLAYS[short(a.trend)] ? short(a.trend) : "过渡态";
  if (t === "横盘震荡" && stateOf(a).nearDeath) return "横盘破位";
  return t === "过渡态" && a.lean.conflict ? a.lean.conflict : t;
}
/** 用了打架的打法时是哪一种。 */
const conflictOf = (a: Analysis) => {
  const k = playKey(a);
  return k === "反弹受压" || k === "回调有撑" ? k : null;
};

/** 只按趋势类型定的打法（还没加看方向给的时机）。浮盈 / 浮亏在持仓打法的做法之后加一行。 */
function basePlans(a: Analysis): Record<Situation, Plan> {
  const key = playKey(a);
  const play = PLAYS[key];
  const l = levels(a);
  const holding = play.holding(l);
  const withPnl = (k: "profit" | "loss"): Plan => {
    const t = PNL[key][k];
    return {
      action: t.action ?? holding.action,
      items: [{ label: "盈亏", text: t.line }, ...holding.items.filter((i) => !t.omit?.includes(i.label))],
    };
  };
  return { flat: play.flat(l), holding, profit: withPnl("profit"), loss: withPnl("loss") };
}

/** 打法 + 第一行"时机"：来自看方向（buildOutlook 的 effect），两处说的是同一句话。 */
export function buildPlans(a: Analysis): Record<Situation, Plan> {
  const base = basePlans(a);
  const { effect } = buildOutlook(a);
  const withTiming = (k: Situation): Plan => ({ ...base[k], items: [{ label: "时机", text: effect[k].text }, ...base[k].items] });
  return Object.fromEntries(SITUATIONS.map((k) => [k, withTiming(k)])) as Record<Situation, Plan>;
}

/** 抵扣价路径里第一次高于现价是第几天（1 起）。偏多时，从那天起回调容易让 MA 拐头。 */
const firstHigh = (path: { close: number }[], close: number) => {
  const i = path.findIndex((p) => p.close > close);
  return i < 0 ? null : i + 1;
};

export function buildOutlook(a: Analysis): Outlook {
  const o = sideOutlook(a);
  const kind = conflictOf(a);
  if (kind) return { ...o, effect: conflictEffect(a, kind) };
  if (playKey(a) === "横盘破位") {
    const out: Effect = { tag: "不变", text: "底线已经破了，看方向改变不了：按止损离场，条件重新满足再进。" };
    return { ...o, effect: { ...o.effect, holding: out, profit: out, loss: out } };
  }
  return o;
}

/** 打架时，看方向的影响要服从结构（不说"顺风、买点窗口"配"不买"这种话）。 */
function conflictEffect(a: Analysis, kind: "反弹受压" | "回调有撑"): Record<Situation, Effect> {
  const l = levels(a);
  const base = basePlans(a);
  const act = (k: Situation) => `「${base[k].action.replace(/。$/, "")}」`;
  if (kind === "反弹受压") {
    const where = l.close >= l.ma60 ? `现在就在 MA60 ${f2(l.ma60)} 上方，正好` : `反弹到 MA60 ${f2(l.ma60)} 附近再`;
    const sell = (k: Situation, tail: string): Effect =>
      ({ tag: "支持", text: `支持${act(k)}：短期反弹还有劲，${where}${tail}。` });
    return {
      flat: { tag: "不变", text: `短期在反弹，但 20 线组还压在 60 线组下方：${act("flat")}不变，等排列理顺。` },
      holding: sell("holding", "减"), profit: sell("profit", "锁住一部分利润"), loss: sell("loss", "减，不要等涨回成本"),
    };
  }
  const hold = (k: Situation): Effect => ({ tag: "支持", text: `支持${act(k)}：短期在回调，但结构还是多头；20/60 双死叉之前不走。` });
  return {
    flat: { tag: "调整时机", text: l.close >= l.ema20
      ? `调整时机：已经回到 EMA20 ${f2(l.ema20)} 上方，等 MA20 重新拐头向上再买。`
      : `调整时机：短期还在回调，等收盘站上 EMA20 ${f2(l.ema20)}、MA20 重新拐头向上再买。` },
    holding: hold("holding"), profit: hold("profit"), loss: hold("loss"),
  };
}

/** 不打架时：按偏空 / 偏多 / 不明给方向结论和对策略的影响。 */
function sideOutlook(a: Analysis): Outlook {
  const l = levels(a);
  const base = basePlans(a);
  const act = (k: Situation) => `「${base[k].action.replace(/。$/, "")}」`;
  /** 持仓三种处境（没填成本 / 浮盈 / 浮亏）共用同一句，只在需要时改说法。 */
  const held = (text: (k: Situation) => string, tag: EffectTag) =>
    ({ holding: { tag, text: text("holding") }, profit: { tag, text: text("profit") }, loss: { tag, text: text("loss") } });
  const d20 = a.drops.find((d) => d.period === 20)!;
  const after = `价格不变 ${a.lean.after.days} 天后，模糊判断是${a.lean.after.label}。`;
  if (a.lean.score <= -0.25) {
    const turn = d20.first_low; // MA20 第几天起扣低值（20 天内）
    const rebound = l.close >= l.ema20 ? `现在已经在 EMA20 ${f2(l.ema20)} 上方，` : `反弹到 EMA20 ${f2(l.ema20)} 附近`;
    return {
      verdict: turn === null ? `逆风：价格不涨的话，20 天内 MA20 都会向下。${after}`
        : turn <= 1 ? `逆风可能快过去：明天起 MA20 就扣到低值。${after}`
        : `逆风：价格不涨的话，MA20 还要向下 ${turn - 1} 天。${after}`,
      change: turn === null ? `想提前转向，${BUY_TURN(l)}`
        : `第 ${turn} 天起 MA20 扣低值，价格不跌就会拐头向上。${l.close >= l.ema20 ? `价格已经在 EMA20 ${l.p(l.ema20)} 上方，EMA20 会先拐。` : `更早的信号是收盘站上 EMA20 ${l.p(l.ema20)}。`}`,
      effect: {
        flat: { tag: "支持", text: turn === null
          ? `支持${act("flat")}：20 天内进场条件都不会出现，不用盯盘；${l.close >= l.ema20 ? `已经在 EMA20 ${f2(l.ema20)} 上方，等它拐头向上` : `收盘站上 ${f2(l.ema20)}`}，再来看。`
          : `支持${act("flat")}：第 ${turn} 天前不会转向，不用急；之后看 MA20 能不能拐头向上。` },
        // 横盘的持仓打法是"拿着"，没有反弹要执行的动作：逆风对它是调整时机，其余类型的持仓打法本来就是反弹减
        ...(playKey(a) === "横盘震荡"
          ? held((k) => `调整时机：逆风还会持续，守住止损；${rebound}可以先减一些${
            k === "profit" ? "，锁住一部分利润" : ""}。`, "调整时机")
          : held((k) => `支持${act(k)}：逆风还会持续，${rebound}就执行${
            k === "loss" ? "，不要等涨回成本" : k === "profit" ? "，先锁住一部分利润" : ""}。`, "支持")),
      },
    };
  }
  if (a.lean.score >= 0.25) {
    const high = firstHigh(d20.path, a.close);
    // 横盘、过渡态的空仓打法是"不做"：短期顺风不等于买点，等的是排列条件
    const waitOnly = ["横盘震荡", "横盘破位", "过渡态"].includes(playKey(a));
    const waitFlat: Effect = { tag: "不变", text: `短期顺风，但排列条件还没满足：${act("flat")}不变，等排列理顺再说。` };
    return {
      verdict: high === null ? `顺风：未来 ${d20.path.length} 天 MA20 都扣低值，价格不跌就继续向上。${after}`
        : high <= 1 ? `顺风在减弱：明天起 MA20 就扣到高值。${after}`
        : `顺风：未来 ${high - 1} 天 MA20 扣低值，价格不跌就继续向上。${after}`,
      change: high === null ? `要转向，收盘得先跌破 EMA20 ${l.p(l.ema20)}，再跌破 MA20 抵扣价 ${l.p(l.drop20)}。`
        : `第 ${high} 天起 MA20 扣高值，那时一回调就容易拐头向下。先盯 EMA20 ${l.p(l.ema20)}。`,
      effect: high === null ? {
        flat: waitOnly ? waitFlat : { tag: "支持", text: `支持${act("flat")}：未来 ${d20.path.length} 天回调都有 MA20 托着，回踩 ${f2(l.ma20)} 附近就是机会。` },
        ...held((k) => `支持${act(k)}：顺风还在，收盘跌破 EMA20 ${f2(l.ema20)} 才需要警惕。`, "支持"),
      } : {
        flat: waitOnly ? waitFlat : { tag: "调整时机", text: high <= 1
          ? `调整时机：明天起 MA20 就扣高值，回调容易让它拐头向下，现在不是回踩买点的好窗口。`
          : `调整时机：第 ${high} 天前回调有 MA20 托着，是买点窗口；之后再买要更小心。` },
        ...held(() => `调整时机：${high <= 1 ? "明天起" : `第 ${high} 天后`} MA20 扣高值，回调更容易破位；${l.close >= l.ema20 ? `${high <= 1 ? "现在" : "那时"}把离场价收紧到 EMA20 ${f2(l.ema20)}` : `现在已经在 EMA20 ${f2(l.ema20)} 下方，EMA20 再拐头向下就按止损走`}。`, "调整时机"),
      },
    };
  }
  return {
    verdict: `没有明确方向：几条线方向不一致。${after}`,
    change: a.lean.flips[0] ? `${a.lean.flips[0].text}，方向才会清楚。` : "等均线理顺，方向才会清楚。",
    effect: {
      flat: { tag: "不变", text: `方向不明，${act("flat")}不变，等方向出来。` },
      ...held((k) => `方向不明，${act(k)}不变。`, "不变"),
    },
  };
}

/**
 * 结论、找打法、做推演的输出（规则生成，不经过模型）。
 *
 * - buildPlans：按"脚本的打法键（analysis.trade_plan.key）× 你的处境"给一句做法、两三条带价位的条件，和两个价位：
 *   trigger（空仓：进场触发；不买的打法是"先看"的价位；持仓：加仓或减仓的价位）、stop（空仓：进场后止损；持仓：止损）。
 *   进场、止损、目标位、盈亏比、股数读脚本的交易计划（trade_plan，skill 的 tradeplan.py），这里只配措辞，不重算。
 *   盈亏比不到 3:1 时空仓的做法改成"不做"，写出差多少；触发价离现价还远（entry.far）时不改，盈亏比写到时重算。
 *   用哪几条规则取自 skill 的 references/playbooks.md；规则满不满足、阈值、构造下一步价位、30 天求解都读脚本结果，这里不重算。
 *   处境分四种：空仓、持仓（没填成本）、持仓浮盈、持仓浮亏。成本只在浏览器里，文字里写 {cost}，由页面填上。
 * - buildChecklist：打法用到的每条规则今天的状态，没满足的写还差什么（价位读规则的 levels）。
 * - buildForecast：做推演先给模糊判断翻成的一句话（headline），再答三问，跨度都是 30 天：类型线还能保持多久、容忍到哪；
 *   打法的条件最早哪天能齐；什么价位推翻这个判断。groups 是 20、60 线组最近的关键变化（docs/adr/0030.md）。
 */
import type { Analysis, LeanLabel, PlanFar, PlanMountain, PlanSet, RuleResult, Solve, TradePlan } from "./citations.ts";
import { EVALUATION_DATE } from "./record.ts";

export type Position = "flat" | "holding";
/** 你的处境：空仓；持仓但没填成本；持仓浮盈；持仓浮亏。页面按"空仓/持仓"和成本价选一个。 */
export type Situation = "flat" | "holding" | "profit" | "loss";
export const SITUATIONS: Situation[] = ["flat", "holding", "profit", "loss"];
/** 计划文字里成本价的占位，页面填上用户输入的成本。 */
export const COST = "{cost}";
/**
 * rules：这条条件依据的规则编号（rules.md），页面上可以点开。
 * evidence：推演求解给的辅助信息，写评估结论（页面上缩小、标「辅助」）；主要的条件没有这一项。
 */
export interface PlanItem { label: string; text: string; rules?: string[]; evidence?: string }
/** 一个价位和它是什么。离现价多远由页面按收盘价算。 */
export interface Level { label: string; price: number }
/**
 * risk：从进场价（空仓：进场触发价；持仓：现价）到止损的距离，%；没有止损或止损不在下方时为 null。
 * trade：这个处境对应的脚本交易计划（空仓读 trade_plan.flat，持仓读 trade_plan.holding），目标、盈亏比、股数在里面。
 */
/**
 * 找打法第一格的一个词（docs/adr/0029.md）。空仓：做（条件今天齐了）、等（这套打法会买，触发价还没到）、不做（不买，或盈亏比不到 3:1）；
 * 持仓：拿着、减仓、离场。
 */
export type Verdict = "做" | "等" | "不做" | "拿着" | "减仓" | "离场";
export interface Plan { action: string; verdict: Verdict; items: PlanItem[]; trigger: Level | null; stop: Level | null; risk: number | null; trade: TradePlan }
type Draft = Omit<Plan, "risk" | "trade" | "verdict">;

/** 找打法的清单：一条规则今天的状态；need 是没满足时还差什么（带价位就写价位）。 */
/** yieldsTo：自己满足、但让位给这条规则（rules.md 的让位），这时不按它做。 */
export interface Check { id: string; name: string; status: RuleResult["status"]; basis: string; need: string | null; yieldsTo: string | null }
/**
 * 做推演的三问。invalid.level 是推翻判断的价位（画在 K 线图上）；没有单一价位时为 null。
 * aux：三问里哪几问的答案来自推演求解（辅助信息）；solves 是相关的求解，页面折叠起来。
 */
export interface Forecast {
  days: number;
  /** 模糊判断翻成动作的一句话，例如"接下来约 6 周均线向下：反弹是减仓机会，不是抄底机会"（LEAN_CALL）。 */
  headline: string;
  /** 20、60 线组最近的关键变化；aux 是推演求解给的那句（辅助），没有就是 null。 */
  groups: GroupChange[];
  /** 模糊判断的历史评估（H1）：标签和悬停的整句。 */
  leanEvidence: { tag: string; tip: string };
  hold: string;
  earliest: string;
  invalid: { text: string; level: Level | null };
  aux: ("earliest" | "invalid")[];
  solves: Solve[];
  evidence: string;
}

/** 一个线组：现在朝哪走（now），收盘不变哪天拐头、明天站上 / 跌破哪个价位就拐头（text），推演求解的最早哪天（aux）。 */
export interface GroupChange { group: 20 | 60; now: string; text: string; aux: string | null }

/** 模糊判断五档各翻成一句动作：均线往哪走，所以回撤 / 反弹该怎么看。不预测明天涨跌。 */
export const LEAN_CALL: Record<LeanLabel, string> = {
  明显偏多: "均线向上：回撤是加仓机会，不是离场信号",
  偏多: "均线偏向上：回撤多半是加仓机会，先别急着走",
  不明: "均线方向不明：不押方向，按打法的价位做，等 MA60、MA120 走出方向",
  偏空: "均线偏向下：反弹多半是减仓机会，先别急着抄底",
  明显偏空: "均线向下：反弹是减仓机会，不是抄底机会",
};

/** 模糊判断的历史评估（evaluation.toml 的 H1）：页面上挨着那句话放一个小标签，悬停看结论和出处。 */
export const LEAN_EVIDENCE = {
  tag: "历史评估：没验证出效果",
  tip: `历史评估（${EVALUATION_DATE}，H1）：86 只美股和 ETF，2013–2026 年日线，每 5 个交易日记一次大方向，看之后 20 个交易日的超额收益，`
    + "另留一半品种做验证集。主张是偏多之后跑赢、偏空之后跑输；结果偏多之后反而略跑输偏空，明显偏空之后 20 日超额反而最高："
    + "方向和主张相反，或者没用。这句话说的是均线接下来往哪走，不是涨跌预测，下单前当作风险提示。"
    + "出处：skill 的 SKILL.md「评估结论」、references/evaluation.toml [H1]。",
} as const;

/** 推演求解（"要涨 / 跌多少才能避免"）的评估结论，凡是显示求解结论的地方都附上（evaluation.toml 的 H4）。 */
export const SOLVER_EVIDENCE = "评估：说“要涨（跌）10% 以上才能避免”的事，97% 真的发生了，但未达到事先定的有用标准（H4）";

const f2 = (x: number) => x.toFixed(2);

/** 价位和它离现价多远，例如 "183.08（+21.3%）"。 */
function at(price: number, close: number) {
  const d = (price / close - 1) * 100;
  return `${f2(price)}（${d >= 0 ? "+" : ""}${d.toFixed(1)}%）`;
}

function ruleOf(a: Analysis, id: string): RuleResult {
  const r = a.rules.find((x) => x.id === id);
  if (!r) throw new Error(`分析结果里没有规则 ${id}`);
  return r;
}
const met = (a: Analysis, id: string) => ruleOf(a, id).status === "满足";
/** 规则今天的状态，写进计划文字，例如"满足（P11）"。 */
const st = (a: Analysis, id: string) => `${ruleOf(a, id).status}（${id}）`;

/**
 * 当下的均线状态，全部读脚本结果：止损、失效的条件可能现在就已经成立，那时要照实说"已经"。
 * - death / gold：20/60 最近一次完整站在哪边（steps 的 side，双交叉之后才换边）。
 * - ema20Down：EMA20 在向下（20 线组里先拐的那条）。
 * - lo / hi / spread：6 条线的最低、最高、相差（占价格 %）；rangeMax、dense、clear 是脚本的阈值。
 */
function stateOf(a: Analysis) {
  const side = a.steps.find((p) => p.pair === "20/60")?.side ?? null;
  const th = (k: string) => a.thresholds[k].value;
  return {
    death: side === "空头",
    gold: side === "多头",
    ema20Down: (a.lean.dirs.EMA20 ?? 0) < 0,
    lo: Math.min(...a.lines.flatMap((x) => [x.ma, x.ema])), hi: Math.max(...a.lines.flatMap((x) => [x.ma, x.ema])),
    spread: a.spread_pct, rangeMax: th("RANGE_SPREAD_PCT"), dense: th("DENSE_PCT"), clear: th("LEAN_CLEAR"),
    score: a.lean.score,
    flip: a.lean.flips.find((f) => f.toward === (a.lean.score >= 0 ? "空" : "多"))?.text ?? null,
    st: (id: string) => st(a, id),
    met: (id: string) => met(a, id),
    basis: (id: string) => ruleOf(a, id).basis,
    /** 规则给的价位（levels），没有就是 null。 */
    lvl: (id: string, key: string) => ruleOf(a, id).levels[key] ?? null,
    stage: a.regime.stage,
    /** 30 天求解：事件名以 prefix 开头、有临界价位的那条。 */
    solve30: (prefix: string, happen = true): Solve | null => a.projection.solves.find((s) =>
      s.days === FORECAST_DAYS && s.happen === happen && s.event.startsWith(prefix) && s.status === "有临界价位") ?? null,
  };
}

/** 做推演的跨度：和 MA60、MA120 的门槛路径、持平情景、模糊判断的依据同一个（脚本的 SCENARIO_DAYS）。 */
export const FORECAST_DAYS = 30;

function levels(a: Analysis) {
  const line = (n: number) => a.lines.find((l) => l.period === n)!;
  const drop = (n: number) => a.drops.find((d) => d.period === n)!;
  const tp = a.trade_plan;
  return {
    close: a.close,
    ema20: line(20).ema, ma20: line(20).ma, ma60: line(60).ma, ema60: line(60).ema,
    drop20: drop(20).tomorrow,
    /** 脚本交易计划的进场和止损价位（空仓进场后、持仓），没有就是 null。 */
    entry: tp.flat.entry, flatStop: tp.flat.stop?.price ?? null, holdStop: tp.holding.stop?.price ?? null,
    p: (x: number) => at(x, a.close),
    ...stateOf(a),
  };
}
type L = ReturnType<typeof levels>;
const lv = (label: string, price: number | null | undefined): Level | null => (price == null ? null : { label, price });
/** 交易计划里进场依据的规则 → 价位标签；now：条件今天就齐了，空仓的结论是"做"（只差小时线的 P13 还要等）。 */
const ENTRY: Record<string, { label: string; now: boolean }> = {
  P2: { label: "埋伏（现价）", now: true }, P21: { label: "突破买入（现价）", now: true }, P11: { label: "回撤到 60 线组", now: false },
  P12: { label: "底部构造完成", now: false }, P13: { label: "只差小时线（现价）", now: false }, P14: { label: "四条齐了（现价）", now: true },
  "P19、P20": { label: "20 线组一起拐头", now: false }, J19: { label: "构造完成、20 线组拐头", now: false },
};
/** 脚本给的进场触发价；条件里没有日线价位时为 null。 */
const entryLevel = (l: L) => (l.entry?.price == null ? null : lv(ENTRY[l.entry.rule]?.label ?? "进场", l.entry.price));
/** 30 天理顺向上要守在的价位。打架和过渡的空仓打法拿它当"先看"的价位，不是买点。 */
const alignUp = (l: L) => lv("30 天内理顺向上要守在", l.solve30("理顺向上")?.level);

/** "收盘站上 X"；现价已经在 X 上方时说"已经在 X 上方"。 */
const above = (l: L, name: string, x: number) => (l.close >= x ? `已经在 ${name} ${l.p(x)} 上方` : `收盘站上 ${name} ${l.p(x)}`);

const BUY_TURN = (l: L) =>
  (l.close >= l.ema20 ? `已经在 EMA20 ${l.p(l.ema20)} 上方，等 EMA20 拐头向上` : `收盘先站上 EMA20 ${l.p(l.ema20)}，EMA20 拐头向上`) + "；" +
  (l.close >= l.drop20 ? `也已经在 MA20 抵扣价 ${l.p(l.drop20)} 上方，MA20 会跟着拐头。` : `再站上 MA20 抵扣价 ${l.p(l.drop20)}，MA20 跟着拐头。`);
const SIZE: PlanItem = { label: "仓位", text: "盈亏影响心情，就是仓位太大，减到睡得着为止。" };
/** 横盘的止损底线是死叉；推演说避不开死叉（P3 的求解）时提前走，是辅助信息。 */
const SOLVER_STOP = (l: L): PlanItem =>
  ({ label: "推演", text: `${l.basis("P3")}；推演说避不开死叉时，可以提前走。`, rules: ["P3"], evidence: SOLVER_EVIDENCE });
const DEATH = (l: L) => l.death ? `20/60 已经双死叉（MA20、EMA20 都在 MA60 ${f2(l.ma60)}、EMA60 ${f2(l.ema60)} 下方）`
  : `20/60 双死叉（MA20 落到 MA60 ${f2(l.ma60)} 下方、EMA20 落到 EMA60 ${f2(l.ema60)} 下方）`;
/** 稳定上涨（下跌）的失效看 60/120（rules.md J7）：20/60 交叉只是深回撤（反弹）。 */
const TYPE_END = (l: L, up: boolean) => up
  ? `60/120 不再平行向上（60 线组拐头向下，MA60 ${f2(l.ma60)}、EMA60 ${f2(l.ema60)}；或 MA120 拐头向下）`
  : `60/120 不再平行向下（60 线组拐头向上，MA60 ${f2(l.ma60)}、EMA60 ${f2(l.ema60)}；或 MA120 拐头向上）`;
const GOLD = (l: L) => l.gold ? `20/60 已经双金叉（MA20、EMA20 都在 MA60 ${f2(l.ma60)}、EMA60 ${f2(l.ema60)} 上方）`
  : `20/60 双金叉（MA20 升过 MA60 ${f2(l.ma60)}、EMA20 升过 EMA60 ${f2(l.ema60)}）`;
/** 持仓的 EMA20 止损：收盘跌破 EMA20、EMA20 拐头向下就 {act}。两半都已成立时说"已经满足"，反弹到 EMA20 附近执行。 */
function ema20Stop(l: L, act: string): string {
  if (l.close < l.ema20 && l.ema20Down) return `止损条件已经满足（在 EMA20 ${l.p(l.ema20)} 下方、EMA20 向下）：还没${act}的，反弹到 EMA20 附近${act}掉，别再等。`;
  if (l.close < l.ema20) return `已经在 EMA20 ${l.p(l.ema20)} 下方；EMA20 再拐头向下，就${act}。`;
  return `收盘跌破 EMA20 ${l.p(l.ema20)}、EMA20 拐头向下，就${act}。`;
}
/** 横盘的失效：均线散开（脚本判横盘的判据，横盘时按定义还没发生）。 */
const TANGLE_END = (l: L, up: string, down: string) =>
  `6 条线现在相差 ${l.spread.toFixed(1)}%（${f2(l.lo)} ~ ${f2(l.hi)}）；超过 ${l.rangeMax}%、或 MA60 不再走平，就不是横盘了：向上散开${up}，向下散开${down}。`;
/** 过渡的失效：模糊判断到 ±LEAN_CLEAR，方向才算明显。 */
const TRANSITION_END = (l: L, up: string, down: string) =>
  `过渡说的是"还没理顺"。大方向现在 ${(Math.abs(l.score) < 0.005 ? 0 : l.score).toFixed(2)}，升到 ${l.clear} 以上${up}，降到 -${l.clear} 以下${down}；` +
  (l.flip ? `最近的变化门槛：${l.flip}。` : `价位上先看 EMA20 ${f2(l.ema20)} 和 MA20 抵扣价 ${f2(l.drop20)}：两条线最先拐。`);
/**
 * 空仓计划进场之后的止损：重新跌回 EMA20 下方、EMA20 再拐头向下就走。下跌类的进场条件是站上 EMA20（反过来就是止损）；
 * 过渡、两种打架的进场条件是排列理顺，理顺时价格必然在 EMA20 上方，同一条也适用。
 */
const ENTRY_STOP = (l: L): PlanItem =>
  ({ label: "进场后止损", text: `按条件进场后，收盘重新跌回 EMA20 下方（EMA20 现在 ${f2(l.ema20)}）、EMA20 再拐头向下，就走。` });

/**
 * 打法键 → 空仓 / 持仓的打法。键是脚本的 play.key（五种类型、空头结构反弹中、多头结构回撤中、过渡），横盘破位在这里另判。
 * 每份计划都有止损（空仓叫「进场后止损」，进场前要过的关叫「进场门槛」）和「失效」（判断错了的标志，以及接下来改用哪套打法）。
 * 做法那一句跟阶段走：已经在回撤（反弹）里，不再说"等回调"。
 * 用哪几条规则按 playbooks.md 的"类型 × 仓位"；每条条件的 rules 写出依据的规则编号，状态读脚本的规则清单。
 */
const PLAYS: Record<string, Record<Position, (l: L) => Draft>> = {
  横盘: {
    flat: (l) => ({
      action: l.entry?.rule === "P2" ? "末期三个条件齐了：小仓位埋伏。" : l.entry?.rule === "P21" ? "末期条件齐了、刚突破箱体：突破买入。" : "中段不做，等末期条件齐了再埋伏。",
      trigger: entryLevel(l), stop: lv(l.entry?.rule === "P21" ? "起涨 K 线最低价" : "20/60 死叉（守住）", l.flatStop), items: [
      { label: "等什么", text: `末期三个条件：横满 6 个月 ${l.st("J12")}，最高最低均线相差 < ${l.dense}% ${l.st("J13")}，均线向上张嘴 ${l.st("J14")}。`, rules: ["P1", "J12", "J13", "J14"] },
      { label: "方向", text: `横盘结束后往哪走跟周线：${l.basis("J11")}。`, rules: ["J11"] },
      { label: "怎么进", text: "三个条件齐了、还没突破时小仓位埋伏，不在箱体中间追。加分项：此前有大量、缺口，或假跌破后收回。", rules: ["P2", "P6"] },
      { label: "进场后止损", text: l.entry?.rule === "P21" ? `突破买入的底线是起涨 K 线最低价 ${l.flatStop === null ? "" : f2(l.flatStop)}：跌回突破前的平台，这次攻势就失败了。`
        : `埋伏后 20/60 死叉（MA20 落到 MA60 ${f2(l.ma60)} 下方）就走；先突破前高后很快跌回、随后跌破 20 线组（假突破的两个动作），也走。`, rules: l.entry?.rule === "P21" ? ["P22"] : ["P3", "P5"] },
      SOLVER_STOP(l),
      { label: "失效", text: TANGLE_END(l, "多半转上涨", "多半转下跌") },
    ] }),
    holding: (l) => ({ action: "拿着，但守住底线。", trigger: null, stop: lv("20/60 死叉（守住）", l.holdStop), items: [
      { label: "软规则", text: "进场后磨蹭不涨，没到止损也先出来。", rules: ["P4"] },
      { label: "止损", text: `20 线组和 60 线组死叉（MA60 ${f2(l.ma60)} 附近）就走。`, rules: ["P3"] },
      SOLVER_STOP(l),
      { label: "失效", text: TANGLE_END(l, "多半转上涨，可以拿着", "多半转下跌，减仓") },
      SIZE,
    ] }),
  },
  // 横盘、但埋伏的底线已经破了（P3 满足）
  横盘破位: {
    flat: (l) => ({ action: "底线已经破了：不埋伏，等多头排列。", trigger: null, stop: null, items: [
      { label: "等什么", text: `末期三个条件：横满 6 个月 ${l.st("J12")}，最高最低均线相差 < ${l.dense}% ${l.st("J13")}，均线向上张嘴 ${l.st("J14")}。`, rules: ["P1", "J12", "J13", "J14"] },
      { label: "进场门槛", text: `埋伏的底线现在就破了（${l.basis("P3")}）：MA20 ${f2(l.ma20)} / MA60 ${f2(l.ma60)}、EMA20 ${f2(l.ema20)} / EMA60 ${f2(l.ema60)}，别进；等多头排列再埋伏，之后一死叉就走。`, rules: ["P3"] },
      { label: "失效", text: TANGLE_END(l, "多半转上涨", "多半转下跌") },
    ] }),
    holding: (l) => ({ action: "底线已经破了：离场。", trigger: null, stop: lv("底线已破，现价离场", l.holdStop), items: [
      { label: "止损", text: `埋伏仓位的底线已经触发（${l.basis("P3")}；MA20 ${f2(l.ma20)} / MA60 ${f2(l.ma60)}、EMA20 ${f2(l.ema20)} / EMA60 ${f2(l.ema60)}）：离场，条件重新满足再进。`, rules: ["P3"] },
      { label: "失效", text: TANGLE_END(l, "多半转上涨，按上涨的打法重新进", "多半转下跌，更不该拿") },
      SIZE,
    ] }),
  },
  稳定上涨: {
    flat: (l) => ({
      action: l.met("P14") ? "吃回撤四个条件齐了：可以进。"
        : l.stage === "回撤中" ? "已经在回撤：等吃回撤的条件齐了再买，不抢。" : "等回调再买，不追高。",
      trigger: entryLevel(l), stop: lv("60 线组拐头向下", l.flatStop), items: [
      { label: "等什么", text: `吃回撤四个条件：中长期均线平行向上 ${l.st("P10")}；回撤到 60 线组（MA60 ${f2(l.ma60)}、EMA60 ${f2(l.ema60)}）且 MA120 方向不变 ${l.st("P11")}；这次回撤后出现底部构造 ${l.st("P12")}；小时线多头排列 ${l.st("P13")}。`, rules: ["P10", "P11", "P12", "P13"] },
      { label: "怎么进", text: `四条都满足才进场（现在 ${l.st("P14")}）。趋势确立后第一次回到 20 / 60 / 120 线组，是非常好的入场点。`, rules: ["P14", "P15"] },
      { label: "进场后止损", text: `和持仓同一条：60 线组拐头向下（MA60、EMA60 都向下；明天收盘低于 ${l.flatStop === null ? "—" : f2(l.flatStop)} 两条就都向下）才走。20/60 双死叉不算，60/120 还平行向上就是深回撤。LEI 给的吃回撤止损是抵抗性 K 线的最低价（P47），回测没测出好处，这里仍放在 60 线组拐头（解读，ADR 0036）。`, rules: ["A1", "J7", "P23"] },
      { label: "失效", text: `${TYPE_END(l, true)}：不再是稳定上涨，不再等回调买。20/60 交叉不算，60/120 还平行向上就是深回撤。`, rules: ["J7"] },
    ] }),
    holding: (l) => ({
      action: l.met("P14") ? "持有：吃回撤四个条件齐了，可以加。" : l.stage === "回撤中" ? "持有：已经在回撤，四个条件齐了再加。" : "持有，回调可以加仓。",
      trigger: entryLevel(l), stop: lv("60 线组拐头向下", l.holdStop), items: [
      { label: "加仓", text: `回撤到 60 线组、MA120 方向不变、出现底部构造、小时线多头排列，四条齐了加（现在 ${l.st("P14")}）。`, rules: ["P14"] },
      { label: "止损", text: `60 线组拐头向下（MA60 ${f2(l.ma60)}、EMA60 ${f2(l.ema60)} 都向下）才走。只是碰到 MA60 不算：价格击穿均线、MA 方向不变，就是吃回撤区；20/60 双死叉也不算，60/120 还平行向上就是深回撤。`, rules: ["A1", "J7"] },
      { label: "失效", text: `${TYPE_END(l, true)}，就不是稳定上涨了：不再回调加仓，改按过渡 / 下跌的打法。`, rules: ["J7"] },
      SIZE,
    ] }),
  },
  加速上涨: {
    flat: (l) => ({ action: "不追，只看不做。", trigger: lv("回落到 MA20（先看）", l.ma20), stop: null, items: [
      { label: "等什么", text: `等价格回落、靠近 MA20 ${l.p(l.ma20)}，均线重新组织后再看。`, rules: ["P7"] },
      { label: "为什么", text: "价格离成本太远，要回归：要么急跌找均线，要么横着走等均线。", rules: ["J9"] },
      { label: "进场后止损", text: `现在不进，没有止损。回落后按稳定上涨的买法进，止损跟着那套走：60 线组拐头向下才走。` },
      { label: "失效", text: `回落很浅、20 线组一直向上：回归是靠横盘等均线完成的，按稳定上涨的打法等回撤；${DEATH(l)}：上涨结束。` },
    ] }),
    holding: (l) => ({ action: l.met("P8") ? "拿着：没见顶部构造不下车。" : "见了顶部构造：只是提醒，等关键性波动再走。",
      trigger: null, stop: lv("跌破 EMA20、EMA20 向下", l.holdStop), items: [
      { label: "构造", text: l.met("P8")
        ? `顶部构造还没出现（${l.basis("J20")}），不必自己吓自己。`
        : `顶部构造已经出现（${l.basis("J20")}）。构造是路牌不是路，还不动手。`, rules: ["P8", "P9", "J20"] },
      { label: "止损", text: ema20Stop(l, "走").replace(/。$/, "（20 线组拐头向下就是关键性波动）。"), rules: ["J19"] },
      { label: "失效", text: `跌到 EMA20 下方后很快收回、20 线组继续向上：回归已经完成，按稳定上涨拿着；${DEATH(l)}：上涨结束。` },
      SIZE,
    ] }),
  },
  稳定下跌: {
    flat: (l) => ({ action: l.stage === "反弹中" ? "已经在反弹：不抄底，空仓等。" : "不抄底，空仓等。",
      trigger: lv("站上 EMA20（转强第一步，不是买点）", l.ema20), stop: null, items: [
      { label: "等什么", text: BUY_TURN(l), rules: ["P19", "P20"] },
      { label: "再等", text: "排列理顺成多头，才算底部确认。" },
      ENTRY_STOP(l),
      { label: "失效", text: `${TYPE_END(l, false)}：下跌判断失效，按过渡 / 上涨的打法看。20/60 金叉不算，60/120 还平行向下就是反弹。`, rules: ["J7"] },
    ] }),
    holding: (l) => ({ action: l.stage === "反弹中" ? "已经在反弹：到均线附近减仓或离场。" : "反弹到均线附近，减仓或离场。",
      trigger: lv("反弹减仓位 EMA20", l.ema20), stop: null, items: [
      { label: "减仓位", text: (l.close >= l.ema20 ? `已经在 EMA20 ${l.p(l.ema20)} 上方，现在就是减仓位（MA20 ${f2(l.ma20)} 附近也是）。`
        : `反弹到 EMA20 ${l.p(l.ema20)}、MA20 ${f2(l.ma20)} 附近。`)
        + `反弹卖出的四个触发：平行向下 ${l.st("P10")}，反弹到 60 线组 ${l.st("P11")}，顶部构造 ${l.st("P12")}，小时线空头排列 ${l.st("P13")}。`, rules: ["P10", "P11", "P12", "P13", "P14"] },
      { label: "别指望", text: "连涨几天改变不了双死叉，跌下去的价格要很久才回来。", rules: ["P16"] },
      { label: "止损", text: `下跌趋势里下方没有均线托底，止损不靠均线：${l.close >= l.ema20 ? `现在已经在 EMA20 ${f2(l.ema20)} 上方，就是离场点` : `反弹到 EMA20 ${f2(l.ema20)} 一带就是离场点`}；没等到反弹，也别把"心理价"一路往下挪。` },
      { label: "失效", text: `${TYPE_END(l, false)}：下跌判断失效，剩下的仓位可以按上涨拿着。`, rules: ["J7"] },
      SIZE,
    ] }),
  },
  加速下跌: {
    flat: (l) => ({ action: "不抢反弹，等底部构造和均线拐头。",
      trigger: entryLevel(l), stop: lv("20 线组拐头失败", l.flatStop), items: [
      { label: "等什么", text: `底部构造 ${l.st("J21")}；20 线组拐头向上（关键性波动）：${BUY_TURN(l)}`, rules: ["P7", "J21", "J19"] },
      { label: "怎么进", text: `两样都到了才进：底部构造完成、20 线组一起拐头向上${l.entry?.price == null ? "" : `（触发价 ${f2(l.entry.price)}）`}。下跌途中不抢。`, rules: ["P7", "J19"] },
      { label: "进场后止损", text: `拐头失败就走：进场后收盘跌回 ${l.flatStop === null ? "EMA20 和抵扣价" : f2(l.flatStop)} 下方，20 线组重新向下。`, rules: ["P23"] },
      { label: "失效", text: `${GOLD(l)}：下跌判断失效，按过渡 / 上涨的打法看。` },
    ] }),
    holding: (l) => ({ action: "不在急跌里割最低点，反弹再减仓。", trigger: lv("反弹减仓位 EMA20", l.ema20), stop: null, items: [
      { label: "减仓位", text: l.close >= l.ema20 ? `已经在 EMA20 ${l.p(l.ema20)} 上方，现在就是减仓机会。` : `反弹到 EMA20 ${l.p(l.ema20)} 附近，是减仓机会。` },
      { label: "为什么", text: "跌太急会回归成本，常有反弹找均线；但趋势没变，反弹是卖点。", rules: ["J9"] },
      { label: "止损", text: `下方没有均线托底，止损不靠均线：${l.close >= l.ema20 ? `现在已经在 EMA20 ${f2(l.ema20)} 上方，就是离场点` : `反弹到 EMA20 ${f2(l.ema20)} 一带就是离场点`}；不在急跌里割最低点，但也不把"心理价"一路往下挪。` },
      { label: "失效", text: `${above(l, "EMA20", l.ema20)}、EMA20 拐头向上，再加上 ${GOLD(l)}：下跌判断失效，剩下的仓位可以拿着。` },
      SIZE,
    ] }),
  },
  过渡: {
    flat: (l) => ({ action: "条件不满足，不做。", trigger: alignUp(l), stop: null, items: [
      { label: "等什么", text: l.gold ? `20 线组已经在 60 线组上方（MA60 ${f2(l.ma60)}）；还差多数线一起向上，大方向到明显偏多。`
        : `排列理顺：20 线组升到 60 线组上方（MA60 ${f2(l.ma60)}），多数线一起向上。`, rules: ["J6", "J15"] },
      { label: "小心", text: "中长期线压着的反弹，多半是假动作。", rules: ["J18"] },
      ENTRY_STOP(l),
      { label: "失效", text: TRANSITION_END(l, "（明显偏多）按上涨打", "（明显偏空）按下跌打") },
    ] }),
    holding: (l) => ({ action: "不加仓，减到心态稳得住。", trigger: null, stop: lv("跌破 EMA20、EMA20 向下", l.holdStop), items: [
      { label: "止损", text: ema20Stop(l, "减"), rules: ["P18"] },
      { label: "失效", text: TRANSITION_END(l, "可以按上涨拿着", "按下跌减仓") },
      SIZE,
    ] }),
  },
  空头结构反弹中: {
    flat: (l) => ({ action: "不买：中长期线压着的反弹，多半是假动作。", trigger: alignUp(l), stop: null, items: [
      { label: "等什么", text: `20 线组升到 60 线组上方（MA20 过 MA60 ${f2(l.ma60)}、EMA20 过 EMA60 ${f2(l.ema60)}），排列理顺再看。`, rules: ["P17", "J18"] },
      { label: "等多久", text: `${l.basis("J17")}。要很多天、价格得一直很强，就别等。`, rules: ["J17"], evidence: SOLVER_EVIDENCE },
      ENTRY_STOP(l),
      { label: "失效", text: `${GOLD(l)}、60 线组拐头向上：不再受压，这次反弹是真的，按上涨的打法看。` },
    ] }),
    holding: (l) => ({ action: "逢高减仓。", trigger: lv("减仓位 MA60", l.ma60), stop: lv("跌破 EMA20、EMA20 向下", l.holdStop), items: [
      { label: "减仓位", text: l.close >= l.ma60
        ? `已经在 MA60 ${l.p(l.ma60)} 上方，现在就是减仓机会。`
        : `反弹到 MA60 ${l.p(l.ma60)} 附近，是减仓机会。`, rules: ["P16"] },
      { label: "为什么", text: "排列不合理时的强反弹，多半撑不住（TSLA 2021-04-14 就是这样）。", rules: ["J18"] },
      { label: "止损", text: l.close >= l.ma60 ? ema20Stop(l, "走") : `没到减仓位就转头：${ema20Stop(l, "走")}` },
      { label: "失效", text: `${GOLD(l)}、60 线组拐头向上：不再受压，剩下的仓位可以按上涨拿着。` },
      SIZE,
    ] }),
  },
  多头结构回撤中: {
    flat: (l) => ({ action: "等回调结束再买，不在下跌途中接。",
      trigger: entryLevel(l), stop: lv("20 线组拐头失败", l.flatStop), items: [
      { label: "等什么", text: l.close < l.ema20 ? `20 线组重新拐头向上：收盘站上 EMA20 ${l.p(l.ema20)}。`
        : l.close < l.drop20 ? `已经在 EMA20 ${l.p(l.ema20)} 上方；再等 MA20 拐头向上：收盘高于 MA20 抵扣价 ${l.p(l.drop20)}。`
        : `已经在 EMA20 ${l.p(l.ema20)} 和 MA20 抵扣价 ${l.p(l.drop20)} 上方：守住几天、MA20 拐头向上，回调就结束了。`, rules: ["P19", "P20"] },
      { label: "位置", text: l.close >= l.ma60
        ? `回踩到 MA60 ${l.p(l.ma60)} 附近止跌，更好。`
        : `已经跌到 MA60 ${l.p(l.ma60)} 下方：很快收回来才算有撑，收不回来就等 20/60 怎么交叉。` },
      { label: "进场后止损", text: `拐头失败就走：进场后收盘跌回 ${l.flatStop === null ? "EMA20 和抵扣价" : f2(l.flatStop)} 下方（EMA20 和进场次日的 MA20 抵扣价里较低的），20 线组重新向下。`, rules: ["P23"] },
      { label: "失效", text: `${DEATH(l)}：结构坏了，不再有撑，按过渡 / 下跌的打法看。`, rules: ["J16"] },
    ] }),
    holding: (l) => ({ action: "持有观察，不在急跌里卖。", trigger: null,
      stop: lv("20/60 双死叉（守住）", l.holdStop), items: [
      { label: "止损", text: `${DEATH(l)}才算结构坏，那时再走。`, rules: ["J16"] },
      { label: "失效", text: `出现上面的止损信号就不再有撑：结构转空，剩下没走的仓位按过渡 / 下跌的打法处理（MA60 ${f2(l.ma60)}、EMA60 ${f2(l.ema60)} 是分界）。` },
      SIZE,
    ] }),
  },
};


/**
 * 浮盈 / 浮亏时持仓计划怎么改：多一行「盈亏」，必要时换掉做法、去掉不再成立的条目。
 * 每种趋势类型各写一条，和同一张计划里的其他条目说同一件事（偏多浮亏不说"再加"配"不加仓"这种话）。
 * 来源：playbooks.md 仓位一节、各类型的离场条件；加速上涨有仓位看构造和关键性波动（P8、P9）。
 * 止损放在趋势结构上，什么原则进就什么原则出（视频 F 05:39）；成本价只用来算仓位，不拿来定止损。
 */
interface PnlTweak { line: string; action?: string; omit?: string[] }
const PNL: Record<string, Record<"profit" | "loss", PnlTweak>> = {
  横盘: {
    profit: { line: `还有浮盈：止损还是埋伏的底线（20/60 交叉），什么原则进就什么原则出；成本 ${COST} 只用来算仓位。磨蹭不涨就先走。` },
    loss: { line: "已经浮亏：守住止损（20/60 死叉），不在箱体里加仓摊低，也不死等回本。" },
  },
  横盘破位: {
    profit: { line: `还有浮盈：底线已经破了，带着利润走（成本 ${COST}），别让它变成亏损。` },
    loss: { line: "已经浮亏：底线破了就认，不加仓摊低，不等回本。" },
  },
  稳定上涨: {
    profit: { line: `还有浮盈：成本 ${COST} 在下方是安全垫，按趋势规则拿着，不因小回调卖掉。` },
    loss: { line: "暂时浮亏：趋势还向上，不急着割；不在浮亏时急着加仓摊低，等吃回撤的四个条件齐了再加。" },
  },
  加速上涨: {
    profit: { line: `浮盈不少：成本 ${COST} 在下方是安全垫。没见顶部构造就拿着；见了也只是提醒，20 线组拐头向下再走。` },
    loss: {
      action: "追在高位、暂时浮亏：不加仓，跌破 EMA20 就走。",
      line: "已经浮亏：多半是追高买的。不加仓摊低，按止损走，不等回本。",
      omit: ["构造"], // 亏着钱时"不必自己吓自己"说不通，按止损走
    },
  },
  稳定下跌: {
    profit: { line: `还有浮盈：止损跟着趋势结构走，不按成本 ${COST} 定；反弹到减仓位先减一部分，别让盈利变成亏损。` },
    loss: { line: "已经浮亏：不等回本。反弹到减仓位就执行，减到浮亏不影响心情为止。" },
  },
  加速下跌: {
    profit: { line: `还有浮盈：止损跟着趋势结构走，不按成本 ${COST} 定；反弹到减仓位先减一部分，别让盈利变成亏损。` },
    loss: { line: "已经浮亏：不等回本。反弹到减仓位就执行，减到浮亏不影响心情为止。" },
  },
  过渡: {
    profit: { line: `还有浮盈：止损跟着趋势结构走，不按成本 ${COST} 定；排列理顺前不加仓。` },
    loss: { line: "已经浮亏：不加仓摊低；按止损减，不等回本。" },
  },
  空头结构反弹中: {
    profit: { line: `还有浮盈：止损跟着趋势结构走，不按成本 ${COST} 定；到减仓位先锁住一部分利润。` },
    loss: { line: "已经浮亏：不等回本。到减仓位就减，这种反弹多半撑不住。" },
  },
  多头结构回撤中: {
    profit: { line: `还有浮盈：成本 ${COST} 在下方是安全垫，结构还是多头，不在回调里卖。` },
    loss: { line: "暂时浮亏：结构还是多头，不急着割；但不加仓摊低，20/60 双死叉就走。" },
  },
};

/** 九套打法的键（交易计划的 key）。练习的打法补全按它配平、查短语表。 */
export const PLAY_KEYS = Object.keys(PLAYS);

/** 这份分析该用哪套打法：脚本交易计划的打法键（横盘里埋伏的底线已经破了时是横盘破位）。 */
export function playKey(a: Analysis): string {
  return a.trade_plan.key;
}

/** 盈亏比两位小数：0.03:1 写成 0.0:1 会像算错了。 */
const ratio = (x: number) => `${x.toFixed(2)}:1`;

/** 目标位一句：价位、是什么、离现价多远；解读的标出来。 */
/** 阻力位的序号：第一阻力、第二阻力（LEI 叫目标位，P25）。 */
const ORDINAL = ["第一", "第二", "第三"];

function targetsText(t: TradePlan, close: number): string {
  return t.targets.map((x, i) => `${i === 0 ? "第一阻力/目标位" : `${ORDINAL[i] ?? `第 ${i + 1} `}阻力`}：${x.kind} ${at(x.price, close)}${x.source === "解读" ? "（解读）" : ""}`).join("；");
}

/** 上方最近的筹码山一句（P38）：山脚到山顶这条带，只作参考（docs/adr/0018.md）。 */
function mountainText(m: PlanMountain, close: number): string {
  return `上方最近的筹码山：山脚 ${at(m.foot, close)}到山顶 ${f2(m.top)} 这条带。只作参考，不排进第一阻力，不算进盈亏比。`;
}

/** 触发价离现价还远（docs/adr/0026.md）：明天的触发价只是按明天就拐头算的，盈亏比到价格走近时再算。 */
const RR_FAR = "触发价离现价还远，到时重算";

/** 盈亏比一句：几比几、哪一档；不做时写差多少；触发价离现价还远时只说到时重算。 */
export function rrText(t: TradePlan): string | null {
  if (t.rr === null || t.rr_verdict === null) return null;
  if (t.entry?.far) return `${RR_FAR}。`;
  if (t.rr_verdict === "不做") {
    const g = t.rr_gap!;
    return `${ratio(t.rr)}，不到 3:1，不做：第一阻力得在 ${f2(g.target_for_min)} 以上，或止损收紧到 ${f2(g.stop_for_min)}，才够 3:1。`;
  }
  return `${ratio(t.rr)}，${t.rr_verdict}（不到 3:1 不做，5:1 以上理想）。`;
}

/** 股数一句：填了账户给股数，没填给每 1 万元风险对应多少股；触发价离现价还远时和盈亏比一样到时重算。 */
export function sizeText(t: TradePlan): string | null {
  const z = t.size;
  if (!z) return null;
  if (t.entry?.far) return `${RR_FAR}。`;
  if (z.shares === null) return `没填账户：每 1 万元风险对应 ${z.per_10k} 股（单位亏损 ${f2(z.unit_risk)}）。在设置里填账户规模，就按每笔可承受亏损给股数。`;
  return `${z.shares} 股：${z.basis}。`;
}

/** 百分比：去掉没意义的尾零（50、3.2、0.4）。 */
const pctNum = (x: number) => String(Number(x.toFixed(x >= 10 ? 0 : 1)));

/**
 * 仓位比例一句（ADR 0039）：用账户的百分之几 = 每笔愿意亏的比例 ÷ 止损幅度，不需要账户总额。
 * 按固定金额又没填账户时算不出比例，不写；超过 100% 如实写，按买得起的最多股数；触发价离现价还远时到时重算。
 */
export function positionPctText(t: TradePlan): string | null {
  const z = t.size;
  if (!z || z.account_pct == null || z.risk_pct == null || z.stop_pct == null) return null;
  if (t.entry?.far) return `${RR_FAR}。`;
  const why = `止损幅度 ${pctNum(z.stop_pct)}%，每笔亏账户的 ${pctNum(z.risk_pct)}%`;
  return z.account_pct > 100
    ? `要用账户的 ${pctNum(z.account_pct)}%（${why}），超过账户：按买得起的最多股数。`
    : `用账户的 ${pctNum(z.account_pct)}%（${why}）。`;
}

/** 触发价离现价还远：按收盘持平推演，最早哪天、站上哪个价位 20 线组一起拐头，和明天要站上的触发价。 */
function farText(far: PlanFar, tomorrow: number, close: number, dates: string[]): string {
  return `按收盘持平推演，20 线组最早约 ${far.day} 个交易日后（${dates[far.day - 1]}）、收盘站上 ${at(far.level, close)}才会一起拐头；` +
    `明天要拐头得站上 ${at(tomorrow, close)}。`;
}

/**
 * 空仓会买时，计划里多四条：目标、到目标怎么办、盈亏比、股数；持仓只多前两条。上方有筹码山时两边都再加一条「参考」。
 * 空仓的触发价离现价还远时，最前面再加一条「触发价」（推演求解，辅助）。
 */
function tradeItems(t: TradePlan, close: number, flat: boolean, dates: string[]): PlanItem[] {
  const out: PlanItem[] = [];
  const e = t.entry;
  if (flat && e?.far) out.push({ label: "触发价", text: farText(e.far, e.price!, close, dates), rules: e.rule.split("、"), evidence: SOLVER_EVIDENCE });
  if (t.targets.length) out.push({ label: "阻力位/目标位", text: targetsText(t, close), rules: ["P25"] });
  if (t.at_target) out.push({ label: "到第一阻力", text: t.at_target, rules: ["P25"] });
  const rr = flat ? rrText(t) : null;
  if (rr) out.push({ label: "盈亏比", text: rr, rules: ["P24"] });
  const size = flat ? sizeText(t) : null;
  if (size) out.push({ label: "股数", text: size, rules: ["A6"] });
  const pct = flat ? positionPctText(t) : null;
  if (pct) out.push({ label: "仓位比例", text: pct, rules: ["A6"] });
  if (t.mountain) out.push({ label: "参考", text: mountainText(t.mountain, close), rules: ["P38"] });
  return out;
}

/** 把目标、盈亏比、股数插在止损之前（计划的顺序：等什么 → 怎么进 → 目标 → 盈亏比 → 股数 → 止损 → 失效 → 仓位）。 */
function withTrade(items: PlanItem[], extra: PlanItem[]): PlanItem[] {
  const at = items.findIndex((i) => ["进场门槛", "止损", "进场后止损", "失效"].includes(i.label));
  const k = at < 0 ? items.length : at;
  return [...items.slice(0, k), ...extra, ...items.slice(k)];
}

/** 持仓的结论按打法定，和各打法持仓那句做法说同一件事。浮盈 / 浮亏不改。 */
export const HOLD_VERDICT: Record<string, Verdict> = {
  横盘: "拿着", 横盘破位: "离场", 稳定上涨: "拿着", 加速上涨: "拿着", 多头结构回撤中: "拿着",
  稳定下跌: "减仓", 加速下跌: "减仓", 过渡: "减仓", 空头结构反弹中: "减仓",
};
/** 空仓的结论：不买或盈亏比不到 3:1（触发价还远时不算）是不做；条件今天齐了是做；其余是等。 */
function flatVerdict(t: TradePlan): Verdict {
  if (t.entry === null || (t.rr_verdict === "不做" && !t.entry.far)) return "不做";
  return ENTRY[t.entry.rule]?.now ? "做" : "等";
}

/** 盈亏比不到 3:1：空仓的做法改成不做（P24）。触发价离现价还远时不改：盈亏比到时重算。 */
function flatAction(d: Draft, t: TradePlan): string {
  return t.rr_verdict === "不做" && !t.entry?.far ? `不做：盈亏比 ${ratio(t.rr!)}，不到 3:1。` : d.action;
}

/** 按趋势类型和阶段定的打法。浮盈 / 浮亏在持仓打法的做法之后加一行「盈亏」，价位和持仓一样。 */
export function buildPlans(a: Analysis): Record<Situation, Plan> {
  const key = playKey(a);
  const play = PLAYS[key];
  const l = levels(a);
  const tp = a.trade_plan;
  const hold = play.holding(l);
  const holding: Draft = { ...hold, items: withTrade(hold.items, tradeItems(tp.holding, a.close, false, a.projection.dates)) };
  const withPnl = (k: "profit" | "loss"): Draft => {
    const t = PNL[key][k];
    return {
      ...holding,
      action: t.action ?? holding.action,
      items: [{ label: "盈亏", text: t.line }, ...holding.items.filter((i) => !t.omit?.includes(i.label))],
    };
  };
  const f = play.flat(l);
  const flat: Draft = { ...f, action: flatAction(f, tp.flat), items: withTrade(f.items, tradeItems(tp.flat, a.close, true, a.projection.dates)) };
  const drafts: Record<Situation, Draft> = { flat, holding, profit: withPnl("profit"), loss: withPnl("loss") };
  return Object.fromEntries(SITUATIONS.map((k) => {
    const trade = k === "flat" ? tp.flat : tp.holding;
    const verdict = k === "flat" ? flatVerdict(trade) : HOLD_VERDICT[key];
    return [k, { ...drafts[k], verdict, risk: trade.risk_pct, trade }];
  })) as Record<Situation, Plan>;
}

/** 结论里的一行（给模型看的数据字段）：做法、触发价、止损、风险。空仓的止损叫进场后止损。 */
export function planLine(p: Plan, close: number, flat: boolean): string {
  const parts = [p.action.replace(/。$/, "")];
  if (p.trigger) parts.push(`${p.trigger.label} ${at(p.trigger.price, close)}`);
  if (p.stop) parts.push(`${flat ? "进场后止损" : "止损"}：${p.stop.label} ${at(p.stop.price, close)}`);
  if (p.risk !== null) parts.push(`到止损 ${p.risk.toFixed(1)}%`);
  if (p.trade.targets.length) parts.push(targetsText(p.trade, close));
  if (flat && p.trade.rr !== null) parts.push(p.trade.entry?.far ? "盈亏比到时重算（触发价离现价还远）" : `盈亏比 ${ratio(p.trade.rr)}（${p.trade.rr_verdict}）`);
  return parts.join("；");
}

/** 交易计划给模型看的数据字段（[[D:计划.进场]] 这样引用）：键、说明、值。价位都是脚本的 trade_plan。 */
export function planFacts(tp: PlanSet, close: number): [string, string, string][] {
  const f = tp.flat, h = tp.holding;
  const price = (x: number | null) => (x === null ? "没有日线价位" : at(x, close));
  const stopText = (s: TradePlan["stop"]) => s ? `${price(s.price)}，${s.reason}（${s.rule}${s.source === "解读" ? "，解读" : ""}）` : null;
  const why = f.notes.join("；");
  const noTarget = h.notes.find((n) => /阻力|目标/.test(n)) ?? "上方没有阻力位";
  const out: [string, string, string][] = [
    ["计划.进场", "空仓的进场触发价和条件（交易计划）", f.entry ? `${price(f.entry.price)}，${f.entry.condition}（${f.entry.rule}）` : `空仓不进场：${why || "这套打法不买"}`],
  ];
  if (f.entry) {
    out.push(
      ["计划.止损", "空仓进场后的止损（什么原则进就什么原则出，P23）", stopText(f.stop) ?? "没有止损价"],
      ["计划.目标", "空仓进场后的阻力位（P25，LEI 叫目标位）", f.targets.length ? targetsText(f, close) : (f.notes.find((n) => /阻力|目标/.test(n)) ?? "第一阻力算不出")],
      ["计划.到目标", "空仓进场后到了第一阻力怎么办（P25）", f.at_target ?? "没有阻力位"],
      ["计划.盈亏比", "盈亏比：(第一阻力 − 进场) ÷ (进场 − 止损)，不到 3:1 不做（P24）；触发价离现价还远时到时重算", rrText(f) ?? `算不了：${why}`],
      ["计划.股数", "建议股数：每笔可承受亏损 ÷ (进场 − 止损)，向下取整（A6）", sizeText(f) ?? `算不了：${why}`],
      ["计划.仓位比例", "仓位占账户 = 每笔愿意亏的比例 ÷ 止损幅度（ADR 0039）", positionPctText(f) ?? "算不出：按固定金额又没填账户，或没有止损"],
    );
  }
  out.push(
    ["计划.持仓止损", "持仓的止损（按进场的原则，不按成本）", stopText(h.stop) ?? h.notes.join("；")],
    ["计划.持仓目标", "持仓的阻力位（P25，LEI 叫目标位）", h.targets.length ? targetsText(h, close) : noTarget],
    ["计划.持仓到目标", "持仓到了第一阻力怎么办（P25）", h.at_target ?? noTarget],
  );
  return out;
}

// ---------- 找打法：条件清单 ----------

/** 没满足的规则还差什么：读规则自己给的价位；构造类给下一根要越过的价位和最少还差几根（脚本的 structure）。 */
function needOf(a: Analysis, r: RuleResult): string | null {
  if (r.status === "满足") return null;
  if (r.status === "需看图") return r.id === "P13" ? "小时线取不到，看小时图" : "脚本算不了，看图";
  const v = (k: string) => r.levels[k] ?? null;
  const step = v("下一步价");
  if (step !== null) {
    const k = [a.structure.bottom, a.structure.top].find((c) => c?.next_at === step)!;
    const word = k.side === "底部构造" ? "最高价高于" : "最低价低于";
    return `${k.side}：下一根${word} ${at(step, a.close)}${k.bars_left === 1 ? "就完成" : "，再来一根越过那根才完成"}（最少还差 ${k.bars_left} 根）`;
  }
  const group = v("60 线组");
  if (r.id === "P11" && group !== null && a.close > group) return `回撤到 60 线组 ${at(group, a.close)}`;
  if (r.id === "P19" && a.close < v("EMA20")!) return `收盘站上 EMA20 ${at(v("EMA20")!, a.close)}，EMA20 拐头向上`;
  if (r.id === "P20") return `收盘高于 MA20 抵扣价 ${at(v("MA20 明天抵扣价")!, a.close)}，MA20 拐头向上`;
  if (r.id === "P14") return "上面几条都满足";
  if (r.id === "P13") return "小时线排列理顺（看小时图，日线推不出价位）";
  return null;   // 没有价位可给：依据一栏已经说了现在是什么样
}

/** 打法用到的规则（按 play.rules 的顺序），加上满足但让位给别人的规则。 */
export function buildChecklist(a: Analysis): Check[] {
  const ids = [...a.play.rules, ...a.rules.filter((r) => r.yields_to && !a.play.rules.includes(r.id)).map((r) => r.id)];
  return ids.map((id) => {
    const r = ruleOf(a, id);
    return { id, name: r.name, status: r.status, basis: r.basis, need: needOf(a, r), yieldsTo: r.yields_to };
  });
}

// ---------- 做推演：三问，跨度 30 天 ----------

const WAY = { 上: "向上", 下: "向下", 平: "走平" } as const;

/** 问一：类型线 MA60、MA120 收盘不变能朝今天的方向走几天；天天这样走要守在哪（安全边际）。数字来自 lean.basis。 */
function holdText(a: Analysis): string {
  return a.lean.basis.map((b) => {
    const kept = b.hold_days >= b.days ? `${b.days} 天都${WAY[b.direction]}` : `还能${WAY[b.direction]} ${b.hold_days} 天`;
    if (b.direction === "平") return `${b.line} 走平`;
    return `${b.line} 收盘不变，${kept}；${b.days} 天里收盘守在 ${at(b.level, a.close)}${b.direction === "上" ? "之上" : "之下"}，天天${WAY[b.direction]}`;
  }).join("。") + "。";
}

const DIR = { 1: "向上", 0: "走平", [-1]: "向下" } as const;
/** 明天收盘在门槛哪一边决定这条线明天往哪走：键是"现在的方向 + 门槛转向哪边"（Flip.toward）。w 是门槛叫什么，p 是价位。 */
const GATE: Record<string, (k: string, w: string, p: string) => string> = {
  "-1多": (k, w, p) => `明天收盘站上 ${w} ${p}，${k} 就拐头向上`,
  "-1空": (k, w, p) => `收盘不变，${k} 明天就拐头向上；跌破 ${w} ${p} 才继续向下`,
  "1空": (k, w, p) => `明天收盘跌破 ${w} ${p}，${k} 就拐头向下`,
  "1多": (k, w, p) => `收盘不变，${k} 明天就拐头向下；站上 ${w} ${p} 才继续向上`,
  "0多": (k, w, p) => `明天收盘站上 ${w} ${p}，${k} 向上`,
  "0空": (k, w, p) => `明天收盘跌破 ${w} ${p}，${k} 向下`,
};

/**
 * 一个线组最近的关键变化：方向读 lean.dirs，收盘不变哪天拐头读持平情景，明天的门槛读 lean.flips（EMA 是线本身，MA 是抵扣价）。
 * 20 线组触发价离现价还远时（entry.far，#68）加一句推演求解的最早哪天，标辅助。
 */
function groupChange(a: Analysis, g: 20 | 60): GroupChange {
  const keys = [`EMA${g}`, `MA${g}`];
  const dir = (k: string) => a.lean.dirs[k] ?? 0;
  const [de, dm] = keys.map(dir);
  const now = de === dm ? DIR[de] : keys.map((k) => `${k} ${DIR[dir(k)]}`).join("、");
  const sc = a.projection.scenarios[0];
  const day = (k: string) => sc.turns.find((t) => t.line === k)?.turn_day ?? null;
  const still = keys.every((k) => day(k) === null) ? `收盘不变，${sc.days} 天内都不拐头`
    : `收盘不变：${keys.map((k) => (day(k) === null ? `${k} ${sc.days} 天内不拐头` : `${k} ${dayN(a, day(k)!)}拐头`)).join("，")}`;
  const gates = keys.flatMap((k) => {
    const f = a.lean.flips.find((x) => x.line === k);
    return f ? [GATE[`${dir(k)}${f.toward}`](k, k.startsWith("EMA") ? k : `${k} 抵扣价`, at(f.price, a.close))] : [];
  });
  const far = g === 20 ? a.trade_plan.flat.entry?.far : null;
  const aux = far ? `按收盘持平推演，最早 ${dayN(a, far.day)}一起拐头向上：收盘站上 ${at(far.level, a.close)}。` : null;
  return { group: g, now, text: `${[still, ...gates].join("；")}。`, aux };
}

/** 推演第 n 个交易日的日期（脚本给的工作日，不扣节假日）。 */
const dayN = (a: Analysis, n: number) => `${a.projection.dates[n - 1]}（第 ${n} 个交易日）`;
/** 触发价离现价还远时，20 线组最早哪天一起拐头（按收盘持平推演）。 */
const farEarliest = (a: Analysis, far: PlanFar, tomorrow: number) =>
  `按收盘持平推演，20 线组最早 ${dayN(a, far.day)}一起拐头：收盘站上 ${at(far.level, a.close)}；明天要拐头得站上 ${at(tomorrow, a.close)}。`;

/** 问二：打法的条件最早哪天能齐。构造按最少还差几根，价位条件最早明天；小时线、横满几个月这种照实说。 */
function earliestOf(a: Analysis, l: L, key: string, plans: Record<Situation, Plan>): { text: string; solved?: boolean } {
  const text = earliestText(a, l, key, plans);
  if (text !== null) return { text };
  // 其余是空仓不买的打法：答"30 天内理顺向上要持平在哪"，是求解
  const s = l.solve30("理顺向上");
  return s ? { text: `这套打法空仓不买。${FORECAST_DAYS} 天内要理顺向上，收盘得持平在 ${at(s.level!, a.close)}${s.side}。`, solved: true }
    : { text: "这套打法空仓不买。排列理顺之前不看进场。" };
}

function earliestText(a: Analysis, l: L, key: string, plans: Record<Situation, Plan>): string | null {
  const bars = (id: string) => l.lvl(id, "还差几根");
  switch (key) {
    case "稳定上涨": {
      if (l.met("P14")) return "吃回撤四个条件今天就齐了。";
      const wait: [number, string][] = [];
      if (!l.met("P11")) wait.push([1, "回撤到 60 线组"]);
      if (!l.met("P12")) wait.push([bars("P12") ?? 1, bars("P12") ? `底部构造最少还差 ${bars("P12")} 根` : "这次回撤后出现底部构造"]);
      const hourly = l.met("P13") ? "" : "小时线多头排列看小时图，日线推不出日子。";
      if (!wait.length) return `日线的条件都齐了，只差小时线：${hourly}`;
      const n = Math.max(...wait.map(([d]) => d));
      return `最早 ${dayN(a, n)}：${wait.map(([, t]) => t).join("，")}。${hourly}`;
    }
    case "多头结构回撤中": {
      const t = plans.flat.trigger;
      if (l.entry?.far) return farEarliest(a, l.entry.far, l.entry.price!);
      return t ? `最早明天 ${dayN(a, 1)}：收盘${t.label} ${at(t.price, a.close)}。`
        : "已经在 EMA20 和 MA20 抵扣价上方：守住几天、MA20 拐头向上，回调就结束了。";
    }
    case "加速下跌": {
      const n = l.met("J21") ? null : bars("J21");
      return `这套打法空仓不买。${n ? `底部构造最早 ${dayN(a, n)}完成，` : ""}之后还要 20 线组拐头向上（关键性波动）。` +
        (l.entry?.far ? farEarliest(a, l.entry.far, l.entry.price!) : "");
    }
    case "横盘": {
      const r = a.regime.range;
      const need = r ? a.thresholds.RANGE_MIN_DAYS.value - r.days : null;
      const months = l.met("J12") || need === null || need <= 0 ? "横满 6 个月已经够了"
        : need <= FORECAST_DAYS ? `横满 6 个月最早 ${dayN(a, need)}` : `横满 6 个月还要 ${need} 个交易日，${FORECAST_DAYS} 天内齐不了`;
      return `${months}；均线相差 < ${l.dense}%、向上张嘴要看走势，推不出日子。`;
    }
    default: return null;
  }
}

/** 求解的事件在价位哪一边发生：求"不发生"的，发生在另一边。 */
const happensAt = (s: Solve) => (s.happen ? s.side : s.side === "以上" ? "以下" : "以上");

/** 问三：什么价位推翻这个判断。稳定类看 MA120 的安全边际；加速、打架看 20/60 的 30 天求解；横盘、过渡没有单一价位，用计划里的失效。 */
function invalidOf(a: Analysis, l: L, key: string, plans: Record<Situation, Plan>): Forecast["invalid"] & { solved?: boolean } {
  const fallback = { text: plans.flat.items.find((i) => i.label === "失效")!.text, level: null };
  const b120 = a.lean.basis.find((b) => b.line === "MA120");
  const viaSolve = (prefix: string, happen: boolean, what: string) => {
    const s = l.solve30(prefix, happen);
    if (!s) return fallback;
    return { text: `收盘停在 ${at(s.level!, a.close)}${happensAt(s)}，${FORECAST_DAYS} 天内 ${what}。`, level: lv("判断失效", s.level), solved: true };
  };
  switch (key) {
    case "稳定上涨":
    case "稳定下跌": {
      const up = key === "稳定上涨";
      if (!b120 || b120.direction !== (up ? "上" : "下")) return fallback;
      return { text: `${b120.days} 天里收盘${up ? "跌破" : "升过"} ${at(b120.level, a.close)}，MA120 就可能拐头${up ? "向下" : "向上"}：60/120 不再平行${up ? "向上" : "向下"}，不再是${key}。`,
        level: lv("判断失效：MA120 守不住", b120.level) };
    }
    case "加速上涨": return viaSolve("20 线组双双跌破 60 线组", false, "20/60 会双死叉：上涨结束");
    case "多头结构回撤中": return viaSolve("20 线组双双跌破 60 线组", false, "20/60 会双死叉：结构坏了，不再有撑");
    case "加速下跌": return viaSolve("20 线组双双站上 60 线组", true, "20/60 会双金叉：下跌判断失效");
    case "空头结构反弹中": return viaSolve("理顺向上", true, "20 线组理顺到 60 线组上方、60 线组向上：不再受压，反弹是真的");
    default: return fallback;
  }
}

/** 和这套打法相关的 30 天求解（最多 3 个）；其余的页面折叠起来。 */
const SOLVES_FOR: Record<string, string[]> = {
  稳定上涨: ["MA60 拐头", "MA120 拐头", "20 线组双双"], 稳定下跌: ["MA60 拐头", "MA120 拐头", "20 线组双双"],
  加速上涨: ["MA20 拐头", "20 线组双双"], 加速下跌: ["MA20 拐头", "20 线组双双"], 多头结构回撤中: ["MA20 拐头", "20 线组双双"],
  空头结构反弹中: ["理顺向上", "20 线组双双", "MA60 拐头"], 过渡: ["理顺向上", "20 线组双双", "MA60 拐头"],
  横盘: ["20 线组双双", "60 线组双双"], 横盘破位: ["20 线组双双", "60 线组双双"],
};

export function buildForecast(a: Analysis, plans = buildPlans(a)): Forecast {
  const l = levels(a);
  const key = playKey(a);
  const solves = a.projection.solves.filter((s) => s.days === FORECAST_DAYS && SOLVES_FOR[key].some((p) => s.event.startsWith(p)));
  const { solved, ...invalid } = invalidOf(a, l, key, plans);
  const earliest = earliestOf(a, l, key, plans);
  const aux = [...(earliest.solved ? ["earliest" as const] : []), ...(solved ? ["invalid" as const] : [])];
  return {
    days: FORECAST_DAYS, headline: `接下来约 6 周${LEAN_CALL[a.lean.label]}`, groups: [groupChange(a, 20), groupChange(a, 60)], leanEvidence: LEAN_EVIDENCE,
    hold: holdText(a), earliest: earliest.text, invalid, aux, solves: solves.slice(0, 3), evidence: SOLVER_EVIDENCE,
  };
}

// ---------- 回放验证用 ----------

/** 抵扣价路径里第一次高于现价是第几天（1 起）。偏多时，从那天起回调容易让 MA 拐头。 */
const firstHigh = (path: { close: number }[], close: number) => {
  const i = path.findIndex((p) => p.close > close);
  return i < 0 ? null : i + 1;
};

/**
 * 价格不变时 MA20 朝哪边、还会持续几天（按 20 天抵扣价和模糊判断的档位 LEAN_SOME）。
 * 中间档、或明天起就变时不下结论，返回 null。只给回放验证（scripts/replay.ts）判对错，页面不显示。
 */
export function ma20Claim(a: Analysis): { dir: 1 | -1; days: number } | null {
  const d20 = a.drops.find((d) => d.period === 20)!;
  const some = a.thresholds.LEAN_SOME.value;
  if (a.lean.score <= -some) {
    const turn = d20.first_low;
    // first_low 是 dma_analyze 在 20 天内找的，不是 path 的长度
    return turn === null ? { dir: -1, days: 20 } : turn <= 1 ? null : { dir: -1, days: turn - 1 };
  }
  if (a.lean.score >= some) {
    const high = firstHigh(d20.path, a.close);
    return high === null ? { dir: 1, days: d20.path.length } : high <= 1 ? null : { dir: 1, days: high - 1 };
  }
  return null;
}

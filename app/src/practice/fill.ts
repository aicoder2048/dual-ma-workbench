/**
 * 打法补全（docs/adr/0037.md）：不告诉类型，先判类型，再按工作台「找打法」的格子逐格选。
 *
 * - 处境：空仓（五格：能不能做、等什么信号、在哪进、止损放哪、目标看哪）或持仓（五格：拿着还是走、盯什么信号、在哪走、
 *   目标看哪、浮盈 / 浮亏怎么办）。不考价格（选的是"种类"），不考仓位（每套打法都是按止损倒算股数）。
 * - 答案从当天的交易计划取：第一格是计划的结论词（Plan.verdict）；止损、目标看交易计划；其余每套打法每格一句，写在 FILL_PHRASES。
 *   干扰项取别的打法在同一格的那句。
 * - 类型判错时后面的格子仍按归雁判的类型给分；alts 记下"按你选的类型，这格该填什么"，交卷后给看，分清认错类型还是不熟打法。
 */
import type { Analysis } from "../citations.ts";
import { buildPlans, HOLD_VERDICT, PLAY_KEYS, type Plan } from "../plan.ts";
import { REGIME_NAMES, regimeChoices, shuffle, type Draft, type Generator, type Part } from "./drillkinds.ts";

type Sit = "flat" | "profit" | "loss";
interface Cell { key: string; title: string; prompt: string }

/** 两种处境各五格，顺序照找打法的格子（docs/adr/0029.md），不考「仓位」。 */
export const FILL_CELLS: Record<"flat" | "holding", Cell[]> = {
  flat: [
    { key: "go", title: "能不能做", prompt: "能不能做？" },
    { key: "signal", title: "等什么信号", prompt: "等什么信号？" },
    { key: "entry", title: "在哪进", prompt: "在哪进？" },
    { key: "stop", title: "止损放哪", prompt: "进场后止损放哪？" },
    { key: "target", title: "目标看哪", prompt: "第一阻力 / 目标看哪？" },
  ],
  holding: [
    { key: "go", title: "拿着还是走", prompt: "拿着还是走？" },
    { key: "signal", title: "盯什么信号", prompt: "盯什么信号？" },
    { key: "stop", title: "在哪走", prompt: "止损 / 在哪走？" },
    { key: "target", title: "目标看哪", prompt: "第一阻力 / 目标看哪？" },
    { key: "pnl", title: "浮盈 / 浮亏怎么办", prompt: "浮盈 / 浮亏怎么办？" },
  ],
};

const NO_STOP = "—（不进场，没有止损）";
/** 找打法格子的编号，依据里照工作台写。 */
const NUMS = "①②③④⑤";

/**
 * 每套打法每格一句（照 plan.ts 各打法的条目和 playbooks.md 写，只说种类、不带价位）。
 * flat.stop 是会买的打法进场后的止损；空仓不买的打法写「—」。缺一项单元测试失败。
 */
export const FILL_PHRASES: Record<string, {
  flat: { signal: string; entry: string; stop: string };
  holding: { signal: string; stop: string; pnl: { profit: string; loss: string } };
}> = {
  横盘: {
    flat: { signal: "末期三条件：横满 6 个月、均线密集、向上张嘴", entry: "末期条件齐了：小仓位埋伏，或突破箱体后买入", stop: "20/60 死叉" },
    holding: { signal: "磨蹭不涨，没到止损也先出来", stop: "20/60 死叉",
      pnl: { profit: "止损还是埋伏的底线，磨蹭不涨就先走", loss: "守住 20/60 死叉止损，不在箱体里摊低" } },
  },
  横盘破位: {
    flat: { signal: "底线已破：等多头排列再说", entry: "—（底线已破，不埋伏）", stop: NO_STOP },
    holding: { signal: "—（底线已破，已经离场）", stop: "底线已破，现价离场",
      pnl: { profit: "带着利润走，别让它变成亏损", loss: "认亏离场，不摊低、不等回本" } },
  },
  稳定上涨: {
    flat: { signal: "吃回撤四条件：回撤到 60 线组、底部构造、小时线多头", entry: "四条件齐了按收盘进（回撤到 60 线组一带）", stop: "60 线组拐头向下" },
    holding: { signal: "吃回撤四条件齐了就加仓", stop: "60 线组拐头向下",
      pnl: { profit: "成本是安全垫，按趋势拿着，不因小回调卖", loss: "不急着割，也不急着摊低，四条件齐了再加" } },
  },
  加速上涨: {
    flat: { signal: "等价格回落、靠近 MA20", entry: "—（加速中不追）", stop: NO_STOP },
    holding: { signal: "看顶部构造：出现只是提醒，等关键性波动", stop: "跌破 EMA20、EMA20 拐头向下",
      pnl: { profit: "没见顶部构造就拿着", loss: "追高浮亏：不加仓，跌破 EMA20 就走" } },
  },
  稳定下跌: {
    flat: { signal: "等 20 线组拐头向上，再等排列理顺成多头", entry: "—（下跌里不抄底）", stop: NO_STOP },
    holding: { signal: "反弹到 EMA20、60 线组一带减仓", stop: "不靠均线：反弹到 EMA20 一带离场",
      pnl: { profit: "反弹到减仓位先减一部分", loss: "不等回本，反弹到减仓位就减" } },
  },
  加速下跌: {
    flat: { signal: "底部构造 + 20 线组拐头向上（关键性波动）", entry: "底部构造完成、20 线组一起拐头向上时进", stop: "20 线组拐头失败" },
    holding: { signal: "急跌里不割，反弹到 EMA20 附近减仓", stop: "不靠均线：反弹到 EMA20 一带离场",
      pnl: { profit: "反弹到减仓位先减一部分", loss: "不等回本，反弹到减仓位就减" } },
  },
  过渡: {
    flat: { signal: "等排列理顺：20 线组升到 60 线组上方、多数线向上", entry: "—（排列没理顺，不进）", stop: NO_STOP },
    holding: { signal: "看排列往哪边理顺：偏多拿着、偏空减仓", stop: "跌破 EMA20、EMA20 拐头向下",
      pnl: { profit: "排列理顺前不加仓", loss: "不摊低，按止损减" } },
  },
  空头结构反弹中: {
    flat: { signal: "20 线组升到 60 线组上方再看（这种反弹多半是假动作）", entry: "—（中长期线压着，不买）", stop: NO_STOP },
    holding: { signal: "反弹到 MA60 附近减仓", stop: "跌破 EMA20、EMA20 拐头向下",
      pnl: { profit: "到减仓位先锁住一部分利润", loss: "到减仓位就减，这种反弹多半撑不住" } },
  },
  多头结构回撤中: {
    flat: { signal: "20 线组重新拐头向上：站上 EMA20、过 MA20 抵扣价", entry: "20 线组一起拐头向上时进", stop: "20 线组拐头失败" },
    holding: { signal: "守住多头结构，不在急跌里卖", stop: "20/60 双死叉",
      pnl: { profit: "结构还是多头，不在回调里卖", loss: "不急着割也不摊低，20/60 双死叉就走" } },
  },
};

/** 空仓会买的打法（回测的打法里有进场的）：判错成它们时，第一格写"做 / 等"。 */
const BUYS = new Set(["横盘", "稳定上涨", "加速下跌", "多头结构回撤中"]);
const DOWN = new Set(["稳定下跌", "加速下跌"]);

/** 类型名（regime.name）换成打法键，照 rules.play_key：转折中和三种过渡状态都是过渡。 */
export function keyOfRegime(name: string): string {
  if (name === "多头结构回撤中" || name === "空头结构反弹中") return name;
  if (name.endsWith("转折中") || name === "失序") return "过渡";
  return name.split("·")[0];
}

const TARGET_OF: Record<string, string> = {
  缺口: "上方没补的缺口", "20、60 均线密集": "上方的 20、60 均线密集", "20、60、120 全部汇聚": "上方 20/60/120 全部汇聚处", 前高: "前高（上方没有缺口和密集）",
};
const TARGET_NONE = { noEntry: "—（不进场，不找目标）", unknown: "—（第一阻力算不出）", down: "—（下跌没拐头，持仓不找目标）", none: "—（上方没有阻力位）" };
/** 目标格的候选按处境分：空仓有"不进场"，持仓有"下跌不找目标"。 */
const TARGET_POOL = {
  flat: [...Object.values(TARGET_OF), TARGET_NONE.noEntry, TARGET_NONE.unknown],
  holding: [...Object.values(TARGET_OF), TARGET_NONE.down, TARGET_NONE.none],
};

function targetPhrase(plan: Plan, key: string, flat: boolean): string {
  const k = plan.trade.targets[0]?.kind;
  if (k) {
    const p = TARGET_OF[k];
    if (!p) throw new Error(`打法补全：没见过的目标种类「${k}」，加进 TARGET_OF`);
    return p;
  }
  if (flat) return plan.trade.entry === null ? TARGET_NONE.noEntry : TARGET_NONE.unknown;
  return DOWN.has(key) ? TARGET_NONE.down : TARGET_NONE.none;
}

function flatStop(plan: Plan, key: string): string {
  if (plan.trade.entry === null) return NO_STOP;
  return (plan.stop?.label ?? FILL_PHRASES[key].flat.stop).replace("（守住）", "");
}

/** 这一处境五格的答案。 */
function answersOf(a: Analysis, key: string, sit: Sit, plan: Plan): string[] {
  const t = FILL_PHRASES[key];
  if (sit === "flat") return [plan.verdict, t.flat.signal, t.flat.entry, flatStop(plan, key), targetPhrase(plan, key, true)];
  return [plan.verdict, t.holding.signal, t.holding.stop, targetPhrase(plan, key, false), t.holding.pnl[sit]];
}

/** 每格的候选：对的那句 + 别的打法同一格最多 3 句（去重），打乱。第一格的结论词固定三选一。 */
function choicesOf(cell: string, sit: Sit, answer: string, rand: () => number): Part["choices"] {
  if (cell === "go") return sit === "flat" ? ["做", "等", "不做"] : ["拿着", "减仓", "离场"];
  const pool = cell === "target" ? TARGET_POOL[sit === "flat" ? "flat" : "holding"] : PLAY_KEYS.map((k) => {
    const t = FILL_PHRASES[k];
    if (sit === "flat") return cell === "signal" ? t.flat.signal : cell === "entry" ? t.flat.entry : t.flat.stop;
    return cell === "signal" ? t.holding.signal : cell === "stop" ? t.holding.stop : t.holding.pnl[sit];
  });
  const others = shuffle([...new Set(pool)].filter((x) => x !== answer), rand).slice(0, 3);
  return shuffle([answer, ...others], rand);
}

/** 按你选的类型（打法键 k），每格该填什么；和答案一样的格写 null。目标和类型无关（看当天的价位），写 null。 */
function altRow(k: string, sit: Sit, answers: string[]): (string | null)[] {
  const t = FILL_PHRASES[k];
  const row = sit === "flat"
    ? [k === "横盘" ? "末期条件齐了做，中段不做" : BUYS.has(k) ? "做 / 等（看条件齐没齐）" : "不做", t.flat.signal, t.flat.entry, t.flat.stop, null]
    : [HOLD_VERDICT[k], t.holding.signal, t.holding.stop, null, t.holding.pnl[sit]];
  return row.map((x, i) => (x === null || x === answers[i] ? null : x));
}

function draftOf(a: Analysis, sit: Sit, rand: () => number): Draft | null {
  const key = a.trade_plan.key;
  if (!FILL_PHRASES[key] || !REGIME_NAMES.includes(a.regime.name as never)) return null;
  const plan = buildPlans(a)[sit];
  const flat = sit === "flat";
  const cells = FILL_CELLS[flat ? "flat" : "holding"];
  const answers = answersOf(a, key, sit, plan);
  const types = regimeChoices(a.regime.name, rand);
  const parts: Part[] = [
    { prompt: "这是什么趋势类型·阶段？", choices: types, answer: types.indexOf(a.regime.name) },
    ...cells.map((c, i) => {
      const choices = choicesOf(c.key, sit, answers[i], rand);
      return { prompt: c.prompt, choices, answer: choices.indexOf(answers[i]) };
    }),
  ];
  const alts = types.map((name) => (keyOfRegime(name) === key ? null : altRow(keyOfRegime(name), sit, answers)));
  const ids = [...new Set(["J1", "J7", ...plan.items.flatMap((i) => i.rules ?? [])])].filter((id) => a.rules.some((r) => r.id === id));
  const where = flat ? "空仓" : sit === "profit" ? "持仓，浮盈（成本在现价下方）" : "持仓，浮亏（成本在现价上方）";
  return {
    kind: "fill", cls: `${key}·${flat ? "空仓" : sit === "profit" ? "浮盈" : "浮亏"}`, view: { bars: 160, lines: true, drops: true }, marks: [],
    context: `${where}。先判类型，再按找打法的格子逐格选。只考种类，不考价格和仓位。`,
    parts, alts,
    evidence: [
      `归雁判的类型：${a.regime.name}（打法「${key}」）`,
      `① ${cells[0].title}：${plan.verdict}。${plan.action}`,
      ...cells.slice(1).map((c, i) => `${NUMS[i + 1]} ${c.title}：${answers[i + 1]}`),
      "完整的格子（带价位和依据）在工作台的「找打法」；这里每格只取要点",
    ],
    rules: ids.map((id) => ({ id, name: a.rules.find((r) => r.id === id)!.name })), hint: null,
  };
}

/** 一份分析出两道：空仓一道，持仓一道（浮盈、浮亏随机一种）。 */
export const fill: Generator = (c) => {
  const sit: Sit = c.rand() < 0.5 ? "profit" : "loss";
  return [draftOf(c.a, "flat", c.rand), draftOf(c.a, sit, c.rand)].filter((d): d is Draft => d !== null);
};

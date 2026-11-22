/**
 * 识别题：几秒一题，当场判，给答案、依据和规则编号。
 *
 * 每种题一个出题函数，登记在 GENERATORS 表里。出题函数拿到题目那一根收盘时 skill 的分析（dma_analyze），
 * 答案直接从分析的字段来，所以练的是系统的规则，不是谁的看法。一份分析可以出 0 到几道题（草稿），
 * 题库（drills.ts）按答案类别配额挑。草稿里的日期还是挪过的日期，入库时换成 T+n。
 */
import { ACCEL_WHERE, type Analysis, type Construct, type PairProgress, type StepName, type Turn } from "../citations.ts";
import { buildPlans, playKey } from "../plan.ts";
import { entryStateOf } from "./discipline.ts";
import { fill } from "./fill.ts";
import { bucketOf, CROSS_CHOICES, type RevealPart, type RevealSpec } from "./reveal.ts";

export const KINDS = ["chart", "signal", "dropoff", "construct", "play", "fill", "project", "steps"] as const;
export type Kind = (typeof KINDS)[number];
export const KIND_LABEL: Record<Kind, string> = {
  chart: "看图", signal: "看信号", dropoff: "看抵扣价", construct: "看构造和 2B", play: "看打法", fill: "打法补全", project: "推演揭晓", steps: "五步点图",
};

/** 一问：几个选项，answer 是对的那个的位置。 */
export interface Part { prompt: string; choices: string[]; answer: number }
/** 图上画什么：最近 bars 根 K 线；lines 画 6 条均线；drops 画明天的抵扣价小点。 */
export interface View { bars: number; lines: boolean; drops: boolean }
/** 图上标出的 K 线：t 是相对题目那一根（0 是题目那根，-3 是往前 3 根）。 */
export interface Mark { t: number; text: string }
export interface Rule { id: string; name: string }

/**
 * 点图题要点的：一对线组（fast/slow）往 direction 的转折，steps 按五步的顺序，t 是相对题目那一根的位置。
 * 点的那根和答案差 tolerance 根以内算对。
 */
export interface ClickTask {
  prompt: string; fast: number; slow: number; direction: Turn["direction"];
  steps: { step: StepName; t: number }[]; tolerance: number;
}

/**
 * 一道题的草稿。cls：答案类别，抽题时按它配平（例如看信号的「都不是」不能占八成）。
 * evidence：答完给看的依据，每条都是分析里的数字；rules：依据的规则编号。
 * 选择题有 parts；推演揭晓题另有 reveal（交卷后拿真实走势对照什么）；五步点图题没有选项，答案在 click。
 */
interface DraftBase { cls: string; view: View; marks: Mark[]; context: string | null; evidence: string[]; rules: Rule[]; hint: string | null }
export type ChoiceKind = Exclude<Kind, "project" | "steps" | "fill">;
export type Draft =
  | (DraftBase & { kind: ChoiceKind; parts: Part[] })
  | (DraftBase & { kind: "project"; parts: Part[]; reveal: RevealSpec })
  /** 打法补全：alts[i] 是第 0 问选了第 i 个类型时，后面每格按那个类型该填什么（和答案一样写 null；选对的那行整行 null）。 */
  | (DraftBase & { kind: "fill"; parts: Part[]; alts: ((string | null)[] | null)[] })
  | (DraftBase & { kind: "steps"; click: ClickTask });

/** dates：图上到题目那一根为止的日期（挪过的），用来把日期换成相对位置。 */
export interface Ctx { a: Analysis; dates: string[]; rand: () => number }
export type Generator = (c: Ctx) => Draft[];

const f2 = (x: number) => x.toFixed(2);
const dirText = (d: -1 | 0 | 1) => (d > 0 ? "向上" : d < 0 ? "向下" : "走平");

function rulesOf(a: Analysis, ids: string[]): Rule[] {
  return ids.map((id) => ({ id, name: a.rules.find((r) => r.id === id)?.name ?? "" }));
}

function tOf(c: Ctx, date: string): number | null {
  const i = c.dates.lastIndexOf(date);
  return i < 0 ? null : i - (c.dates.length - 1);
}

/** 价格选项：去掉相差不到 0.3% 的，从低到高排；不够 min 个返回 null。 */
function priceChoices(correct: number, others: number[], min = 3): { choices: string[]; answer: number } | null {
  const picked = [correct];
  for (const x of others) {
    if (Number.isFinite(x) && x > 0 && picked.every((p) => Math.abs(p - x) / p > 0.003)) picked.push(x);
  }
  if (picked.length < min) return null;
  const sorted = picked.slice(0, 4).sort((p, q) => p - q);
  return { choices: sorted.map(f2), answer: sorted.indexOf(correct) };
}

// ---------- 看图：类型 × 阶段 ----------

/** regime.name 可能的取值（regime.py 的类型 × 阶段，和定不出类型时的过渡状态）。 */
export const REGIME_NAMES = [
  "加速上涨·延伸", "加速上涨·回撤中", "加速上涨·顶部转折中", "稳定上涨·延伸", "稳定上涨·回撤中",
  "横盘",
  "稳定下跌·延伸", "稳定下跌·反弹中", "加速下跌·延伸", "加速下跌·反弹中", "加速下跌·底部转折中",
  "多头结构回撤中", "空头结构反弹中", "顶部转折中", "底部转折中", "失序",
] as const;
const UP_NAMES = REGIME_NAMES.filter((n) => n.includes("上涨") || n === "多头结构回撤中");
const DOWN_NAMES = REGIME_NAMES.filter((n) => n.includes("下跌") || n === "空头结构反弹中");
const CHART_CHOICES = 6;

export function shuffle<T>(xs: readonly T[], rand: () => number): T[] {
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 六个选项：对的那个，加同方向的 3 个、其余随机，按词表的顺序排（位置固定，好记）。 */
export function regimeChoices(name: string, rand: () => number): string[] {
  const family = UP_NAMES.includes(name as never) ? UP_NAMES : DOWN_NAMES.includes(name as never) ? DOWN_NAMES : REGIME_NAMES.filter((n) => !UP_NAMES.includes(n) && !DOWN_NAMES.includes(n));
  const near = shuffle(family.filter((n) => n !== name), rand).slice(0, 3);
  const rest = shuffle(REGIME_NAMES.filter((n) => n !== name && !near.includes(n)), rand).slice(0, CHART_CHOICES - 1 - near.length);
  const set = new Set<string>([name, ...near, ...rest]);
  return REGIME_NAMES.filter((n) => set.has(n));
}

function progressText(a: Analysis): string {
  const p = a.steps[0];
  if (!p.current) return "20/60 还没站到任何一边";
  const done = p.current.steps.filter((s) => s.date);
  return `20/60 原来${p.side}，往${p.current.direction.slice(1)}的转折走到 ${done.length ? done.map((s) => s.step).join("、") : "还没开始"}`;
}

const chart: Generator = (c) => {
  const { a } = c;
  const r = a.regime;
  if (!REGIME_NAMES.includes(r.name as never)) return [];
  const choices = regimeChoices(r.name, c.rand);
  const order = r.order > 0 ? "多头（60 在 120 上方）" : r.order < 0 ? "空头（60 在 120 下方）" : "缠在一起";
  const evidence = [`60/120 次序${order}，60 线组${dirText(r.dir60)}，120 线组${dirText(r.dir120)}`,
    `MA60 钟表 ${r.clock60.hour}（${r.clock60.angle.toFixed(0)}°），MA20 ${r.clock20.hour}（${r.clock20.angle.toFixed(0)}°）`];
  const ids = ["J1", "J2"];
  if (r.accel) { evidence.push(`加速：按${r.accel.by}判，出现在${ACCEL_WHERE[r.accel.phase]}`); ids.push("J3", "J8"); }
  else if (r.type === "稳定上涨" || r.type === "稳定下跌") ids.push("J4");
  if (r.range) { evidence.push(`6 条线相差 ${r.range.spread_pct.toFixed(1)}%，60 线走平 ${r.range.days} 根`); ids.push("J5"); }
  if (r.transition) { evidence.push(`60/120 定不出类型，按 20/60 的结构叫「${r.transition}」`); ids.push("J6"); }
  if (r.stage) { evidence.push(`阶段看 20/60：${progressText(a)}${r.depth ? `，${r.depth}` : ""}`); ids.push("J7"); }
  return [{
    kind: "chart", cls: r.name, view: { bars: 200, lines: true, drops: false }, marks: [], context: null,
    parts: [{ prompt: "这是什么类型、走到哪个阶段？", choices, answer: choices.indexOf(r.name) }],
    evidence, rules: rulesOf(a, ids), hint: `钟表方向：MA60 ${r.clock60.hour}，MA20 ${r.clock20.hour}（3 点钟是走平，越往 12 点越陡）`,
  }];
};

// ---------- 看信号：20/60 的五个进度点 ----------

export const SIGNAL_CHOICES = ["破线", "EMA 拐头", "MA 拐头", "第一个交叉", "双交叉", "都不是"] as const;
/** 步骤 → 配平用的类别：EMA、MA 拐头算一类。 */
const SIGNAL_CLASS: Record<(typeof SIGNAL_CHOICES)[number], string> = {
  破线: "破线", "EMA 拐头": "拐头", "MA 拐头": "拐头", 第一个交叉: "交叉", 双交叉: "双交叉", 都不是: "都不是",
};
/** 五个进度点的定义（rules.md J15、J16；拐头的条件是 A1、A3），rule 是出处的编号。 */
export function stepMeaning(step: StepName, fast: number, slow: number): { text: string; rule: string } {
  switch (step) {
    case "破线": return { text: `收盘穿过 MA${fast}、EMA${fast} 两条线`, rule: "J15" };
    case "EMA 拐头": return { text: `EMA${fast} 当天朝反方向走（收盘越过 EMA${fast} 本身）`, rule: "A3" };
    case "MA 拐头": return { text: `MA${fast} 当天朝反方向走（收盘越过 ${fast} 日抵扣价）`, rule: "A1" };
    case "第一个交叉": return { text: `MA${fast} 或 EMA${fast} 有一条穿过 ${slow} 那条`, rule: "J15" };
    case "双交叉": return { text: `MA${fast} 穿过 MA${slow}、EMA${fast} 穿过 EMA${slow}，两组都交叉`, rule: "J16" };
  }
}

/** 题目那一根新走到的进度点，按五步的顺序取最靠后的；一步都没有是「都不是」。没站到一边返回 null。 */
export function signalAnswer(a: Analysis): (typeof SIGNAL_CHOICES)[number] | null {
  const cur = a.steps[0].current;
  if (!cur) return null;
  const today = cur.steps.filter((s) => s.date === a.date);
  return today.length ? today.at(-1)!.step : "都不是";
}

const signal: Generator = (c) => {
  const { a } = c;
  const ans = signalAnswer(a);
  if (!ans) return [];
  const p = a.steps[0], cur = p.current!;
  const line = (n: number) => a.lines.find((l) => l.period === n)!;
  const ids = ["J15", "J16", ...(ans === "MA 拐头" ? ["A1"] : ans === "EMA 拐头" ? ["A3"] : [])];
  return [{
    kind: "signal", cls: SIGNAL_CLASS[ans], view: { bars: 120, lines: true, drops: true }, marks: [{ t: 0, text: "这根" }],
    context: `20/60 原来${p.side}排列，现在看往${cur.direction.slice(1)}的转折。`,
    parts: [{ prompt: "标出的最后一根，20/60 新走到了哪一个进度点？（同一根走到好几步，选最靠后的一步）", choices: [...SIGNAL_CHOICES], answer: SIGNAL_CHOICES.indexOf(ans) }],
    evidence: [
      `这次转折的进度点：${cur.steps.map((s) => `${s.step} ${s.date ?? "还没有"}`).join("；")}`,
      ans === "都不是" ? "这一根没有新走到的进度点" : `${ans}：${stepMeaning(ans, 20, 60).text}`,
      `这根收盘 ${f2(a.close)}；MA20 ${f2(line(20).ma)}、EMA20 ${f2(line(20).ema)}；MA60 ${f2(line(60).ma)}、EMA60 ${f2(line(60).ema)}`,
    ],
    rules: rulesOf(a, ids), hint: null,
  }];
};

// ---------- 看抵扣价：明天收平 MA20 / MA60 往哪走，20 天不拐头要守在哪 ----------

export const DROPOFF_CHOICES = ["MA20 上、MA60 上", "MA20 上、MA60 下", "MA20 下、MA60 上", "MA20 下、MA60 下"] as const;

const dropoff: Generator = (c) => {
  const { a } = c;
  const d20 = a.drops.find((d) => d.period === 20)!, d60 = a.drops.find((d) => d.period === 60)!;
  if (d20.direction === "平" || d60.direction === "平") return [];
  const ans = `MA20 ${d20.direction}、MA60 ${d60.direction}`;
  const h = a.projection.hurdles.find((x) => x.period === 20)!;
  const ma20 = a.lines.find((l) => l.period === 20)!.ma;
  const price = priceChoices(h.max_price, [h.min_price, d20.tomorrow, ma20, a.lines.find((l) => l.period === 60)!.ma]);
  const cmp = (d: typeof d20) => `收盘 ${f2(a.close)} ${a.close > d.tomorrow ? "高于" : "低于"} ${d.period} 日抵扣价 ${f2(d.tomorrow)}，MA${d.period} ${d.direction}`;
  const parts: Part[] = [{ prompt: "明天收盘和今天一样（收平），MA20、MA60 各往哪走？", choices: [...DROPOFF_CHOICES], answer: DROPOFF_CHOICES.indexOf(ans as never) }];
  const evidence = [cmp(d20), cmp(d60)];
  if (price) {
    parts.push({ prompt: `接下来 ${h.days} 天 MA20 天天向上、不拐头向下，收盘要守在哪个价位之上？`, ...price });
    evidence.push(`MA20 未来 ${h.days} 天要扣的收盘：最高 ${f2(h.max_price)}（${h.dates[h.max_day - 1] ?? ""} 那根），最低 ${f2(h.min_price)}；天天守在最高的之上，MA20 天天向上`);
  }
  return [{
    kind: "dropoff", cls: ans, view: { bars: 140, lines: true, drops: true }, marks: [], context: "小黄点是明天要扣掉的那根 K 线（20扣、60扣）。",
    parts, evidence, rules: rulesOf(a, price ? ["A1", "A2"] : ["A1"]), hint: null,
  }];
};

// ---------- 看构造和 2B：只看最高价、最低价 ----------

export const CONSTRUCT_STATES = ["形成中", "已完成", "已破坏"] as const;
export const TWO_B_CHOICES = ["2B 顶", "2B 底", "没有"] as const;
const CONSTRUCT_BARS = 90;

function constructStatus(c: Ctx, k: Construct): Draft | null {
  const t = tOf(c, k.pivot_date);
  if (t === null || t < -(CONSTRUCT_BARS - 1)) return null;
  const top = k.side === "顶部构造";
  const steps = [k.lh_date && `${top ? "更低的高点" : "更高的低点"} ${k.lh_date}`, k.done_date && `完成 ${k.done_date}`, k.broken_date && `破坏 ${k.broken_date}`].filter(Boolean);
  return {
    kind: "construct", cls: `状态:${k.state}`, view: { bars: CONSTRUCT_BARS, lines: false, drops: false },
    marks: [{ t, text: top ? "新高" : "新低" }], context: "只看每根 K 线的最高价和最低价。",
    parts: [{ prompt: `标出的是最近一次${top ? "新高" : "新低"}，${k.side}从这根算起。这个${k.side}现在？`, choices: [...CONSTRUCT_STATES], answer: CONSTRUCT_STATES.indexOf(k.state) }],
    evidence: [
      `${k.side}：${top ? "新高" : "新低"} ${k.pivot_date}（${f2(k.pivot_price)}）${steps.length ? "；" + steps.join("；") : ""}；现在${k.state}`,
      top ? "顶部构造：新高之后先出现更低的高点，再出现更低的低点（被新高那根包住的 K 线不算）" : "底部构造：新低之后先出现更高的低点，再出现更高的高点（被新低那根包住的 K 线不算）",
      `完成之后又${top ? "创出更高的高点" : "创出更低的低点"}（越过 ${f2(k.invalidation)}），构造作废`,
    ],
    rules: rulesOf(c.a, [top ? "J20" : "J21", "J22"]), hint: null,
  };
}

function constructNext(c: Ctx, k: Construct): Draft | null {
  if (k.state !== "形成中" || k.bars_left !== 1 || k.complete_at === null) return null;
  const t = tOf(c, k.pivot_date);
  if (t === null || t < -(CONSTRUCT_BARS - 1)) return null;
  const top = k.side === "顶部构造";
  const price = priceChoices(k.complete_at, [k.invalidation, c.a.close, ...(k.next_at === null ? [] : [k.next_at])]);
  if (!price) return null;
  return {
    kind: "construct", cls: "下一根", view: { bars: CONSTRUCT_BARS, lines: false, drops: false },
    marks: [{ t, text: top ? "新高" : "新低" }], context: "只看每根 K 线的最高价和最低价。",
    parts: [{ prompt: `${k.side}只差一根。下一根 K 线${top ? "最低价低于" : "最高价高于"}多少就完成？`, ...price }],
    evidence: [
      `${k.side}形成中，最少还差 ${k.bars_left} 根：下一根${top ? "最低价低于" : "最高价高于"} ${f2(k.complete_at)} 就完成`,
      `${top ? "最高价超过" : "最低价跌破"} ${f2(k.invalidation)}（${top ? "新高" : "新低"}那根）构造作废`,
    ],
    rules: rulesOf(c.a, ["J27", top ? "J20" : "J21", "J22"]), hint: null,
  };
}

/** 2B：J26 满足时 basis 以「2B 顶 / 2B 底」开头；不满足是最近 60 根里没有已形成的。需看图（没有高低价）不出题。 */
export function twoBAnswer(a: Analysis): (typeof TWO_B_CHOICES)[number] | null {
  const j = a.rules.find((r) => r.id === "J26")!;
  if (j.status === "需看图") return null;
  if (j.status === "不满足") return "没有";
  return j.basis.startsWith("2B 顶") ? "2B 顶" : "2B 底";
}

function twoB(c: Ctx): Draft | null {
  const ans = twoBAnswer(c.a);
  if (!ans) return null;
  const j = c.a.rules.find((r) => r.id === "J26")!;
  return {
    kind: "construct", cls: `2B:${ans}`, view: { bars: CONSTRUCT_BARS, lines: false, drops: false }, marks: [], context: "只看每根 K 线的最高价和最低价。",
    parts: [{ prompt: "最近 60 根里，有没有已经形成的 2B？", choices: [...TWO_B_CHOICES], answer: TWO_B_CHOICES.indexOf(ans) }],
    evidence: [`J26：${j.basis}`, "2B 顶：创出高点 A，明显回撤到 B（B 不是底部构造），迅速创新高 C，随后几根内又跌回 A 之下。2B 底是镜像"],
    rules: rulesOf(c.a, ["J26"]), hint: null,
  };
}

const construct: Generator = (c) => {
  const s = c.a.structure;
  if (!s.available) return [];
  const ks = [s.top, s.bottom].filter((k): k is Construct => Boolean(k));
  return [...ks.map((k) => constructStatus(c, k)), ...ks.map((k) => constructNext(c, k)), twoB(c)].filter((d): d is Draft => d !== null);
};

// ---------- 看打法：空仓怎么做、进场后止损放哪 ----------

export const PLAY_CHOICES = ["等", "埋伏", "不做", "回撤买", "反弹卖"] as const;
export type PlayClass = (typeof PLAY_CHOICES)[number];
/**
 * 空仓计划的止损（plan.ts 的 flat.stop.label，价位来自 skill 的交易计划）→ 选项。
 * 回测里空仓不买的打法（entryStateOf 的 entries 为 null）答「不设」：加速下跌的交易计划虽然给了等构造和拐头之后的止损，回测不进场。
 */
export const NO_STOP = "不设（这时不进场）";
export const STOP_CHOICES = ["60 线组拐头向下", "20/60 死叉", "20 线组拐头失败", "起涨 K 线最低价", NO_STOP] as const;
const STOP_OF: Record<string, (typeof STOP_CHOICES)[number]> = {
  "60 线组拐头向下": "60 线组拐头向下", "20/60 死叉（守住）": "20/60 死叉", "20 线组拐头失败": "20 线组拐头失败", "起涨 K 线最低价": "起涨 K 线最低价",
};

/**
 * 空仓的打法类别，按回测的 SETUPS（entryStateOf）：
 * - 这套打法空仓不买 → 不做；横盘末期条件没齐也是不做（P1）。
 * - 会买、进场条件有一条满足 → 横盘叫埋伏（P2），其余（稳定上涨、多头结构回撤中）叫回撤买。
 * - 会买、条件还没满足 → 等。条件只能看图判（需看图）时不出题，返回 null。
 * 「反弹卖」是持仓的做法，空仓永远不对，留着当干扰项。
 */
export function playClass(a: Analysis): PlayClass | null {
  const st = entryStateOf(a);
  if (st.entries === null) return "不做";
  const range = st.play === "横盘";
  if (st.entries.some((e) => e.status === "满足")) return range ? "埋伏" : "回撤买";
  if (st.entries.some((e) => e.status === "需看图")) return null;
  return range ? "不做" : "等";
}

const play: Generator = (c) => {
  const { a } = c;
  const cls = playClass(a);
  if (!cls) return [];
  const plan = buildPlans(a).flat;
  const st = entryStateOf(a);
  const stop = plan.stop && st.entries !== null ? STOP_OF[plan.stop.label] : NO_STOP;
  if (!stop) throw new Error(`看打法：没见过的止损「${plan.stop!.label}」，加进 STOP_CHOICES`);
  const key = playKey(a);
  const hourlyless = Boolean(st.entries?.some((e) => e.id === "P14" && e.status === "满足")) && a.rules.find((r) => r.id === "P14")?.status === "需看图";
  // 空仓不买的打法：用空仓计划里「等什么」那些条件的规则（脚本的 play.rules 是持仓的做法，例如下跌里的反弹卖）
  const flatRules = plan.items.flatMap((i) => i.rules ?? []);
  const ids = st.entries === null ? (flatRules.length ? flatRules : a.play.rules) : [...(st.play === "横盘" ? ["P1", "P2"] : []), ...st.entries.map((e) => e.id)];
  return [{
    kind: "play", cls, view: { bars: 160, lines: true, drops: true }, marks: [],
    context: `空仓。脚本判定：${a.regime.name}（打法「${key}」）。`,
    parts: [
      { prompt: "现在该怎么做？", choices: [...PLAY_CHOICES], answer: PLAY_CHOICES.indexOf(cls) },
      { prompt: "按这套打法，进场后的止损放在哪？", choices: [...STOP_CHOICES], answer: STOP_CHOICES.indexOf(stop) },
    ],
    evidence: [
      // 结论卡片的 P14 照实写需看图（没有小时线）；回测和练习按前三条判，这时卡片上的做法和答案对不上，不引用它
      hourlyless ? "P14：P10、P11、P12 都满足；P13 要看小时线，练习里没有，照回测的口径算满足" : `空仓做法：${plan.action}`,
      st.entries === null ? `「${key}」空仓不买（回测的打法里没有它）` : `进场条件：${st.entries.map((e) => `${e.id} ${e.status}`).join("，")}`,
      stop !== NO_STOP && plan.stop ? `进场后止损：${plan.stop.label} ${f2(plan.stop.price)}` : "这时空仓不进场，没有止损",
      "等 = 这套打法会买、条件还没齐；不做 = 这种状态空仓不进场；反弹卖是持仓的做法",
    ],
    rules: rulesOf(a, [...new Set(ids)]), hint: null,
  }];
};

// ---------- 推演揭晓：收平推演 N 天，交卷后放出真实走势对照 ----------

/**
 * 问第几天的方向：5、10、15 天里随机挑一个。不问第 20 天：MA20 第 20 天扣掉的正是 T0 自己，收平时 MA20 一定走平。
 */
export const PROJECT_DAYS = [5, 10, 15] as const;
/** 问拐头的价位：推演求解的 10 天、20 天里挑一个。 */
const TURN_DAYS = [10, 20] as const;
const pick = <T>(xs: readonly T[], rand: () => number) => xs[Math.floor(rand() * xs.length)];
export const PROJECT_CONTEXT = "推演照系统的假设：之后每天收盘都和 T0 一样（收平）。评分按推演；交卷后放出之后的真实走势，只作对照、不算分。推演不是预测。";

/** 收平时 days 天内会不会出现 event：从推演的求解（持平价位的临界值）读。求解里没有、或临界价位就卡在收盘上，返回 null。 */
function occursAtClose(a: Analysis, event: string, happen: boolean, days: number): boolean | null {
  const s = a.projection.solves.find((x) => x.event === event && x.happen === happen && x.days === days);
  if (!s) return null;
  let goal: boolean;
  if (s.status === "任何价位都成立") goal = true;
  else if (s.status === "任何价位都不成立") goal = false;
  else if (Math.abs(s.level! / a.close - 1) < 1e-4) return null;
  else goal = s.side === "以上" ? a.close > s.level! : a.close < s.level!;
  return happen ? goal : !goal;
}

const project: Generator = (c) => {
  const { a, rand } = c;
  const line = (n: number) => a.lines.find((l) => l.period === n)!;
  const hurdle = (n: number) => a.projection.hurdles.find((h) => h.period === n)!;
  const parts: Part[] = [], reveal: RevealPart[] = [], evidence: string[] = [], ids = new Set<string>();
  const close = f2(a.close);

  // 1. 第 n 天 MA20、MA60 往哪走：那天扣掉的收盘和收平价比（A1、A2）
  const n = pick(PROJECT_DAYS, rand);
  const dropped = (p: number) => hurdle(p).prices[n - 1];
  const p20 = dropped(20), p60 = dropped(60);
  if (p20 === undefined || p60 === undefined || p20 === a.close || p60 === a.close) return [];
  const w = (x: number) => (a.close > x ? "上" : "下");
  const dirAns = `MA20 ${w(p20)}、MA60 ${w(p60)}`;
  parts.push({ prompt: `之后每天都收在 T0 的 ${close}（收平），第 ${n} 天（T+${n}）当天 MA20、MA60 各往哪走？`, choices: [...DROPOFF_CHOICES], answer: DROPOFF_CHOICES.indexOf(dirAns as never) });
  reveal.push({ q: "dir", n });
  for (const [p, x] of [[20, p20], [60, p60]] as const) {
    evidence.push(`第 ${n} 天 MA${p} 扣掉 ${hurdle(p).dates[n - 1]} 那根（收盘 ${f2(x)}），收平 ${close} ${a.close > x ? "高于" : "低于"}它，MA${p} 向${w(x)}`);
  }
  ids.add("A1").add("A2");

  // 2. 30 天内 20/60 会不会双交叉、最早哪段：两组现在在同一边才问（J16），从推演求解读 10、20、30 天
  let cls = `方向:${dirAns}`;
  const sMa = Math.sign(line(20).ma - line(60).ma), sEma = Math.sign(line(20).ema - line(60).ema);
  if (sMa !== 0 && sMa === sEma) {
    const way = sMa > 0 ? "死叉" : "金叉";
    const [event, happen] = sMa > 0 ? ["20 线组双双跌破 60 线组", false] : ["20 线组双双站上 60 线组", true];
    const hits = ([10, 20, 30] as const).map((k) => occursAtClose(a, event as string, happen as boolean, k));
    if (hits.every((x) => x !== null)) {
      const first = hits.indexOf(true);
      const ans = bucketOf(first < 0 ? null : [10, 20, 30][first]);
      parts.push({ prompt: `20/60 两组现在都是快线在${sMa > 0 ? "上" : "下"}。一直收平，30 天内会不会出现双交叉（${way}）、最早在哪段时间？`, choices: [...CROSS_CHOICES], answer: CROSS_CHOICES.indexOf(ans) });
      reveal.push({ q: "cross", way });
      const sc = a.projection.scenarios[0];
      const day = (kind: "MA" | "EMA") => sc.crosses.find((x) => x.kind === kind && x.pair === "20/60")?.cross_day ?? null;
      const at = (k: number | null) => (k === null ? "30 天内不交叉" : `第 ${k} 天交叉`);
      evidence.push(`收平 30 天的推演：MA20/MA60 ${at(day("MA"))}，EMA20/EMA60 ${at(day("EMA"))}；两组都到了另一边才是双交叉，答案「${ans}」`);
      cls = `交叉:${ans}`;
      ids.add("J16").add("A1").add("A3");
    }
  }

  // 3. 要让 MA20（或 MA60）几天内拐头，收盘持平在哪：推演求解的临界价位，就是门槛路径前几天的最高（最低）价（A2）
  const p = pick([20, 60] as const, rand), days = pick(TURN_DAYS, rand);
  const s = a.projection.solves.find((x) => x.event.startsWith(`MA${p} 拐头向`) && x.happen && x.days === days);
  // 临界价位就是 T0 收盘时不问：MA20 第 20 天扣的是 T0 自己，这时答案和「现价」分不开
  if (s?.status === "有临界价位" && Math.abs(s.level! / a.close - 1) > 0.003) {
    const way = s.event.endsWith("向下") ? "下" : "上";
    const h = hurdle(p), path = h.prices.slice(0, days);
    const edge = way === "下" ? Math.max(...path) : Math.min(...path);
    const other = a.projection.solves.find((x) => x.event === s.event && x.happen && x.days !== days && x.level !== null)?.level ?? NaN;
    const price = priceChoices(s.level!, [other, way === "下" ? h.min_price : h.max_price, a.close, line(p).ma, line(p === 20 ? 60 : 20).ma]);
    if (price) {
      parts.push({ prompt: `要在 ${days} 天内让 MA${p} 拐头向${way}，收盘持平在哪个价位${s.side}？`, ...price });
      reveal.push({ q: "turn", period: p, way, days, level: s.level! });
      evidence.push(`MA${p} 未来 ${days} 天要扣的收盘里${way === "下" ? "最高" : "最低"}是 ${f2(edge)}（${h.dates[path.indexOf(edge)]} 那根）：持平在它${s.side}，扣到那一根 MA${p} 就拐头向${way}；推演求解的临界价位 ${f2(s.level!)}`);
      ids.add("A1").add("A2");
    }
  }
  if (parts.length < 2) return [];
  return [{
    kind: "project", cls, view: { bars: 140, lines: true, drops: true }, marks: [], context: PROJECT_CONTEXT,
    parts, evidence, rules: rulesOf(a, [...ids]), hint: null, reveal: { close: a.close, parts: reveal },
  }];
};

// ---------- 五步点图：在图上依次点出一轮转折的进度点 ----------

/** 点的和答案差几根以内算对。脚本自定：相邻两根常常一根是这一步、一根是下一步，差 1 根留给看图点偏的手。 */
export const STEP_TOLERANCE = 1;
const STEPS_MIN_BARS = 40;
const STEPS_MAX_BARS = 80;
/** 第一步之前多给几根，看得出转折前站在哪边。 */
const STEPS_PAD = 12;

/** 一轮转折出一道：走了几步就点几步。只出前 k 步都有日期的（中间跳了一步的不出），而且都在 80 根以内。 */
function stepsDraft(c: Ctx, p: PairProgress, turn: Turn | null): Draft | null {
  if (!turn || turn.progress === 0) return null;
  const k = turn.progress, done = turn.steps.slice(0, k);
  if (done.some((s) => !s.date)) return null;
  const ts = done.map((s) => tOf(c, s.date!));
  if (ts.some((t) => t === null)) return null;
  const bars = Math.max(STEPS_MIN_BARS, 1 - Math.min(...(ts as number[])) + STEPS_PAD);
  if (bars > STEPS_MAX_BARS) return null;
  const [fast, slow] = p.pair.split("/").map(Number);
  const up = turn.direction === "向上";
  const from = up ? "空头" : "多头";
  return {
    kind: "steps", cls: `${p.pair}·${turn.direction}·${k}步`, view: { bars, lines: true, drops: false }, marks: [],
    context: `${p.pair} 原来${from}排列。从最近一次完整站在${from}一边之后算起（两组都是 ${fast} 在 ${slow} ${up ? "下方" : "上方"}、收盘在两条 ${fast} 线${up ? "下方" : "上方"}、两条 ${fast} 线都朝${up ? "下" : "上"}走），每一步点它第一次出现的那根；几步落在同一根，就在那根点几次。差 ${STEP_TOLERANCE} 根以内算对。`,
    evidence: [
      `这一轮${turn.direction}转折的进度点：${done.map((s) => `${s.step} ${s.date}`).join("；")}${k < 5 ? `；${turn.steps.slice(k).map((s) => s.step).join("、")}还没有` : ""}`,
      "每个进度点记这一轮里第一次出现的那根；回到原来那边的完整状态，这一轮作废、重新记",
    ],
    rules: rulesOf(c.a, ["J15", "J16", "A1", "A3"]), hint: null,
    click: {
      prompt: `依次在图上点出 ${p.pair} 这一轮${turn.direction}转折的 ${done.map((s) => s.step).join(" → ")}（${k === 5 ? "五步都走完了" : `这一段走到第 ${k} 步`}，点 ${k} 下）。`,
      fast, slow, direction: turn.direction, steps: done.map((s, i) => ({ step: s.step, t: ts[i]! })), tolerance: STEP_TOLERANCE,
    },
  };
}

/** 点图题判分：第 i 步点的那根（相对题目那一根）和答案差 tolerance 根以内算对。全对才算这题对。 */
export function gradeClicks(task: Pick<ClickTask, "steps" | "tolerance">, picks: number[]): boolean[] {
  return task.steps.map((s, i) => picks[i] !== undefined && Math.abs(picks[i] - s.t) <= task.tolerance);
}

const steps: Generator = (c) => c.a.steps.flatMap((p) => [p.completed, p.current].map((t) => stepsDraft(c, p, t)).filter((d): d is Draft => d !== null));

/** 每种题一个出题函数。加题型：在 KINDS 加一个键，在这里登记。 */
export const GENERATORS: Record<Kind, Generator> = { chart, signal, dropoff, construct, play, fill, project, steps };

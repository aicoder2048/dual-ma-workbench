/**
 * 识别题：几秒一题，当场判，给答案、依据和规则编号。
 *
 * 每种题一个出题函数，登记在 GENERATORS 表里。出题函数拿到题目那一根收盘时 skill 的分析（dma_analyze），
 * 答案直接从分析的字段来，所以练的是系统的规则，不是谁的看法。一份分析可以出 0 到几道题（草稿），
 * 题库（drills.ts）按答案类别配额挑。草稿里的日期还是挪过的日期，入库时换成 T+n。
 */
import type { Analysis, Construct, StepName } from "../citations.ts";
import { buildPlans, playKey } from "../plan.ts";
import { entryStateOf } from "./discipline.ts";

export const KINDS = ["chart", "signal", "dropoff", "construct", "play"] as const;
export type Kind = (typeof KINDS)[number];
export const KIND_LABEL: Record<Kind, string> = { chart: "看图", signal: "看信号", dropoff: "看抵扣价", construct: "看构造和 2B", play: "看打法" };

/** 一问：几个选项，answer 是对的那个的位置。 */
export interface Part { prompt: string; choices: string[]; answer: number }
/** 图上画什么：最近 bars 根 K 线；lines 画 6 条均线；drops 画明天的抵扣价小点。 */
export interface View { bars: number; lines: boolean; drops: boolean }
/** 图上标出的 K 线：t 是相对题目那一根（0 是题目那根，-3 是往前 3 根）。 */
export interface Mark { t: number; text: string }
export interface Rule { id: string; name: string }

/**
 * 一道题的草稿。cls：答案类别，抽题时按它配平（例如看信号的「都不是」不能占八成）。
 * evidence：答完给看的依据，每条都是分析里的数字；rules：依据的规则编号。
 */
export interface Draft {
  kind: Kind;
  cls: string;
  view: View;
  marks: Mark[];
  context: string | null;
  parts: Part[];
  evidence: string[];
  rules: Rule[];
  hint: string | null;
}

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
function regimeChoices(name: string, rand: () => number): string[] {
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
  if (r.accel) { evidence.push(`加速：按${r.accel.by}判，在${r.accel.phase}`); ids.push("J3", "J8"); }
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
const STEP_MEANING: Record<StepName, string> = {
  破线: "收盘穿过 MA20、EMA20 两条线",
  "EMA 拐头": "EMA20 当天朝反方向走（收盘越过 EMA20 本身）",
  "MA 拐头": "MA20 当天朝反方向走（收盘越过 20 日抵扣价）",
  第一个交叉: "MA20 或 EMA20 有一条穿过 60 那条",
  双交叉: "MA20 穿过 MA60、EMA20 穿过 EMA60，两组都交叉",
};

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
      ans === "都不是" ? "这一根没有新走到的进度点" : `${ans}：${STEP_MEANING[ans]}`,
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
/** 空仓计划的止损（plan.ts 的 flat.stop.label）→ 选项。没有止损是「不设」。 */
export const STOP_CHOICES = ["60 线组拐头向下", "20/60 死叉", "跌回 EMA20 下方、EMA20 向下", "不设（这时不进场）"] as const;
const STOP_OF: Record<string, (typeof STOP_CHOICES)[number]> = {
  "60 线组拐头向下": "60 线组拐头向下", "20/60 死叉（守住）": "20/60 死叉", "跌回 EMA20 下方、EMA20 向下": "跌回 EMA20 下方、EMA20 向下",
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
  const stop = plan.stop ? STOP_OF[plan.stop.label] : STOP_CHOICES[3];
  if (!stop) throw new Error(`看打法：没见过的止损「${plan.stop!.label}」，加进 STOP_CHOICES`);
  const key = playKey(a);
  const st = entryStateOf(a);
  const hourlyless = Boolean(st.entries?.some((e) => e.id === "P14" && e.status === "满足")) && a.rules.find((r) => r.id === "P14")?.status === "需看图";
  const ids = st.entries === null ? a.play.rules : [...(st.play === "横盘" ? ["P1", "P2"] : []), ...st.entries.map((e) => e.id)];
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
      plan.stop ? `进场后止损：${plan.stop.label} ${f2(plan.stop.price)}` : "这套打法空仓没有止损：不进场",
      "等 = 这套打法会买、条件还没齐；不做 = 这种状态空仓不进场；反弹卖是持仓的做法",
    ],
    rules: rulesOf(a, [...new Set(ids)]), hint: null,
  }];
};

/** 每种题一个出题函数。加题型：在 KINDS 加一个键，在这里登记。 */
export const GENERATORS: Record<Kind, Generator> = { chart, signal, dropoff, construct, play };

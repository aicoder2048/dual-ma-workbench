/**
 * 引用：回答里的每个判断都要标出处。
 *
 * - `[[S:article#2.3]]`：引用库里的原文片段（sources.ts）。
 * - `[[D:扣20.均值]]`：当前分析结果里的数据字段（buildFacts 生成）。
 *
 * 服务端在回答结束后调用 validateCitations，把不存在的编号标出来，前端显示成红色。
 */
import { buildForecast, buildPlans, planFacts, planLine, playKey } from "./plan.ts";
import { naiveCompare, recordNote } from "./record.ts";
import type { SourceLibrary } from "./sources.ts";

export type CitationKind = "S" | "D";

export interface Citation {
  kind: CitationKind;
  ref: string;
  raw: string;
}

const CITATION = /\[\[(S|D):([^\]\n]+?)\]\]/g;

export function parseCitations(text: string): Citation[] {
  return [...text.matchAll(CITATION)].map((m) => ({ kind: m[1] as CitationKind, ref: m[2].trim(), raw: m[0] }));
}

export interface Fact {
  label: string;
  value: string;
}

export type Facts = Record<string, Fact>;

export type LeanLabel = "明显偏多" | "偏多" | "不明" | "偏空" | "明显偏空";

/** 类型线 MA60、MA120：朝今天的方向、收盘不变能保持几天；days 天天天这样走要收盘守在 level 那一边。 */
export interface LeanBasis { line: string; direction: "上" | "下" | "平"; hold_days: number; days: number; level: number; level_pct: number }
/** 什么会改变判断：价位在现价上方是"站上转多"，下方是"跌破转空"。 */
export interface Flip { line: string; price: number; toward: "多" | "空"; text: string }

/** 模糊判断：类型线组的方向和安全边际合成的分数（−1 最空，+1 最多）。up/down/flat、dirs、pairs 是 6 条线的证据。 */
export interface Lean {
  score: number;
  label: LeanLabel;
  basis: LeanBasis[];
  up: number;
  down: number;
  flat: number;
  dirs: Record<string, -1 | 0 | 1>;
  pairs: { pair: string; rel: -1 | 0 | 1 }[];
  flips: Flip[];
  after: { days: number; score: number; label: LeanLabel; up: number; down: number; flat: number };
}

export type TrendType = "加速上涨" | "稳定上涨" | "横盘" | "稳定下跌" | "加速下跌";
export interface Clock { line: string; angle: number; hour: string }

/** 类型 × 阶段（rules.md J1–J7）。type 为 null 时是过渡状态，看 transition。 */
export interface Regime {
  type: TrendType | null;
  stage: "延伸" | "回撤中" | "反弹中" | "转折中" | null;
  transition: "多头结构回撤中" | "空头结构反弹中" | "顶部转折中" | "底部转折中" | "失序" | null;
  name: string;
  direction: -1 | 0 | 1;
  clock60: Clock;
  clock20: Clock;
  order: -1 | 0 | 1;
  dir60: -1 | 0 | 1;
  dir120: -1 | 0 | 1;
  depth: string | null;
  range: { days: number; spread_pct: number; dense: boolean; box_high: number | null; box_low: number | null; opening: string | null } | null;
  accel: { phase: "起点" | "末端"; by: string } | null;
}

/** J8 的起点 / 末端是加速出现在趋势哪一头（视频 B 08:59），不是阶段：给人读时写「出现在…」，和脚本的 regime.ACCEL_WHERE 一致。 */
export const ACCEL_WHERE = { 起点: "趋势刚开始", 末端: "趋势即将结束" } as const;

export interface RuleResult {
  id: string;
  kind: "公理" | "判定" | "动作";
  name: string;
  status: "满足" | "不满足" | "需看图";
  basis: string;
  levels: Partial<Record<string, number>>;
  /** 自己满足、但结论相反的另一条规则也满足且优先时，写那条的编号（rules.md 的让位）。 */
  yields_to: string | null;
}

/** 五个进度点（rules.md J15）：一对线组的转折走到哪一步，每步带日期。 */
export type StepName = "破线" | "EMA 拐头" | "MA 拐头" | "第一个交叉" | "双交叉";
export interface Turn { direction: "向上" | "向下"; steps: { step: StepName; date: string | null }[]; progress: number }
export interface PairProgress { pair: "20/60" | "60/120"; side: "多头" | "空头" | null; completed: Turn | null; current: Turn | null }

/** 门槛路径（rules.md A2）：MA(period) 未来 days 天要扣的价格和它们的最高、最低。 */
export interface HurdlePath { period: number; days: number; dates: string[]; prices: number[]; max_price: number; max_day: number; min_price: number; min_day: number }
/** 持平情景：收盘停在 level days 天，每条线第几天转向、每对线第几天交叉、期末排列。 */
export interface Scenario {
  name: string; level: number; days: number;
  turns: { line: string; now: "上" | "下" | "平"; turn_day: number | null }[];
  crosses: { kind: "MA" | "EMA"; pair: string; now: "上方" | "下方"; cross: "金叉" | "死叉" | null; cross_day: number | null }[];
  end_arr_ma: string; end_arr_ema: string; end_values: Record<string, number>;
}
/** 求解：days 天内让 event 发生（happen=false 时不发生）要持平在 level 的哪一边。 */
export interface Solve {
  event: string; happen: boolean; days: number;
  status: "有临界价位" | "任何价位都成立" | "任何价位都不成立";
  level: number | null; pct: number | null; side: "以上" | "以下" | null;
}
/** dates：推演第 1…30 天的日期（工作日，不扣节假日）。 */
export interface ProjectionOut { dates: string[]; hurdles: HurdlePath[]; scenarios: Scenario[]; solves: Solve[] }
/** 顶底构造（structure.py）。形成中时 next_at 是下一根要越过的价位，bars_left 是最少还差几根。 */
export interface Construct {
  side: "顶部构造" | "底部构造"; state: "形成中" | "已完成" | "已破坏"; extreme: boolean;
  pivot_date: string; pivot_price: number; invalidation: number;
  /** 更低的高点（底部：更高的低点）、完成、破坏的那一根；还没有为 null。 */
  lh_date: string | null; done_date: string | null; broken_date: string | null;
  complete_at: number | null; next_at: number | null; bars_left: number | null;
}
/** 波段端点（高低交替）。 */
export interface Pivot { kind: "高" | "低"; date: string; price: number }
/** M 顶 / W 底 / 2B（rules.md J25、J26）：level 是颈线（2B 是前高 A），confirmed 是收盘越过它的那根，待确认为 null。 */
export interface Pattern {
  name: "M 顶" | "W 底" | "2B 顶" | "2B 底"; state: "已形成" | "待确认"; dates: string[]; level: number; confirmed?: string | null;
}
export interface StructureOut {
  available: boolean; top?: Construct | null; bottom?: Construct | null; pivots?: Pivot[]; patterns?: Pattern[];
}

/** 筹码山（volprofile.py）：foot 山脚（价格下沿）、top 山顶（上沿），share 占统计区间总量的比例。 */
export interface Mountain { foot: number; top: number; volume: number; share: number }
/** 筹码分布（skill 的 volprofile.py，JSON 的 profile）：规则和交易计划用的那份，统计最近 days 个自然日。 */
export type ProfileOut = Unavailable | {
  available: true; days: number; start: string; end: string; bars: number; edges: number[]; volumes: number[]; mountains: Mountain[];
};

export interface FrameLine { period: number; ma: number; ema: number }
export type Unavailable = { available: false; reason: string };
/** 周线（大一级）：同一套均线和排列。 */
export type Weekly = Unavailable | {
  available: true; bars: number; date: string; partial: boolean; close: number; arr_ma: string; arr_ema: string;
  lines: (FrameLine & { above: boolean; ma_direction: string; ema_direction: string })[];
};
/** 小时线（小一级）：给 P13 用；取不到时 P13 需看图。 */
export type Hourly = Unavailable | {
  available: true; source: string; bars: number; last: string; close: number; arr_ma: string; arr_ema: string; lines: FrameLine[];
};

/** 持有还是空仓：MA200 对照两边都说成这两个词。 */
export type HoldStance = "持有" | "空仓";
/**
 * MA200 朴素规则的对照（只是对照，不进规则）：收盘在 MA200 上方持有、否则空仓；
 * dual_ma_stance 是双均线照方向持有（类型稳定 / 加速上涨才持有，评估 H3 的定义）。
 */
export type Ma200 = Unavailable | {
  available: true; period: number; value: number; close_above: boolean; distance_pct: number; slope: number;
  direction: "上" | "下" | "平";
  last_cross: { kind: "上穿" | "下穿"; date: string; bars_ago: number } | null;
  stance: HoldStance; dual_ma_stance: HoldStance; agrees: boolean;
};

/**
 * 财报日（skill 的 earnings.py）：只是信息，不进规则。past 是日线窗口里 asof 及以前的，next 是之后第一次，
 * days_to_next 是 asof 之后到那天的工作日数。盲测练习没有这个字段（日期会泄露是哪只票）。
 */
export type Earnings = Unavailable | { available: true; past: string[]; next: string | null; days_to_next: number | null; source: string };

/** 唯一的打法：key 选 plan.ts 里按仓位的措辞，text 是脚本生成的那段话，rules 是用到的规则编号。 */
export interface Play { key: string; text: string; rules: string[] }

/**
 * 交易计划（skill 的 tradeplan.py，JSON 的 trade_plan）：进场、止损、目标位、盈亏比、股数都是脚本算的，
 * plan.ts 和页面只读，不重算。flat 是空仓（不买的打法 entry 为 null），holding 是持仓（没有进场和股数，止损按进场的原则）。
 * source：视频给了定价位的办法写"视频"，视频没给价位、脚本按原则放的写"解读"。
 */
export type PlanSource = "视频" | "解读";
/**
 * 触发价离现价还远时的推演（docs/adr/0026.md）：按收盘持平，days 天内 MA20、EMA20 同一天都向上的最低价位 level，
 * 持平在那里最早第 day 个交易日一起向上。只给显示用：进场价、盈亏比照旧按明天算，回测读那几个。
 */
export interface PlanFar { level: number; day: number; days: number }
/** far：触发价离现价还远时才有；旧数据没有。 */
export interface PlanEntry { price: number | null; condition: string; rule: string; far?: PlanFar | null }
export interface PlanStop { price: number | null; reason: string; rule: string; source: PlanSource }
export interface PlanTarget { price: number; kind: string; rule: string; source: PlanSource; date: string | null }
/** 上方最近的整座筹码山（P38）：只作参考价位，不是目标（docs/adr/0018.md）。foot 山脚、top 山顶，date 是统计区间"开始~结束"。 */
export interface PlanMountain { foot: number; top: number; date: string }
/** shares 为 null 时没填账户，看 per_10k（每 1 万元风险对应多少股）。 */
export interface PlanSize { shares: number | null; risk_amount: number | null; per_10k: number; unit_risk: number; capped: boolean; basis: string }
export type RrVerdict = "不做" | "可做" | "理想";
export interface TradePlan {
  entry: PlanEntry | null;
  stop: PlanStop | null;
  targets: PlanTarget[];
  rr: number | null;
  rr_verdict: RrVerdict | null;
  /** 不做时：要 3:1，目标得到哪、或止损得收紧到哪。 */
  rr_gap: { target_for_min: number; stop_for_min: number } | null;
  risk_pct: number | null;
  size: PlanSize | null;
  /** 到第一目标怎么办（P25）：中长线完好就继续拿，不完好就在目标位走。没有目标时为 null。 */
  at_target: string | null;
  notes: string[];
  /** 进场价（持仓是现价）上方最近的筹码山；上方没有时为 null。旧数据没有。 */
  mountain?: PlanMountain | null;
}
/** key：打法键，横盘里埋伏的底线已破时是"横盘破位"。 */
export interface PlanSet { key: string; flat: TradePlan; holding: TradePlan }

/**
 * 黑绿线读数（skill 的 rules.bwl_json，rules.md P40–P45，docs/adr/0022.md）：只是读数，交易计划不用它。
 * source 是 K 线颜色的来源（自带着色或本机的着色插件），只照着色插件的颜色判；applicable 是类型适不适用（只有稳定上涨、稳定下跌）。
 * 判不了时 color、arrangement 为 null，text 是原因；判了 text 是一句怎么读。
 */
export interface BwlReading {
  source: { key: "builtin" | "plugin"; name: string };
  applicable: boolean;
  color: "绿" | "黑" | "灰" | null;
  arrangement: "多头" | "空头" | "不一致" | null;
  text: string;
}

/** 结论卡片的黑绿线一行：配了着色插件、类型适用时才有。 */
export function bwlCard(a: Pick<Analysis, "bwl">): { source: string; text: string } | null {
  const b = a.bwl;
  return b && b.source.key === "plugin" && b.applicable ? { source: b.source.name, text: b.text } : null;
}

/** dma_analyze.py --json 里 analysis 的形状（只列用到的字段）。 */
export interface Analysis {
  label: string;
  date: string;
  close: number;
  change_pct: number;
  source: string;
  warning: string | null;
  lines: { period: number; ma: number; ema: number; above: boolean; slope: number; clock: string; ema_clock: string }[];
  arr_ma: string;
  arr_ema: string;
  spread_pct: number;
  bias20: number;
  bias_pctl: number;
  crosses: { pair: string; ma: string; ema: string }[];
  volume: { ratio: number; spikes: string[] } | null;
  regime: Regime;
  play: Play;
  trade_plan: PlanSet;
  /** 旧数据没有。 */
  bwl?: BwlReading;
  rules: RuleResult[];
  steps: PairProgress[];
  thresholds: Record<string, { value: number; source: string }>;
  projection: ProjectionOut;
  structure: StructureOut;
  /** 没补的向下缺口（tradeplan.unfilled_gaps，和找目标位同一个定义）：top 是跳空前一根的最低价，bottom 是没补的那段的底。旧数据没有。 */
  gaps?: { date: string; top: number; bottom: number }[];
  /** 筹码分布。旧数据没有。 */
  profile?: ProfileOut;
  weekly: Weekly;
  hourly: Hourly;
  ma200: Ma200;
  /** 盲测练习里拿掉（blind.ts 的 blindAnalysis）。 */
  earnings?: Earnings;
  lean: Lean;
  drops: {
    period: number; tomorrow: number; mean: number; max: number; below: number; count: number;
    first_low: number | null; ma_flat_change_pct: number; direction: string;
    path: { date: string; close: number }[];
  }[];
}

/** 下次财报在提醒窗口（thresholds.EARNINGS_WARN_DAYS 个交易日）内：返回日期和天数，否则 null。 */
export function earningsSoon(a: Pick<Analysis, "earnings" | "thresholds">): { next: string; days: number } | null {
  const e = a.earnings;
  const warn = a.thresholds.EARNINGS_WARN_DAYS?.value;
  if (!e?.available || !e.next || e.days_to_next === null || warn === undefined || e.days_to_next > warn) return null;
  return { next: e.next, days: e.days_to_next };
}

const f2 = (x: number) => x.toFixed(2);
const pct = (x: number, digits = 2) => `${x >= 0 ? "+" : ""}${x.toFixed(digits)}%`;

/** 把分析结果摊平成可引用的数据字段。键名就是引用编号，改了旧引用会失效。 */
export function buildFacts(a: Analysis): Facts {
  const facts: Facts = {};
  const put = (key: string, label: string, value: string) => (facts[key] = { label, value });

  put("日期", "K 线日期", a.date);
  put("收盘", "收盘价", f2(a.close));
  put("涨跌", "当日涨跌", pct(a.change_pct));
  put("数据源", "数据来源", a.source);
  put("趋势初判", "类型 × 阶段（规则判定）", a.regime.name);
  put("打法", "脚本按类型、阶段和规则结果给的打法", a.play.text);
  const ln = a.lean;
  put("模糊判断", "接下来几周对谁有利（类型线 MA60、MA120 的方向和能保持几天）", `${ln.label}（${ln.score >= 0 ? "+" : ""}${ln.score.toFixed(2)}）`);
  for (const b of ln.basis) {
    put(`模糊判断.${b.line}`, `${b.line} 收盘不变能朝今天的方向走几天`, `${b.direction}，${b.hold_days}/${b.days} 天；天天这样走要守在 ${f2(b.level)}（${pct(b.level_pct, 1)}）`);
  }
  put("模糊判断.方向", "6 条均线的方向票数", `${ln.up} 上 · ${ln.flat} 平 · ${ln.down} 下`);
  put("模糊判断.排布", `20/60、60/120 线组谁在上（≈ 是相差不到价格 ${a.thresholds.ORDER_TIE_PCT.value}%）`,
    ln.pairs.map((p) => `${p.pair} ${p.rel > 0 ? ">" : p.rel < 0 ? "<" : "≈"}`).join("，"));
  put("模糊判断.10天后", `价格不变 ${ln.after.days} 天后的模糊判断`, `${ln.after.label}（${ln.after.up} 上 · ${ln.after.down} 下）`);
  for (const f of ln.flips) put(`改变判断.${f.line}`, `什么会改变判断（转${f.toward}）：${f.line}`, f.text);
  for (const r of a.rules) put(`规则.${r.id}`, `规则 ${r.id} ${r.name}`, `${r.status}${r.yields_to ? `，${r.yields_to} 优先` : ""}：${r.basis}`);
  for (const p of a.steps) put(`五步.${p.pair}`, `${p.pair} 的五个进度点（破线、EMA 拐头、MA 拐头、第一个交叉、双交叉）`, stepsText(p));
  put("周线.排列", "周线 MA、EMA 排列", a.weekly.available ? `MA ${a.weekly.arr_ma}，EMA ${a.weekly.arr_ema}` : a.weekly.reason);
  put("小时线.排列", "小时线 MA、EMA 排列", a.hourly.available ? `MA ${a.hourly.arr_ma}，EMA ${a.hourly.arr_ema}（到 ${a.hourly.last}）` : a.hourly.reason);
  put("排列.MA", "MA 排列", a.arr_ma);
  put("排列.EMA", "EMA 排列", a.arr_ema);
  put("间距", "6 条线最大最小差占价格", `${a.spread_pct.toFixed(1)}%`);
  put("乖离20", "价格相对 MA20 的乖离率", pct(a.bias20, 1));
  put("乖离分位", "乖离率在自身历史中的分位", `${Math.round(a.bias_pctl * 100)}%`);
  for (const ln of a.lines) {
    const n = ln.period;
    put(`MA${n}`, `${n} 日 MA`, f2(ln.ma));
    put(`EMA${n}`, `${n} 日 EMA`, f2(ln.ema));
    put(`MA${n}.方向`, `${n} 日 MA 方向`, `${ln.clock} ${pct(ln.slope)}/日`);
    put(`EMA${n}.方向`, `${n} 日 EMA 方向`, ln.ema_clock);
    put(`MA${n}.位置`, `价格在 ${n} 日 MA 上方还是下方`, ln.above ? "上方" : "下方");
  }
  for (const c of a.crosses) {
    put(`交叉.${c.pair}`, `${c.pair} 最近交叉`, `MA ${c.ma}；EMA ${c.ema}`);
  }
  if (a.volume) {
    put("量比", "今日成交量 / 50 日均量", `${a.volume.ratio.toFixed(1)}×`);
    put("放量日", "近 20 日大量（>2×）的日子", a.volume.spikes.join("、") || "无");
  }
  for (const d of a.drops) {
    const n = d.period;
    put(`扣${n}.明天`, `MA${n} 明天的抵扣价`, `${f2(d.tomorrow)}（明天 MA${n} ${d.direction}）`);
    put(`扣${n}.均值`, `MA${n} 未来 ${d.count} 天抵扣价均值`, f2(d.mean));
    put(`扣${n}.最高`, `MA${n} 未来 ${d.count} 天抵扣价最高`, f2(d.max));
    put(`扣${n}.扣低天数`, `MA${n} 未来 ${d.count} 天里抵扣价低于现价的天数`, `${d.below}/${d.count}`);
    put(`扣${n}.价平变化`, `价格不变时 ${d.count} 天后 MA${n} 的变化`, pct(d.ma_flat_change_pct));
    put(`扣${n}.首次扣低`, `MA${n} 第几天首次扣到低于现价`, d.first_low ? `第 ${d.first_low} 天` : `${n} 天内都不会`);
  }
  for (const h of a.projection.hurdles) {
    put(`门槛.MA${h.period}`, `MA${h.period} 未来 ${h.days} 天抵扣价的最高、最低（rules.md A2）`,
      `最高 ${f2(h.max_price)}（第 ${h.max_day} 天）、最低 ${f2(h.min_price)}（第 ${h.min_day} 天）；守在最高之上天天上行，最低之下天天下行`);
  }
  const sc = a.projection.scenarios[0];
  const lines = a.lines.map((ln) => ln.period);
  for (const k of [...lines.map((n) => `MA${n}`), ...lines.map((n) => `EMA${n}`)]) {
    const now = k.startsWith("MA") ? a.lines.find((ln) => `MA${ln.period}` === k)!.ma : a.lines.find((ln) => `EMA${ln.period}` === k)!.ema;
    const turn = sc.turns.find((t) => t.line === k);
    put(`推演.${k}`, `价格不变 ${sc.days} 天后的 ${k}`, `${f2(now)} → ${f2(sc.end_values[k])}${turn?.turn_day ? `，第 ${turn.turn_day} 天转向` : ""}`);
  }
  put("推演.排列.MA", `价格不变 ${sc.days} 天后的 MA 排列`, `${a.arr_ma} → ${sc.end_arr_ma}`);
  put("推演.排列.EMA", `价格不变 ${sc.days} 天后的 EMA 排列`, `${a.arr_ema} → ${sc.end_arr_ema}`);
  for (const s of a.projection.solves) put(`求解.${solveKey(s)}`, `${s.days} 天内${s.happen ? "让" : "不让"}「${s.event}」发生要持平在哪`, solveText(s));
  const plans = buildPlans(a);
  put("结论.空仓", "空仓的做法、触发价、进场后止损", planLine(plans.flat, a.close, true));
  put("结论.持仓", "持仓的做法、加减仓价位、止损", planLine(plans.holding, a.close, false));
  for (const [k, label, value] of planFacts(a.trade_plan, a.close)) put(k, label, value);
  if (a.bwl) put("黑绿线", `黑绿线读数（P40–P45，颜色：${a.bwl.source.name}；只是读数，交易计划没用它）`, a.bwl.text);
  for (const [k, label, value] of profileFacts(a)) put(k, label, value);
  const fc = buildForecast(a, plans);
  put("推演.结论", "模糊判断翻成的一句话：均线接下来几周往哪走，回撤 / 反弹该怎么看", fc.headline);
  for (const g of fc.groups) put(`推演.${g.group}线组`, `${g.group} 线组最近的关键变化：现在朝哪走、收盘不变哪天拐头、明天站上 / 跌破哪就拐头`, `${g.now}：${g.text}${g.aux ? `${g.aux}（推演求解，辅助）` : ""}`);
  put("推演.保持", `类型线 MA60、MA120 未来 ${fc.days} 天能保持多久、守在哪`, fc.hold);
  put("推演.最早", "这套打法的条件最早哪天能齐", fc.earliest);
  put("推演.失效", "什么价位推翻这个判断", fc.invalid.text);
  put("回测", "这套打法的回测记录（skill 的 backtest.py）", recordNote(playKey(a)).text);
  const m = a.ma200;
  if (m.available) {
    const x = m.last_cross;
    put("MA200", "200 日 MA（对照用，不进规则）",
      `${f2(m.value)}，向${m.direction}；${x ? `${x.date} 收盘${x.kind}（${x.bars_ago} 根前）` : "窗口内收盘没穿过"}`);
  }
  put("MA200.对照", "MA200 朴素规则（收盘在上方持有，否则空仓）和双均线照方向持有一不一致", naiveCompare(m).text);
  const e = a.earnings;
  if (e) {
    const soon = earningsSoon(a);
    put("财报.下次", `下次财报（只是信息，不进规则；${a.thresholds.EARNINGS_WARN_DAYS?.value ?? "—"} 个交易日内提醒跳空风险）`,
      !e.available ? e.reason : e.next ? `${e.next}（${e.days_to_next} 个交易日后${soon ? "，在提醒窗口内：跳空可能越过止损价" : ""}）` : "还没公布");
    if (e.available && e.past.length) put("财报.上次", "上一次财报", e.past.at(-1)!);
  }
  return facts;
}

/**
 * 筹码分布给模型看的数据字段（[[D:筹码.上方]] 这样引用）：只当价位和目标参考，不是买卖信号（docs/adr/0015.md）；
 * 筹码山不排进第一目标、不算盈亏比（docs/adr/0018.md）。
 * 统计区间是最近 1 年，和工作台图上按可见范围算的那份不一定是同一段。
 */
export function profileFacts(a: Pick<Analysis, "profile" | "close" | "trade_plan">): [string, string, string][] {
  const p = a.profile;
  if (!p) return [];
  if (!p.available) return [["筹码.区间", "筹码分布的统计区间", p.reason]];
  const band = (m: Mountain) => `${f2(m.foot)}–${f2(m.top)}（占 ${Math.round(m.share * 100)}%）`;
  const above = p.mountains.find((m) => m.foot > a.close);
  const below = p.mountains.filter((m) => m.top < a.close).at(-1);
  const inside = p.mountains.find((m) => m.foot <= a.close && a.close <= m.top);
  const ref = a.trade_plan.flat.mountain ?? a.trade_plan.holding.mountain;
  const note = "只当价位和目标参考，不是买卖信号";
  return [
    ["筹码.区间", "筹码分布的统计区间（规则、交易计划用的那份，和图默认的 1 年视图同一段）", `${p.start} ~ ${p.end}，${p.bars} 根`],
    ["筹码.山", `筹码山的山脚到山顶，从低到高（J46；${note}）`, p.mountains.map(band).join("、") || "没有"],
    ["筹码.上方", `收盘上方最近的整座筹码山：反弹的目标区间（J47；${note}）`, above ? band(above) : "上方没有整座的筹码山"],
    ["筹码.下方", "收盘下方最近的整座筹码山", below ? band(below) : "下方没有整座的筹码山"],
    ["筹码.所在", "收盘所在的筹码山（在山里照 P25 看中长线，P39）", inside ? band(inside) : "不在哪座山里"],
    ["筹码.参考带", "交易计划记下的上方最近的筹码山（P38）：只作参考，不排进第一目标、不算盈亏比",
      ref ? `${f2(ref.foot)}–${f2(ref.top)}` : "进场价（持仓是现价）上方没有整座的筹码山"],
  ];
}

/** 求解的引用键：去掉括号里的说明和空格，例如 "理顺向上.10天"。 */
export const solveKey = (s: Solve) => `${s.happen ? "" : "不"}${s.event.split("（")[0].replace(/\s/g, "")}.${s.days}天`;

export function solveText(s: Solve): string {
  if (s.status !== "有临界价位") return s.status;
  return `持平在 ${f2(s.level!)}（${pct(s.pct!, 1)}）${s.side}`;
}

export function stepsText(p: PairProgress): string {
  const cell = (t: Turn | null) => t ? `${t.direction} ${t.progress}/5${t.steps.filter((x) => x.date).map((x) => `，${x.step} ${x.date}`).join("")}` : "—";
  return `${p.side ?? "未定"}；上一次 ${cell(p.completed)}；现在 ${cell(p.current)}`;
}

/** 给模型看的数据字段清单：`D:键 = 值（说明）`，一行一个。 */
export function factsForPrompt(facts: Facts): string {
  return Object.entries(facts)
    .map(([k, f]) => `D:${k} = ${f.value}（${f.label}）`)
    .join("\n");
}

/**
 * 一次回答可能涉及多只股票：按股票代码存数据字段，`current` 是不写代码时默认指的那只。
 * 引用写法：`[[D:MA20]]`（默认股票）或 `[[D:TSLA:MA20]]`（指定股票）。
 */
export interface FactsBook {
  byTicker: Record<string, Facts>;
  current: string | null;
}

export const bookOf = (ticker: string, facts: Facts): FactsBook => ({ byTicker: { [ticker]: facts }, current: ticker });

export function lookupFact(book: FactsBook | null, ref: string): Fact | undefined {
  if (!book) return undefined;
  const m = ref.match(/^([A-Z0-9.\-^=]+):(.+)$/);
  const ticker = m ? m[1] : book.current;
  const key = m ? m[2] : ref;
  return ticker ? book.byTicker[ticker]?.[key] : undefined;
}

export interface CitationCheck {
  citation: Citation;
  ok: boolean;
  /** 校验通过时：原文片段标题或数据值，前端悬停显示。 */
  title?: string;
  value?: string;
}

export function validateCitations(text: string, lib: SourceLibrary, book: FactsBook | null): CitationCheck[] {
  return parseCitations(text).map((citation) => {
    if (citation.kind === "S") {
      const chunk = lib.get(citation.ref);
      return chunk
        ? { citation, ok: true, title: `${chunk.docTitle} · ${chunk.heading}` }
        : { citation, ok: false };
    }
    const fact = lookupFact(book, citation.ref);
    return fact ? { citation, ok: true, title: fact.label, value: fact.value } : { citation, ok: false };
  });
}

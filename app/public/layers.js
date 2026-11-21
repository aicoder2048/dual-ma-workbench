// 图上画什么：一张图层表。预设、能不能用、现在是不是某个预设，都是这张表上的纯函数（单元测试直接用）；
// chart.js 只照着画，layermenu.js 只照着摆菜单。默认只画最少的（ADR 0019）。

/** 预设，从少到多。没存过的、存坏了的都是第一个。 */
export const PRESETS = [
  { key: "simple", label: "简洁", title: "只画均线、价位线、抵扣价" },
  { key: "structure", label: "结构", title: "简洁之上加顶底构造、形态、波段、缺口" },
  { key: "all", label: "全部", title: "全画：再加着色和变色提示、所有缺口、筹码" },
];
export const DEFAULT_PRESET = "simple";

const SIMPLE = ["simple", "structure", "all"], STRUCTURE = ["structure", "all"], ALL = ["all"];

/**
 * 能不能用看图表现在的情况 ctx：
 * { frame: "day" | "week", replay: 在不在回放, practice: 在不在练习, structure: 这份数据有没有结构标注,
 *   gaps: 没补的缺口有几个（null：这份数据没有缺口）, moreGaps: 默认不画的缺口有几个, volume: 有没有成交量,
 *   tone: 颜色的来源 { name, legend, warning }（tones.js 的 toneInfo，日线、周线各一份）, tones: 这份数据的 K 线有没有颜色 }。
 * 返回不能用的原因；能用返回 null。
 */
const always = () => null;
/** 结构（构造、形态、波段）属于分析那一天：回放时收起（会露出之后才知道的构造），练习、揭晓时没有（免得提前看到答案）。 */
const structureWhy = (c) => (c.frame === "week" ? "结构按日线算：切回日线看"
  : c.replay ? "回放时收起：结构是按最新一天算的，会露出之后的走势"
  : !c.structure ? "这份数据没有结构标注（练习里不画，免得提前看到答案）" : null);
const gapsWhy = (c) => (c.frame === "week" ? "缺口按日线算：切回日线看"
  : c.replay ? "回放时收起：缺口补没补要看之后的 K 线"
  : c.gaps === null ? "这份数据没有缺口（练习里不画，免得提前看到答案）"
  : c.gaps === 0 ? "上方没有没补的缺口" : null);
const profileWhy = (c) => (c.frame === "week" ? "筹码按日线算：切回日线看"
  : !c.volume ? "这份数据没有成交量，算不了筹码分布" : null);
/** 练习里的题目就是让人自己认变色，标出来等于给答案。 */
const turnsWhy = (c) => (c.practice ? "练习里不标：这是题目要你自己看的"
  : !c.tones ? "这份数据的 K 线没有颜色，标不出变色" : null);

/**
 * 每个图层一行。key：状态里的键；group：菜单里的分组，同一组里第一行是主项，后面的是它的子项（主项关着或不能用，子项也不能用）；
 * presets：属于哪些预设；available(ctx)：见上。菜单里的字都可以写成看 ctx 的函数：
 * hint：标签后面的一句小字；lead：小字前面单独一行、不变灰的字（「着色」写颜色是谁算的）；title：悬停看的说明；
 * note：这一行下面的一句提醒，没有就不占地方。
 */
export const LAYERS = [
  { key: "ma", group: "均线", label: "均线", hint: "MA、EMA 20 / 60 / 120", presets: SIMPLE, available: always,
    title: "6 条均线和点开了的 MA200。画哪几条、聚焦哪一组，在上面的图例里选" },
  { key: "levels", group: "价位线", label: "价位线", hint: "触发、止损、目标、判断失效", presets: SIMPLE,
    available: (c) => (c.replay ? "回放时收起：价位线属于最新一天的结论" : null),
    title: "把结论里的触发价、止损、目标和推翻判断的价位画成虚线" },
  { key: "drops", group: "抵扣价", label: "抵扣价", hint: "小黄点", presets: SIMPLE, available: always,
    title: "小黄点：明天各条 MA 要扣掉的那根 K 线（抵扣价）" },
  // 颜色按什么规则算、怎么读，都由图表数据的 tone_source 说（自带规则或本机的着色插件），这里不留一份
  { key: "tone", group: "着色", label: "着色", presets: ALL, available: always,
    lead: (c) => c.tone.name, hint: (c) => c.tone.legend[0] ?? "", note: (c) => c.tone.warning,
    title: (c) => [c.tone.name, ...c.tone.legend].filter(Boolean).join("\n") },
  { key: "toneTurns", group: "着色", label: "变色提示", hint: "转绿标 ▲、转黑标 ▼", presets: ALL, available: turnsWhy,
    title: "K 线上方的小三角：这根是绿而上一根不是，标 ▲（转绿）；这根是黑而上一根不是，标 ▼（转黑）。"
      + "只看颜色有没有变，和颜色按什么规则算无关。鼠标停在那根上，读数条里写「转绿」或「转黑」" },
  { key: "constructs", group: "顶底构造", label: "顶底构造", hint: "最近的顶部、底部构造", presets: STRUCTURE, available: structureWhy,
    title: "最近的顶部 / 底部构造和它的状态；形成中时旁边的短虚线写着下一根 K 线怎样就完成。点图上的标记看规则原文" },
  { key: "patterns", group: "形态", label: "形态", hint: "M 顶、W 底、2B 和颈线", presets: STRUCTURE, available: structureWhy,
    title: "M 顶 / W 底 / 2B：标在收盘越过颈线（2B 是越过前高、前低 A）的那根，带 ? 的还没确认；颈线一起画。点图上的标记看规则原文" },
  { key: "swings", group: "波段", label: "波段", hint: "连起构造高低点的细线", presets: STRUCTURE, available: structureWhy,
    title: "波段：把顶部构造的最高点连到底部构造的最低点，最后一段虚线是还在形成的那个构造" },
  { key: "gaps", group: "缺口", label: "缺口", hint: "没补的向下缺口", presets: STRUCTURE, available: gapsWhy,
    title: "没补的向下缺口：从跳空那天画到现在的色带，上沿是跳空前一天的最低价，下沿是还没补的那段的底；交易计划拿它当目标位的标「目标位」。默认只画目标位和离现价最近的上下各一个" },
  { key: "gapsAll", group: "缺口", label: "全部", presets: ALL,
    hint: (c) => `离得远、不是目标位的那 ${c.moreGaps} 个也画`,
    available: (c) => (c.moreGaps > 0 ? null : "没有更多：要紧的那几个就是全部"),
    title: "把离得远、不是目标位的缺口也画出来" },
  { key: "profile", group: "筹码", label: "筹码", hint: "按价格统计成交量", presets: ALL, available: profileWhy,
    title: "筹码分布：按价格统计图上看得见的那段 K 线的成交量，画成贴着价格轴的横向山（视频 O）。"
      + "描框的是筹码山，标出山脚（下沿）、山顶（上沿）；交易计划记下的上方最近那座高亮，写着「参考带」（P38）：只作参考，不排进第一目标、不算盈亏比。筹码分布只当价位参考，不是买卖信号" },
];

/** 一个预设的状态 { [key]: boolean }。 */
export const presetState = (name) => Object.fromEntries(LAYERS.map((l) => [l.key, l.presets.includes(name)]));

/** 现在的状态是哪个预设；手动改过、对不上任何一个返回 null（菜单里显示「自定」）。 */
export const presetOf = (state) => PRESETS.find((p) => LAYERS.every((l) => Boolean(state[l.key]) === l.presets.includes(p.key)))?.key ?? null;

export const toggleLayer = (state, key) => ({ ...state, [key]: !state[key] });

/**
 * 菜单的每一行：{ key, group, label, lead, hint, title, note, sub（是不是子项）, on（开关开着）, why（不能用的原因或 null）,
 * shown（图上画不画 = 开着而且能用） }。lead、note 没有时是 null。
 */
export function layerRows(state, ctx) {
  const text = (v) => (typeof v === "function" ? v(ctx) : v) ?? null;
  const rows = [];
  for (const l of LAYERS) {
    const head = rows.find((r) => r.group === l.group);
    const why = head ? head.why ?? (head.on ? l.available(ctx) : `先打开「${head.label}」`) : l.available(ctx);
    const on = Boolean(state[l.key]);
    rows.push({ key: l.key, group: l.group, label: l.label, lead: text(l.lead), hint: text(l.hint), title: text(l.title), note: text(l.note),
      sub: Boolean(head), on, why, shown: on && !why });
  }
  return rows;
}

/** 图上现在画哪些图层：{ [key]: boolean }。 */
export const shownLayers = (state, ctx) => Object.fromEntries(layerRows(state, ctx).map((r) => [r.key, r.shown]));

/** 本机存的开关（localStorage 的 dma-layers）→ 状态。没存过、存坏了是简洁；少了的图层按简洁补，不认识的键丢掉。 */
export const LAYERS_KEY = "dma-layers";
export function parseLayers(text) {
  const base = presetState(DEFAULT_PRESET);
  let saved = null;
  try { saved = JSON.parse(text ?? "null"); } catch { /* 存坏了：当没存过 */ }
  if (saved === null || typeof saved !== "object") return base;
  return Object.fromEntries(Object.keys(base).map((k) => [k, typeof saved[k] === "boolean" ? saved[k] : base[k]]));
}

// 图上的结构标注和缺口：把分析 JSON 的 structure / gaps 换成图上要画的东西（第几根 K 线、什么价位）。
// 只换算，不重新判断：构造、波段、M 顶 / 2B、缺口都是 skill 的 structure.py、tradeplan.py 算好的。纯函数，单元测试直接用。

/** 只连最近这么多个波段端点（5 段），图上不至于太乱。 */
export const SWING_PIVOTS = 6;
/** 形成中的构造那条短虚线：最多往回画几根、往右边留白里伸几根。 */
const LEVEL_BACK = 8;
const LEVEL_AHEAD = 2;

const TOP = "顶部构造";

/** 日期 → 图上第几根；不在图上（比第一根早，或回放没走到）返回 null。 */
const indexer = (candles) => {
  const at = new Map(candles.map((c, i) => [c.time, i]));
  return (date) => (date == null ? null : at.get(date) ?? null);
};

const f2 = (x) => x.toFixed(2);

/** 构造的说明（点开标记时写在规则原文上面）。 */
function constructLead(c) {
  const top = c.side === TOP;
  const head = `${c.side} · ${c.state}${c.extreme ? "（极端构造）" : ""}：${top ? "新高" : "新低"} ${c.pivot_date} 的 ${f2(c.pivot_price)}`;
  if (c.state === "已破坏") return `${head}；${c.broken_date} ${top ? "又创新高" : "又创新低"}，构造作废，从新的${top ? "高" : "低"}点重新找。`;
  if (c.state === "已完成") return `${head}；${c.done_date} 完成。之后${top ? "最高价超过" : "最低价跌破"} ${f2(c.invalidation)} 就作废。`;
  return `${head}；${nextText(c)}。${top ? "最高价超过" : "最低价跌破"} ${f2(c.invalidation)} 就作废。`;
}

/** 形成中的构造下一根要怎样：只差一根时是"就完成"，差两根时是"往前走一步"。 */
function nextText(c) {
  const price = c.complete_at ?? c.next_at;
  if (price == null) return "";
  const cond = c.side === TOP ? `最低价低于 ${f2(price)}` : `最高价高于 ${f2(price)}`;
  return c.bars_left === 1 ? `下一根${cond} 就完成` : `下一根${cond} 往前走一步，最少还差 ${c.bars_left} 根`;
}

const PATTERN_RULE = { "M 顶": "J25", "W 底": "J25", "2B 顶": "J26", "2B 底": "J26" };

function patternLead(p) {
  const mw = p.name === "M 顶" || p.name === "W 底";
  const what = mw ? `三个构造 ${p.dates.join("、")}，颈线 ${f2(p.level)}` : `前${p.name.endsWith("顶") ? "高" : "低"} A ${p.dates[0]} 的 ${f2(p.level)}，${p.dates[1]} 越过它`;
  const done = p.confirmed ? `；${p.confirmed} 收盘${p.name.endsWith("顶") ? "跌破" : "升破"} ${f2(p.level)}` : "；还没收盘越过";
  return `${p.name} · ${p.state}：${what}${done}。`;
}

/**
 * structure（分析 JSON 的 structure）→ 图上要画的：
 * - segments：波段（最近 SWING_PIVOTS 个端点连线，J24），最后一个端点到正在形成的反向构造是虚线；M / W 的颈线、2B 的前高（前低）
 * - levels：形成中的构造"下一根怎样"的价位（J27），从新高（新低）那根画到最新一根
 * - marks：最近的顶部、底部构造和 M 顶 / W 底 / 2B 的标记，点开看规则原文
 * 点用 { i: 第几根, price }；不在图上的点所在的线、标记不画。
 * parts：三个图层各画不画（layers.js）。swings：波段连线；constructs：构造的标记和 levels；patterns：M / W / 2B 的标记和颈线。
 */
export function structureScene(s, candles, parts = { constructs: true, patterns: true, swings: true }) {
  const empty = { segments: [], levels: [], marks: [] };
  if (!s?.available || !candles.length) return empty;
  const idx = indexer(candles);
  const last = candles.length - 1;
  const segments = [];
  const pt = (date, price) => {
    const i = idx(date);
    return i === null ? null : { i, price };
  };
  const pivots = parts.swings ? (s.pivots ?? []).slice(-SWING_PIVOTS) : [];
  for (let k = 1; k < pivots.length; k++) {
    const a = pt(pivots[k - 1].date, pivots[k - 1].price), b = pt(pivots[k].date, pivots[k].price);
    if (a && b) segments.push({ kind: "swing", a, b });
  }
  const constructs = [s.top, s.bottom].filter(Boolean);
  // 正在形成的构造和最后一个端点方向相反：这一段波段还没走完，画虚线
  const end = pivots.at(-1);
  const forming = constructs.find((c) => c.state === "形成中" && end && (c.side === TOP) === (end.kind === "低") && c.pivot_date > end.date);
  if (forming) {
    const a = pt(end.date, end.price), b = pt(forming.pivot_date, forming.pivot_price);
    if (a && b) segments.push({ kind: "tentative", a, b });
  }
  const marked = parts.constructs ? constructs : [];
  const levels = [];
  for (const c of marked) {
    const price = c.complete_at ?? c.next_at;
    const i = idx(c.pivot_date);
    if (c.state !== "形成中" || price == null || i === null) continue;
    const cond = c.side === TOP ? `低 < ${f2(price)}` : `高 > ${f2(price)}`;
    levels.push({ a: { i: Math.max(i, last - LEVEL_BACK), price }, b: { i: last + LEVEL_AHEAD, price }, side: c.side === TOP ? "top" : "bottom",
      text: `下一根${cond} ${c.side === TOP ? "顶" : "底"}构造${c.bars_left === 1 ? "完成" : "进一步"}` });
  }
  const marks = [];
  for (const c of marked) {
    const i = idx(c.pivot_date);
    if (i === null) continue;
    const top = c.side === TOP;
    marks.push({ i, side: top ? "top" : "bottom", text: `${top ? "顶" : "底"}·${c.state}`,
      rule: c.state === "已破坏" ? "J22" : c.state === "形成中" && c.bars_left === 1 ? "J27" : top ? "J20" : "J21",
      tone: c.state === "已破坏" ? "faint" : top ? "down" : "up", lead: constructLead(c), stack: 0 });
  }
  // M / W 和 2B 各只标最近的一个：五个全标会把最近几根 K 线盖住
  const latest = (two) => (s.patterns ?? []).filter((p) => p.name.startsWith("2B") === two).at(-1);
  for (const p of parts.patterns ? [latest(false), latest(true)].filter(Boolean) : []) {
    const top = p.name.endsWith("顶");
    const at = idx(p.confirmed ?? p.dates.at(-1));
    if (at === null) continue;
    marks.push({ i: at, side: top ? "top" : "bottom", text: `${p.name.replace(" ", "")}${p.confirmed ? "" : "?"}`,
      rule: PATTERN_RULE[p.name], tone: top ? "down" : "up", lead: patternLead(p), stack: 0 });
    // 颈线从中间那个构造（M / W）、前高从 A（2B）画到收盘越过它的那根；待确认画到最新一根
    const from = idx(p.name.startsWith("2B") ? p.dates[0] : p.dates[1]);
    const to = p.confirmed ? at : last;
    if (from !== null) segments.push({ kind: "neck", a: { i: from, price: p.level }, b: { i: to, price: p.level }, label: p.name.startsWith("2B") ? "A" : "颈线" });
  }
  // 同一根 K 线同一侧有两个标记时往外叠，免得盖在一起
  const seen = new Map();
  for (const m of marks) {
    const key = `${m.i}|${m.side}`;
    m.stack = seen.get(key) ?? 0;
    seen.set(key, m.stack + 1);
  }
  return { segments, levels, marks };
}

/**
 * 没补的缺口（分析 JSON 的 gaps，和交易计划找目标位同一个定义）→ 色带：从跳空那根画到最新一根，上沿是前一根最低价，
 * 下沿是还没补的那段的底。targets 是交易计划的目标位，缺口被用作目标的标出来。跳空在图的第一根之前时从第一根画起。
 */
export function gapBands(gaps, targets, candles) {
  if (!gaps?.length || !candles.length) return [];
  const last = candles.length - 1;
  return gaps.filter((g) => g.date <= candles[last].time).map((g) => {
    const from = candles.findIndex((c) => c.time >= g.date);
    const target = isTarget(g, targets);
    return { from, to: last, top: g.top, bottom: g.bottom, target, date: g.date,
      label: `缺口 ${f2(g.bottom)}–${f2(g.top)}${target ? " · 阻力位" : ""}` };
  });
}

/** 交易计划拿这个缺口当目标位了吗（目标位记的是缺口的日期和下沿）。 */
const isTarget = (g, targets) => (targets ?? []).some((t) => t.kind === "缺口" && t.date === g.date && Math.abs(t.price - g.bottom) < 1e-6);

/**
 * 默认只画要紧的缺口：交易计划当目标位的，加上离现价最近的上方、下方各一个（价格在缺口里面算上方）。
 * 其余的收在「全部缺口」后面。按原来的顺序返回。
 */
export function pickGaps(gaps, targets, close) {
  if (!gaps?.length) return [];
  const above = gaps.filter((g) => g.top > close), below = gaps.filter((g) => g.top <= close);
  const nearest = [
    above.reduce((a, g) => (!a || g.bottom < a.bottom ? g : a), null),
    below.reduce((a, g) => (!a || g.top > a.top ? g : a), null),
  ];
  return gaps.filter((g) => nearest.includes(g) || isTarget(g, targets));
}

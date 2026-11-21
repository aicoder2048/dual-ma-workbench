// K 线回放：从过去某一天开始，一根一根往后放。纯逻辑，不碰页面。
// 状态：{ mode: "off" } | { mode: "replay", index, playing }。"点图选起点"是图上的交互模式（chart.js 的 tool），不在这里。

export const OFF = { mode: "off" };
export const PERIODS = [20, 60, 120];
/** 速度倍数：1x = 一秒一根。 */
export const SPEEDS = [0.1, 0.3, 0.5, 1, 3, 5, 10];
export const DEFAULT_SPEED = 1;
export const speedMs = (x) => 1000 / x;

const at = (index, playing = false) => ({ mode: "replay", index, playing });

/** total：K 线总根数。不合法的动作原样返回同一个状态。 */
export function step(s, action, total) {
  const last = total - 1;
  switch (action.type) {
    case "pick":
      if (!Number.isInteger(action.index) || action.index < 0 || action.index > last) return s;
      return at(action.index, action.index < last); // 选好起点就开始播放（最后一根没东西可放）
    case "realtime":
    case "exit":
      return s.mode === "off" ? s : OFF;
  }
  if (s.mode !== "replay") return s;
  switch (action.type) {
    case "play":
      return s.playing || s.index >= last ? s : at(s.index, true);
    case "pause":
      return s.playing ? at(s.index) : s;
    case "toggle":
      return step(s, { type: s.playing ? "pause" : "play" }, total);
    case "back": // 回退一根：停下来看（边放边退没意义）；第一根上不动
      return s.index > 0 ? at(s.index - 1) : s;
    case "forward":
      if (s.index >= last) return s.playing ? at(last) : s;
      return at(s.index + 1, s.playing && s.index + 1 < last);
    default:
      return s;
  }
}

/**
 * 截到第 index 根的图表数据（K 线、量、6 条线都只留到那天）。
 * 抵扣价小黄点 = 第 index 天"明天要扣"的那根：第 index-n+1 根（Python 的 close[-n]），不在图上就不画。
 */
export function sliceAt(d, index) {
  const candles = d.candles.slice(0, index + 1);
  const t = candles.at(-1).time;
  const upTo = (pts) => pts.filter((p) => p.time <= t);
  return {
    candles,
    volume: upTo(d.volume),
    lines: Object.fromEntries(Object.entries(d.lines).map(([k, pts]) => [k, upTo(pts)])),
    drops: PERIODS.filter((n) => index - n + 1 >= 0).map((n) => ({ time: d.candles[index - n + 1].time, period: n })),
  };
}

/** 选日期：那天或之前最近的一根；比第一根还早返回 -1。 */
export function indexOnOrBefore(candles, date) {
  let i = -1;
  while (i + 1 < candles.length && candles[i + 1].time <= date) i++;
  return i;
}

/**
 * 最早一天：6 条线都有值的第一根。服务端用 3 年历史算线，图上的 K 线通常从第一根起就都有值；
 * 历史不够的票（刚上市不久）长均线会晚开始。没有一根齐全时从第一根开始。MA200 只是对照线，不算在内。
 */
export function earliestIndex(d) {
  const starts = Object.entries(d.lines).filter(([k]) => k !== "MA200").map(([, pts]) => pts[0]?.time).filter(Boolean);
  const from = starts.reduce((a, b) => (a > b ? a : b), "");
  const i = d.candles.findIndex((c) => c.time >= from);
  return i < 0 ? 0 : i;
}

/** 随机一天：最早一天到倒数第二根之间（至少留一根可放）。 */
export function randomIndex(d, rand = Math.random) {
  const total = d.candles.length;
  const lo = Math.min(earliestIndex(d), Math.max(0, total - 2));
  const hi = Math.max(lo, total - 2);
  return lo + Math.floor(rand() * (hi - lo + 1));
}

/** 盲测练习往后一根：服务端发来新的一根（K 线、量、6 条线的点、新的抵扣价），接到图表数据后面。 */
export function appendDelta(d, delta) {
  return {
    candles: [...d.candles, delta.candle],
    volume: [...d.volume, ...delta.volume],
    lines: Object.fromEntries(Object.entries(d.lines).map(([k, pts]) => [k, [...pts, ...(delta.lines[k] ?? [])]])),
    drops: delta.drops,
  };
}

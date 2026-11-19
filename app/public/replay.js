// K 线回放：从过去某一天开始，一根一根往后放。纯逻辑，不碰页面。
// 状态：{ mode: "off" } | { mode: "select" } | { mode: "replay", index, playing }

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
    case "enter":
      return s.mode === "select" ? s : { mode: "select" };
    case "pick":
      if (s.mode === "off" || !Number.isInteger(action.index) || action.index < 0 || action.index > last) return s;
      return at(action.index);
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

/** 最早一天：MA120 有值的第一根；不够 120 根就从第一根开始。 */
export const earliestIndex = (total) => (total > 119 ? 119 : 0);

/** 随机一天：最早一天到倒数第二根之间（至少留一根可放）。 */
export function randomIndex(total, rand = Math.random) {
  const lo = earliestIndex(total);
  const hi = Math.max(lo, total - 2);
  return lo + Math.floor(rand() * (hi - lo + 1));
}

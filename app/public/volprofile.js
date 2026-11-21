// 筹码分布（视频 O，规则 J45–J49）：skill 的 volprofile.py 一行对一行的移植，图上按可见范围在浏览器里算。
// 运算顺序和 Python 一样，结果逐位相同；test/volprofile.test.ts 拿 Python 生成的夹具核对。纯函数，单元测试直接用。

/** 分几档、量低于平均的几倍算出了山（volprofile.PROFILE_BINS、PROFILE_EDGE，脚本自定，值见 rules.md 阈值表）。 */
export const PROFILE_BINS = 24;
export const PROFILE_EDGE = 1.0;

/** bars：[{ high, low, volume }] → { edges, volumes }。每根的量按价格均匀摊在 [最低价, 最高价] 上，一字线记在它所在那档。 */
export function distribute(bars, bins = PROFILE_BINS) {
  const lo = Math.min(...bars.map((b) => b.low));
  const hi = Math.max(...bars.map((b) => b.high));
  const edges = Array.from({ length: bins + 1 }, (_, j) => lo + (hi - lo) * j / bins);
  const out = new Array(bins).fill(0);
  if (!(hi > lo)) return { edges, volumes: out };
  const width = (hi - lo) / bins;
  for (const { high: h, low: l, volume: v } of bars) {
    if (h <= l) {
      out[Math.min(Math.floor((l - lo) / width), bins - 1)] += v;
      continue;
    }
    for (let j = 0; j < bins; j++) {
      const overlap = Math.min(h, edges[j + 1]) - Math.max(l, edges[j]);
      if (overlap > 0) out[j] += v * overlap / (h - l);
    }
  }
  return { edges, volumes: out };
}

/** 量 ≥ edge × 各档平均量的连续几档是一座山：{ foot（山脚）, top（山顶）, volume, share }，从低到高。 */
export function findMountains(edges, volumes, edge = PROFILE_EDGE) {
  const total = volumes.reduce((s, v) => s + v, 0);
  if (!(total > 0)) return [];
  const line = edge * total / volumes.length;
  const out = [];
  let start = null;
  [...volumes, -1].forEach((v, j) => {
    if (v >= line && start === null) start = j;
    else if (v < line && start !== null) {
      const vol = volumes.slice(start, j).reduce((s, x) => s + x, 0);
      out.push({ foot: edges[start], top: edges[j], volume: vol, share: vol / total });
      start = null;
    }
  });
  return out;
}

/**
 * 图上看得见的那几根 K 线的筹码分布。view：图上画着的数据（回放时截到回放那天），range：可见的逻辑范围。
 * 返回 null 表示算不了（没有 K 线或没有量）；否则 { from, to, bars, edges, volumes, mountains }，from / to 是第一根、最后一根的日期。
 */
export function visibleProfile(view, range) {
  if (!view?.candles.length || !range) return null;
  const first = Math.max(0, Math.ceil(range.from));
  const last = Math.min(view.candles.length - 1, Math.floor(range.to));
  const vol = new Map((view.volume ?? []).map((v) => [v.time, v.value]));
  const bars = [];
  for (let i = first; i <= last; i++) {
    const c = view.candles[i];
    if (vol.has(c.time)) bars.push({ time: c.time, high: c.high, low: c.low, volume: vol.get(c.time) });
  }
  if (!bars.length) return null;
  const { edges, volumes } = distribute(bars);
  return { from: bars[0].time, to: bars.at(-1).time, bars: bars.length, edges, volumes, mountains: findMountains(edges, volumes) };
}

/** 图上标山脚、山顶的那几座：价格所在的山、上方最近的和下方最近的（其余只画轮廓，免得小字挤在一起）。 */
export function labeledMountains(mountains, close) {
  const inside = mountains.find((m) => m.foot <= close && close <= m.top);
  const above = mountains.find((m) => m.foot > close);
  const below = mountains.findLast((m) => m.top < close);
  return [below, inside, above].filter(Boolean);
}

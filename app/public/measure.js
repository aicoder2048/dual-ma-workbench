// 测量工具：图上两点之间涨跌多少、隔几根 K 线、几个自然日、几个 ATR。纯函数，单元测试直接用。

export const ATR_N = 14;

/**
 * Wilder 的 ATR(14)，和 skill 的 fullplan.atr 一样：真实波幅 = 最高、最低、前收三者里最大的差，
 * 按 1/n 指数平均（第一根只有最高 − 最低）；前 n − 1 根没有值（null）。只用当天和之前的 K 线。
 */
export function atrSeries(candles, n = ATR_N) {
  let avg = null;
  return candles.map((c, i) => {
    const prev = candles[i - 1]?.close;
    const tr = prev === undefined ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
    avg = avg === null ? tr : avg + (tr - avg) / n;
    return i >= n - 1 ? avg : null;
  });
}

const DAY_MS = 86_400_000;

/**
 * 从 a 量到 b（{ index, price }，index 是图上第几根，已经落在 K 线上）。涨跌按 b − a 算，根数、天数不分左右。
 * ATR 取两点里靠后那一根当天的值：回放时不会用到之后的 K 线。不到 14 根没有 ATR（atr 为 null）。
 */
export function measure(a, b, candles) {
  const change = b.price - a.price;
  const later = Math.max(a.index, b.index);
  const atr = atrSeries(candles.slice(0, later + 1)).at(-1);
  const days = Math.round(Math.abs(Date.parse(candles[b.index].time) - Date.parse(candles[a.index].time)) / DAY_MS);
  return {
    change,
    pct: (change / a.price) * 100,
    bars: Math.abs(b.index - a.index),
    days,
    atr: atr ?? null,
    atrUnits: atr ? Math.abs(change) / atr : null,
  };
}

const signed = (x, digits = 2) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(digits)}`;

/** 测量框里的三行：+12.34（+5.60%）、8 根 · 11 天、1.8 ATR（ATR 14.20）。 */
export function measureLines(m) {
  return [
    `${signed(m.change)}（${signed(m.pct)}%）`,
    `${m.bars} 根 · ${m.days} 天`,
    m.atrUnits === null ? "不到 14 根，没有 ATR" : `${m.atrUnits.toFixed(1)} ATR（ATR ${m.atr.toFixed(2)}）`,
  ];
}

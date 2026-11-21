// K 线的颜色：不着色时照常涨绿跌红；着色时按破线拐头信号（tone，由 Python 算好）上色。纯函数，单元测试直接用。

/** 不着色时整列 K 线的样式：涨绿跌红、实心。colors.up / colors.down 来自主题的 --up / --down。 */
export function baseCandleStyle(colors) {
  return {
    upColor: colors.up, downColor: colors.down,
    borderUpColor: colors.up, borderDownColor: colors.down,
    wickUpColor: colors.up, wickDownColor: colors.down,
  };
}

/** 一根 K 线 → 图表库的数据点（新对象：图表库会把 time 就地改成 {year, month, day}）。着色时阳线空心、阴线实心。 */
export function candleBar(c, toneOn, colors) {
  const bar = { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close };
  const color = toneOn && colors[c.tone];
  if (!color) return bar;
  return { ...bar, color: c.close >= c.open ? "rgba(0,0,0,0)" : color, borderColor: color, wickColor: color };
}

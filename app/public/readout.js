// 读数条里的成交量：33.8M、1.2× 均量。纯函数，单元测试直接用。

/** 成交量缩写：980、45.6K、33.8M、1.23B（照 TradingView）。 */
export function fmtVolume(v) {
  for (const [n, unit] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]]) {
    if (v >= n) return `${(v / n).toFixed(v / n >= 100 ? 0 : v / n >= 10 ? 1 : 2)}${unit}`;
  }
  return String(Math.round(v));
}

/**
 * 一天的量 → 读数条那一格的 HTML。ratio 是当天量 / 50 日均量（脚本算的，和「大量」同一个口径），
 * spike 是脚本按 VOLUME_SPIKE 标的大量：标黄，和底部的黄量柱一样。没有量（指数、CSV 没给）返回空串。
 */
export function volumeCell(v) {
  if (!v) return "";
  const ratio = v.ratio == null ? "" : `<span class="ro-ratio${v.spike ? " spike" : ""}"${v.spike ? ' title="大量：超过 50 日均量 2 倍"' : ""}>${v.ratio.toFixed(1)}× 均量</span>`;
  return `<span class="ro-vol">量<b>${fmtVolume(v.value)}</b>${ratio}</span>`;
}

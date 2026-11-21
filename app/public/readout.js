// 读数条里的成交量：33.8M、1.2× 均量。纯函数，单元测试直接用。
import { TURN_TEXT } from "./tones.js";

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
 * 「均量」两个字单独包一层（ro-unit）：一行实在放不下时收起，只留倍数。
 */
export function volumeCell(v) {
  if (!v) return "";
  const ratio = v.ratio == null ? "" : `<span class="ro-ratio${v.spike ? " spike" : ""}"${v.spike ? ' title="大量：超过 50 日均量 2 倍"' : ""}>${v.ratio.toFixed(1)}×<span class="ro-unit"> 均量</span></span>`;
  return `<span class="ro-vol">量<b>${fmtVolume(v.value)}</b>${ratio}</span>`;
}

const f2 = (x) => (x == null ? "—" : x.toFixed(2));
const sign = (x) => (x >= 0 ? "+" : "−") + Math.abs(x).toFixed(2);

/**
 * 读数条第一行：日期 + 开高低收 + 比前一根涨跌 + 量。日线的前一根是前一天，周线是前一周。
 * label 是开头写的日期（周线见 weekLabel），prev 没有时不写涨跌，v 是这一根的量（volumeCell）。
 * turn：这根变了色（tones.js 的 toneTurns）就紧跟在日期后面写「转绿」「转黑」，一行放不下时也不会被截掉。
 * @param {"bull" | "bear" | null} [turn]
 */
export function ohlcRow(label, c, prev, v, turn = null) {
  const chg = prev ? c.close - prev.close : null;
  const tone = chg == null ? "" : chg >= 0 ? "up" : "down";
  // 涨跌额放括号外的 ro-abs：一行放不下时先收起涨跌额，留涨跌幅
  const chgText = chg == null ? ""
    : `<span class="ro-chg ${tone}"><span class="ro-abs">${sign(chg)}（</span>${sign((chg / prev.close) * 100)}%<span class="ro-abs">）</span></span>`;
  const ohlc = [["开", c.open], ["高", c.high], ["低", c.low], ["收", c.close]]
    .map(([k, x]) => `<span>${k}<b class="${tone}">${f2(x)}</b></span>`).join("");
  const turnText = turn ? `<span class="ro-turn ${turn}">${TURN_TEXT[turn]}</span>` : "";
  return `<b>${label}</b>${turnText}${ohlc}${chgText}${volumeCell(v)}`;
}

/**
 * 读数条第二行：各条均线的值。cells：[{ key, kind, token, group, value }]，按图例的顺序。
 * 同一组的 MA、EMA 包在一个 ro-group 里：窄栏一行放不下时整组折到下一行，不把一组拆开，也不截掉哪条线。
 */
export function linesRow(cells) {
  const groups = [];
  for (const c of cells) {
    const last = groups.at(-1);
    if (last && c.group != null && last[0].group === c.group) last.push(c);
    else groups.push([c]);
  }
  const cell = (c) => `<span class="ro-line"><i class="${c.kind.toLowerCase()}" style="--c: var(${c.token})"></i>${c.key} ${f2(c.value)}</span>`;
  return groups.map((g) => `<span class="ro-group">${g.map(cell).join("")}</span>`).join("");
}

/** 周 K 线开头的日期：那一周最后一个交易日；最新一周没走完（今天不是周五）时注明。 */
export function weekLabel(time, partial) {
  return `周 ${time}${partial ? "（本周未完）" : ""}`;
}

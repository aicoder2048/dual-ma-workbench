// 6 条均线（加 MA200 对照线）怎么画：颜色、粗细、右端标签。纯函数，单元测试直接用。
// 都用实线：虚线细、被 K 线切碎，跟不住（ADR 0016）。同一周期 MA 深而粗、EMA 同色调浅而细。

export const GROUPS = [20, 60, 120];

/** key：数据里的线名；token：主题里的颜色；group：属于哪个线组（MA200 不属于任何组）。 */
export const SPECS = [
  ...GROUPS.flatMap((n) => ["MA", "EMA"].map((kind) => ({ key: kind + n, token: `--${kind.toLowerCase()}${n}`, group: n, kind }))),
  // MA200 朴素规则的对照线：默认不画，在图例里点开
  { key: "MA200", token: "--ma200", group: null, kind: "MA", off: true },
];

const WIDTH = { MA: 2.5, EMA: 1.5, MA200: 1 };
/** K 线淡一点，线浮在上面。 */
export const CANDLE_ALPHA = 0.65;
/** 聚焦一组时，其他组的线淡到这个程度。 */
export const FADED_ALPHA = 0.2;
/** 聚焦那组 MA 和 EMA 之间色带的浓度。 */
export const BAND_ALPHA = 0.16;

/** "#rgb" / "#rrggbb" → rgba(…, a)；不是十六进制颜色就原样返回。 */
export function alpha(color, a) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color ?? "")?.[1];
  if (!hex) return color;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${a})`;
}

/** WCAG 对比度（1 ~ 21）：两个 "#rrggbb" 颜色。每条线对图表底色要 ≥ 3（非文字图形的标准），测试里按主题钉住。 */
export function contrastRatio(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 一条线的样式。colors：token → 颜色（当前主题）；focus：聚焦的线组（20 / 60 / 120）或 null。
 * 右端价格轴上用线的颜色写 MA 的值（图表库自己会错开重叠的标签）；EMA 只在聚焦它那组时写，免得 6 个标签挤在一起。
 * 不写 MA20 这类名字：名字画在绘图区右边，会压在筹码分布上；哪个颜色是哪条线看图例。
 */
export function lineStyle(spec, colors, focus) {
  const faded = focus != null && spec.group !== focus;
  return {
    color: faded ? alpha(colors[spec.token], FADED_ALPHA) : colors[spec.token],
    lineWidth: WIDTH[spec.key] ?? WIDTH[spec.kind],
    lineStyle: 0,
    lastValueVisible: !faded && (spec.kind === "MA" || spec.group === focus),
    title: "",
  };
}

/** 聚焦：点一个组聚焦它，再点同一个组（或 clear，比如按 Esc）取消。不认识的组当作取消。 */
export function nextFocus(current, action) {
  if (action.type !== "click" || !GROUPS.includes(action.group)) return null;
  return action.group === current ? null : action.group;
}

/**
 * 聚焦那组的色带：图上第几根（i）和那根的 MA、EMA 值，两条线都有值的那几根才有。
 * view 是图上画着的数据（回放时是截到那天的），所以色带跟着回放走。
 */
export function bandPoints(view, group) {
  if (!view || !GROUPS.includes(group)) return [];
  const at = (key) => new Map((view.lines[`${key}${group}`] ?? []).map((p) => [p.time, p.value]));
  const ma = at("MA"), ema = at("EMA");
  return view.candles.flatMap((c, i) => (ma.has(c.time) && ema.has(c.time) ? [{ i, ma: ma.get(c.time), ema: ema.get(c.time) }] : []));
}

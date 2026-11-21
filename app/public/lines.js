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

/** "#rgb" / "#rrggbb" → rgba(…, a)；不是十六进制颜色就原样返回。 */
export function alpha(color, a) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color ?? "")?.[1];
  if (!hex) return color;
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * 一条线的样式。colors：token → 颜色（当前主题）。
 * 右端价格轴上写 MA 的名字和值（图表库自己会错开重叠的标签）；EMA 不写，免得 6 个标签挤在一起。
 */
export function lineStyle(spec, colors) {
  const labeled = spec.kind === "MA";
  return {
    color: colors[spec.token],
    lineWidth: WIDTH[spec.key] ?? WIDTH[spec.kind],
    lineStyle: 0,
    lastValueVisible: labeled,
    title: labeled ? spec.key : "",
  };
}

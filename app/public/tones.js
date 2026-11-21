// K 线颜色的说明和变色的地方。颜色（每根的 tone）和它的来源（图表数据的 tone_source）都是 Python 算好的（skill 的 tones.py），
// 这里只读：自带规则、本机的着色插件都一样对待。纯函数，单元测试直接用。

const NO_SOURCE = "这份数据没写明颜色按什么规则算（旧的分析结果），重新分析一次就有";

/**
 * 图表数据的 tone_source → 页面上要写的 { name: 来源的名字, legend: 几行说明, warning: 着色插件没用上的原因 }。
 * 旧的分析结果没有 tone_source：name 是 null，legend 是一行说明。
 */
export function toneInfo(source) {
  if (!source) return { name: null, legend: [NO_SOURCE], warning: null };
  return { name: source.name, legend: source.legend, warning: source.warning ?? null };
}

/** 变色提示在读数条里的叫法。 */
export const TURN_TEXT = { bull: "转绿", bear: "转黑" };

/**
 * 变了色的那几根：[{ i: 第几根, time, to: "bull" | "bear" }]。只看颜色序列，和颜色是谁算的无关：
 * 这根是绿而上一根不是绿就是转绿，黑也一样；变成灰不算。上一根没有颜色（均线还没算出来的那段）不算。
 */
export function toneTurns(candles) {
  const turns = [];
  for (let i = 1; i < candles.length; i++) {
    const to = candles[i].tone, from = candles[i - 1].tone;
    if (from && to !== from && (to === "bull" || to === "bear")) turns.push({ i, time: candles[i].time, to });
  }
  return turns;
}

// K 线颜色的说明。颜色（每根的 tone）和它的来源（图表数据的 tone_source）都是 Python 算好的（skill 的 tones.py），
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

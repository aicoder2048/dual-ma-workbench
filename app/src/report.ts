/**
 * 规则版三步报告：完全由脚本的分析结果生成，不经过 LLM。每条都带引用。
 *
 * 分析师的 AI 回答是在这份报告之上的解读；报告本身保证"数字可核对、出处可点开"。
 */
import type { Analysis } from "./citations.ts";

export interface ReportStep {
  key: "big_picture" | "strategy" | "direction";
  title: string;
  subtitle: string;
  items: string[];
}

export interface Report {
  headline: string;
  stance: "bullish" | "bearish" | "neutral";
  steps: ReportStep[];
}

const STANCE: Record<string, Report["stance"]> = {
  健康上涨: "bullish", 极度超买: "bullish", 健康下跌: "bearish", 极度超卖: "bearish",
};

export function buildReport(a: Analysis): Report {
  const dirs = a.lines.map((ln) => `MA${ln.period} ${ln.clock} [[D:MA${ln.period}.方向]]`).join("，");
  const where = a.lines.map((ln) => `${ln.period} 线${ln.above ? "上方" : "下方"}`).join("、");
  const cross = a.crosses.map((c) => `${c.pair}：${c.ma.startsWith("无") ? "无" : "MA " + c.ma}；EMA ${c.ema} [[D:交叉.${c.pair}]]`);

  const big = [
    `**方向**：${dirs}。均线的方向就是价格的最小阻力方向 [[S:article#1]]，钟表读法见 [[S:article#2.4]]。`,
    `**排列**：MA ${a.arr_ma} [[D:排列.MA]]，EMA ${a.arr_ema} [[D:排列.EMA]]；价格在 ${where}。`,
    `**间距**：三条 MA 相差 ${a.spread_pct.toFixed(1)}% [[D:间距]]（小于 4% 视为缠绕）[[S:article#2.4]]。`,
    `**乖离**：离 20 线 ${a.bias20.toFixed(1)}% [[D:乖离20]]，处于自身历史 ${Math.round(a.bias_pctl * 100)}% 分位 [[D:乖离分位]]；大幅乖离是趋势最后一步 [[S:article#2.5]]。`,
    `**交叉**：${cross.join("；")}。两组都交叉（双交叉）才算确认 [[S:article#2.2]]。`,
  ];
  if (a.volume) {
    big.push(`**量能**：今日 ${a.volume.ratio.toFixed(1)}× 50 日均量 [[D:量比]]；近 20 日大量 ${a.volume.spikes.length} 天 [[D:放量日]]。大量是标志性动作之一 [[S:article#2.6]]。`);
  }
  big.push(`**规则初判**：${a.trend} [[D:趋势初判]]。这是按脚本阈值算的，边界情况要对照判断表复核 [[S:skill#第1步]]。`);

  const strategy = [
    `按「${a.trend}」查表：${a.strategy} [[S:article#4]]`,
    "先认清趋势类型再选打法，不机械地照破线、拐头、交叉买卖 [[S:skill#原则]]。",
    "仓位以心态稳得住为准，浮盈浮亏影响心情就减到舒服为止 [[S:article#资金原则]]。",
  ];

  const direction = a.drops.map((d) => {
    const n = d.period;
    const kind = d.below * 2 >= d.count ? "扣低值为主" : "扣高值为主";
    return `**MA${n}**：明天扣 ${d.tomorrow.toFixed(2)} [[D:扣${n}.明天]]；未来 ${d.count} 天${kind}，均值 ${d.mean.toFixed(2)} [[D:扣${n}.均值]]、低于现价 ${d.below}/${d.count} 天 [[D:扣${n}.扣低天数]]；价格不变时 MA${n} 变化 ${fmtPct(d.ma_flat_change_pct)} [[D:扣${n}.价平变化]]，首次扣低：${d.first_low ? `第 ${d.first_low} 天` : `${n} 天内都不会`} [[D:扣${n}.首次扣低]]。`;
  });
  direction.push("收盘价 > 底扣价 → MA 上升；< 底扣价 → MA 下降。未来要扣的价格已经在图上 [[S:article#2.3]]，推演链见 [[S:skill#第3步]]。");

  return {
    headline: `${a.label} · ${a.trend}`,
    stance: STANCE[a.trend] ?? "neutral",
    steps: [
      { key: "big_picture", title: "看大局", subtitle: "现在是什么趋势", items: big },
      { key: "strategy", title: "定策略", subtitle: "该怎么做", items: strategy },
      { key: "direction", title: "看方向", subtitle: "底扣价推演", items: direction },
    ],
  };
}

function fmtPct(x: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;
}

// 搜索框：把常用中文名（和几个英文名）换成美股代码。纯函数，bun test 直接测。
// 行情源（Polygon / yfinance）只认代码，Yahoo 的搜索也不认中文名，所以用一张本地小表。

/** 代码 → [显示名, ...别名]。别名不分大小写、不计空格。 */
const NAMES = {
  TSM: ["台积电", "台積電", "tsmc"],
  NVDA: ["英伟达", "輝達", "辉达", "nvidia"],
  AAPL: ["苹果", "蘋果", "apple"],
  MSFT: ["微软", "微軟", "microsoft"],
  GOOGL: ["谷歌", "alphabet", "google"],
  AMZN: ["亚马逊", "亞馬遜", "amazon"],
  META: ["脸书", "臉書", "facebook"],
  TSLA: ["特斯拉", "tesla"],
  NFLX: ["奈飞", "网飞", "netflix"],
  AMD: ["超威", "超微"],
  INTC: ["英特尔", "英特爾", "intel"],
  AVGO: ["博通", "broadcom"],
  QCOM: ["高通", "qualcomm"],
  ORCL: ["甲骨文", "oracle"],
  ASML: ["阿斯麦", "艾司摩尔"],
  BABA: ["阿里巴巴", "阿里", "alibaba"],
  TCEHY: ["腾讯", "騰訊", "tencent"],
  JD: ["京东", "京東"],
  PDD: ["拼多多"],
  BIDU: ["百度", "baidu"],
  NTES: ["网易", "網易"],
  NIO: ["蔚来", "蔚來"],
  LI: ["理想汽车", "理想"],
  XPEV: ["小鹏", "小鵬"],
  BYDDY: ["比亚迪", "比亞迪"],
  SPY: ["标普500", "标普", "標普"],
  QQQ: ["纳指", "纳斯达克", "納指"],
  DIA: ["道指", "道琼斯"],
  IWM: ["罗素2000"],
  GLD: ["黄金", "黃金"],
};

const key = (s) => String(s).replace(/\s+/g, "").toLowerCase();
const ALIAS = new Map(Object.entries(NAMES).flatMap(([t, names]) => names.map((n) => [key(n), { ticker: t, name: names[0] }])));
const TICKER = /^[A-Z0-9][A-Z0-9.\-^=]{0,14}$/; // 和服务端 normalizeTicker 一致

/** → { ticker, name? }：能查；{ error }：说明为什么不能；{}：空输入。名称表优先（例如 "AMD"、"JD" 本身也是代码，结果一样）。 */
export function resolveTicker(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return {};
  const hit = ALIAS.get(key(s));
  if (hit) return { ...hit };
  const t = s.toUpperCase();
  if (TICKER.test(t)) return { ticker: t };
  return { error: `「${s}」不是股票代码，也不在常用名称表里。请输入美股代码，例如 TSM（台积电）、NVDA（英伟达）。` };
}

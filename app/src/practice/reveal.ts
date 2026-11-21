/**
 * 推演揭晓题交卷后的对照：同一问，按系统推演（收平假设）该选什么、真实走势实际是什么。
 *
 * 出题函数只看得到题目那一根（T0）的分析，写下每一问「真实走势要看什么」（RevealSpec）；交卷时题库把 T0
 * 及之后的真实收盘和均线（Series）交给 revealOf 算对照。评分只按推演，真实走势不扣分（docs/adr/0023.md）。
 */

/** 双交叉最早出现在哪一段（持平 30 天的推演看 10、20、30 天）。 */
export const CROSS_CHOICES = ["10 天内", "11–20 天", "21–30 天", "30 天内不会"] as const;
export type CrossBucket = (typeof CROSS_CHOICES)[number];
export const CROSS_DAYS = 30;

export function bucketOf(day: number | null): CrossBucket {
  if (day === null || day > CROSS_DAYS) return "30 天内不会";
  return day <= 10 ? "10 天内" : day <= 20 ? "11–20 天" : "21–30 天";
}

/**
 * 一问要对照什么。dir：第 n 天 MA20、MA60 的方向；cross：20/60 的双交叉（金叉或死叉）最早哪天；
 * turn：MA(period) days 天内会不会拐头向 way，level 是推演求出的临界持平价位。
 */
export type RevealPart =
  | { q: "dir"; n: number }
  | { q: "cross"; way: "金叉" | "死叉" }
  | { q: "turn"; period: 20 | 60; way: "上" | "下"; days: number; level: number };
/** close：T0 收盘，也就是收平假设的价位。parts 和题目的 parts 一一对应。 */
export interface RevealSpec { close: number; parts: RevealPart[] }

/** 要放出 T0 之后几根才对照得了。 */
export const horizonOf = (s: RevealSpec) => Math.max(...s.parts.map((p) => (p.q === "dir" ? p.n : p.q === "cross" ? CROSS_DAYS : p.days)));

/** T0 及之后的真实数据：下标 0 是 T0，k 是 T+k。 */
export interface Series { close: number[]; ma20: number[]; ema20: number[]; ma60: number[]; ema60: number[] }

/** system：推演该选的（评分用的答案）；real：真实走势；两者对不上时 why 写一句为什么。 */
export interface RevealResult { system: string; real: string; agree: boolean; why: string | null }

const f2 = (x: number) => x.toFixed(2);
const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const word = (d: number) => (d > 0 ? "上" : d < 0 ? "下" : "平");
const tl = (k: number) => `T+${k}`;

/** 第 k 天 MA 朝哪走：比前一天。 */
const dirAt = (xs: number[], k: number) => sign(xs[k] - xs[k - 1]);

/** 20/60 两组都到了 way 那一边的第一天；T0 已经两组都在那一边，就谈不上交叉，返回 null。 */
export function crossDay(s: Series, way: "金叉" | "死叉", days: number = CROSS_DAYS): number | null {
  const to = way === "金叉" ? 1 : -1;
  const there = (k: number) => sign(s.ma20[k] - s.ma60[k]) === to && sign(s.ema20[k] - s.ema60[k]) === to;
  if (there(0)) return null;
  for (let k = 1; k <= days && k < s.close.length; k++) if (there(k)) return k;
  return null;
}

/** MA(period) 第一天朝 way 走的那天。 */
export function turnDay(s: Series, period: 20 | 60, way: "上" | "下", days: number): number | null {
  const xs = period === 20 ? s.ma20 : s.ma60;
  const want = way === "上" ? 1 : -1;
  for (let k = 1; k <= days && k < xs.length; k++) if (dirAt(xs, k) === want) return k;
  return null;
}

/** 真实走势里 20/60 的交叉（MA、EMA 各自第一次，和两组都到了另一边的双交叉），k 是 T+k。图上标出来。 */
export function crossMarks(s: Series): { k: number; text: string }[] {
  const out: { k: number; text: string }[] = [];
  const first = (fast: number[], slow: number[]) => {
    const was = sign(fast[0] - slow[0]);
    for (let k = 1; k < fast.length; k++) if (was !== 0 && sign(fast[k] - slow[k]) === -was) return { k, way: was > 0 ? "死叉" : "金叉" };
    return null;
  };
  const ma = first(s.ma20, s.ma60), ema = first(s.ema20, s.ema60);
  if (ma) out.push({ k: ma.k, text: `MA ${ma.way}` });
  if (ema) out.push({ k: ema.k, text: `EMA ${ema.way}` });
  const was = sign(s.ma20[0] - s.ma60[0]);
  if (was !== 0 && was === sign(s.ema20[0] - s.ema60[0])) {
    const way = was > 0 ? "死叉" : "金叉";
    const k = crossDay(s, way, s.close.length - 1);
    if (k !== null) out.push({ k, text: `双交叉（${way}）` });
  }
  return out;
}

/** 价格没收平：到第 n 天涨跌了多少、这几天收在哪个区间。 */
function drift(s: Series, n: number, close: number): string {
  const xs = s.close.slice(1, n + 1);
  const end = xs.at(-1)!;
  const pct = (end / close - 1) * 100;
  return `价格没有收平：${tl(n)} 收盘 ${f2(end)}，比 T0 的 ${f2(close)}${pct >= 0 ? "涨" : "跌"}了 ${Math.abs(pct).toFixed(1)}%，这 ${n} 天收在 ${f2(Math.min(...xs))} ~ ${f2(Math.max(...xs))}；推演假设每天都收在 ${f2(close)}`;
}

/** 每一问的对照。system 是题目里对的那个选项（drills.ts 传进来），turn 那一问另写推演的结论。 */
export function revealOf(spec: RevealSpec, systemChoices: string[], s: Series): RevealResult[] {
  return spec.parts.map((p, i): RevealResult => {
    if (p.q === "dir") {
      const real = `MA20 ${word(dirAt(s.ma20, p.n))}、MA60 ${word(dirAt(s.ma60, p.n))}`;
      const agree = real === systemChoices[i];
      return { system: systemChoices[i], real: `${tl(p.n)} 当天 ${real}`, agree, why: agree ? null : drift(s, p.n, spec.close) };
    }
    if (p.q === "cross") {
      const day = crossDay(s, p.way);
      const agree = bucketOf(day) === systemChoices[i];
      return {
        system: systemChoices[i],
        real: day === null ? `${CROSS_DAYS} 天内没有出现双交叉` : `${tl(day)} 出现双交叉（${p.way}）：${bucketOf(day)}`,
        agree, why: agree ? null : drift(s, CROSS_DAYS, spec.close),
      };
    }
    const side = p.way === "下" ? "以下" : "以上";
    const flatTurns = p.way === "下" ? spec.close < p.level : spec.close > p.level;
    const day = turnDay(s, p.period, p.way, p.days);
    const agree = flatTurns === (day !== null);
    return {
      system: `收盘持平在 ${systemChoices[i]} ${side}，${p.days} 天内 MA${p.period} 拐头向${p.way}；照收平（每天 ${f2(spec.close)}）算，${flatTurns ? "会" : "不会"}拐头`,
      real: day === null ? `${p.days} 天内 MA${p.period} 没有拐头向${p.way}` : `MA${p.period} 在 ${tl(day)} 拐头向${p.way}`,
      agree, why: agree ? null : drift(s, p.days, spec.close),
    };
  });
}

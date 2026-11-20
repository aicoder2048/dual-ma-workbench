import type { Bar } from "../../src/practice/blind.ts";

/** 约 7 年的"真实"日线：价格在 3000 ~ 6000，和换算后的指数（100 上下）分得开，泄露一眼就能查出来。 */
export function realBars(): Bar[] {
  const bars: Bar[] = [];
  let prev = 4000;
  for (let d = new Date("2014-01-02T00:00:00Z"); bars.length < 1800; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() % 6 === 0) continue;
    const i = bars.length;
    const close = 4000 * Math.exp(0.25 * Math.sin(i / 70) + 0.12 * Math.sin(i / 17) + 0.0001 * i);
    const open = prev * (1 + 0.004 * Math.sin(i * 1.7));
    bars.push({ date: d.toISOString().slice(0, 10), open, high: Math.max(open, close) * 1.006, low: Math.min(open, close) * 0.994, close,
      volume: 50_000_000 + 9_000_000 * Math.sin(i / 5) });
    prev = close;
  }
  return bars;
}
export const REAL = realBars();
/** 不在任何固定文字里的代码（回测记录列着 14 只票，名称表里有常见代码），查出来就一定是泄露。 */
export const REAL_TICKER = "ZQXT";
export const prices = { load: async () => REAL };


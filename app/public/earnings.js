// 图上的财报日 E 标记：标哪几天、标在第几根。纯函数，单元测试直接用。

/**
 * 要标的财报日：upTo（图上最后一根，回放时是回放到的那天）及以前的，加上之后的第一次（next: true）。
 * e 是分析 JSON 的 earnings；取不到、练习里没有时不标。
 */
export function earningsMarks(e, upTo) {
  if (!e?.available) return [];
  const all = e.next ? [...e.past, e.next] : e.past;
  const next = all.find((d) => d > upTo);
  return [...all.filter((d) => d <= upTo).map((date) => ({ date, next: false })), ...(next ? [{ date: next, next: true }] : [])];
}

const weekdaysAfter = (from, to) => {
  let n = 0;
  for (let t = Date.parse(`${from}T00:00:00Z`) + 864e5; t <= Date.parse(`${to}T00:00:00Z`); t += 864e5) {
    if (new Date(t).getUTCDay() % 6) n++;
  }
  return n;
};

/**
 * 日期在图上的逻辑序号（第几根）：有这根 K 线就是它；在最后一根之后按工作日往后数（右边留白里也能标）；
 * 比第一根还早返回 null。
 */
export function logicalOf(date, candles) {
  if (!candles.length || date < candles[0].time) return null;
  const last = candles.length - 1;
  if (date > candles[last].time) return last + weekdaysAfter(candles[last].time, date);
  return candles.findIndex((c) => c.time >= date);
}

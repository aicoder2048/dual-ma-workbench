/**
 * 识别题的统计、按弱项挑题型、按答案类别配平抽题。都是纯函数，题库（drills.ts）调用。
 */
import { KINDS, type Kind } from "./drillkinds.ts";

/** 答过的一题。picks：每一问选的位置；answers：每一问对的位置；ms：从出题到交卷的毫秒数。 */
export interface Answer { drill: string; kind: Kind; cls: string; picks: number[]; answers: number[]; correct: boolean; ms: number; at: string }

export interface KindStats { kind: Kind; n: number; correct: number; accuracy: number | null; medianMs: number | null }
export interface DrillStats {
  total: { n: number; correct: number; accuracy: number | null };
  kinds: KindStats[];
  /** 错得最多的题型（答过 MIN_SAMPLE 题以上，按正确率从低到高，最多 2 个）。 */
  weakest: Kind[];
  /** 错得最多的答案类别（题型 + 类别），最多 3 个。 */
  missed: { kind: Kind; cls: string; misses: number; n: number }[];
  /** 连对：现在连着对了几题，最长连对几题。 */
  streak: { current: number; best: number };
}

export const MIN_SAMPLE = 3;
/** 挑题型时只看每种最近这么多题，进步了权重跟着降。 */
export const RECENT = 20;

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** answers：按时间先后。 */
export function drillStats(answers: Answer[]): DrillStats {
  const right = answers.filter((x) => x.correct).length;
  const kinds = KINDS.map((kind): KindStats => {
    const xs = answers.filter((x) => x.kind === kind);
    const c = xs.filter((x) => x.correct).length;
    return { kind, n: xs.length, correct: c, accuracy: xs.length ? c / xs.length : null, medianMs: median(xs.map((x) => x.ms)) };
  });
  const weakest = kinds.filter((k) => k.n >= MIN_SAMPLE && k.correct < k.n)
    .sort((p, q) => p.accuracy! - q.accuracy! || q.n - p.n).slice(0, 2).map((k) => k.kind);
  const byCls = new Map<string, { kind: Kind; cls: string; misses: number; n: number }>();
  for (const x of answers) {
    const key = `${x.kind}|${x.cls}`;
    const g = byCls.get(key) ?? { kind: x.kind, cls: x.cls, misses: 0, n: 0 };
    g.n++;
    if (!x.correct) g.misses++;
    byCls.set(key, g);
  }
  const missed = [...byCls.values()].filter((g) => g.misses > 0).sort((p, q) => q.misses - p.misses || q.n - p.n).slice(0, 3);
  let current = 0, best = 0;
  for (const x of answers) {
    current = x.correct ? current + 1 : 0;
    best = Math.max(best, current);
  }
  return { total: { n: answers.length, correct: right, accuracy: answers.length ? right / answers.length : null }, kinds, weakest, missed, streak: { current, best } };
}

/**
 * 每种题型的权重：最近 RECENT 题的错误率（加一个对、一个错的先验：(错 + 1) / (题数 + 2)）。
 * 没答过的是 0.5，全对的会降到接近 0 但不为 0，错得多的被挑中的机会大。只在 available 里挑。
 */
export function kindWeights(answers: Answer[], available: Kind[]): Map<Kind, number> {
  const out = new Map<Kind, number>();
  for (const kind of available) {
    const xs = answers.filter((x) => x.kind === kind).slice(-RECENT);
    out.set(kind, (xs.filter((x) => !x.correct).length + 1) / (xs.length + 2));
  }
  return out;
}

/** 按权重抽一个键。权重全为 0 或没有键时返回 null。 */
export function weighted<K>(weights: Map<K, number>, rand: () => number): K | null {
  const total = [...weights.values()].reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  let r = rand() * total;
  for (const [k, w] of weights) {
    if ((r -= w) < 0) return k;
  }
  return [...weights.keys()].at(-1)!;
}

/** 配平：先在现有的答案类别里等概率挑一个类别，再在这个类别里随便挑一题。 */
export function balancedPick<T extends { cls: string }>(items: T[], rand: () => number): T | null {
  if (!items.length) return null;
  const classes = [...new Set(items.map((x) => x.cls))];
  const cls = classes[Math.floor(rand() * classes.length)];
  const pool = items.filter((x) => x.cls === cls);
  return pool[Math.floor(rand() * pool.length)];
}

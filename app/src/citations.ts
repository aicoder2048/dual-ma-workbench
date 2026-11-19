/**
 * 引用：回答里的每个判断都要标出处。
 *
 * - `[[S:article#2.3]]`：引用库里的原文片段（sources.ts）。
 * - `[[D:扣20.均值]]`：当前分析结果里的数据字段（buildFacts 生成）。
 *
 * 服务端在回答结束后调用 validateCitations，把不存在的编号标出来，前端显示成红色。
 */
import { project } from "./report.ts";
import type { SourceLibrary } from "./sources.ts";

export type CitationKind = "S" | "D";

export interface Citation {
  kind: CitationKind;
  ref: string;
  raw: string;
}

const CITATION = /\[\[(S|D):([^\]\n]+?)\]\]/g;

export function parseCitations(text: string): Citation[] {
  return [...text.matchAll(CITATION)].map((m) => ({ kind: m[1] as CitationKind, ref: m[2].trim(), raw: m[0] }));
}

export interface Fact {
  label: string;
  value: string;
}

export type Facts = Record<string, Fact>;

export type LeanLabel = "明显偏多" | "偏多" | "不明" | "偏空" | "明显偏空";
export type LeanConflict = "反弹受压" | "回调有撑" | null;

/** 模糊判断：6 条线的方向 + 线组排布合成的分数（−1 最空，+1 最多）。 */
export interface Lean {
  score: number;
  label: LeanLabel;
  conflict: LeanConflict;
  up: number;
  down: number;
  flat: number;
  dirs: Record<string, -1 | 0 | 1>;
  pairs: { pair: string; rel: -1 | 0 | 1 }[];
  play: string;
  flips: { line: string; price: number; crossed: boolean; text: string }[];
  after: { days: number; score: number; label: LeanLabel; conflict: LeanConflict; up: number; down: number; flat: number };
}

/** dma_analyze.py --json 里 analysis 的形状（只列用到的字段）。 */
export interface Analysis {
  label: string;
  date: string;
  close: number;
  change_pct: number;
  source: string;
  warning: string | null;
  lines: { period: number; ma: number; ema: number; above: boolean; slope: number; clock: string; ema_clock: string }[];
  arr_ma: string;
  arr_ema: string;
  spread_pct: number;
  bias20: number;
  bias_pctl: number;
  crosses: { pair: string; ma: string; ema: string }[];
  volume: { ratio: number; spikes: string[] } | null;
  trend: string;
  strategy: string;
  lean: Lean;
  drops: {
    period: number; tomorrow: number; mean: number; max: number; below: number; count: number;
    first_low: number | null; ma_flat_change_pct: number; direction: string;
    path: { date: string; close: number }[];
  }[];
}

const f2 = (x: number) => x.toFixed(2);
const pct = (x: number, digits = 2) => `${x >= 0 ? "+" : ""}${x.toFixed(digits)}%`;

/** 把分析结果摊平成可引用的数据字段。键名就是引用编号，改了旧引用会失效。 */
export function buildFacts(a: Analysis): Facts {
  const facts: Facts = {};
  const put = (key: string, label: string, value: string) => (facts[key] = { label, value });

  put("日期", "K 线日期", a.date);
  put("收盘", "收盘价", f2(a.close));
  put("涨跌", "当日涨跌", pct(a.change_pct));
  put("数据源", "数据来源", a.source);
  put("趋势初判", "规则初判的趋势类型", a.trend);
  const ln = a.lean;
  const leanName = (l: { label: string; conflict: string | null }) => l.label + (l.conflict ? `·${l.conflict}` : "");
  put("模糊判断", "接下来几周对谁有利（方向 + 排布）", `${leanName(ln)}（${ln.score >= 0 ? "+" : ""}${ln.score.toFixed(2)}）`);
  put("模糊判断.方向", "6 条均线的方向票数", `${ln.up} 上 · ${ln.flat} 平 · ${ln.down} 下`);
  put("模糊判断.排布", "20/60、60/120 线组谁在上（≈ 是相差不到价格 0.5%）",
    ln.pairs.map((p) => `${p.pair} ${p.rel > 0 ? ">" : p.rel < 0 ? "<" : "≈"}`).join("，"));
  put("模糊判断.10天后", `价格不变 ${ln.after.days} 天后的模糊判断`, `${leanName(ln.after)}（${ln.after.up} 上 · ${ln.after.down} 下）`);
  for (const f of ln.flips) put(`改变判断.${f.line}`, `什么会改变判断：${f.line}`, f.text);
  put("排列.MA", "MA 排列", a.arr_ma);
  put("排列.EMA", "EMA 排列", a.arr_ema);
  put("间距", "三条 MA 最大最小差占价格", `${a.spread_pct.toFixed(1)}%`);
  put("乖离20", "价格相对 MA20 的乖离率", pct(a.bias20, 1));
  put("乖离分位", "乖离率在自身历史中的分位", `${Math.round(a.bias_pctl * 100)}%`);
  for (const ln of a.lines) {
    const n = ln.period;
    put(`MA${n}`, `${n} 日 MA`, f2(ln.ma));
    put(`EMA${n}`, `${n} 日 EMA`, f2(ln.ema));
    put(`MA${n}.方向`, `${n} 日 MA 方向`, `${ln.clock} ${pct(ln.slope)}/日`);
    put(`EMA${n}.方向`, `${n} 日 EMA 方向`, ln.ema_clock);
    put(`MA${n}.位置`, `价格在 ${n} 日 MA 上方还是下方`, ln.above ? "上方" : "下方");
  }
  for (const c of a.crosses) {
    put(`交叉.${c.pair}`, `${c.pair} 最近交叉`, `MA ${c.ma}；EMA ${c.ema}`);
  }
  if (a.volume) {
    put("量比", "今日成交量 / 50 日均量", `${a.volume.ratio.toFixed(1)}×`);
    put("放量日", "近 20 日大量（>2×）的日子", a.volume.spikes.join("、") || "无");
  }
  for (const d of a.drops) {
    const n = d.period;
    put(`扣${n}.明天`, `MA${n} 明天的底扣价`, `${f2(d.tomorrow)}（明天 MA${n} ${d.direction}）`);
    put(`扣${n}.均值`, `MA${n} 未来 ${d.count} 天底扣价均值`, f2(d.mean));
    put(`扣${n}.最高`, `MA${n} 未来 ${d.count} 天底扣价最高`, f2(d.max));
    put(`扣${n}.扣低天数`, `MA${n} 未来 ${d.count} 天里底扣价低于现价的天数`, `${d.below}/${d.count}`);
    put(`扣${n}.价平变化`, `价格不变时 ${d.count} 天后 MA${n} 的变化`, pct(d.ma_flat_change_pct));
    put(`扣${n}.首次扣低`, `MA${n} 第几天首次扣到低于现价`, d.first_low ? `第 ${d.first_low} 天` : `${n} 天内都不会`);
  }
  // 价格保持不变时的推演（MA 由底扣价推出；EMA 用精确公式）
  const p = project(a);
  for (const [k, v] of [...Object.entries(p.ma), ...Object.entries(p.ema)]) {
    put(`推演.${k}`, `价格不变 ${p.days} 天后的 ${k}`, `${f2(v.now)} → ${f2(v.after)}`);
  }
  put("推演.排列.MA", `价格不变 ${p.days} 天后的 MA 排列`, `${p.arrNow.ma} → ${p.arrAfter.ma}`);
  put("推演.排列.EMA", `价格不变 ${p.days} 天后的 EMA 排列`, `${p.arrNow.ema} → ${p.arrAfter.ema}`);
  return facts;
}

/** 给模型看的数据字段清单：`D:键 = 值（说明）`，一行一个。 */
export function factsForPrompt(facts: Facts): string {
  return Object.entries(facts)
    .map(([k, f]) => `D:${k} = ${f.value}（${f.label}）`)
    .join("\n");
}

/**
 * 一次回答可能涉及多只股票：按股票代码存数据字段，`current` 是不写代码时默认指的那只。
 * 引用写法：`[[D:MA20]]`（默认股票）或 `[[D:TSLA:MA20]]`（指定股票）。
 */
export interface FactsBook {
  byTicker: Record<string, Facts>;
  current: string | null;
}

export const bookOf = (ticker: string, facts: Facts): FactsBook => ({ byTicker: { [ticker]: facts }, current: ticker });

export function lookupFact(book: FactsBook | null, ref: string): Fact | undefined {
  if (!book) return undefined;
  const m = ref.match(/^([A-Z0-9.\-^=]+):(.+)$/);
  const ticker = m ? m[1] : book.current;
  const key = m ? m[2] : ref;
  return ticker ? book.byTicker[ticker]?.[key] : undefined;
}

export interface CitationCheck {
  citation: Citation;
  ok: boolean;
  /** 校验通过时：原文片段标题或数据值，前端悬停显示。 */
  title?: string;
  value?: string;
}

export function validateCitations(text: string, lib: SourceLibrary, book: FactsBook | null): CitationCheck[] {
  return parseCitations(text).map((citation) => {
    if (citation.kind === "S") {
      const chunk = lib.get(citation.ref);
      return chunk
        ? { citation, ok: true, title: `${chunk.docTitle} · ${chunk.heading}` }
        : { citation, ok: false };
    }
    const fact = lookupFact(book, citation.ref);
    return fact ? { citation, ok: true, title: fact.label, value: fact.value } : { citation, ok: false };
  });
}

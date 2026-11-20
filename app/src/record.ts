/**
 * 回测记录：skill 的 backtest.py 按打法汇总的逐笔结果（references/backtest-record.json，提交进仓库）。
 * 结论卡片上那一句照它说，这里只把数字写成话，不改数字。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { HoldStance, Ma200 } from "./citations.ts";
import { PROJECT_ROOT } from "./sources.ts";

export interface SetupRecord {
  entries: string[];
  trades: number;
  dates?: number;
  win_rate?: number;
  median?: number;
  mean?: number;
  excess?: number | null;
  ci?: [number, number] | null;
  ci_crosses_zero?: boolean;
  few_dates?: boolean;
}
export interface BacktestRecord {
  variant: string;
  source_report: string;
  from: string;
  to: string;
  tickers: string[];
  generated: string;
  /** 能买的打法（trades.py 的 SETUPS）；空仓不买的打法不在里面。 */
  setups: Record<string, SetupRecord>;
}
export interface RecordNote { text: string; setup: SetupRecord | null; record: BacktestRecord }

export const RECORD_PATH = resolve(PROJECT_ROOT, ".agents/skills/dual-moving-averages/references/backtest-record.json");
export const RECORD: BacktestRecord = JSON.parse(readFileSync(RECORD_PATH, "utf8"));

const pc = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

/** 2026-11-20 的评估（skill 的 evaluate.py，报告不进仓库）：六条主张都没通过。结论卡片的回测那句末尾照它说。 */
export const EVALUATION_DATE = "2026-11-20";
export const EVALUATION_NOTE = `${EVALUATION_DATE} 的评估（86 只票、2013–2026、事先定的标准、验证集）没找到可验证的交易优势，这套方法当学习和复盘工具用。`;

const RULE_EVIDENCE_RE = /^\| ([AJP]\d+) \|.*\*\*(回测[^*]+)\*\*（([^）]+)）/;

/** rules.md 里标了评估结论的规则（`**回测不支持**（评估 2026-11-20，H5）`）：编号 → "回测不支持（评估 2026-11-20，H5）"。 */
export function parseRuleEvidence(md: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(RULE_EVIDENCE_RE);
    if (m) out.set(m[1], `${m[2]}（${m[3]}）`);
  }
  return out;
}

export const RULE_EVIDENCE = parseRuleEvidence(readFileSync(resolve(PROJECT_ROOT, ".agents/skills/dual-moving-averages/references/rules.md"), "utf8"));

/** 这套打法（plan.ts 的 playKey）的回测记录说成一句话。 */
export function recordNote(key: string, r: BacktestRecord = RECORD): RecordNote {
  const s = r.setups[key] ?? null;
  const scope = `回测（${r.variant}，${r.tickers.length} 只票，${r.from} ~ ${r.to}）`;
  if (!s) return { text: `${scope}：这套打法空仓不买，回测没有进场。${EVALUATION_NOTE}`, setup: null, record: r };
  if (!s.trades) return { text: `${scope}：这段时间这套打法一笔也没进场，没有可看的记录。${EVALUATION_NOTE}`, setup: s, record: r };
  const ci = s.ci ? `，90% 区间 ${pc(s.ci[0])} ~ ${pc(s.ci[1])}` : "";
  const verdict = s.ci_crosses_zero ? "区间跨过 0，说明不了比随机进场好" : s.excess! > 0 ? "区间在 0 以上" : "区间在 0 以下，比随机进场差";
  return {
    text: `${scope}：按 ${s.entries.join(" / ")} 进场 ${s.trades} 笔（${s.dates} 个日期${s.few_dates ? "，日期少" : ""}），`
      + `胜率 ${Math.round(s.win_rate! * 100)}%，中位数 ${pc(s.median!)}，比随机进场多 ${s.excess == null ? "—" : pc(s.excess)}${ci}：${verdict}。${EVALUATION_NOTE}`,
    setup: s, record: r,
  };
}

/** 评估 H3 开发集中位数的收益/回撤（MAR），SKILL.md 评估结论、README 是同一组数。 */
const MAR = { ma200: 0.26, dual: 0.14, hold: 0.33 };

/**
 * 结论卡片的对照一行。rule：MA200 朴素规则怎么说（算不了时写原因）；dual：双均线照方向持有怎么说；
 * agrees 算不了时为 null。卡片上写 rule、dual、agrees 和 short，text 是整句（悬停、给模型）。
 */
export interface NaiveCompare {
  rule: string;
  dual: HoldStance | null;
  agrees: boolean | null;
  short: string;
  text: string;
}

const SHORT = `评估 MAR ${MAR.ma200} vs ${MAR.dual}`;
const EVIDENCE = `评估里 MAR：MA200 ${MAR.ma200}、照方向持有 ${MAR.dual}、买入持有 ${MAR.hold}（${EVALUATION_DATE}，H3，见 README）`;

export function naiveCompare(m: Ma200): NaiveCompare {
  if (!m.available) {
    const rule = `MA200 朴素规则：${m.reason}`;
    return { rule, dual: null, agrees: null, short: SHORT, text: `${rule}。${EVIDENCE}` };
  }
  const pct = `${m.distance_pct >= 0 ? "+" : ""}${m.distance_pct.toFixed(1)}%`;
  const rule = `MA200 朴素规则：收盘在${m.close_above ? "上方" : "下方"} ${pct}，${m.stance}`;
  const dual = `双均线照方向持有（稳定 / 加速上涨才持有）：${m.dual_ma_stance}`;
  return { rule, dual: m.dual_ma_stance, agrees: m.agrees, short: SHORT, text: `${rule}；${dual}；${m.agrees ? "一致" : "不一致"}。${EVIDENCE}` };
}

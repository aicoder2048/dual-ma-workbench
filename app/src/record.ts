/**
 * 回测记录：skill 的 backtest.py 按打法汇总的逐笔结果（references/backtest-record.json，提交进仓库）。
 * 结论卡片上那一句照它说，这里只把数字写成话，不改数字。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

/** 这套打法（plan.ts 的 playKey）的回测记录说成一句话。 */
export function recordNote(key: string, r: BacktestRecord = RECORD): RecordNote {
  const s = r.setups[key] ?? null;
  const scope = `回测（${r.variant}，${r.tickers.length} 只票，${r.from} ~ ${r.to}）`;
  if (!s) return { text: `${scope}：这套打法空仓不买，回测没有进场。`, setup: null, record: r };
  if (!s.trades) return { text: `${scope}：这段时间这套打法一笔也没进场，没有可看的记录。`, setup: s, record: r };
  const ci = s.ci ? `，90% 区间 ${pc(s.ci[0])} ~ ${pc(s.ci[1])}` : "";
  const verdict = s.ci_crosses_zero ? "区间跨过 0，说明不了比随机进场好" : s.excess! > 0 ? "区间在 0 以上" : "区间在 0 以下，比随机进场差";
  return {
    text: `${scope}：按 ${s.entries.join(" / ")} 进场 ${s.trades} 笔（${s.dates} 个日期${s.few_dates ? "，日期少" : ""}），`
      + `胜率 ${Math.round(s.win_rate! * 100)}%，中位数 ${pc(s.median!)}，比随机进场多 ${s.excess == null ? "—" : pc(s.excess)}${ci}：${verdict}。`,
    setup: s, record: r,
  };
}

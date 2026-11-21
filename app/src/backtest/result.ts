/**
 * planrun.py 写的结果 JSON。页面只渲染这里的数字，不在 TypeScript 里重算任何指标。
 * 只校验页面要用的字段（多出来的照留），读文件、导入时都过一遍；和 Python 对不上的测试用 CLI 真跑出来的 fixture。
 */
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { BacktestError, BacktestPlan, Day, firstError } from "./plan.ts";

const N = Type.Number();
const NumOrNull = Type.Union([N, Type.Null()]);

const Metrics = Type.Object({
  trades: N,
  mean_r: NumOrNull,
  ci: Type.Union([Type.Tuple([N, N]), Type.Null()]),
  win: NumOrNull,
  payoff: NumOrNull,
  cagr: N,
  mdd: N,
  mar: NumOrNull,
  exposure: N,
  invested: N,
  streak: N,
  equity_pct_mean: NumOrNull,
  equity_pct_median: NumOrNull,
  reasons: Type.Record(Type.String(), N),
  skipped: Type.Record(Type.String(), N),
});
const BaseMetrics = Type.Object({ cagr: N, mdd: N, mar: NumOrNull, exposure: N });

const Trade = Type.Object({
  ticker: Type.String(),
  key: Type.String(),
  rule: Type.String(),
  kind: Type.String(),
  signal_date: Day,
  entry_date: Day,
  exit_date: Day,
  plan_entry: N,
  fill: N,
  stop: N,
  target: NumOrNull,
  rr: NumOrNull,
  exit_px: N,
  shares: N,
  reason: Type.String(),
  r: N,
  pnl: N,
  equity_pct: N,
});
export type Trade = Static<typeof Trade>;

export const BacktestResult = Type.Object({
  kind: Type.Literal("dma-backtest-result"),
  version: Type.Literal(1),
  plan: BacktestPlan,
  meta: Type.Object({
    generated: Type.String(),
    head: Type.String(),
    tickers: Type.Array(Type.String()),
    skipped: Type.Record(Type.String(), Type.String()),
    start: Day,
    end: Day,
    days: N,
    computed: Type.Array(Type.String()),
    seconds: Type.Object({ data: N, plans: N, sim: N }),
  }),
  /** 和完整计划报告的口径不一样的执行参数：有就标「参数非默认」。 */
  nondefault: Type.Array(Type.Object({
    key: Type.String(), label: Type.String(), value: Type.Unknown(), default: Type.Unknown(),
    origin: Type.Union([Type.Literal("脚本自定"), Type.Literal("完整计划")]),
  })),
  /** 第 4 步的新验证集（还没建）：锁上以后碰到的票不让跑。 */
  holdout: Type.Object({ locked: Type.Boolean(), overlap: Type.Array(Type.String()) }),
  summary: Type.Object({ plan: Metrics, baselines: Type.Record(Type.String(), BaseMetrics) }),
  /** 净值曲线，起点 = 1：plan 和每个对照（键是对照的名字）。 */
  equity: Type.Intersect([
    Type.Object({ dates: Type.Array(Day), plan: Type.Array(N) }),
    Type.Record(Type.String(), Type.Array(Type.Union([N, Type.String()]))),
  ]),
  trades: Type.Array(Trade),
});
export type BacktestResult = Static<typeof BacktestResult>;

export function parseResult(value: unknown, what = "回测结果"): BacktestResult {
  if (!Value.Check(BacktestResult, value)) throw new BacktestError(`${what}的格式不对：${firstError(BacktestResult, value)}`);
  const r = value as BacktestResult;
  const n = r.equity.dates.length;
  for (const name of ["plan", ...Object.keys(r.summary.baselines)]) {
    const curve = r.equity[name];
    if (!Array.isArray(curve) || curve.length !== n) throw new BacktestError(`${what}的格式不对：净值曲线 ${name} 和日期对不上`);
  }
  return r;
}

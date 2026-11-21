/**
 * 回测方案：data/backtests/<name>.toml。格式和 planrun.py 读的一样（`uv run planrun.py --template` 打印带说明的默认方案）。
 *
 * 这里只在边界上读写和校验：文件 / 请求体 → BacktestPlan，BacktestPlan → TOML。方案怎么变成单、怎么算指标全在 Python。
 * 两边各校验一遍：页面上填错当场说，命令行改坏了文件 planrun.py 照样报错。
 */
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

/** status：HTTP 状态码。400 输入不对，404 没有，409 当前状态不能这么做，500 文件坏了或脚本出错。 */
export class BacktestError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 500 = 400) {
    super(message);
  }
}

const Strict = { additionalProperties: false } as const;
export const Day = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const Ticker = Type.String({ pattern: "^[A-Z0-9][A-Z0-9.\\-^=]{0,14}$" });
export const PLAN_NAME = /^[\p{L}\p{N}_][\p{L}\p{N}_ \-·]{0,39}$/u;
export const MAX_TICKERS = 100;

export const BacktestPlan = Type.Object({
  version: Type.Literal(1),
  name: Type.String({ minLength: 1, maxLength: 40 }),
  mode: Type.Literal("fullplan"),
  universe: Type.Object({
    kind: Type.Union([Type.Literal("tickers"), Type.Literal("watchlist"), Type.Literal("core")]),
    tickers: Type.Array(Ticker, { maxItems: MAX_TICKERS }),
  }, Strict),
  period: Type.Object({ start: Day, end: Day }, Strict),
  execution: Type.Object({
    stop: Type.Union([Type.Literal("close"), Type.Literal("intraday")]),
    risk: Type.Union([Type.Literal("pct"), Type.Literal("amount")]),
    risk_pct: Type.Number({ exclusiveMinimum: 0, maximum: 10 }),
    risk_amount: Type.Number({ exclusiveMinimum: 0, maximum: 1e12 }),
    account: Type.Number({ exclusiveMinimum: 0, maximum: 1e12 }),
    /** 占净值的比例；0 = 不限。 */
    max_position: Type.Number({ minimum: 0, maximum: 1 }),
    rr_filter: Type.Boolean(),
    targets: Type.Boolean(),
    stop_floor_atr: Type.Union([Type.Literal(0), Type.Literal(0.5), Type.Literal(1)]),
    cost: Type.Number({ minimum: 0, maximum: 0.01 }),
  }, Strict),
}, Strict);
export type BacktestPlan = Static<typeof BacktestPlan>;

/** 页面会填错的字段，用中文说清。 */
const FIELD_HINT: Record<string, string> = {
  start: "开始日期要写成 2013-01-02 这样（加引号）", end: "结束日期要写成 2026-11-19 这样（加引号）",
  risk_pct: "每笔风险比例要在 0 ~ 10% 之间", risk_amount: "每笔风险金额要大于 0", account: "账户规模要大于 0",
  max_position: "单票仓位上限要在 0 ~ 100% 之间（0 = 不限）", cost: "手续费要在 0 ~ 1% 之间", stop_floor_atr: "止损下限只能是 0、0.5、1",
};

export function firstError(schema: TSchema, value: unknown): string {
  const e = [...Value.Errors(schema, value)][0] as { instancePath?: string; message?: string } | undefined;
  if (!e) return "格式不对";
  const field = e.instancePath?.split("/").filter((s) => !/^\d+$/.test(s)).at(-1) ?? "";
  if (field === "tickers") return "代码不合法（只能是字母、数字和 . - ^ =）";
  return FIELD_HINT[field] ?? `${e.instancePath || "/"} ${e.message}`;
}

const isRealDay = (d: string) => !Number.isNaN(Date.parse(d)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

/** 请求体或文件里读出来的对象 → 方案。代码统一大写去重；不对就抛 BacktestError（400）。 */
export function parsePlan(value: unknown, what = "回测方案"): BacktestPlan {
  const raw = value as { universe?: { tickers?: unknown } } | null;
  const tickers = raw?.universe?.tickers;
  const v = Array.isArray(tickers)
    ? { ...raw, universe: { ...raw!.universe, tickers: [...new Set(tickers.map((t) => (typeof t === "string" ? t.trim().toUpperCase() : t)))] } }
    : value;
  if (!Value.Check(BacktestPlan, v)) throw new BacktestError(`${what}不对：${firstError(BacktestPlan, v)}`);
  const p = v as BacktestPlan;
  const bad = (why: string) => new BacktestError(`${what}不对：${why}`);
  if (!PLAN_NAME.test(p.name)) throw bad("名字只能用文字、数字、空格、- 和 ·，最多 40 个字");
  if (p.universe.kind === "tickers" && !p.universe.tickers.length) throw bad("至少选一只票");
  if (!isRealDay(p.period.start) || !isRealDay(p.period.end)) throw bad("日期不存在");
  if (p.period.start >= p.period.end) throw bad(`开始 ${p.period.start} 要早于结束 ${p.period.end}`);
  if (p.execution.risk === "amount" && p.execution.risk_amount > p.execution.account) throw bad("每笔风险金额比账户还大");
  return p;
}

export function parsePlanToml(text: string, what = "回测方案"): BacktestPlan {
  let doc: unknown;
  try {
    doc = Bun.TOML.parse(text);
  } catch (err) {
    throw new BacktestError(`${what}不是合法的 TOML：${(err as Error).message}`);
  }
  return parsePlan(doc, what);
}

const str = (s: string) => JSON.stringify(s); // TOML 的基本字符串和 JSON 字符串转义一样
const num = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));

/** 方案 → TOML（固定的键顺序，和 planrun.py --template 一样）。 */
export function planToToml(p: BacktestPlan): string {
  const x = p.execution;
  return [
    "# 回测方案（归雁「回测」页）。命令行：uv run .agents/skills/dual-moving-averages/scripts/planrun.py <这个文件> --out result.json",
    `version = 1`,
    `name = ${str(p.name)}`,
    `mode = ${str(p.mode)}`,
    "",
    "[universe]",
    `kind = ${str(p.universe.kind)}`,
    `tickers = [${p.universe.tickers.map(str).join(", ")}]`,
    "",
    "[period]",
    `start = ${str(p.period.start)}`,
    `end = ${str(p.period.end)}`,
    "",
    "[execution]",
    `stop = ${str(x.stop)}`,
    `risk = ${str(x.risk)}`,
    `risk_pct = ${num(x.risk_pct)}`,
    `risk_amount = ${num(x.risk_amount)}`,
    `account = ${num(x.account)}`,
    `max_position = ${num(x.max_position)}`,
    `rr_filter = ${x.rr_filter}`,
    `targets = ${x.targets}`,
    `stop_floor_atr = ${num(x.stop_floor_atr)}`,
    `cost = ${num(x.cost)}`,
    "",
  ].join("\n");
}

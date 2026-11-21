/**
 * 一次回测运行的生命周期：排队 → 运行中 → 完成 / 失败 / 取消。排队时也能取消；导入的结果直接是完成。
 *
 * 状态和事件是一张表（NEXT）：表里没有的事件就是不合法，抛 409，不悄悄忽略。
 * 每个状态带的字段不一样（运行中有进度、完成有摘要、失败有原因），用联合类型写死，不会出现"完成了却没有摘要"。
 */
import { Type, type Static } from "typebox";
import { BacktestError } from "./plan.ts";

const Progress = Type.Object({ stage: Type.String(), done: Type.Number(), total: Type.Number(), text: Type.String() });
export type Progress = Static<typeof Progress>;

/** 列表里一眼要看的几个数（从结果 JSON 里抄，不在这里算）。 */
const Headline = Type.Object({
  trades: Type.Number(), mean_r: Type.Union([Type.Number(), Type.Null()]), cagr: Type.Number(), mdd: Type.Number(),
  tickers: Type.Number(), start: Type.String(), end: Type.String(), nondefault: Type.Boolean(),
});
export type Headline = Static<typeof Headline>;

const base = {
  id: Type.String({ pattern: "^[0-9]{8}-[0-9]{6}-[a-f0-9]{4}$" }),
  /** 方案名字（运行时的那一份存在 runs/<id>/plan.toml）。 */
  plan: Type.String(),
  source: Type.Union([Type.Literal("run"), Type.Literal("imported")]),
  createdAt: Type.String(),
  /** 脚本的输出，最后 LOG_LINES 行。 */
  log: Type.Array(Type.String()),
};
const at = Type.String();
export const Run = Type.Union([
  Type.Object({ ...base, state: Type.Literal("queued") }),
  Type.Object({ ...base, state: Type.Literal("running"), startedAt: at, progress: Type.Union([Progress, Type.Null()]) }),
  Type.Object({ ...base, state: Type.Literal("done"), startedAt: Type.Union([at, Type.Null()]), endedAt: at, headline: Headline }),
  Type.Object({ ...base, state: Type.Literal("failed"), startedAt: Type.Union([at, Type.Null()]), endedAt: at, error: Type.String() }),
  Type.Object({ ...base, state: Type.Literal("cancelled"), startedAt: Type.Union([at, Type.Null()]), endedAt: at }),
]);
export type Run = Static<typeof Run>;
export type RunState = Run["state"];

export const RUN_LABEL: Record<RunState, string> = { queued: "排队", running: "运行中", done: "完成", failed: "失败", cancelled: "取消" };
export const LOG_LINES = 200;

export type RunEvent =
  | { type: "start"; at: string }
  | { type: "progress"; progress: Progress }
  | { type: "log"; line: string }
  | { type: "finish"; at: string; headline: Headline }
  | { type: "fail"; at: string; error: string }
  | { type: "cancel"; at: string };

const NEXT: Record<RunState, Partial<Record<RunEvent["type"], RunState>>> = {
  queued: { start: "running", cancel: "cancelled", log: "queued" },
  running: { progress: "running", log: "running", finish: "done", fail: "failed", cancel: "cancelled" },
  done: {},
  failed: {},
  cancelled: {},
};

export const isFinished = (r: Run) => Object.keys(NEXT[r.state]).length === 0;

/** 走一步；表里没有这一步就抛 409。 */
export function advance(r: Run, e: RunEvent): Run {
  if (!NEXT[r.state][e.type]) throw new BacktestError(`这次回测已经${RUN_LABEL[r.state]}，不能再${EVENT_LABEL[e.type]}`, 409);
  const { id, plan, source, createdAt, log } = r;
  const keep = { id, plan, source, createdAt, log };
  const startedAt = "startedAt" in r ? r.startedAt : null;
  switch (e.type) {
    case "start": return { ...keep, state: "running", startedAt: e.at, progress: null };
    case "progress": return { ...(r as Extract<Run, { state: "running" }>), progress: e.progress };
    case "log": return { ...r, log: [...log, e.line].slice(-LOG_LINES) };
    case "finish": return { ...keep, state: "done", startedAt, endedAt: e.at, headline: e.headline };
    case "fail": return { ...keep, state: "failed", startedAt, endedAt: e.at, error: e.error };
    case "cancel": return { ...keep, state: "cancelled", startedAt, endedAt: e.at };
  }
}

const EVENT_LABEL: Record<RunEvent["type"], string> = {
  start: "开始", progress: "更新进度", log: "写日志", finish: "完成", fail: "记为失败", cancel: "取消",
};

export function newRun(id: string, plan: string, createdAt: string): Run {
  return { id, plan, source: "run", createdAt, log: [], state: "queued" };
}

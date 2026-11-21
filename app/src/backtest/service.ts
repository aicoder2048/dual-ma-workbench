/**
 * 回测页的服务端：存方案（data/backtests/<name>.toml），在后台跑 planrun.py，记每次运行（data/backtests/runs/<id>/）。
 *
 * - 一次只跑一个（每天的计划要算时会用满 CPU），其余排队。
 * - 子进程单独一个进程组：取消时整组停掉（uv、python 和它开的计算进程一起）。
 * - 每次运行一个目录：run.json（状态，见 run.ts）、plan.toml（运行时的方案，自选股已经换成当时的代码）、result.json。
 *   写文件都先写临时文件再改名。工作台重启时还在排队或运行的，记为失败。
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { PROJECT_ROOT } from "../sources.ts";
import { BacktestError, PLAN_NAME, parsePlan, parsePlanToml, planToToml, type BacktestPlan } from "./plan.ts";
import { parseResult, type BacktestResult } from "./result.ts";
import { advance, isFinished, newRun, Run, type Headline, type RunEvent } from "./run.ts";

const pexec = promisify(execFile);
export const PLANRUN = resolve(PROJECT_ROOT, ".agents/skills/dual-moving-averages/scripts/planrun.py");
const defaultCommand = (args: string[]) => ["uv", "run", "--quiet", "--script", PLANRUN, ...args];
const KILL_GRACE_MS = 5000;

/** planrun.py --estimate 的输出。 */
const Estimate = Type.Object({
  tickers: Type.Array(Type.String()),
  rows: Type.Array(Type.Object({
    ticker: Type.String(),
    status: Type.Union([Type.Literal("cached"), Type.Literal("compute"), Type.Literal("download"), Type.Literal("short")]),
    days: Type.Union([Type.Number(), Type.Null()]),
  })),
  counts: Type.Object({ cached: Type.Number(), compute: Type.Number(), download: Type.Number(), short: Type.Number() }),
  days: Type.Number(),
  compute_days: Type.Number(),
  jobs: Type.Number(),
  seconds: Type.Number(),
  holdout: Type.Object({ locked: Type.Boolean(), overlap: Type.Array(Type.String()) }),
});
export type Estimate = Static<typeof Estimate>;

export interface PlanEntry {
  name: string;
  updatedAt: string;
  /** 读不了的文件也列出来，写明原因，不悄悄跳过。 */
  plan: BacktestPlan | null;
  error: string | null;
}

export interface BacktestDeps {
  /** 默认 data/backtests。 */
  dir?: string;
  /** 自选股：方案选了自选股时，运行前把当时的代码填进去。 */
  watchlist: () => string[];
  /** planrun.py 的命令行；测试换成假脚本。 */
  command?: (args: string[]) => string[];
  now?: () => Date;
}

const stamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

function writeAtomic(file: string, text: string) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function headline(r: BacktestResult): Headline {
  const s = r.summary.plan;
  return { trades: s.trades, mean_r: s.mean_r, cagr: s.cagr, mdd: s.mdd, tickers: r.meta.tickers.length,
    start: r.meta.start, end: r.meta.end, nondefault: r.nondefault.length > 0 };
}

/** 子进程报错：取 stderr 最后几行。 */
const tail = (lines: string[], n = 4) => lines.filter((l) => l.trim()).slice(-n).join("\n");

export class Backtests {
  private readonly dir: string;
  private readonly runsDir: string;
  private readonly command: (args: string[]) => string[];
  private readonly now: () => Date;
  private readonly runs = new Map<string, Run>();
  private active: { id: string; child: ChildProcess } | null = null;
  private templateCache: Promise<BacktestPlan> | null = null;

  constructor(private deps: BacktestDeps) {
    this.dir = deps.dir ?? resolve(PROJECT_ROOT, "data/backtests");
    this.runsDir = join(this.dir, "runs");
    this.command = deps.command ?? defaultCommand;
    this.now = deps.now ?? (() => new Date());
    this.loadRuns();
  }

  // ---------- 方案 ----------

  private planFile(name: string): string {
    if (!PLAN_NAME.test(name)) throw new BacktestError(`方案名字不合法：${name}`);
    return join(this.dir, `${name}.toml`);
  }

  listPlans(): PlanEntry[] {
    if (!existsSync(this.dir)) return [];
    const names = readdirSync(this.dir).filter((f) => f.endsWith(".toml")).map((f) => f.slice(0, -".toml".length));
    return names.sort().map((name) => {
      const f = `${name}.toml`;
      const file = join(this.dir, f);
      const updatedAt = statSync(file).mtime.toISOString();
      try {
        return { name, updatedAt, plan: parsePlanToml(readFileSync(file, "utf8"), f), error: null };
      } catch (err) {
        return { name, updatedAt, plan: null, error: (err as Error).message };
      }
    });
  }

  getPlan(name: string): BacktestPlan {
    const file = this.planFile(name);
    if (!existsSync(file)) throw new BacktestError(`没有方案「${name}」`, 404);
    return parsePlanToml(readFileSync(file, "utf8"), `${name}.toml`);
  }

  /** 按方案里的名字存（同名覆盖）。 */
  savePlan(raw: unknown): BacktestPlan {
    const plan = parsePlan(raw);
    mkdirSync(this.dir, { recursive: true });
    writeAtomic(this.planFile(plan.name), planToToml(plan));
    return plan;
  }

  private freeName(base: string): string {
    const taken = new Set(this.listPlans().map((p) => p.name));
    if (!taken.has(base)) return base;
    for (let k = 2; ; k++) {
      const suffix = ` ${k}`;
      const name = base.slice(0, 40 - suffix.length) + suffix;
      if (!taken.has(name)) return name;
    }
  }

  duplicate(name: string): BacktestPlan {
    const plan = this.getPlan(name);
    return this.savePlan({ ...plan, name: this.freeName(`${plan.name.slice(0, 37)} 副本`) });
  }

  /** 导入一个 TOML 文件；名字已经有了就加编号，不覆盖。 */
  importPlan(text: unknown): BacktestPlan {
    if (typeof text !== "string" || !text.trim()) throw new BacktestError("导入的文件是空的");
    const plan = parsePlanToml(text, "导入的方案");
    return this.savePlan({ ...plan, name: this.freeName(plan.name) });
  }

  exportPlan(name: string): string {
    return planToToml(this.getPlan(name));
  }

  deletePlan(name: string): void {
    const file = this.planFile(name);
    if (!existsSync(file)) throw new BacktestError(`没有方案「${name}」`, 404);
    rmSync(file);
  }

  /** 新方案的默认值：planrun.py --template（和完整计划报告一样的口径），只取一次。 */
  template(): Promise<BacktestPlan> {
    this.templateCache ??= this.exec(["--template"]).then((out) => parsePlanToml(out, "planrun.py --template"));
    this.templateCache.catch(() => (this.templateCache = null));
    return this.templateCache;
  }

  // ---------- 估计 ----------

  async estimate(raw: unknown): Promise<Estimate> {
    const plan = this.snapshot(parsePlan(raw));
    const dir = mkdtempSync(join(tmpdir(), "dma-bt-"));
    try {
      const file = join(dir, "plan.toml");
      writeFileSync(file, planToToml(plan));
      const out = JSON.parse(await this.exec([file, "--estimate"]));
      if (!Value.Check(Estimate, out)) throw new BacktestError("planrun.py --estimate 的输出格式不对", 500);
      return out as Estimate;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private async exec(args: string[]): Promise<string> {
    const [cmd, ...rest] = this.command(args);
    try {
      const { stdout } = await pexec(cmd!, rest, { cwd: PROJECT_ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120_000 });
      return stdout;
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      throw new BacktestError(tail(String(e.stderr ?? "").split("\n")) || e.message || String(err), 400);
    }
  }

  /** 自选股换成当时的代码。 */
  private snapshot(plan: BacktestPlan): BacktestPlan {
    if (plan.universe.kind !== "watchlist") return plan;
    return parsePlan({ ...plan, universe: { kind: "watchlist", tickers: this.deps.watchlist() } });
  }

  // ---------- 运行 ----------

  private runDir(id: string): string {
    if (!/^[0-9]{8}-[0-9]{6}-[a-f0-9]{4}$/.test(id)) throw new BacktestError(`没有这次回测：${id}`, 404);
    return join(this.runsDir, id);
  }

  private loadRuns() {
    if (!existsSync(this.runsDir)) return;
    for (const id of readdirSync(this.runsDir)) {
      const file = join(this.runsDir, id, "run.json");
      if (!existsSync(file)) continue;
      const r = JSON.parse(readFileSync(file, "utf8"));
      if (!Value.Check(Run, r)) throw new BacktestError(`${file} 的格式不对`, 500);
      this.runs.set(id, r);
      if (!isFinished(r)) this.apply(id, { type: "fail", at: this.now().toISOString(), error: "工作台重启，这次运行中断了" });
    }
  }

  private apply(id: string, e: RunEvent): Run {
    const next = advance(this.runs.get(id)!, e);
    this.runs.set(id, next);
    writeAtomic(join(this.runDir(id), "run.json"), JSON.stringify(next, null, 1) + "\n");
    return next;
  }

  private create(plan: string, source: Run["source"]): string {
    const now = this.now();
    let id: string;
    do id = `${stamp(now)}-${randomBytes(2).toString("hex")}`; while (this.runs.has(id));
    mkdirSync(this.runDir(id), { recursive: true });
    this.runs.set(id, { ...newRun(id, plan, now.toISOString()), source });
    return id;
  }

  /** 存下方案，排进队列。 */
  start(raw: unknown): Run {
    const plan = this.snapshot(this.savePlan(raw));
    const id = this.create(plan.name, "run");
    writeFileSync(join(this.runDir(id), "plan.toml"), planToToml(plan));
    const run = this.apply(id, { type: "log", line: `方案「${plan.name}」排队` });
    this.pump();
    return run;
  }

  private pump() {
    if (this.active) return;
    const next = this.listRuns().reverse().find((r) => r.state === "queued");
    if (next) this.launch(next.id);
  }

  private launch(id: string) {
    const dir = this.runDir(id);
    const out = join(dir, "result.json");
    const [cmd, ...args] = this.command([join(dir, "plan.toml"), "--out", out]);
    this.apply(id, { type: "start", at: this.now().toISOString() });
    const child = spawn(cmd!, args, { cwd: PROJECT_ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    this.active = { id, child };
    const stderr: string[] = [];
    const running = () => this.runs.get(id)?.state === "running";
    createInterface({ input: child.stdout! }).on("line", (line) => {
      if (!running()) return;
      let e: { event?: string; stage?: string; done?: number; total?: number; text?: string } | null = null;
      try { e = JSON.parse(line); } catch { /* 不是事件的输出照原样记日志 */ }
      if (e?.event === "progress") {
        this.apply(id, { type: "progress", progress: { stage: String(e.stage), done: Number(e.done), total: Number(e.total), text: String(e.text) } });
      }
      this.apply(id, { type: "log", line: e?.text ?? line });
    });
    createInterface({ input: child.stderr! }).on("line", (line) => {
      stderr.push(line);
      if (running()) this.apply(id, { type: "log", line });
    });
    const finish = (code: number | null, error?: Error) => {
      if (this.active?.id === id) this.active = null;
      if (running()) {
        const at = this.now().toISOString();
        try {
          if (error || code !== 0) throw new Error(error?.message || tail(stderr) || `planrun.py 退出码 ${code}`);
          this.apply(id, { type: "finish", at, headline: headline(parseResult(JSON.parse(readFileSync(out, "utf8")), "result.json")) });
        } catch (err) {
          this.apply(id, { type: "fail", at, error: (err as Error).message });
        }
      }
      this.pump();
    };
    child.on("error", (err) => finish(null, err));
    child.on("close", (code) => finish(code));
  }

  cancel(id: string): Run {
    this.runDir(id);
    if (!this.runs.has(id)) throw new BacktestError(`没有这次回测：${id}`, 404);
    const run = this.apply(id, { type: "cancel", at: this.now().toISOString() });
    if (this.active?.id === id) {
      const pid = this.active.child.pid!;
      this.active = null;
      const kill = (sig: NodeJS.Signals) => { try { process.kill(-pid, sig); } catch { /* 已经退出 */ } };
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS).unref();
      this.pump();
    }
    return run;
  }

  /** 新的在前。 */
  listRuns(): Run[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  getRun(id: string): { run: Run; result: BacktestResult | null } {
    const dir = this.runDir(id);
    const run = this.runs.get(id);
    if (!run) throw new BacktestError(`没有这次回测：${id}`, 404);
    if (run.state !== "done") return { run, result: null };
    return { run, result: parseResult(JSON.parse(readFileSync(join(dir, "result.json"), "utf8")), "result.json") };
  }

  /** 导入命令行跑出来的结果 JSON：直接是一次完成的运行。 */
  importResult(raw: unknown): Run {
    const result = parseResult(raw, "导入的结果");
    const id = this.create(result.plan.name, "imported");
    const dir = this.runDir(id);
    writeAtomic(join(dir, "result.json"), JSON.stringify(result) + "\n");
    writeFileSync(join(dir, "plan.toml"), planToToml(result.plan));
    this.apply(id, { type: "start", at: result.meta.generated });
    return this.apply(id, { type: "finish", at: this.now().toISOString(), headline: headline(result) });
  }
}

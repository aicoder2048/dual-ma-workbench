import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BacktestError, parsePlan, parsePlanToml, planToToml, type BacktestPlan } from "../src/backtest/plan.ts";
import { parseResult } from "../src/backtest/result.ts";
import { advance, newRun, type Run } from "../src/backtest/run.ts";
import { Backtests, PLANRUN } from "../src/backtest/service.ts";
import { Analyzer } from "../src/analyze.ts";
import { createHandler } from "../src/http.ts";
import { Journal } from "../src/journal.ts";
import { SettingsStore } from "../src/settings.ts";
import { SourceLibrary } from "../src/sources.ts";
import { Watchlist } from "../src/watchlist.ts";
import { TEMPLATE } from "./fixtures/fake-planrun.ts";
import nvdaResult from "./fixtures/backtest-nvda-result.json";

const FAKE = resolve(import.meta.dir, "fixtures/fake-planrun.ts");
const plan = (patch: (p: BacktestPlan) => void = () => {}): BacktestPlan => {
  const p = parsePlanToml(TEMPLATE);
  patch(p);
  return p;
};
const errorOf = (f: () => unknown) => {
  try { f(); } catch (err) { return err as BacktestError; }
  throw new Error("没有报错");
};

describe("回测方案：TOML 读写", () => {
  test("默认方案读进来：标的、时间段、执行参数都对", () => {
    const p = plan();
    expect(p.universe).toEqual({ kind: "tickers", tickers: ["NVDA"] });
    expect(p.period).toEqual({ start: "2013-01-02", end: "2026-11-19" });
    expect(p.execution).toMatchObject({ stop: "close", risk_pct: 1, max_position: 0.25, stop_floor_atr: 0, cost: 0.0005 });
  });

  test("写出去再读回来一模一样（导出 → 导入）", () => {
    const p = plan((p) => {
      p.name = "核心 · 盘中止损";
      p.universe = { kind: "tickers", tickers: ["NVDA", "BRK-B", "BTC-USD"] };
      p.execution = { ...p.execution, stop: "intraday", risk: "amount", risk_amount: 5000, max_position: 0, stop_floor_atr: 0.5, targets: false };
    });
    expect(parsePlanToml(planToToml(p))).toEqual(p);
  });

  test("代码统一大写、去重", () => {
    const p = parsePlan({ ...plan(), universe: { kind: "tickers", tickers: ["nvda", " NVDA", "spy"] } });
    expect(p.universe.tickers).toEqual(["NVDA", "SPY"]);
  });

  const bad: [string, (p: any) => void, string][] = [
    ["不认识的键", (p) => { p.execution.slippage = 0.001; }, "不对"],
    ["风险比例 0", (p) => { p.execution.risk_pct = 0; }, "每笔风险比例要在 0 ~ 10% 之间"],
    ["风险比例写成字符串", (p) => { p.execution.risk_pct = "1%"; }, "每笔风险比例"],
    ["仓位上限 150%", (p) => { p.execution.max_position = 1.5; }, "单票仓位上限"],
    ["止损下限 0.75", (p) => { p.execution.stop_floor_atr = 0.75; }, "止损下限只能是"],
    ["手续费 5%", (p) => { p.execution.cost = 0.05; }, "手续费"],
    ["日期格式", (p) => { p.period.start = "2013/01/02"; }, "开始日期"],
    ["不存在的日期", (p) => { p.period.end = "2026-02-30"; }, "日期不存在"],
    ["开始晚于结束", (p) => { p.period.start = "2027-01-01"; }, "要早于结束"],
    ["空的代码清单", (p) => { p.universe.tickers = []; }, "至少选一只票"],
    ["不合法的代码", (p) => { p.universe.tickers = ["NV DA"]; }, "代码不合法"],
    ["名字带斜杠", (p) => { p.name = "a/b"; }, "名字只能用"],
    ["测什么不是完整计划", (p) => { p.mode = "grid"; }, "不对"],
    ["风险金额比账户大", (p) => { p.execution.risk = "amount"; p.execution.risk_amount = 2e6; }, "比账户还大"],
  ];
  for (const [what, edit, msg] of bad) {
    test(`填错直接报错：${what}`, () => {
      const p = structuredClone(plan()) as any;
      edit(p);
      const e = errorOf(() => parsePlan(p));
      expect(e).toBeInstanceOf(BacktestError);
      expect(e.status).toBe(400);
      expect(e.message).toContain(msg);
    });
  }

  test("不是 TOML、日期没加引号：说清楚", () => {
    expect(errorOf(() => parsePlanToml("[period")).message).toContain("不是合法的 TOML");
    expect(errorOf(() => parsePlanToml(TEMPLATE.replace('start = "2013-01-02"', "start = 2013-01-02"))).message).toContain("开始日期");
  });

  test("和 planrun.py 是同一个格式：它的默认方案这里读得进，这里写的方案它也读得进", () => {
    const run = (...args: string[]) => execFileSync("uv", ["run", "--quiet", "--script", PLANRUN, ...args], { encoding: "utf8" });
    const fromPython = parsePlanToml(run("--template"));
    expect(fromPython).toEqual(plan()); // 替身的默认方案和真的一样
    const dir = mkdtempSync(join(tmpdir(), "bt-"));
    const p = plan((p) => { p.universe.tickers = ["NVDA", "BRK-B"]; p.execution.stop_floor_atr = 1; p.execution.max_position = 0; });
    writeFileSync(join(dir, "p.toml"), planToToml(p));
    const est = JSON.parse(run(join(dir, "p.toml"), "--estimate", "--data", join(dir, "none"), "--cache", dir));
    expect(est.tickers).toEqual(["NVDA", "BRK-B"]);
    expect(est.rows.map((r: any) => r.status)).toEqual(["download", "download"]); // 没有行情：只报要下载，不真下载
  }, 60_000);
});

describe("回测结果：和 CLI 的 JSON 对得上", () => {
  test("planrun.py 真跑出来的 NVDA 结果通过校验", () => {
    const r = parseResult(nvdaResult);
    expect(r.meta.tickers).toEqual(["NVDA"]);
    expect(r.trades.length).toBe(r.summary.plan.trades);
    expect(Object.keys(r.summary.baselines)).toEqual(["买入持有", "MA200 朴素规则"]);
  });

  test("净值曲线和日期长短不一：报错", () => {
    const broken = structuredClone(nvdaResult) as any;
    broken.equity["买入持有"].pop();
    expect(errorOf(() => parseResult(broken)).message).toContain("净值曲线 买入持有 和日期对不上");
  });

  test("不是回测结果的 JSON：报错", () => {
    expect(errorOf(() => parseResult({ hello: 1 })).message).toContain("格式不对");
  });
});

describe("一次运行的状态：排队 → 运行中 → 完成 / 失败 / 取消", () => {
  const at = "2026-11-20T10:00:00.000Z";
  const queued = newRun("20261120-100000-abcd", "完整计划", at);
  const headline = { trades: 4, mean_r: 0.1, cagr: 0.02, mdd: -0.1, tickers: 1, start: "2023-01-03", end: "2026-11-19", nondefault: false };

  test("正常走完", () => {
    let r: Run = advance(queued, { type: "start", at });
    r = advance(r, { type: "progress", progress: { stage: "plans", done: 1, total: 2, text: "NVDA" } });
    expect(r).toMatchObject({ state: "running", progress: { done: 1 } });
    r = advance(r, { type: "finish", at, headline });
    expect(r).toMatchObject({ state: "done", startedAt: at, headline });
    expect("progress" in r).toBe(false);
  });

  test("排队时可以取消；运行中可以取消、可以失败", () => {
    expect(advance(queued, { type: "cancel", at }).state).toBe("cancelled");
    const running = advance(queued, { type: "start", at });
    expect(advance(running, { type: "cancel", at }).state).toBe("cancelled");
    expect(advance(running, { type: "fail", at, error: "x" })).toMatchObject({ state: "failed", error: "x" });
  });

  test("结束了的不能再动：取消之后晚到的完成、完成之后再取消，都是 409", () => {
    const cancelled = advance(queued, { type: "cancel", at });
    const e = errorOf(() => advance(cancelled, { type: "finish", at, headline }));
    expect(e.status).toBe(409);
    expect(e.message).toContain("已经取消");
    expect(errorOf(() => advance(queued, { type: "finish", at, headline })).status).toBe(409); // 没开始不能完成
  });

  test("日志只留最后 200 行", () => {
    let r: Run = queued;
    for (let i = 0; i < 250; i++) r = advance(r, { type: "log", line: String(i) });
    expect(r.log.length).toBe(200);
    expect(r.log[0]).toBe("50");
  });
});

/** 服务端：真的子进程（替身脚本），真的文件。 */
function service(watchlist = ["NVDA", "TSLA"], dir = mkdtempSync(join(tmpdir(), "bt-svc-"))) {
  return { dir, bt: new Backtests({ dir, watchlist: () => watchlist, command: (args) => ["bun", FAKE, ...args] }) };
}
async function until(f: () => boolean, ms = 10_000) {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error("等不到");
    await Bun.sleep(20);
  }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("回测服务", () => {
  test("存、复制、导出、导入、删除方案：文件在 data/backtests/<名字>.toml", async () => {
    const { dir, bt } = service();
    const p = bt.savePlan({ ...(await bt.template()), name: "NVDA 单票" });
    expect(readFileSync(join(dir, "NVDA 单票.toml"), "utf8")).toBe(planToToml(p));
    expect(bt.duplicate("NVDA 单票").name).toBe("NVDA 单票 副本");
    expect(bt.duplicate("NVDA 单票").name).toBe("NVDA 单票 副本 2");
    const imported = bt.importPlan(bt.exportPlan("NVDA 单票"));
    expect(imported).toEqual({ ...p, name: "NVDA 单票 2" }); // 同名不覆盖
    expect(bt.listPlans().map((e) => e.name)).toEqual(["NVDA 单票", "NVDA 单票 2", "NVDA 单票 副本", "NVDA 单票 副本 2"]);
    bt.deletePlan("NVDA 单票 2");
    expect(existsSync(join(dir, "NVDA 单票 2.toml"))).toBe(false);
    expect(errorOf(() => bt.getPlan("没有")).status).toBe(404);
    expect(() => bt.importPlan("version = 2")).toThrow("不对");
  });

  test("坏掉的方案文件照样列出来，写明原因", () => {
    const { dir, bt } = service();
    writeFileSync(join(dir, "手改坏了.toml"), TEMPLATE.replace("risk_pct = 1.0", "risk_pct = -1"));
    const [e] = bt.listPlans();
    expect(e).toMatchObject({ name: "手改坏了", plan: null });
    expect(e!.error).toContain("每笔风险比例");
  });

  test("估计：自选股换成当时的代码交给脚本", async () => {
    const { bt } = service(["NVDA", "TSLA", "META"]);
    const est = await bt.estimate(plan((p) => { p.universe = { kind: "watchlist", tickers: [] }; }));
    expect(est.tickers).toEqual(["NVDA", "TSLA", "META"]);
    expect(est.counts).toMatchObject({ cached: 1, compute: 2 });
  });

  test("运行：排队 → 运行中（进度一行行更新）→ 完成，结果和摘要可以读", async () => {
    const { dir, bt } = service();
    const run = bt.start(plan((p) => { p.name = "NVDA 单票"; }));
    expect(["queued", "running"]).toContain(run.state);
    expect(existsSync(join(dir, "NVDA 单票.toml"))).toBe(true); // 运行前先存方案
    await until(() => bt.getRun(run.id).run.state === "running" && (bt.getRun(run.id).run as any).progress?.done === 2);
    await until(() => bt.getRun(run.id).run.state === "done");
    const { run: done, result } = bt.getRun(run.id);
    expect(done).toMatchObject({ state: "done", headline: { trades: 4, tickers: 1, nondefault: false } });
    expect(result!.trades.length).toBe(4);
    expect(done.log).toContain("NVDA 完成（975 天）");
  });

  test("一次只跑一个：第二个排队，第一个完了接着跑", async () => {
    const { bt } = service();
    const a = bt.start(plan((p) => { p.name = "甲"; }));
    const b = bt.start(plan((p) => { p.name = "乙"; }));
    expect(bt.getRun(b.id).run.state).toBe("queued");
    await until(() => bt.getRun(b.id).run.state === "done");
    expect(bt.getRun(a.id).run.state).toBe("done");
    expect(bt.listRuns().map((r) => r.plan)).toEqual(["乙", "甲"]); // 新的在前
  });

  test("取消：子进程和它开的进程一起停掉，状态是取消，排队的接着跑", async () => {
    const { dir, bt } = service();
    const slow = bt.start(plan((p) => { p.name = "慢"; }));
    const next = bt.start(plan((p) => { p.name = "接着"; }));
    const pidFile = join(dir, "runs", slow.id, "result.json.pids");
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0);
    const pids = JSON.parse(readFileSync(pidFile, "utf8")) as number[];
    expect(pids.every(alive)).toBe(true);
    expect(bt.cancel(slow.id).state).toBe("cancelled");
    await until(() => !pids.some(alive));
    await until(() => bt.getRun(next.id).run.state === "done");
    expect(bt.getRun(slow.id).run.state).toBe("cancelled"); // 被杀掉的退出码不会把它改成失败
    expect(errorOf(() => bt.cancel(slow.id)).status).toBe(409);
  });

  test("脚本报错：失败，原因是脚本最后几行输出", async () => {
    const { bt } = service();
    const run = bt.start(plan((p) => { p.name = "坏"; }));
    await until(() => bt.getRun(run.id).run.state === "failed");
    expect((bt.getRun(run.id).run as any).error).toContain("取不到行情");
  });

  test("运行时存的是当时的自选股", async () => {
    const { dir, bt } = service(["META", "MU"]);
    const run = bt.start(plan((p) => { p.name = "自选"; p.universe = { kind: "watchlist", tickers: [] }; }));
    expect(parsePlanToml(readFileSync(join(dir, "runs", run.id, "plan.toml"), "utf8")).universe).toEqual({ kind: "watchlist", tickers: ["META", "MU"] });
    expect(bt.getPlan("自选").universe.tickers).toEqual([]); // 方案本身还是"自选股"，下次跑用新的自选股
    await until(() => bt.getRun(run.id).run.state === "done");
  });

  test("导入命令行的结果 JSON：成为一次完成的运行；工作台重启后历史还在，没跑完的记为失败", async () => {
    const { dir, bt } = service();
    const run = bt.importResult(nvdaResult);
    expect(run).toMatchObject({ state: "done", source: "imported", plan: "NVDA 单票", headline: { trades: 4 } });
    expect(bt.getRun(run.id).result!.meta.tickers).toEqual(["NVDA"]);
    const slow = bt.start(plan((p) => { p.name = "慢"; }));
    await until(() => bt.getRun(slow.id).run.state === "running");
    const again = service([], dir).bt;
    expect(again.getRun(run.id).run.state).toBe("done");
    expect((again.getRun(slow.id).run as any).error).toBe("工作台重启，这次运行中断了");
    bt.cancel(slow.id);
    expect(() => bt.importResult({ kind: "x" })).toThrow("导入的结果的格式不对");
  });
});

describe("回测接口", () => {
  const { dir, bt } = service();
  const handler = createHandler({
    analyzer: new Analyzer(async () => { throw new Error("不该取行情"); }), journal: new Journal(join(dir, "j.json")),
    library: SourceLibrary.load(), publicDir: dir, watchlist: new Watchlist(join(dir, "w.json")),
    settings: new SettingsStore(join(dir, "s.json")), backtests: bt,
  });
  const call = (path: string, init?: RequestInit) => handler(new Request(`http://127.0.0.1${path}`, init));
  const post = (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body) });

  test("存方案、导出成 .toml 下载、填错 400、没有的 404", async () => {
    expect((await post("/api/backtest/plans", { plan: plan((p) => { p.name = "单票"; }) })).status).toBe(200);
    const res = await call("/api/backtest/plans/%E5%8D%95%E7%A5%A8/export");
    expect(res.headers.get("content-disposition")).toContain(`filename*=UTF-8''${encodeURIComponent("单票")}.toml`);
    expect(parsePlanToml(await res.text()).name).toBe("单票");
    const bad = await post("/api/backtest/plans", { plan: { ...plan(), period: { start: "2026-01-01", end: "2025-01-01" } } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("要早于结束");
    expect((await call("/api/backtest/plans/没有")).status).toBe(404);
    expect((await call("/api/backtest/runs/20260101-000000-abcd")).status).toBe(404);
    expect((await call("/api/backtest/nope")).status).toBe(404);
  });

  test("运行、取消已经结束的 409、导入结果", async () => {
    const run = await (await post("/api/backtest/runs", { plan: plan((p) => { p.name = "接口"; }) })).json();
    await until(() => bt.getRun(run.id).run.state === "done");
    const view = await (await call(`/api/backtest/runs/${run.id}`)).json();
    expect(view.result.trades.length).toBe(4);
    expect((await call(`/api/backtest/runs/${run.id}/cancel`, { method: "POST" })).status).toBe(409);
    expect((await (await post("/api/backtest/runs/import", nvdaResult)).json()).source).toBe("imported");
  });
});

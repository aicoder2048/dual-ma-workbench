/**
 * planrun.py 的替身（测试和端到端用）：同样的参数、同样的输出格式，不算任何东西。
 * - --template：打印默认方案
 * - <plan> --estimate：打印估计
 * - <plan> --out <file>：逐行打印进度事件，把 CLI 真跑出来的 NVDA 结果（backtest-nvda-result.json）写到 file
 * 方案名字里有「慢」：开一个孙进程 sleep，把两个 pid 写到 <out>.pids，然后一直等（测取消）；有「坏」：报错退出。
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const TEMPLATE = `version = 1
name = "完整计划"
mode = "fullplan"

[universe]
kind = "tickers"
tickers = ["NVDA"]

[period]
start = "2013-01-02"
end = "2026-11-19"

[execution]
stop = "close"
risk = "pct"
risk_pct = 1.0
risk_amount = 10000.0
account = 1000000.0
max_position = 0.25
rr_filter = true
targets = true
stop_floor_atr = 0.0
cost = 0.0005
`;

async function main() {
  const args = process.argv.slice(2);
  const emit = (e: object) => console.log(JSON.stringify(e));

  if (args[0] === "--template") {
    process.stdout.write(TEMPLATE);
    return;
  }
  const plan = Bun.TOML.parse(readFileSync(args[0]!, "utf8")) as { name: string; universe: { kind: string; tickers: string[] } };
  const tickers = plan.universe.kind === "core" ? ["SPY", "QQQ", "NVDA"] : plan.universe.tickers;
  if (args[1] === "--estimate") {
    emit({
      tickers, rows: tickers.map((t, i) => ({ ticker: t, status: i ? "compute" : "cached", days: 975 })),
      counts: { cached: 1, compute: tickers.length - 1, download: 0, short: 0 }, days: 975 * tickers.length,
      compute_days: 3500 * (tickers.length - 1), jobs: 8, seconds: 2 + 30 * (tickers.length - 1), holdout: { locked: true, overlap: tickers.filter((t) => t === "VTI"), runs: 1 },
    });
    return;
  }
  const out = args[args.indexOf("--out") + 1]!;
  if (plan.name.includes("坏")) {
    console.error("Traceback (most recent call last):");
    console.error("planrun.py：取不到行情");
    process.exit(1);
  }
  emit({ event: "progress", stage: "plans", done: 0, total: 2, text: `每天的计划：${tickers.length} 只` });
  if (plan.name.includes("慢")) {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    writeFileSync(`${out}.pids`, JSON.stringify([process.pid, child.pid]));
    await Bun.sleep(30_000);
  }
  await Bun.sleep(150);
  emit({ event: "progress", stage: "plans", done: 2, total: 2, text: "NVDA 完成（975 天）" });
  await Bun.sleep(150);
  emit({ event: "progress", stage: "sim", done: 0, total: 1, text: "逐笔模拟" });
  const result = JSON.parse(readFileSync(resolve(import.meta.dir, "backtest-nvda-result.json"), "utf8"));
  writeFileSync(out, JSON.stringify({ ...result, plan: { ...result.plan, ...plan } }));
  emit({ event: "done", trades: result.trades.length, seconds: 0.1 });
}

if (import.meta.main) await main();

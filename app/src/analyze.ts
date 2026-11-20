/**
 * 调用 skill 的 Python 脚本（PEP 723，`uv run --script`）拿分析结果，带内存缓存。
 *
 * 网页图表、自选股标签、长风的 dma_analyze 工具都走这里，保证同一次计算的数字处处一致。
 */
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { Analysis } from "./citations.ts";
import { sourceArg, type DataSource } from "./settings.ts";
import { PROJECT_ROOT } from "./sources.ts";

const pexec = promisify(execFile);
export const SCRIPT = resolve(PROJECT_ROOT, ".agents/skills/dual-moving-averages/scripts/dma_analyze.py");

/** 破线拐头着色：bull 收盘站上 MA20 且高于 20 日抵扣价，bear 两样都不满足，mixed 只满足一样。 */
export type Tone = "bull" | "bear" | "mixed";

export interface ChartData {
  candles: { time: string; open: number; high: number; low: number; close: number; tone?: Tone }[];
  volume: { time: string; value: number; spike: boolean }[];
  lines: Record<string, { time: string; value: number }[]>;
  drops: { time: string; period: number }[];
}

export interface AnalyzeResult {
  analysis: Analysis;
  chart: ChartData;
}

const TICKER = /^[A-Z0-9][A-Z0-9.\-^=]{0,14}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 统一成大写；不合法就抛错（参数会传给子进程，不信任输入）。 */
export function normalizeTicker(raw: string): string {
  const t = raw.trim().toUpperCase();
  if (!TICKER.test(t)) throw new Error(`股票代码不合法：${raw}`);
  return t;
}

export function normalizeAsof(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = raw.trim();
  if (!DATE.test(d) || Number.isNaN(Date.parse(d))) throw new Error(`日期格式应为 YYYY-MM-DD：${raw}`);
  return d;
}

export type Runner = (args: string[]) => Promise<string>;

const defaultRunner: Runner = async (args) => {
  const { stdout } = await pexec("uv", ["run", "--quiet", "--script", SCRIPT, ...args], {
    cwd: PROJECT_ROOT, // 让脚本找到项目根目录的 .env
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 90_000,
  });
  return stdout;
};

/** 最新行情缓存 10 分钟；回放历史日期的结果不会变，一直缓存。 */
const LATEST_TTL_MS = 10 * 60 * 1000;

export class Analyzer {
  private cache = new Map<string, { at: number; value: Promise<AnalyzeResult> }>();

  constructor(
    private run: Runner = defaultRunner,
    private now: () => number = Date.now,
    /** 当前设置的数据源；切换后缓存按新数据源重新取。 */
    private source: () => DataSource = () => "polygon",
  ) {}

  analyze(tickerRaw: string, asofRaw?: string | null): Promise<AnalyzeResult> {
    const ticker = normalizeTicker(tickerRaw);
    const asof = normalizeAsof(asofRaw);
    const src = sourceArg(this.source());
    const key = `${ticker}|${asof ?? "latest"}|${src}`;
    const hit = this.cache.get(key);
    if (hit && (asof || this.now() - hit.at < LATEST_TTL_MS)) return hit.value;

    const args = [ticker, "--json", ...(asof ? ["--asof", asof] : []), "--source", src];
    const value = this.run(args).then((out) => JSON.parse(out) as AnalyzeResult);
    this.cache.set(key, { at: this.now(), value });
    value.catch(() => this.cache.delete(key)); // 失败不缓存，下次重试
    return value;
  }
}

/** 子进程报错时，取 stderr 最后几行给人看。 */
export function explainError(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  const tail = e.stderr?.trim().split("\n").slice(-3).join(" ");
  return tail || e.message || String(err);
}

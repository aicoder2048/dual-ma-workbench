/**
 * 工作台设置：大模型、市场数据源。存在 data/settings.json，界面右上角的设置面板修改。
 *
 * 大模型只允许清单里的两个（显式白名单）：
 *   - openai-codex/gpt-6.1-sol：Codex 订阅（默认）
 *   - deepseek/deepseek-flash：DeepSeek API，按量计费；key 从项目根目录 .env 的 DEEPSEEK_API_KEY 读
 * anthropic/* 不在清单里，一律拒绝（第三方 harness 用它走 API 按量计费）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PROJECT_ROOT } from "./sources.ts";

export interface ModelOption {
  id: string;
  label: string;
  billing: "订阅" | "按量计费";
  note: string;
  /** 需要的环境变量（从 .env 读）。 */
  keyEnv?: string;
}

export const MODEL_OPTIONS: ModelOption[] = [
  { id: "openai-codex/gpt-6.1-sol", label: "Codex · gpt-6.1-sol", billing: "订阅", note: "Codex 订阅，不额外花钱。需要先在 pi 里登录 Codex。" },
  {
    id: "deepseek/deepseek-flash", label: "DeepSeek · deepseek-flash", billing: "按量计费",
    note: "DeepSeek 官方 API，按 token 计费（预充值）。key 读项目 .env 的 DEEPSEEK_API_KEY。", keyEnv: "DEEPSEEK_API_KEY",
  },
];

export type DataSource = "polygon" | "yfinance";

export const DATA_OPTIONS: { id: DataSource; label: string; note: string }[] = [
  { id: "polygon", label: "Polygon / Massive", note: "付费 API，复权日线。失败或超出约 5 年历史时自动回退 yfinance，报告会写明。" },
  { id: "yfinance", label: "yfinance", note: "免费，非官方接口，偶尔不稳定。" },
];

export interface Settings {
  model: string;
  dataSource: DataSource;
}

export const DEFAULT_SETTINGS: Settings = { model: MODEL_OPTIONS[0].id, dataSource: "polygon" };

/** 设置里的数据源 → 脚本的 --source 参数。Polygon 允许回退，否则回放早年日期会失败。 */
export function sourceArg(s: DataSource): "auto" | "yfinance" {
  return s === "yfinance" ? "yfinance" : "auto";
}

const validModel = (m: unknown): m is string => MODEL_OPTIONS.some((o) => o.id === m);
const validSource = (s: unknown): s is DataSource => DATA_OPTIONS.some((o) => o.id === s);

export class SettingsStore {
  private current: Settings;
  private listeners = new Set<(s: Settings, prev: Settings) => void>();

  constructor(private file = resolve(PROJECT_ROOT, "data/settings.json")) {
    this.current = this.read();
  }

  private read(): Settings {
    if (!existsSync(this.file)) return { ...DEFAULT_SETTINGS };
    let raw: Partial<Settings> = {};
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
    // 手改成非法值的字段回到默认，合法字段保留
    return {
      model: validModel(raw.model) ? raw.model : DEFAULT_SETTINGS.model,
      dataSource: validSource(raw.dataSource) ? raw.dataSource : DEFAULT_SETTINGS.dataSource,
    };
  }

  get(): Settings {
    return { ...this.current };
  }

  /** 校验全部通过才写入；任何一个字段不合法就整体拒绝。 */
  update(patch: Partial<Settings>): Settings {
    if (patch.model !== undefined && !validModel(patch.model)) {
      throw new Error(`模型不在可选清单里：${patch.model}`);
    }
    if (patch.dataSource !== undefined && !validSource(patch.dataSource)) {
      throw new Error(`数据源不合法：${patch.dataSource}`);
    }
    const prev = this.current;
    this.current = { ...prev, ...patch };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.current, null, 2) + "\n");
    for (const cb of this.listeners) cb(this.get(), prev);
    return this.get();
  }

  onChange(cb: (s: Settings, prev: Settings) => void) {
    this.listeners.add(cb);
  }
}

/** 只从 .env 读模型要用的 key（不碰 Polygon 等其他 key，那些由 Python 脚本自己读）。已有的环境变量优先。 */
const MODEL_KEYS = [...new Set(MODEL_OPTIONS.map((o) => o.keyEnv).filter(Boolean))] as string[];

export function loadEnvKeys(
  file = resolve(PROJECT_ROOT, ".env"),
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (!existsSync(file)) return [];
  const loaded: string[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || !MODEL_KEYS.includes(m[1]) || env[m[1]]) continue;
    env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    loaded.push(m[1]);
  }
  return loaded;
}

/** 给界面看的：每个模型的 key 是否就绪（不返回 key 本身）。 */
export function modelReadiness(env: Record<string, string | undefined> = process.env) {
  return Object.fromEntries(MODEL_OPTIONS.map((o) => [o.id, !o.keyEnv || Boolean(env[o.keyEnv])]));
}

/**
 * 工作台设置：大模型、市场数据源。存在 data/settings.json，界面右上角的设置面板修改。
 *
 * 大模型只允许清单里的两个（显式白名单）：
 *   - openai-codex/gpt-6.1-sol：Codex 订阅（默认）
 *   - deepseek/deepseek-flash：DeepSeek API，按量计费；用 pi 里登录的 key，没登录时读项目根目录 .env 的 DEEPSEEK_API_KEY
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
  /** 也可以用的环境变量（从 .env 读）。Pi 里登录过就不需要。 */
  keyEnv?: string;
  /** 没有凭据时告诉用户怎么办。 */
  authHint: string;
}

export const MODEL_OPTIONS: ModelOption[] = [
  {
    id: "openai-codex/gpt-6.1-sol", label: "Codex · gpt-6.1-sol", billing: "订阅", note: "Codex 订阅，不额外花钱。需要先在 pi 里登录 Codex。",
    authHint: "没有 Codex 登录：先在终端运行 pi，在里面登录 Codex，再回来刷新。",
  },
  {
    id: "deepseek/deepseek-flash", label: "DeepSeek · deepseek-flash", billing: "按量计费",
    note: "DeepSeek 官方 API，按 token 计费（预充值）。用 pi 里登录的 key；没登录时读项目 .env 的 DEEPSEEK_API_KEY。两边都有时用 pi 的。",
    keyEnv: "DEEPSEEK_API_KEY",
    authHint: "没有 DeepSeek 凭据：在 pi 里登录 deepseek，或在项目 .env 里设 DEEPSEEK_API_KEY 后重启服务。",
  },
];

export type DataSource = "polygon" | "yfinance";

export const DATA_OPTIONS: { id: DataSource; label: string; note: string }[] = [
  { id: "polygon", label: "Polygon / Massive", note: "付费 API，复权日线。失败或超出约 5 年历史时自动回退 yfinance，报告会写明。" },
  { id: "yfinance", label: "yfinance", note: "免费，非官方接口，偶尔不稳定。" },
];

/** 微软 Edge 在线语音里的普通话声音，三男三女（方言声音不列）。 */
export const VOICE_OPTIONS: { id: string; label: string; gender: "男" | "女"; note: string }[] = [
  { id: "zh-CN-YunxiNeural", label: "云希", gender: "男", note: "年轻，阳光" },
  { id: "zh-CN-YunyangNeural", label: "云扬", gender: "男", note: "新闻播音，沉稳" },
  { id: "zh-CN-YunjianNeural", label: "云健", gender: "男", note: "激昂，体育解说" },
  { id: "zh-CN-XiaoxiaoNeural", label: "晓晓", gender: "女", note: "年轻，温暖" },
  { id: "zh-CN-XiaoyiNeural", label: "晓伊", gender: "女", note: "年轻，活泼" },
  { id: "zh-TW-HsiaoChenNeural", label: "晓臻", gender: "女", note: "台湾口音，亲切" },
];

export interface Settings {
  model: string;
  dataSource: DataSource;
  voiceAnalyst: string;
  voiceAdvisor: string;
  /** 回答结束后自动朗读。 */
  autoSpeak: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  model: MODEL_OPTIONS[0].id, dataSource: "polygon",
  voiceAnalyst: "zh-CN-YunxiNeural", voiceAdvisor: "zh-CN-XiaoxiaoNeural", autoSpeak: false,
};

/** 设置里的数据源 → 脚本的 --source 参数。Polygon 允许回退，否则回放早年日期会失败。 */
export function sourceArg(s: DataSource): "auto" | "yfinance" {
  return s === "yfinance" ? "yfinance" : "auto";
}

const validModel = (m: unknown): m is string => MODEL_OPTIONS.some((o) => o.id === m);
const validSource = (s: unknown): s is DataSource => DATA_OPTIONS.some((o) => o.id === s);
export const validVoice = (v: unknown): v is string => VOICE_OPTIONS.some((o) => o.id === v);

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
      voiceAnalyst: validVoice(raw.voiceAnalyst) ? raw.voiceAnalyst : DEFAULT_SETTINGS.voiceAnalyst,
      voiceAdvisor: validVoice(raw.voiceAdvisor) ? raw.voiceAdvisor : DEFAULT_SETTINGS.voiceAdvisor,
      autoSpeak: typeof raw.autoSpeak === "boolean" ? raw.autoSpeak : DEFAULT_SETTINGS.autoSpeak,
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
    for (const k of ["voiceAnalyst", "voiceAdvisor"] as const) {
      if (patch[k] !== undefined && !validVoice(patch[k])) throw new Error(`声音不在可选清单里：${patch[k]}`);
    }
    if (patch.autoSpeak !== undefined && typeof patch.autoSpeak !== "boolean") {
      throw new Error(`autoSpeak 应为 true 或 false：${patch.autoSpeak}`);
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

/** provider（如 "deepseek"）有没有可用凭据。实际由 Pi 判断：pi 里登录过，或环境变量里有 key（见 agents/model.ts 的 piHasAuth）。 */
export type HasAuth = (provider: string) => boolean;

/** 给界面看的：每个模型有没有可用凭据（不返回 key 本身）。 */
export function modelReadiness(hasAuth: HasAuth) {
  return Object.fromEntries(MODEL_OPTIONS.map((o) => [o.id, hasAuth(o.id.split("/")[0])]));
}

/**
 * 工作台设置：大模型和思考程度、市场数据源、语音。存在 data/settings.json，界面右上角的设置面板修改。
 *
 * 大模型从 pi 动态读（agents/catalog.ts）：在 pi 里登录过的 provider 的模型都能选。
 * 这里只校验格式；能不能用（登录了没有、在不在 Pi 的目录里）由清单判断。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_MODEL, isThinking, type Thinking } from "./agents/catalog.ts";
import { PROJECT_ROOT } from "./sources.ts";

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
  /** provider/model，如 openai-codex/gpt-6.1-sol。 */
  model: string;
  /** 想要的思考程度；模型不支持时实际用最近的一档（nearestThinking）。 */
  thinkingAnalyst: Thinking;
  thinkingAdvisor: Thinking;
  dataSource: DataSource;
  voiceAnalyst: string;
  voiceAdvisor: string;
  /** 回答结束后自动朗读。 */
  autoSpeak: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  model: DEFAULT_MODEL, thinkingAnalyst: "medium", thinkingAdvisor: "medium", dataSource: "polygon",
  voiceAnalyst: "zh-CN-YunxiNeural", voiceAdvisor: "zh-CN-XiaoxiaoNeural", autoSpeak: false,
};

/** 设置里的数据源 → 脚本的 --source 参数。Polygon 允许回退，否则回放早年日期会失败。 */
export function sourceArg(s: DataSource): "auto" | "yfinance" {
  return s === "yfinance" ? "yfinance" : "auto";
}

export const validModel = (m: unknown): m is string => typeof m === "string" && /^[^/\s]+\/\S+$/.test(m);
const validSource = (s: unknown): s is DataSource => DATA_OPTIONS.some((o) => o.id === s);
export const validVoice = (v: unknown): v is string => VOICE_OPTIONS.some((o) => o.id === v);

export class SettingsStore {
  private current: Settings;
  private listeners = new Set<(s: Settings, prev: Settings) => void>();

  /** initial：没写过的字段用它（如 pi 的默认模型），再没有用 DEFAULT_SETTINGS。 */
  constructor(private file = resolve(PROJECT_ROOT, "data/settings.json"), initial: Partial<Settings> = {}) {
    this.defaults = { ...DEFAULT_SETTINGS, ...initial };
    this.current = this.read();
  }
  private readonly defaults: Settings;

  private read(): Settings {
    const d = this.defaults;
    if (!existsSync(this.file)) return { ...d };
    let raw: Partial<Settings> = {};
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return { ...d };
    }
    // 手改成非法值的字段回到默认，合法字段保留
    return {
      model: validModel(raw.model) ? raw.model : d.model,
      thinkingAnalyst: isThinking(raw.thinkingAnalyst) ? raw.thinkingAnalyst : d.thinkingAnalyst,
      thinkingAdvisor: isThinking(raw.thinkingAdvisor) ? raw.thinkingAdvisor : d.thinkingAdvisor,
      dataSource: validSource(raw.dataSource) ? raw.dataSource : d.dataSource,
      voiceAnalyst: validVoice(raw.voiceAnalyst) ? raw.voiceAnalyst : d.voiceAnalyst,
      voiceAdvisor: validVoice(raw.voiceAdvisor) ? raw.voiceAdvisor : d.voiceAdvisor,
      autoSpeak: typeof raw.autoSpeak === "boolean" ? raw.autoSpeak : d.autoSpeak,
    };
  }

  get(): Settings {
    return { ...this.current };
  }

  /** 校验全部通过才写入；任何一个字段不合法就整体拒绝。 */
  update(patch: Partial<Settings>): Settings {
    if (patch.model !== undefined && !validModel(patch.model)) {
      throw new Error(`模型格式应为 provider/model：${patch.model}`);
    }
    for (const k of ["thinkingAnalyst", "thinkingAdvisor"] as const) {
      if (patch[k] !== undefined && !isThinking(patch[k])) throw new Error(`思考程度不合法：${patch[k]}`);
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

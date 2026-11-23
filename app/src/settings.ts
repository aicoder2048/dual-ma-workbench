/**
 * 工作台设置：大模型和思考程度、市场数据源、语音、仓位（账户规模和每笔可承受亏损）。存在 data/settings.json，界面右上角的设置面板修改。
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
  { id: "polygon", label: "Polygon / Massive", note: "付费 API，日线只按拆股复权。失败或超出约 5 年历史时自动回退 yfinance（同一口径），报告会写明。" },
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

/** 每笔可承受亏损按账户的比例（pct）还是固定金额（amount）。 */
export type RiskMode = "pct" | "amount";

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
  /** 账户规模（金额）；没填时交易计划只给每 1 万元风险对应多少股。 */
  account: number | null;
  riskMode: RiskMode;
  /** 每笔可承受亏损占账户的百分比，默认 1。 */
  riskPct: number;
  /** 每笔可承受亏损的固定金额（riskMode 是 amount 时用）。 */
  riskAmount: number | null;
}

export const DEFAULT_SETTINGS: Settings = {
  model: DEFAULT_MODEL, thinkingAnalyst: "medium", thinkingAdvisor: "medium", dataSource: "polygon",
  voiceAnalyst: "zh-CN-YunxiNeural", voiceAdvisor: "zh-CN-XiaoxiaoNeural", autoSpeak: false,
  account: null, riskMode: "pct", riskPct: 1, riskAmount: null,
};

/**
 * 设置里的仓位 → 脚本参数（交易计划的股数按它算）。按比例时没填账户也传比例：股数只给每 1 万元风险的，但仓位占账户的比例照样算得出（ADR 0039）；
 * 按金额时金额本身就够算股数（视频 F：最大亏损用金额），账户只用来封顶。
 */
export function sizingArgs(s: Pick<Settings, "account" | "riskMode" | "riskPct" | "riskAmount">): string[] {
  const account = s.account ? ["--account", String(s.account)] : [];
  if (s.riskMode === "amount" && s.riskAmount) return [...account, "--risk-amount", String(s.riskAmount)];
  return [...account, "--risk-pct", String(s.riskPct)];
}

/** 设置里的数据源 → 脚本的 --source 参数。Polygon 允许回退，否则回放早年日期会失败。 */
export function sourceArg(s: DataSource): "auto" | "yfinance" {
  return s === "yfinance" ? "yfinance" : "auto";
}

export const validModel = (m: unknown): m is string => typeof m === "string" && /^[^/\s]+\/\S+$/.test(m);
const validSource = (s: unknown): s is DataSource => DATA_OPTIONS.some((o) => o.id === s);
export const validVoice = (v: unknown): v is string => VOICE_OPTIONS.some((o) => o.id === v);
const positive = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;
/** 账户、固定金额：正数，或 null 表示不填。 */
const validMoney = (x: unknown): x is number | null => x === null || positive(x);
const validPct = (x: unknown): x is number => positive(x) && x <= 100;
const validMode = (x: unknown): x is RiskMode => x === "pct" || x === "amount";

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
      account: validMoney(raw.account) ? raw.account : d.account,
      riskMode: validMode(raw.riskMode) ? raw.riskMode : d.riskMode,
      riskPct: validPct(raw.riskPct) ? raw.riskPct : d.riskPct,
      riskAmount: validMoney(raw.riskAmount) ? raw.riskAmount : d.riskAmount,
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
    for (const k of ["account", "riskAmount"] as const) {
      if (patch[k] !== undefined && !validMoney(patch[k])) throw new Error(`${k === "account" ? "账户规模" : "每笔可承受亏损"}要是正数，或留空：${patch[k]}`);
    }
    if (patch.riskPct !== undefined && !validPct(patch.riskPct)) throw new Error(`每笔可承受亏损的比例要在 0 到 100 之间：${patch.riskPct}`);
    if (patch.riskMode !== undefined && !validMode(patch.riskMode)) throw new Error(`riskMode 应为 pct 或 amount：${patch.riskMode}`);
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

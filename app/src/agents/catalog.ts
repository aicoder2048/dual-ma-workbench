/**
 * 模型清单：从 Pi 动态读，用户在 pi 里登录了哪些 provider，这里就列哪些模型。
 *
 * - 凭据只认 pi 存的（~/.pi/agent/auth.json），不认环境变量：免得"shell 里 export 了 key 所以能用"这种看不见的来源。
 * - 计费按登录方式推断：oauth（订阅登录）→ 订阅；api_key → 按量计费；其他 → 未知。推断，不是保证。
 * - 验证过的两个模型（提示词、引用格式、工具调用实测过）排最前；其他标"未验证"。
 * - 不挡 anthropic，但它不会被当成默认（第三方 harness 里走 API 按量计费）。
 */
import { getAgentDir, ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];
export const isThinking = (v: unknown): v is Thinking => (THINKING_LEVELS as readonly unknown[]).includes(v);

export type Billing = "订阅" | "按量计费" | "未知";

export const DEFAULT_MODEL = "openai-codex/gpt-6.1-sol";
const VERIFIED = [DEFAULT_MODEL, "deepseek/deepseek-flash"];

export interface CatalogModel {
  id: string; // provider/model
  provider: string;
  name: string;
  billing: Billing;
  verified: boolean;
  /** 能看图（附件里的截图）。 */
  image: boolean;
  /** 支持的思考程度，按 THINKING_LEVELS 的顺序。 */
  thinking: Thinking[];
}

/** Pi 模型对象里用到的字段。 */
export interface PiModel { provider: string; id: string; name: string; input: readonly string[] }

export function billingOf(credentialType: string | undefined): Billing {
  return credentialType === "oauth" ? "订阅" : credentialType === "api_key" ? "按量计费" : "未知";
}

/** 想要的档位模型不支持时，取最近的一档；两边一样近取低的。模型不支持思考时是 off。 */
export function nearestThinking(want: Thinking, supported: readonly string[]): Thinking {
  const ok = THINKING_LEVELS.filter((l) => supported.includes(l));
  if (!ok.length) return "off";
  const at = (l: Thinking) => THINKING_LEVELS.indexOf(l);
  return ok.reduce((best, l) => (Math.abs(at(l) - at(want)) < Math.abs(at(best) - at(want)) ? l : best));
}

export function buildCatalog(
  models: readonly PiModel[],
  credentialType: (provider: string) => string | undefined,
  levels: (m: PiModel) => readonly string[],
): CatalogModel[] {
  const rank = (id: string) => (VERIFIED.includes(id) ? VERIFIED.indexOf(id) : VERIFIED.length);
  return models
    .filter((m) => credentialType(m.provider) !== undefined)
    .map((m) => {
      const id = `${m.provider}/${m.id}`;
      return {
        id, provider: m.provider, name: m.name,
        billing: billingOf(credentialType(m.provider)),
        verified: VERIFIED.includes(id),
        image: m.input.includes("image"),
        thinking: THINKING_LEVELS.filter((l) => levels(m).includes(l)),
      };
    })
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

/** 没设置过模型时的初始值：pi 的默认模型（能用、不是 anthropic），否则 Codex。 */
export function initialModel(list: readonly CatalogModel[], piDefault: string | undefined): string {
  const m = list.find((x) => x.id === piDefault);
  return m && m.provider !== "anthropic" ? m.id : DEFAULT_MODEL;
}

export function piCredentialType(provider: string, authPath?: string): string | undefined {
  return readStoredCredential(provider, authPath)?.type;
}

/** pi 里设的默认模型（~/.pi/agent/settings.json），读不到就是 undefined。 */
export function piDefaultModel(agentDir = getAgentDir()): string | undefined {
  try {
    const s = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    return typeof s.defaultProvider === "string" && typeof s.defaultModel === "string"
      ? `${s.defaultProvider}/${s.defaultModel}` : undefined;
  } catch {
    return undefined;
  }
}

export interface ModelCatalog {
  list(): Promise<CatalogModel[]>;
}

/** 真实清单：模型目录建一次；登录状态每次现查（在 pi 里刚登录完，刷新页面就生效）。 */
export function piCatalog(authPath?: string): ModelCatalog {
  let runtime: Promise<ModelRuntime> | null = null;
  return {
    async list() {
      runtime ??= ModelRuntime.create();
      const rt = await runtime;
      return buildCatalog(rt.getModels(), (p) => piCredentialType(p, authPath),
        (m) => getSupportedThinkingLevels(m as Parameters<typeof getSupportedThinkingLevels>[0]));
    },
  };
}

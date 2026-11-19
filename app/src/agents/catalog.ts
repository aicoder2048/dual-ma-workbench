/**
 * 模型清单：从 Pi 动态读，用户在 pi 里登录了哪些 provider，这里就列哪些模型。
 *
 * - 凭据只认 pi 存的（~/.pi/agent/auth.json），不认环境变量：免得"shell 里 export 了 key 所以能用"这种看不见的来源。
 * - 计费：Pi 标明是订阅的 OAuth 登录（auth.oauth.isSubscription）→ 订阅；api_key → 按量计费；anthropic 一律按量计费
 *   （在 Pi 里走 API 计费，Claude Pro 登录也一样）；其他 → 未知。推断，不是保证；不是订阅的切换前都要确认。
 * - 模型按 provider 自己的规则过滤（如 Copilot 只列套餐里有的）。
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

/** 一个登录过的 provider：登录方式、OAuth 是不是订阅、按凭据过滤模型。 */
export interface ProviderInfo {
  credentialType: string;
  isSubscription?: boolean;
  filter?: <M extends PiModel>(models: M[]) => readonly M[];
}

export function billingOf(provider: string, info: ProviderInfo): Billing {
  if (provider === "anthropic" || info.credentialType === "api_key") return "按量计费";
  return info.credentialType === "oauth" && info.isSubscription === true ? "订阅" : "未知";
}

/** 想要的档位模型不支持时，取最近的一档；两边一样近取低的。模型不支持思考时是 off。 */
export function nearestThinking(want: Thinking, supported: readonly string[]): Thinking {
  const ok = THINKING_LEVELS.filter((l) => supported.includes(l));
  if (!ok.length) return "off";
  const at = (l: Thinking) => THINKING_LEVELS.indexOf(l);
  return ok.reduce((best, l) => (Math.abs(at(l) - at(want)) < Math.abs(at(best) - at(want)) ? l : best));
}

/** providerInfo 返回 undefined 表示没在 pi 里登录：它的模型不列。 */
export function buildCatalog<M extends PiModel>(
  models: readonly M[],
  providerInfo: (provider: string) => ProviderInfo | undefined,
  levels: (m: M) => readonly string[],
): CatalogModel[] {
  const rank = (id: string) => (VERIFIED.includes(id) ? VERIFIED.indexOf(id) : VERIFIED.length);
  const providers = [...new Set(models.map((m) => m.provider))];
  return providers
    .flatMap((p) => {
      const info = providerInfo(p);
      if (!info) return [];
      const own = models.filter((m) => m.provider === p);
      return (info.filter ? info.filter(own) : own).map((m) => ({ m, info }));
    })
    .map(({ m, info }) => {
      const id = `${m.provider}/${m.id}`;
      return {
        id, provider: m.provider, name: m.name,
        billing: billingOf(m.provider, info),
        verified: VERIFIED.includes(id),
        image: m.input.includes("image"),
        thinking: THINKING_LEVELS.filter((l) => levels(m).includes(l)),
      };
    })
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

/** 没设置过模型时的初始值：pi 的默认模型（能用、而且是订阅），否则 Codex。按量计费的不悄悄用。 */
export function initialModel(list: readonly CatalogModel[], piDefault: string | undefined): string {
  const m = list.find((x) => x.id === piDefault);
  return m && m.billing === "订阅" ? m.id : DEFAULT_MODEL;
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

/**
 * 真实清单：模型目录在启动时建一次（pi 里更新了模型目录，要重启工作台）；
 * 登录状态每次现查（在 pi 里刚登录完，刷新页面就生效）。
 */
export function piCatalog(authPath?: string): ModelCatalog {
  let runtime: Promise<ModelRuntime> | null = null;
  return {
    async list() {
      runtime ??= ModelRuntime.create().catch((err) => { runtime = null; throw err; }); // 失败了下次重试
      const rt = await runtime;
      return buildCatalog(rt.getModels(), (id) => {
        const credential = readStoredCredential(id, authPath);
        if (!credential) return undefined;
        const p = rt.getProvider(id);
        return {
          credentialType: credential.type,
          isSubscription: p?.auth.oauth?.isSubscription,
          filter: p?.filterModels ? (ms) => p.filterModels!(ms as any, credential) as any : undefined,
        };
      }, (m) => getSupportedThinkingLevels(m));
    },
  };
}

/**
 * 模型选择：只允许设置清单（settings.ts 的 MODEL_OPTIONS）里的模型。
 *
 * 用户规则（~/.claude/CLAUDE.md）：第三方 harness 里不能用 anthropic/*（走 API 按量计费）。
 * 清单是显式白名单：Codex 订阅（默认）+ DeepSeek flash（按量计费，用户主动选择）。
 *
 * 环境变量：DMA_THINKING = off | low | medium | high，默认按角色（分析师 medium，鸿雁 low）。
 */
import { readStoredCredential, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { MODEL_OPTIONS } from "../settings.ts";

const THINKING = ["off", "low", "medium", "high"] as const;
export type Thinking = (typeof THINKING)[number];

export function parseModelSpec(spec: string): { provider: string; id: string } {
  const i = spec.indexOf("/");
  if (i <= 0 || i === spec.length - 1) throw new Error(`模型格式应为 provider/model-id：${spec}`);
  return { provider: spec.slice(0, i), id: spec.slice(i + 1) };
}

/** 不在清单里就抛错。anthropic/* 单独说明原因。 */
export function assertAllowedModel(spec: string): void {
  if (MODEL_OPTIONS.some((o) => o.id === spec)) return;
  const { provider } = parseModelSpec(spec);
  if (provider === "anthropic") {
    throw new Error(`拒绝使用 ${spec}：第三方 harness 用 Anthropic 模型会走 API 按量计费。`);
  }
  throw new Error(`模型 ${spec} 不在可选清单里（${MODEL_OPTIONS.map((o) => o.id).join("、")}）。`);
}

export function resolveThinking(raw: string | undefined, fallback: Thinking): Thinking {
  if (!raw) return fallback;
  if (!(THINKING as readonly string[]).includes(raw)) throw new Error(`DMA_THINKING 只能是 ${THINKING.join(" / ")}`);
  return raw as Thinking;
}

export function resolveModel(runtime: ModelRuntime, spec: string) {
  assertAllowedModel(spec);
  const { provider, id } = parseModelSpec(spec);
  const model = runtime.getModel(provider, id);
  if (!model) {
    const ids = runtime.getModels().filter((m) => m.provider === provider).map((m) => m.id);
    throw new Error(`找不到模型 ${spec}。可用的 ${provider} 模型：${ids.join(", ") || "无"}`);
  }
  return model;
}

/**
 * 在 pi 里登录过的 provider：只看 pi 存的凭据（~/.pi/agent/auth.json），不认环境变量，
 * 免得"shell 里 export 了 key 所以能用"这种看不见的来源让人困惑。每次现查，在 pi 里刚登录完刷新就生效。
 * 调用模型时 Pi 也优先用 auth.json 里的 key（实测），所以"能不能用"和"实际用哪个"一致。
 */
export async function piAuthedProviders(authPath?: string): Promise<Set<string>> {
  const providers = new Set(MODEL_OPTIONS.map((o) => parseModelSpec(o.id).provider));
  return new Set([...providers].filter((p) => readStoredCredential(p, authPath) !== undefined));
}

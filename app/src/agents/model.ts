/**
 * 模型选择：只允许 openai-codex（Codex 订阅）。
 *
 * 用户规则（~/.claude/CLAUDE.md）：第三方 harness 里不能用 anthropic/*（走 API 按量计费）；
 * 自动化运行首选 openai-codex 订阅。这里在代码层面兜底：配置成别的 provider 直接拒绝启动。
 *
 * 环境变量：
 *   DMA_MODEL      openai-codex/<model-id>，默认 openai-codex/gpt-6.1-sol
 *   DMA_THINKING   off | low | medium | high，默认按角色（分析师 medium，参谋 low）
 */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const ALLOWED_PROVIDER = "openai-codex";
export const DEFAULT_MODEL = `${ALLOWED_PROVIDER}/gpt-6.1-sol`;
const THINKING = ["off", "low", "medium", "high"] as const;
export type Thinking = (typeof THINKING)[number];

export function parseModelSpec(spec: string): { provider: string; id: string } {
  const i = spec.indexOf("/");
  if (i <= 0 || i === spec.length - 1) throw new Error(`模型格式应为 provider/model-id：${spec}`);
  return { provider: spec.slice(0, i), id: spec.slice(i + 1) };
}

/** 不是订阅 provider 就抛错。 */
export function assertSubscriptionProvider(provider: string): void {
  if (provider !== ALLOWED_PROVIDER) {
    throw new Error(
      `拒绝使用 provider "${provider}"：工作台只允许 ${ALLOWED_PROVIDER}（Codex 订阅），避免走按量计费。` +
        `请把 DMA_MODEL 设成 ${ALLOWED_PROVIDER}/<model-id>。`,
    );
  }
}

export function resolveThinking(raw: string | undefined, fallback: Thinking): Thinking {
  if (!raw) return fallback;
  if (!(THINKING as readonly string[]).includes(raw)) throw new Error(`DMA_THINKING 只能是 ${THINKING.join(" / ")}`);
  return raw as Thinking;
}

export function resolveModel(runtime: ModelRuntime, spec = process.env.DMA_MODEL ?? DEFAULT_MODEL) {
  const { provider, id } = parseModelSpec(spec);
  assertSubscriptionProvider(provider);
  const model = runtime.getModel(provider, id);
  if (!model) {
    const ids = runtime.getModels().filter((m) => m.provider === provider).map((m) => m.id);
    throw new Error(`找不到模型 ${spec}。可用的 ${provider} 模型：${ids.join(", ") || "无（先在 pi 里登录 Codex）"}`);
  }
  return model;
}

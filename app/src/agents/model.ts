/**
 * 模型选择：只允许设置清单（settings.ts 的 MODEL_OPTIONS）里的模型。
 *
 * 用户规则（~/.claude/CLAUDE.md）：第三方 harness 里不能用 anthropic/*（走 API 按量计费）。
 * 清单是显式白名单：Codex 订阅（默认）+ DeepSeek flash（按量计费，用户主动选择）。
 *
 * 环境变量：DMA_THINKING = off | low | medium | high，默认按角色（分析师 medium，鸿雁 low）。
 */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
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

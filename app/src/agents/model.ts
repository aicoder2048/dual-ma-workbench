/**
 * 模型：按设置里的 provider/model 从 Pi 的目录里找；思考程度按模型支持的档位取最近的一档。
 * 可选清单见 catalog.ts（在 pi 里登录过的 provider 的模型）。
 */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { nearestThinking, type Thinking } from "./catalog.ts";

export function parseModelSpec(spec: string): { provider: string; id: string } {
  const i = spec.indexOf("/");
  if (i <= 0 || i === spec.length - 1) throw new Error(`模型格式应为 provider/model-id：${spec}`);
  return { provider: spec.slice(0, i), id: spec.slice(i + 1) };
}

export function resolveModel(runtime: ModelRuntime, spec: string) {
  const { provider, id } = parseModelSpec(spec);
  const model = runtime.getModel(provider, id);
  if (!model) {
    throw new Error(`找不到模型 ${spec}：Pi 的模型目录里没有它。在终端运行 pi，用 /model 看看可用的模型，再到设置里重选。`);
  }
  return model;
}

type PiModel = ReturnType<typeof resolveModel>;

/** 这个模型实际用的思考程度：支持就照用，不支持取最近的一档（两边一样近取低的）。 */
export function thinkingFor(model: PiModel, want: Thinking): Thinking {
  return nearestThinking(want, getSupportedThinkingLevels(model as Parameters<typeof getSupportedThinkingLevels>[0]));
}

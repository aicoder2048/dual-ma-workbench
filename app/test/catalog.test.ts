import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { billingOf, buildCatalog, DEFAULT_MODEL, initialModel, nearestThinking, piCatalog, type PiModel, type ProviderInfo } from "../src/agents/catalog.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "dma-cat-"));

const LEVELS: Record<string, string[]> = {
  "openai-codex/gpt-6.1-sol": ["minimal", "low", "medium", "high", "xhigh", "max"],
  "deepseek/deepseek-flash": ["off", "low", "high", "max"],
};
const pm = (provider: string, id: string, input = ["text", "image"]): PiModel => ({ provider, id, name: id, input });
const MODELS = [
  pm("anthropic", "claude-opus-5-5"),
  pm("deepseek", "deepseek-v4-pro", ["text"]),
  pm("deepseek", "deepseek-flash"),
  pm("openai-codex", "gpt-6.1-sol"),
  pm("openrouter", "some-model"),
  pm("github-copilot", "gpt-a"),
  pm("github-copilot", "gpt-b"),
  pm("xai", "grok-x"),
];
/** 模拟 Pi 的 provider：登录方式、OAuth 是不是订阅、按凭据过滤模型。 */
const PROVIDERS: Record<string, ProviderInfo> = {
  "openai-codex": { credentialType: "oauth", isSubscription: true },
  deepseek: { credentialType: "api_key" },
  anthropic: { credentialType: "oauth", isSubscription: true }, // Claude Pro 登录：在 Pi 里仍走 API 计费
  openrouter: { credentialType: "oauth" }, // OAuth 但按 credits 扣费
  "github-copilot": { credentialType: "oauth", isSubscription: true, filter: (ms) => ms.filter((m) => m.id === "gpt-a") },
};
const catalog = () => buildCatalog(MODELS, (p) => PROVIDERS[p], (m) => LEVELS[`${m.provider}/${m.id}`] ?? ["off"]);

describe("模型清单：从 Pi 动态读", () => {
  test("只列在 pi 里登录过的 provider 的模型", () => {
    expect(catalog().map((m) => m.provider)).not.toContain("xai");
    expect(catalog().map((m) => m.id)).toContain("anthropic/claude-opus-5-5");
  });
  test("provider 按凭据过滤模型（Copilot 只列套餐里有的）", () => {
    expect(catalog().filter((m) => m.provider === "github-copilot").map((m) => m.id)).toEqual(["github-copilot/gpt-a"]);
  });
  test("计费：只有 Pi 标明是订阅的 OAuth 才算订阅；api_key 按量；anthropic 一律按量；其他未知", () => {
    expect(billingOf("openai-codex", { credentialType: "oauth", isSubscription: true })).toBe("订阅");
    expect(billingOf("deepseek", { credentialType: "api_key" })).toBe("按量计费");
    expect(billingOf("anthropic", { credentialType: "oauth", isSubscription: true })).toBe("按量计费");
    expect(billingOf("openrouter", { credentialType: "oauth" })).toBe("未知");
    expect(billingOf("x", { credentialType: "aws" })).toBe("未知");
    const by = Object.fromEntries(catalog().map((m) => [m.id, m.billing]));
    expect(by["openai-codex/gpt-6.1-sol"]).toBe("订阅");
    expect(by["deepseek/deepseek-flash"]).toBe("按量计费");
    expect(by["anthropic/claude-opus-5-5"]).toBe("按量计费");
    expect(by["openrouter/some-model"]).toBe("未知");
  });
  test("验证过的两个排最前并标出；能不能看图、支持哪些思考程度都带上", () => {
    const list = catalog();
    expect(list.slice(0, 2).map((m) => m.id)).toEqual(["openai-codex/gpt-6.1-sol", "deepseek/deepseek-flash"]);
    expect(list.filter((m) => m.verified).length).toBe(2);
    expect(list.find((m) => m.id === "deepseek/deepseek-v4-pro")!.image).toBe(false);
    expect(list.find((m) => m.id === "deepseek/deepseek-flash")!.thinking).toEqual(["off", "low", "high", "max"]);
  });
});

describe("思考程度不支持时取最近的一档", () => {
  test("支持就照用", () => {
    expect(nearestThinking("medium", LEVELS["openai-codex/gpt-6.1-sol"])).toBe("medium");
  });
  test("deepseek-flash 没有 medium：两边一样近，取低的 low", () => {
    expect(nearestThinking("medium", LEVELS["deepseek/deepseek-flash"])).toBe("low");
  });
  test("codex 没有 off：用 minimal", () => {
    expect(nearestThinking("off", LEVELS["openai-codex/gpt-6.1-sol"])).toBe("minimal");
  });
  test("模型不支持思考：off", () => {
    expect(nearestThinking("high", [])).toBe("off");
  });
});

describe("没设置过模型时的初始值", () => {
  test("pi 的默认模型能用、是订阅：用它", () => {
    expect(initialModel(catalog(), "github-copilot/gpt-a")).toBe("github-copilot/gpt-a");
  });
  test("pi 默认是按量计费或计费未知：不悄悄用它，用 Codex", () => {
    expect(initialModel(catalog(), "deepseek/deepseek-flash")).toBe(DEFAULT_MODEL);
    expect(initialModel(catalog(), "openrouter/some-model")).toBe(DEFAULT_MODEL);
  });
  test("pi 默认是 anthropic：不当默认，用 Codex", () => {
    expect(initialModel(catalog(), "anthropic/claude-opus-5-5")).toBe(DEFAULT_MODEL);
  });
  test("pi 默认不在清单里（没登录）或没有：用 Codex", () => {
    expect(initialModel(catalog(), "xai/grok-x")).toBe(DEFAULT_MODEL);
    expect(initialModel(catalog(), undefined)).toBe(DEFAULT_MODEL);
  });
});

describe("真实的 Pi 模型目录 + 临时 auth.json（不调用模型）", () => {
  test("只认 auth.json 里的登录，环境变量里的 key 不算；codex 订阅、deepseek 按量", async () => {
    const auth = join(tmp(), "auth.json");
    const before = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "sk-from-shell";
    try {
      writeFileSync(auth, JSON.stringify({ "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 0 } }));
      let list = await piCatalog(auth).list();
      expect(list.some((m) => m.provider === "deepseek")).toBe(false);
      expect(list.find((m) => m.id === "openai-codex/gpt-6.1-sol")?.billing).toBe("订阅");
      writeFileSync(auth, JSON.stringify({ deepseek: { type: "api_key", key: "sk-x" } }));
      list = await piCatalog(auth).list();
      expect(list.find((m) => m.id === "deepseek/deepseek-flash")?.billing).toBe("按量计费");
      expect(list.some((m) => m.provider === "openai-codex")).toBe(false);
    } finally {
      if (before === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = before;
    }
  });
  test("Claude Pro 登录（oauth）的 anthropic 照样标按量计费", async () => {
    const auth = join(tmp(), "auth.json");
    writeFileSync(auth, JSON.stringify({ anthropic: { type: "oauth", access: "a", refresh: "r", expires: 0 } }));
    const list = await piCatalog(auth).list();
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((m) => m.billing === "按量计费")).toBe(true);
  });
});

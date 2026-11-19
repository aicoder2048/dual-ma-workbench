import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { billingOf, buildCatalog, DEFAULT_MODEL, initialModel, nearestThinking, piCredentialType, type PiModel } from "../src/agents/catalog.ts";

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
];
const CREDS: Record<string, string> = { "openai-codex": "oauth", deepseek: "api_key", anthropic: "api_key" };
const catalog = () => buildCatalog(MODELS, (p) => CREDS[p], (m) => LEVELS[`${m.provider}/${m.id}`] ?? ["off"]);

describe("模型清单：从 Pi 动态读", () => {
  test("只列在 pi 里登录过的 provider 的模型", () => {
    expect(catalog().map((m) => m.provider)).not.toContain("openrouter");
    expect(catalog().map((m) => m.id)).toContain("anthropic/claude-opus-5-5");
  });
  test("计费按登录方式推断：oauth 订阅，api_key 按量计费，其他未知", () => {
    expect(billingOf("oauth")).toBe("订阅");
    expect(billingOf("api_key")).toBe("按量计费");
    expect(billingOf("something")).toBe("未知");
    const by = Object.fromEntries(catalog().map((m) => [m.id, m.billing]));
    expect(by["openai-codex/gpt-6.1-sol"]).toBe("订阅");
    expect(by["deepseek/deepseek-flash"]).toBe("按量计费");
    expect(by["anthropic/claude-opus-5-5"]).toBe("按量计费");
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
  test("pi 的默认模型能用、不是 anthropic：用它", () => {
    expect(initialModel(catalog(), "deepseek/deepseek-flash")).toBe("deepseek/deepseek-flash");
  });
  test("pi 默认是 anthropic：不当默认，用 Codex", () => {
    expect(initialModel(catalog(), "anthropic/claude-opus-5-5")).toBe(DEFAULT_MODEL);
  });
  test("pi 默认不在清单里（没登录）或没有：用 Codex", () => {
    expect(initialModel(catalog(), "openrouter/some-model")).toBe(DEFAULT_MODEL);
    expect(initialModel(catalog(), undefined)).toBe(DEFAULT_MODEL);
  });
});

describe("凭据只认 pi 里的登录", () => {
  test("auth.json 里有才算；只设环境变量不算；没有文件不报错", () => {
    const auth = join(tmp(), "auth.json");
    expect(piCredentialType("deepseek", auth)).toBeUndefined();
    const before = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "sk-from-shell";
    try {
      writeFileSync(auth, JSON.stringify({ "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 0 } }));
      expect(piCredentialType("deepseek", auth)).toBeUndefined();
      expect(piCredentialType("openai-codex", auth)).toBe("oauth");
      writeFileSync(auth, JSON.stringify({ deepseek: { type: "api_key", key: "sk-x" } }));
      expect(piCredentialType("deepseek", auth)).toBe("api_key");
    } finally {
      if (before === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = before;
    }
  });
});

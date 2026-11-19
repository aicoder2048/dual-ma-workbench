import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Analyzer } from "../src/analyze.ts";
import { assertAllowedModel } from "../src/agents/model.ts";
import { DEFAULT_SETTINGS, loadEnvKeys, MODEL_OPTIONS, SettingsStore, sourceArg, VOICE_OPTIONS } from "../src/settings.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "dma-set-"));

describe("模型白名单", () => {
  test("只允许设置里列出的两个模型", () => {
    expect(() => assertAllowedModel("openai-codex/gpt-6.1-sol")).not.toThrow();
    expect(() => assertAllowedModel("deepseek/deepseek-flash")).not.toThrow();
  });
  test("anthropic 和清单外的模型一律拒绝", () => {
    expect(() => assertAllowedModel("anthropic/claude-opus-5-5")).toThrow(/按量计费|不在/);
    expect(() => assertAllowedModel("deepseek/deepseek-v4-pro")).toThrow();
  });
  test("DeepSeek 选项标明按量计费", () => {
    expect(MODEL_OPTIONS.find((m) => m.id === "deepseek/deepseek-flash")?.billing).toBe("按量计费");
  });
});

describe("SettingsStore", () => {
  test("没有文件时用默认值", () => {
    expect(new SettingsStore(join(tmp(), "s.json")).get()).toEqual(DEFAULT_SETTINGS);
  });
  test("保存后能读回，且只合并合法字段", () => {
    const file = join(tmp(), "s.json");
    const s = new SettingsStore(file);
    s.update({ model: "deepseek/deepseek-flash" });
    expect(new SettingsStore(file).get()).toEqual({ ...DEFAULT_SETTINGS, model: "deepseek/deepseek-flash" });
    expect(JSON.parse(readFileSync(file, "utf8")).model).toBe("deepseek/deepseek-flash");
  });
  test("非法值拒绝，不改文件", () => {
    const s = new SettingsStore(join(tmp(), "s.json"));
    expect(() => s.update({ model: "anthropic/claude-opus-5-5" } as any)).toThrow();
    expect(() => s.update({ dataSource: "bloomberg" } as any)).toThrow();
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
  });
  test("文件被手改成非法值时回到默认值", () => {
    const file = join(tmp(), "s.json");
    writeFileSync(file, JSON.stringify({ model: "anthropic/x", dataSource: "yfinance" }));
    expect(new SettingsStore(file).get()).toEqual({ ...DEFAULT_SETTINGS, dataSource: "yfinance" });
  });
});

describe("数据源", () => {
  test("Polygon 选项允许回退 yfinance（回放 5 年以前要用）", () => {
    expect(sourceArg("polygon")).toBe("auto");
    expect(sourceArg("yfinance")).toBe("yfinance");
  });
  test("Analyzer 把数据源传给脚本，缓存按数据源区分", async () => {
    const calls: string[][] = [];
    let src: "polygon" | "yfinance" = "polygon";
    const fixture = JSON.stringify({ analysis: { label: "NVDA" }, chart: {} });
    const a = new Analyzer(async (args) => (calls.push(args), fixture), Date.now, () => src);
    await a.analyze("NVDA");
    await a.analyze("NVDA");
    src = "yfinance";
    await a.analyze("NVDA");
    expect(calls).toEqual([
      ["NVDA", "--json", "--source", "auto"],
      ["NVDA", "--json", "--source", "yfinance"],
    ]);
  });
});

describe(".env 里的模型 key", () => {
  test("读 DEEPSEEK_API_KEY；已有环境变量不覆盖；不碰其他 key", () => {
    const dir = tmp();
    writeFileSync(join(dir, ".env"), "POLYGON_API_KEY=p\nDEEPSEEK_API_KEY=\"sk-test\"\n# 注释\n");
    const env: Record<string, string | undefined> = {};
    expect(loadEnvKeys(join(dir, ".env"), env)).toEqual(["DEEPSEEK_API_KEY"]);
    expect(env.DEEPSEEK_API_KEY).toBe("sk-test");
    expect(env.POLYGON_API_KEY).toBeUndefined();
    const env2: Record<string, string | undefined> = { DEEPSEEK_API_KEY: "from-shell" };
    loadEnvKeys(join(dir, ".env"), env2);
    expect(env2.DEEPSEEK_API_KEY).toBe("from-shell");
  });
  test("没有 .env 文件不报错", () => expect(loadEnvKeys(join(tmp(), ".env"), {})).toEqual([]));
});

describe("语音设置", () => {
  test("默认：分析师年轻男声云希，参谋年轻女声晓晓，不自动朗读", () => {
    expect(DEFAULT_SETTINGS.voiceAnalyst).toBe("zh-CN-YunxiNeural");
    expect(DEFAULT_SETTINGS.voiceAdvisor).toBe("zh-CN-XiaoxiaoNeural");
    expect(DEFAULT_SETTINGS.autoSpeak).toBe(false);
  });
  test("三男三女", () => {
    expect(VOICE_OPTIONS.filter((v) => v.gender === "男").length).toBe(3);
    expect(VOICE_OPTIONS.filter((v) => v.gender === "女").length).toBe(3);
  });
  test("清单外的声音拒绝", () => {
    const s = new SettingsStore(join(tmp(), "s.json"));
    expect(() => s.update({ voiceAnalyst: "en-US-GuyNeural" } as any)).toThrow();
    expect(() => s.update({ autoSpeak: "yes" } as any)).toThrow();
    s.update({ voiceAdvisor: "zh-CN-XiaoyiNeural", autoSpeak: true });
    expect(s.get().voiceAdvisor).toBe("zh-CN-XiaoyiNeural");
  });
});

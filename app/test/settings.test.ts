import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Analyzer } from "../src/analyze.ts";
import { DEFAULT_SETTINGS, SettingsStore, sourceArg, VOICE_OPTIONS } from "../src/settings.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "dma-set-"));

describe("模型和思考程度", () => {
  test("默认 Codex；长风、鸿雁的思考程度都是 medium", () => {
    expect(DEFAULT_SETTINGS.model).toBe("openai-codex/gpt-6.1-sol");
    expect(DEFAULT_SETTINGS.thinkingAnalyst).toBe("medium");
    expect(DEFAULT_SETTINGS.thinkingAdvisor).toBe("medium");
  });
  test("模型只校验格式（能不能用由清单判断）；anthropic 也能存", () => {
    const s = new SettingsStore(join(tmp(), "s.json"));
    s.update({ model: "anthropic/claude-opus-5-5" });
    expect(s.get().model).toBe("anthropic/claude-opus-5-5");
    expect(() => s.update({ model: "no-slash" })).toThrow();
    expect(() => s.update({ model: "a/" })).toThrow();
  });
  test("思考程度只认 Pi 的七档", () => {
    const s = new SettingsStore(join(tmp(), "s.json"));
    s.update({ thinkingAnalyst: "high", thinkingAdvisor: "off" });
    expect(s.get()).toMatchObject({ thinkingAnalyst: "high", thinkingAdvisor: "off" });
    expect(() => s.update({ thinkingAnalyst: "extreme" } as any)).toThrow();
  });
  test("没设置过模型时用传进来的初始值（pi 的默认）；文件里有就用文件的", () => {
    const file = join(tmp(), "s.json");
    expect(new SettingsStore(file, { model: "deepseek/deepseek-flash" }).get().model).toBe("deepseek/deepseek-flash");
    writeFileSync(file, JSON.stringify({ model: "openai-codex/gpt-6.1-sol" }));
    expect(new SettingsStore(file, { model: "deepseek/deepseek-flash" }).get().model).toBe("openai-codex/gpt-6.1-sol");
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
    expect(() => s.update({ model: "bad" } as any)).toThrow();
    expect(() => s.update({ dataSource: "bloomberg" } as any)).toThrow();
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
  });
  test("文件被手改成非法值时回到默认值", () => {
    const file = join(tmp(), "s.json");
    writeFileSync(file, JSON.stringify({ model: "bad", thinkingAnalyst: "extreme", dataSource: "yfinance" }));
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

describe("语音设置", () => {
  test("默认：长风年轻男声云希，鸿雁年轻女声晓晓，不自动朗读", () => {
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

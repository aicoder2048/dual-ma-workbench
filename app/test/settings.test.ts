import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Analyzer } from "../src/analyze.ts";
import { DEFAULT_SETTINGS, SettingsStore, sizingArgs, sourceArg, VOICE_OPTIONS } from "../src/settings.ts";

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

describe("仓位设置：账户规模和每笔可承受亏损", () => {
  test("默认：没填账户，按账户的 1%", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ account: null, riskMode: "pct", riskPct: 1, riskAmount: null });
  });
  test("按比例：填了账户才传给脚本；没填就什么都不传（脚本只给每 1 万元风险的股数）", () => {
    expect(sizingArgs(DEFAULT_SETTINGS)).toEqual([]);
    expect(sizingArgs({ ...DEFAULT_SETTINGS, account: 50000 })).toEqual(["--account", "50000", "--risk-pct", "1"]);
    expect(sizingArgs({ ...DEFAULT_SETTINGS, account: 50000, riskPct: 0.5 })).toEqual(["--account", "50000", "--risk-pct", "0.5"]);
  });
  test("按固定金额：金额本身就够算股数，填了账户再用来封顶", () => {
    expect(sizingArgs({ ...DEFAULT_SETTINGS, riskMode: "amount", riskAmount: 400 })).toEqual(["--risk-amount", "400"]);
    expect(sizingArgs({ ...DEFAULT_SETTINGS, riskMode: "amount", riskAmount: 400, account: 50000 }))
      .toEqual(["--account", "50000", "--risk-amount", "400"]);
    // 选了金额却没填：退回按比例
    expect(sizingArgs({ ...DEFAULT_SETTINGS, riskMode: "amount", account: 50000 })).toEqual(["--account", "50000", "--risk-pct", "1"]);
  });
  test("非法值整体拒绝；null 是清空", () => {
    const s = new SettingsStore(join(tmp(), "s.json"));
    for (const bad of [{ account: -1 }, { account: 0 }, { account: Number.NaN }, { account: "5万" }, { riskPct: 0 }, { riskPct: 101 },
      { riskAmount: -5 }, { riskMode: "kelly" }]) {
      expect(() => s.update(bad as any)).toThrow();
    }
    s.update({ account: 80000, riskMode: "amount", riskAmount: 500 });
    expect(s.get()).toMatchObject({ account: 80000, riskMode: "amount", riskAmount: 500 });
    s.update({ account: null });
    expect(s.get().account).toBeNull();
  });
  test("文件里手改成非法的仓位字段回到默认", () => {
    const file = join(tmp(), "s.json");
    writeFileSync(file, JSON.stringify({ account: -3, riskPct: 500, riskMode: "x", riskAmount: 200 }));
    expect(new SettingsStore(file).get()).toMatchObject({ account: null, riskPct: 1, riskMode: "pct", riskAmount: 200 });
  });
  test("Analyzer 把仓位参数传给脚本，改了仓位按新参数重新算", async () => {
    const calls: string[][] = [];
    let args: string[] = [];
    const fixture = JSON.stringify({ analysis: { label: "NVDA" }, chart: {} });
    const a = new Analyzer(async (x) => (calls.push(x), fixture), Date.now, () => "polygon", () => args);
    await a.analyze("NVDA");
    args = ["--account", "50000", "--risk-pct", "1"];
    await a.analyze("NVDA");
    await a.analyze("NVDA");
    expect(calls).toEqual([
      ["NVDA", "--json", "--source", "auto"],
      ["NVDA", "--json", "--source", "auto", "--account", "50000", "--risk-pct", "1"],
    ]);
  });
});

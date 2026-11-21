import { describe, expect, test } from "bun:test";
import { bwlLine, conclusionCard } from "../public/viz.js";
import { buildFacts, bwlCard, type Analysis, type BwlReading } from "../src/citations.ts";
import { buildReport } from "../src/report.ts";
import spy from "./fixtures/spy-2024-04-19-analysis.json";

const FAKE = "假规则：按日期单双";
const PLUGIN: BwlReading = {
  source: { key: "plugin", name: FAKE }, applicable: true, color: "绿", arrangement: "多头",
  text: "多头排列里绿：做多 / 持有（P40）；已连续绿 3 根，没出现灰或黑之前不用关心（P45）",
};
const BUILTIN: BwlReading = {
  source: { key: "builtin", name: "破线拐头信号着色" }, applicable: true, color: null, arrangement: null,
  text: "自带着色不是黑绿线，配了着色插件才判",
};
const OFF: BwlReading = {
  source: { key: "plugin", name: FAKE }, applicable: false, color: null, arrangement: null,
  text: "黑绿线不适合横盘：视频 P 01:25「这个指标的缺陷就是不适合在三点钟方向的」",
};
const withBwl = (bwl: BwlReading | undefined) => ({ ...(spy as Analysis), bwl }) as Analysis;
const card = (a: Analysis) => conclusionCard(buildReport(a), a.close, { pos: "flat", cost: "" });

describe("结论卡片的黑绿线一行", () => {
  test("配了着色插件、类型适用：一行写来源和怎么读", () => {
    expect(bwlCard(withBwl(PLUGIN))).toEqual({ source: FAKE, text: PLUGIN.text });
    const html = card(withBwl(PLUGIN));
    expect(html).toContain('data-item="bwl"');
    expect(html).toContain(`（${FAKE}）：多头排列里绿：做多 / 持有（P40）`);
    expect(html).toContain("黑绿线 · 仅参考"); // 交易计划没用它，卡片上直接看得见，不只靠悬停
    expect(html).toContain("交易计划没用它");
  });

  test("自带着色、类型不适用、旧数据：没有这一行", () => {
    for (const b of [BUILTIN, OFF, undefined]) {
      expect(bwlCard(withBwl(b))).toBeNull();
      expect(card(withBwl(b))).not.toContain('data-item="bwl"');
    }
    expect(bwlLine({ bwl: null })).toBe("");
  });

  test("交易计划、打法不因黑绿线改变", () => {
    const plain = buildReport(withBwl(BUILTIN));
    const colored = buildReport(withBwl(PLUGIN));
    expect(colored.plans).toEqual(plain.plans);
    expect(colored.playKey).toBe(plain.playKey);
    expect(colored.checklist).toEqual(plain.checklist);
  });
});

describe("长风的数据字段", () => {
  test("黑绿线一条：写明颜色来源，判不了时是原因", () => {
    expect(buildFacts(withBwl(PLUGIN))["黑绿线"]).toEqual({
      label: `黑绿线读数（P40–P45，颜色：${FAKE}；只是读数，交易计划没用它）`, value: PLUGIN.text,
    });
    expect(buildFacts(withBwl(BUILTIN))["黑绿线"].value).toBe("自带着色不是黑绿线，配了着色插件才判");
    expect(buildFacts(withBwl(undefined))["黑绿线"]).toBeUndefined();
  });
});

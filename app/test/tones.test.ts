import { describe, expect, test } from "bun:test";
import { toneHelp } from "../public/charthelp.js";
import { TURN_TEXT, toneInfo, toneTurns } from "../public/tones.js";

/** 一眼看得出是假的来源：测试只谈接口，不写任何真规则。 */
const FAKE = { key: "plugin", name: "假规则：按日期单双", legend: ["单号绿、双号黑（测试用，不是真规则）", "第二行说明 <b>&"], warning: null };

const bars = (tones: (string | null | undefined)[]) => tones.map((tone, i) => ({ time: `2026-01-${String(i + 1).padStart(2, "0")}`, tone }));
const turns = (tones: (string | null | undefined)[]) => toneTurns(bars(tones)).map((t: { i: number; to: string }) => [t.i, t.to]);

describe("颜色的来源说明", () => {
  test("有 tone_source：名字、几行说明、出错原因原样拿来", () => {
    expect(toneInfo(FAKE)).toEqual({ name: "假规则：按日期单双", legend: FAKE.legend, warning: null });
    expect(toneInfo({ ...FAKE, key: "builtin", warning: "着色插件 fake.py 没用上，退回自带规则：文件不存在" }).warning)
      .toBe("着色插件 fake.py 没用上，退回自带规则：文件不存在");
  });

  test("没有 tone_source（旧的分析结果、测试替身）：没有名字，一行中性的说明，不报错", () => {
    for (const none of [undefined, null]) {
      const info = toneInfo(none);
      expect(info.name).toBeNull();
      expect(info.legend).toHaveLength(1);
      expect(info.legend[0]).toContain("重新分析");
      expect(info.warning).toBeNull();
    }
  });
});

describe("变色提示：只看颜色序列", () => {
  test("这根是绿而上一根不是绿：转绿；这根是黑而上一根不是黑：转黑", () => {
    expect(turns(["mixed", "bull", "bull", "mixed", "bear", "bear", "bull", "bear"]))
      .toEqual([[1, "bull"], [4, "bear"], [6, "bull"], [7, "bear"]]);
  });

  test("变成灰不标；颜色没变不标", () => {
    expect(turns(["bull", "mixed", "mixed", "bear", "mixed"])).toEqual([[3, "bear"]]);
    expect(turns(["bear", "bear", "bear"])).toEqual([]);
  });

  test("上一根没有颜色（预热段、插件没给）不标；第一根没有上一根，也不标", () => {
    expect(turns([null, "bull", "bear"])).toEqual([[2, "bear"]]);
    expect(turns([undefined, "bear", null, "bull", "mixed", "bull"])).toEqual([[5, "bull"]]);
    expect(turns(["bull"])).toEqual([]);
    expect(turns([])).toEqual([]);
  });

  test("标在哪根：带上那根的日期", () => {
    expect(toneTurns(bars(["mixed", "bull"]))).toEqual([{ i: 1, time: "2026-01-02", to: "bull" }]);
  });

  test("读数条里的叫法", () => {
    expect(TURN_TEXT).toEqual({ bull: "转绿", bear: "转黑" });
  });
});

describe("「怎么用」里讲着色的那段", () => {
  test("写来源的名字和整段说明，文字里的尖括号照字面显示", () => {
    const html = toneHelp(toneInfo(FAKE));
    expect(html).toContain("假规则：按日期单双");
    expect(html).toContain("单号绿、双号黑（测试用，不是真规则）");
    expect(html).toContain("第二行说明 &lt;b&gt;&amp;");
    expect(html).not.toContain("help-warn");
  });

  test("插件没用上：原因也写出来", () => {
    const html = toneHelp(toneInfo({ ...FAKE, warning: "着色插件 fake.py 没用上，退回自带规则：<文件不存在>" }));
    expect(html).toContain('<span class="help-warn">着色插件 fake.py 没用上，退回自带规则：&lt;文件不存在&gt;</span>');
  });

  test("没有来源：只有那一行中性的说明，不写「现在用的是」", () => {
    const html = toneHelp(toneInfo(undefined));
    expect(html).toContain(toneInfo(undefined).legend[0]);
    expect(html).not.toContain("现在用的是");
  });
});

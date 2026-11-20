import { describe, expect, test } from "bun:test";
import { cardContext, cardQuestions, selectionLabel } from "../public/askmenu.js";
import type { Analysis } from "../src/citations.ts";
import { buildReport } from "../src/report.ts";
import nvda from "./fixtures/nvda-analysis.json";

const a = nvda as Analysis;
const v = buildReport(a).visual;

describe("卡片问题", () => {
  test("每张卡都有问题，最多 5 条，不重复", () => {
    for (const card of ["chart", "big_picture", "strategy", "direction"]) {
      const qs = cardQuestions(card, a, v).map((q) => q.text);
      expect(qs.length).toBeGreaterThan(1);
      expect(qs.length).toBeLessThanOrEqual(5);
      expect(new Set(qs).size).toBe(qs.length);
    }
  });
  test("跟着数据走：NVDA 的 60/120 不一致、乖离 0% 分位、9 天大量", () => {
    const big = cardQuestions("big_picture", a, v).map((q) => q.text).join("\n");
    expect(big).toContain("60/120：MA 金叉、EMA 死叉");
    expect(big).toContain("0% 分位");
    expect(cardQuestions("chart", a, v).map((q) => q.text).join("\n")).toContain("9 根黄色量柱");
  });
  test("看方向：排列推演有变化时问为什么变", () => {
    const qs = cardQuestions("direction", a, v).map((q) => q.text).join("\n");
    expect(qs).toContain(`从${a.arr_ma}变成${v.scenario.end_arr_ma}`);
  });
  test("上下文说明用户在看哪张卡", () => {
    expect(cardContext("direction", a)).toEqual({ kind: "view", what: "3. 看方向", detail: "NVDA 2026-11-18" });
  });
});

describe("selectionLabel", () => {
  test("卡片菜单的上下文（没有 drops 字段）不报错", () => {
    expect(selectionLabel(cardContext("big_picture", a))).toBe("「1. 看大局」 · NVDA 2026-11-18");
  });
  test("划选文字", () => expect(selectionLabel({ kind: "text", where: "看方向", text: "扣高值" })).toBe("「看方向」扣高值"));
  test("点图表", () => {
    expect(selectionLabel({ kind: "chart", time: "2026-10-22", drops: [20], candle: { close: 180 } }))
      .toBe("图表 2026-10-22 · MA20 的抵扣价 · 收 180.00");
  });
});

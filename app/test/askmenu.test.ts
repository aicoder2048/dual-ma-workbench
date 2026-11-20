import { describe, expect, test } from "bun:test";
import { cardContext, cardQuestions, selectionLabel } from "../public/askmenu.js";
import type { Analysis } from "../src/citations.ts";
import { buildReport } from "../src/report.ts";
import nvda from "./fixtures/nvda-analysis.json";

const a = nvda as Analysis;
const r = buildReport(a);
const v = r.visual;

describe("卡片问题", () => {
  test("每张卡都有问题，最多 5 条，不重复", () => {
    for (const card of ["verdict", "chart", "big_picture", "play", "forecast"]) {
      const qs = cardQuestions(card, a, r).map((q) => q.text);
      expect(qs.length).toBeGreaterThan(1);
      expect(qs.length).toBeLessThanOrEqual(5);
      expect(new Set(qs).size).toBe(qs.length);
    }
  });
  test("跟着数据走：NVDA 的 60/120 不一致、乖离 0% 分位、9 天大量", () => {
    const big = cardQuestions("big_picture", a, r).map((q) => q.text).join("\n");
    expect(big).toContain("60/120：MA 金叉、EMA 死叉");
    expect(big).toContain("0% 分位");
    expect(cardQuestions("chart", a, r).map((q) => q.text).join("\n")).toContain("9 根黄色量柱");
  });
  test("做推演：排列推演有变化时问为什么变", () => {
    const qs = cardQuestions("forecast", a, r).map((q) => q.text).join("\n");
    expect(qs).toContain(`从${a.arr_ma}变成${v.scenario.end_arr_ma}`);
  });
  test("结论卡：问触发价和止损怎么来的", () => {
    const qs = cardQuestions("verdict", a, r).map((q) => q.text).join("\n");
    expect(qs).toContain(r.plans.flat.trigger!.price.toFixed(2));
    expect(qs).toContain("盈亏比 0.6:1 是怎么算的"); // NVDA 加速下跌：空仓等构造和 20 线组拐头再进，盈亏比不够
  });
  test("上下文说明用户在看哪张卡", () => {
    expect(cardContext("forecast", a)).toEqual({ kind: "view", what: "3. 做推演", detail: "NVDA 2026-11-18" });
  });
});

describe("selectionLabel", () => {
  test("卡片菜单的上下文（没有 drops 字段）不报错", () => {
    expect(selectionLabel(cardContext("big_picture", a))).toBe("「1. 看大局」 · NVDA 2026-11-18");
  });
  test("划选文字", () => expect(selectionLabel({ kind: "text", where: "做推演", text: "扣高值" })).toBe("「做推演」扣高值"));
  test("点图表", () => {
    expect(selectionLabel({ kind: "chart", time: "2026-10-22", drops: [20], candle: { close: 180 } }))
      .toBe("图表 2026-10-22 · MA20 的抵扣价 · 收 180.00");
  });
});

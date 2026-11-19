import { describe, expect, test } from "bun:test";
import { speechChunks, speechText } from "../public/speech.js";

describe("speechText：回答 → 能读出来的文字", () => {
  test("去掉引用标签", () => {
    expect(speechText("MA20 向下 [[D:MA20.方向]]。看原文 [[S:article#2.3]]。")).toBe("MA20 向下。看原文。");
  });
  test("去掉代码块（流程图、迷你 K 线）", () => {
    const md = "先看图。\n```mermaid\nflowchart LR\n A-->B\n```\n结论：不买。";
    expect(speechText(md)).toBe("先看图。 结论：不买。");
  });
  test("去掉 Markdown 记号，表格只读单元格", () => {
    expect(speechText("## 结论\n**明显偏空**，`EMA20` 先拐。\n- 第一条\n- 第二条")).toBe("结论 明显偏空，EMA20 先拐。 第一条 第二条");
    expect(speechText("| 周期 | 方向 |\n|---|---|\n| 20 | 向下 |")).toBe("周期，方向。 20，向下。");
  });
});

describe("speechChunks：按句切成小段，先播第一段", () => {
  test("短文字一段", () => expect(speechChunks("均线向上。")).toEqual(["均线向上。"]));
  test("长文字按句号切，每段不超过上限", () => {
    const text = "这是一句话。".repeat(80);
    const chunks = speechChunks(text, 120);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 120)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });
  test("没有标点的超长句也会硬切", () => {
    expect(speechChunks("啊".repeat(300), 120).every((c) => c.length <= 120)).toBe(true);
  });
});

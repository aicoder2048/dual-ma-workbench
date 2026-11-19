import { describe, expect, test } from "bun:test";
import { buildFacts, factsForPrompt, parseCitations, validateCitations, type Analysis } from "../src/citations.ts";
import { SourceLibrary } from "../src/sources.ts";
import nvda from "./fixtures/nvda-analysis.json";

const analysis = nvda as Analysis;
const lib = SourceLibrary.load();

describe("parseCitations", () => {
  test("同时解析原文和数据引用", () => {
    const got = parseCitations("不抄底 [[S:article#4]]，MA20 还要扣高值 [[D:扣20.均值]]。");
    expect(got.map((c) => `${c.kind}:${c.ref}`)).toEqual(["S:article#4", "D:扣20.均值"]);
  });
  test("忽略不完整的写法", () => expect(parseCitations("[[S:article#4] 和 [D:x]]")).toEqual([]));
});

describe("buildFacts", () => {
  const facts = buildFacts(analysis);

  test("基本字段", () => {
    expect(facts["收盘"].value).toBe("150.96");
    expect(facts["日期"].value).toBe("2026-11-18");
    expect(facts["MA20"].value).toBe("189.04");
  });
  test("底扣价字段", () => {
    expect(facts["扣20.扣低天数"].value).toBe("0/10");
    expect(facts["扣20.首次扣低"].value).toBe("20 天内都不会");
    expect(facts["扣20.价平变化"].value).toBe("-15.61%");
  });
  test("每个周期都有 MA/EMA/方向/位置", () => {
    for (const n of [20, 60, 120]) {
      for (const k of [`MA${n}`, `EMA${n}`, `MA${n}.方向`, `MA${n}.位置`, `扣${n}.明天`]) expect(facts[k]).toBeDefined();
    }
  });
  test("给模型的清单一行一个字段", () => {
    const lines = factsForPrompt(facts).split("\n");
    expect(lines.length).toBe(Object.keys(facts).length);
    expect(lines[0].startsWith("D:日期 = 2026-11-18")).toBe(true);
  });
});

describe("validateCitations", () => {
  const facts = buildFacts(analysis);

  test("存在的编号通过，并带上标题或数值", () => {
    const [s, d] = validateCitations("[[S:article#2.3]] [[D:MA60]]", lib, facts);
    expect(s.ok).toBe(true);
    expect(s.title).toContain("底扣价");
    expect(d.ok && d.value).toBe("212.35");
  });
  test("不存在的编号标为失败", () => {
    const checks = validateCitations("[[S:article#99]] [[D:MA999]]", lib, facts);
    expect(checks.map((c) => c.ok)).toEqual([false, false]);
  });
  test("没有当前分析时，数据引用一律失败", () => {
    expect(validateCitations("[[D:MA20]]", lib, null)[0].ok).toBe(false);
  });
});

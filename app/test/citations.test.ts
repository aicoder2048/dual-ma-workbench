import { describe, expect, test } from "bun:test";
import { bookOf, buildFacts, factsForPrompt, lookupFact, parseCitations, validateCitations, type Analysis } from "../src/citations.ts";
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
  test("抵扣价字段", () => {
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
  const facts = bookOf("NVDA", buildFacts(analysis));

  test("存在的编号通过，并带上标题或数值", () => {
    const [s, d] = validateCitations("[[S:article#2.3]] [[D:MA60]]", lib, facts);
    expect(s.ok).toBe(true);
    expect(s.title).toContain("抵扣价");
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

describe("多只股票的数据引用", () => {
  const book = { byTicker: { NVDA: buildFacts(analysis), TSLA: { MA20: { label: "20 日 MA", value: "386.13" } } }, current: "NVDA" };

  test("不写代码时指默认股票", () => expect(lookupFact(book, "MA20")?.value).toBe("189.04"));
  test("写了代码就指那只股票", () => expect(lookupFact(book, "TSLA:MA20")?.value).toBe("386.13"));
  test("代码不存在则找不到", () => expect(lookupFact(book, "AMD:MA20")).toBeUndefined());
  test("字段名里本身含冒号以外的点号不受影响", () => expect(lookupFact(book, "扣20.均值")?.value).toBe("209.97"));
});

describe("模糊判断字段", () => {
  const facts = buildFacts(nvda as Analysis);
  test("判断与票数", () => {
    expect(facts["模糊判断"].value).toStartWith("明显偏空");
    expect(facts["模糊判断.方向"].value).toBe("0 上 · 0 平 · 6 下");
  });
  test("10 天后与改变判断的价位", () => {
    expect(facts["模糊判断.10天后"].value).toStartWith("明显偏空");
    expect(facts["改变判断.EMA20"].value).toContain("183.08");
  });
});

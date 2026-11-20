import { describe, expect, test } from "bun:test";
import { buildFacts, type Analysis } from "../src/citations.ts";
import { buildReport, crossVerdict, parseCross, parseTypeTable, stanceOf, TYPE_TABLE } from "../src/report.ts";
import { EVALUATION_NOTE, parseRuleEvidence } from "../src/record.ts";
import nvda from "./fixtures/nvda-analysis.json";

const analysis = nvda as Analysis;
const report = buildReport(analysis);

/** 去掉引用和 Markdown 标记，按句号、问号、分号切句。 */
function sentences(text: string): string[] {
  return text
    .replace(/\[\[(S|D):[^\]]+\]\]/g, "")
    .replace(/\*\*/g, "")
    .split(/[。？！；]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

describe("STE 写法", () => {
  const all = report.steps.flatMap((s) => s.items);

  test("每句不超过 40 字（不计引用）", () => {
    const long = all.flatMap(sentences).filter((s) => [...s].length > 40);
    expect(long).toEqual([]);
  });
  test("不用被字句和含糊词", () => {
    const bad = all.flatMap(sentences).filter((s) => /被|进行|相关|一定的|有效地/.test(s));
    expect(bad).toEqual([]);
  });
  test("不用感叹号", () => expect(all.join("").includes("！")).toBe(false));
});

describe("交叉", () => {
  test("解析脚本的交叉文字", () => {
    expect(parseCross("死叉 2026-10-30（13 根前）")).toEqual({ kind: "死叉", date: "2026-10-30", barsAgo: 13 });
    expect(parseCross("无").kind).toBeNull();
  });
  test("双交叉 / 不一致", () => {
    const d = (kind: "金叉" | "死叉") => ({ kind, date: "2026-01-01", barsAgo: 1 });
    expect(crossVerdict(d("死叉"), d("死叉"))).toBe("双死叉");
    expect(crossVerdict(d("金叉"), d("死叉"))).toBe("不一致");
  });
  test("NVDA：20/60 双死叉，60/120 不一致", () => {
    expect(report.visual.crosses.map((c) => c.verdict)).toEqual(["双死叉", "不一致"]);
  });
});

describe("推演：用脚本的 projection，不在这里重算", () => {
  const sc = analysis.projection.scenarios[0];
  test("可引用数据里的推演就是脚本的持平情景", () => {
    const f = buildFacts(analysis);
    expect(f["推演.排列.MA"].value).toBe(`${analysis.arr_ma} → ${sc.end_arr_ma}`);
    expect(f["推演.EMA20"].value).toContain(sc.end_values.EMA20.toFixed(2));
    expect(f["门槛.MA60"].value).toContain(analysis.projection.hurdles[1].max_price.toFixed(2));
  });
  test("做推演只写 30 天的门槛路径（MA60、MA120），并引用 rules.md A2", () => {
    const hurdles = report.steps[2].items.filter((t) => t.includes("[[S:rules#A2]]"));
    expect(hurdles.map((t) => t.split("：")[0])).toEqual(["MA60", "MA120"]);
    expect(report.visual.scenario).toBe(sc);
  });
});

describe("找打法：规则清单并进来了", () => {
  const play = report.steps.find((s) => s.key === "play")!;
  test("打法用到的规则逐条写，每条都链到 rules.md 和它今天的状态", () => {
    for (const id of analysis.play.rules) {
      const line = play.items.find((t) => t.startsWith(`${id} `))!;
      expect(line).toContain(`[[S:rules#${id}]]`);
      expect(line).toContain(`[[D:规则.${id}]]`);
    }
  });
  test("让位的规则写出谁优先", () => {
    const a = structuredClone(analysis);
    a.rules = a.rules.map((r) => (r.id === "P20" ? { ...r, status: "满足", yields_to: "P17" } : r));
    const items = buildReport(a).steps.find((s) => s.key === "play")!.items;
    expect(items.find((t) => t.startsWith("P20 "))).toContain("P17 优先");
  });
  test("结论两行和回测记录都能引用", () => {
    expect(play.items.join("")).toContain("[[D:结论.空仓]]");
    expect(play.items.join("")).toContain("[[D:回测]]");
  });
});

describe("类型总表只有一份：读 SKILL.md", () => {
  test("八行，第一列以脚本的打法键开头", () => {
    const keys = ["横盘", "稳定上涨", "加速上涨", "稳定下跌", "加速下跌", "空头结构反弹中", "多头结构回撤中", "过渡"];
    expect(TYPE_TABLE.map((r) => keys.find((k) => r.type.startsWith(k)))).toEqual(keys);
  });
  test("表头不对就报错，不悄悄给空表", () => {
    expect(() => parseTypeTable("# 没有表")).toThrow();
  });
});

describe("可视化数据", () => {
  test("趋势判定表只高亮当前类型", () => {
    const cur = report.visual.trendTable.filter((r) => r.current).map((r) => r.type);
    expect(cur).toEqual(["加速下跌"]);
  });
  test("抵扣价路径每条 10 天", () => {
    expect(report.visual.drops.map((d) => d.path.length)).toEqual([10, 10, 10]);
  });
});

describe("模糊判断在前", () => {
  test("标题先说对谁有利，再说趋势类型", () => expect(report.headline).toBe("NVDA · 明显偏空 · 加速下跌·延伸"));
  test("立场跟模糊判断走", () => expect(report.stance).toBe("bearish"));
  test("看大局第一句就是结论：趋势类型，并带数据引用", () => {
    expect(report.steps[0].items[0]).toStartWith("趋势类型：加速下跌·延伸 [[D:趋势初判]]");
  });
  test("看大局不再把「规则初判」放在最后一句", () => {
    expect(report.steps[0].items.at(-1)).not.toContain("规则初判");
  });
  test("结论、找打法、做推演都有输出", () => {
    expect(report.plans.flat.action).toBeTruthy();
    expect(report.plans.holding.action).toBeTruthy();
    expect(report.checklist.map((c) => c.id)).toEqual(analysis.play.rules);
    expect(report.forecast.days).toBe(30);
  });
  test("回测记录：加速下跌空仓不买，照实说没有进场", () => {
    expect(report.record.setup).toBeNull();
    expect(report.record.text).toContain("空仓不买");
  });
  test("可视化数据带上模糊判断和改变判断的价位", () => {
    expect(report.visual.lean.label).toBe("明显偏空");
    expect(report.visual.lean.flips[0].line).toBe("EMA20");
  });
});

describe("立场", () => {
  // 立场跟脚本给的档位走，不在这里再写一遍 0.25
  test("立场按模糊判断的档位分三档", () => {
    expect(stanceOf({ label: "偏多" })).toBe("bullish");
    expect(stanceOf({ label: "明显偏多" })).toBe("bullish");
    expect(stanceOf({ label: "不明" })).toBe("neutral");
    expect(stanceOf({ label: "明显偏空" })).toBe("bearish");
  });
});

describe("评估结论照实标注", () => {
  test("rules.md 里标了回测不支持的规则：规则列表和清单都带上那句标注，没标的是 null", () => {
    const bounce = buildReport({ ...analysis, play: { ...analysis.play, key: "空头结构反弹中", rules: ["P17", "J18", "J17"] } });
    expect(bounce.checklist.find((c) => c.id === "J18")!.evidence).toBe("回测不支持（评估 2026-11-20，H6）");
    expect(report.visual.rules.find((r) => r.id === "P17")!.evidence).toBe("回测不支持（评估 2026-11-20，H6）");
    expect(report.visual.rules.find((r) => r.id === "P7")!.evidence).toBeNull();
    expect(bounce.steps[1].items.find((x) => x.startsWith("J18 "))).toContain("回测不支持");
  });
  test("parseRuleEvidence 只认规则行里加粗的回测标注", () => {
    const md = ["| J1 | 判定 | a | b。**回测不支持**（评估 2026-11-20，H5） | c | d |", "| J2 | 判定 | a | 回测不支持 | c | d |", "说明：**回测不支持**（x）"].join("\n");
    expect([...parseRuleEvidence(md)]).toEqual([["J1", "回测不支持（评估 2026-11-20，H5）"]]);
  });
  test("结论卡片的回测那句末尾说评估没找到交易优势", () => {
    expect(report.record.text.endsWith(EVALUATION_NOTE)).toBe(true);
  });
});

describe("MA200 朴素规则对照", () => {
  const nv = analysis.ma200 as Extract<Analysis["ma200"], { available: true }>;
  test("NVDA 2026-11-18：收盘在 MA200 下方，朴素规则空仓；双均线也空仓，一致", () => {
    expect(report.naive.rule).toBe("MA200 朴素规则：收盘在下方 -25.9%，空仓");
    expect(report.naive.dual).toBe("空仓");
    expect(report.naive.agrees).toBe(true);
    expect(report.naive.short).toBe("评估 MAR 0.26 vs 0.14");
    expect(report.naive.text).toContain("MA200 0.26、照方向持有 0.14、买入持有 0.33");
  });
  test("两边说法不同时是不一致", () => {
    const r = buildReport({ ...analysis, ma200: { ...nv, close_above: true, distance_pct: 3.04, stance: "持有", agrees: false } });
    expect(r.naive.rule).toBe("MA200 朴素规则：收盘在上方 +3.0%，持有");
    expect(r.naive.agrees).toBe(false);
    expect(buildFacts({ ...analysis, ma200: { ...nv, stance: "持有", agrees: false } })["MA200.对照"].value).toContain("不一致");
  });
  test("历史不够 205 根：说明原因，不判一致与否", () => {
    const r = buildReport({ ...analysis, ma200: { available: false, reason: "日线只有 150 根，MA200 对照要 205 根" } });
    expect(r.naive).toMatchObject({ rule: "MA200 朴素规则：日线只有 150 根，MA200 对照要 205 根", dual: null, agrees: null });
  });
  test("长风拿得到 MA200 和对照两个字段", () => {
    const facts = buildFacts(analysis);
    expect(facts["MA200"].value).toBe("203.72，向下；2026-11-04 收盘下穿（10 根前）");
    expect(facts["MA200.对照"].value).toStartWith("MA200 朴素规则：收盘在下方 -25.9%，空仓；双均线照方向持有（稳定 / 加速上涨才持有）：空仓；一致。");
  });
});

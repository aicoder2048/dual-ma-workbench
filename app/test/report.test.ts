import { describe, expect, test } from "bun:test";
import { buildFacts, type Analysis } from "../src/citations.ts";
import { buildReport, crossVerdict, parseCross, parseTypeTable, stanceOf, TYPE_TABLE } from "../src/report.ts";
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
  test("看方向写出门槛路径，并引用 rules.md A2", () => {
    expect(report.steps[2].items[0]).toContain("[[S:rules#A2]]");
    expect(report.visual.scenario).toBe(sc);
  });
});

describe("规则清单", () => {
  const rules = report.steps.find((s) => s.key === "rules")!;
  test("打法用到的规则排在前面，每条都链到 rules.md 和它今天的状态", () => {
    expect(rules.items.length).toBeGreaterThanOrEqual(analysis.play.rules.length);
    analysis.play.rules.forEach((id, i) => {
      expect(rules.items[i]).toStartWith(`${id} `);
      expect(rules.items[i]).toContain(`[[S:rules#${id}]]`);
      expect(rules.items[i]).toContain(`[[D:规则.${id}]]`);
    });
  });
  test("让位的规则写出谁优先", () => {
    const a = structuredClone(analysis);
    a.rules = a.rules.map((r) => (r.id === "P20" ? { ...r, status: "满足", yields_to: "P17" } : r));
    const items = buildReport(a).steps.find((s) => s.key === "rules")!.items;
    expect(items.find((t) => t.startsWith("P20 "))).toContain("P17 优先");
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
  test("定策略、看方向都有结论输出", () => {
    expect(report.plans.flat.action).toBeTruthy();
    expect(report.plans.holding.action).toBeTruthy();
    expect(report.outlook.verdict).toContain("逆风");
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

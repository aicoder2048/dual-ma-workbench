import { describe, expect, test } from "bun:test";
import { buildFacts, type Analysis } from "../src/citations.ts";
import { buildReport, crossVerdict, parseCross, project, stanceOf } from "../src/report.ts";
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

describe("推演", () => {
  const p = project(analysis);

  test("EMA 精确解与逐日递推一致", () => {
    const c = analysis.close;
    for (const ln of analysis.lines) {
      const alpha = 2 / (ln.period + 1);
      let e = ln.ema;
      for (let i = 0; i < 10; i++) e = alpha * c + (1 - alpha) * e;
      expect(p.ema[`EMA${ln.period}`].after).toBeCloseTo(e, 8);
    }
  });
  test("MA 推演与脚本的价平变化一致", () => {
    expect(p.ma.MA20.after).toBeCloseTo(189.04 * (1 - 0.1561), 1);
  });
  test("推演进入可引用数据", () => {
    const f = buildFacts(analysis);
    expect(f["推演.排列.MA"].value).toBe(`${p.arrNow.ma} → ${p.arrAfter.ma}`);
    expect(f["推演.EMA20"]).toBeDefined();
  });
});

describe("可视化数据", () => {
  test("趋势判定表只高亮当前类型", () => {
    const cur = report.visual.trendTable.filter((r) => r.current).map((r) => r.type);
    expect(cur).toEqual(["极度超卖"]);
  });
  test("抵扣价路径每条 10 天", () => {
    expect(report.visual.drops.map((d) => d.path.length)).toEqual([10, 10, 10]);
  });
});

describe("模糊判断在前", () => {
  test("标题先说对谁有利，再说趋势类型", () => expect(report.headline).toBe("NVDA · 明显偏空 · 极度超卖"));
  test("立场跟模糊判断走", () => expect(report.stance).toBe("bearish"));
  test("看大局第一句就是模糊判断，并带数据引用", () => {
    expect(report.steps[0].items[0]).toContain("[[D:模糊判断]]");
  });
  test("可视化数据带上模糊判断和改变判断的价位", () => {
    expect(report.visual.lean.label).toBe("明显偏空");
    expect(report.visual.lean.flips[0].line).toBe("EMA20");
  });
});

describe("立场", () => {
  test("方向和排布打架时是中性", () => {
    expect(stanceOf({ score: 0.4, conflict: "反弹受压" })).toBe("neutral");
    expect(stanceOf({ score: 0.4, conflict: null })).toBe("bullish");
  });
});

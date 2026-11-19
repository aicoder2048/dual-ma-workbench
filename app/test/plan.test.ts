import { describe, expect, test } from "bun:test";
import type { Analysis } from "../src/citations.ts";
import { buildOutlook, buildPlans } from "../src/plan.ts";
import nvda from "./fixtures/nvda-analysis.json";

const bear = nvda as Analysis; // 明显偏空 · 极度超卖，三条 MA 未来都扣高值

/** 偏多的例子：把 NVDA 改成健康上涨，价格 230，MA20 前 4 天扣低值、之后扣高值。 */
function bullish(): Analysis {
  const a = structuredClone(bear);
  a.close = 230;
  a.trend = "健康上涨";
  a.lean = { ...a.lean, score: 0.8, label: "明显偏多", conflict: null,
    flips: [
      { line: "EMA20", price: 221.5, crossed: false, text: "收盘跌破 EMA20（221.50），EMA20 拐头向下" },
      { line: "MA20", price: 224.0, crossed: false, text: "收盘跌破 MA20 的抵扣价（224.00），MA20 拐头向下" },
    ],
    after: { ...a.lean.after, label: "明显偏多", conflict: null, score: 0.8 } };
  a.lines = a.lines.map((l) => ({ ...l, ma: l.period === 20 ? 220 : 205, ema: l.period === 20 ? 221.5 : 207, above: true }));
  const prices = [210, 212, 215, 218, 232, 235, 236, 238, 240, 241];
  a.drops = a.drops.map((d) => ({ ...d, tomorrow: d.period === 20 ? 224 : 200, below: d.period === 20 ? 4 : 10,
    first_low: 1, path: d.path.map((p, i) => ({ ...p, close: d.period === 20 ? prices[i] : 190 })) }));
  return a;
}

const bullishPlans = () => buildPlans(bullish());

describe("定策略：按有没有仓位给出做法和价位", () => {
  const plans = buildPlans(bear);
  test("空仓：一句话做法 + 等什么条件，条件里有具体价位", () => {
    expect(plans.flat.action).toContain("不抢反弹");
    const text = plans.flat.items.map((i) => i.text).join("");
    expect(text).toContain("183.08"); // 先站上 EMA20
    expect(text).toContain("212.21"); // 再站上 MA20 抵扣价
  });
  test("持仓：一句话做法 + 减仓 / 离场的价位", () => {
    expect(plans.holding.action).toMatch(/减仓|离场/);
    expect(plans.holding.items.some((i) => i.label === "仓位")).toBe(true);
  });
  test("偏多时空仓等回调，给出回踩的价位", () => {
    const p = buildPlans(bullish());
    expect(p.flat.action).toMatch(/回调/);
    expect(p.flat.items.map((i) => i.text).join("")).toContain("220.00");
  });
});

describe("看方向：给出结论，而不只是图", () => {
  test("偏空、20 天内都扣高值：逆风持续，只有站上 EMA20 才会提前转向", () => {
    const o = buildOutlook(bear);
    expect(o.verdict).toContain("逆风");
    expect(o.verdict).toContain("20 天");
    expect(o.change).toContain("183.08");
    expect(o.effect.flat.tag).toBe("支持");
    expect(o.effect.flat.text).toContain("不抢反弹");
  });
  test("偏多、MA20 第 5 天开始扣高值：顺风还有 4 天，之后回调容易拐头", () => {
    const o = buildOutlook(bullish());
    expect(o.verdict).toContain("顺风");
    expect(o.change).toContain("第 5 天");
    expect(o.effect.flat.tag).toBe("调整时机");
    expect(o.effect.flat.text).toContain("第 5 天");
  });
});

describe("看方向和定策略互相引用", () => {
  test("每份计划都带一行「时机（来自看方向）」，和看方向的影响一致", () => {
    const plans = buildPlans(bear);
    const o = buildOutlook(bear);
    for (const pos of ["flat", "holding"] as const) {
      const timing = plans[pos].items.find((i) => i.label === "时机");
      expect(timing?.text).toBe(o.effect[pos].text);
    }
  });
});

describe("成本价参与策略：浮盈、浮亏分开说", () => {
  const plans = buildPlans(bear);
  const o = buildOutlook(bear);
  const text = (k: "holding" | "profit" | "loss") => [plans[k].action, ...plans[k].items.map((i) => i.text)].join("");

  test("浮盈：先保住利润，止损提到成本附近（成本由页面填进 {cost}）", () => {
    expect(text("profit")).toContain("{cost}");
    expect(text("profit")).toMatch(/保本|锁住|利润/);
    expect(text("profit")).not.toMatch(/浮亏|涨回成本/);
  });
  test("浮亏：不等回本", () => {
    expect(text("loss")).toMatch(/不等回本|不要等涨回成本/);
  });
  test("没填成本时，不提浮盈浮亏，也不提回本", () => {
    expect(text("holding")).not.toMatch(/浮盈|浮亏|回本|涨回成本/);
  });
  test("看方向的影响也按浮盈 / 浮亏分开，和计划第一行「时机」一致", () => {
    for (const k of ["flat", "holding", "profit", "loss"] as const) {
      expect(plans[k].items[0]).toEqual({ label: "时机", text: o.effect[k].text });
    }
    expect(o.effect.profit.text).not.toContain("涨回成本");
    expect(o.effect.loss.text).toContain("涨回成本");
  });
  test("偏多时浮亏：不在浮亏时加仓摊低", () => {
    expect([bullishPlans().loss.action, ...bullishPlans().loss.items.map((i) => i.text)].join("")).toContain("摊低");
  });
});

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

describe("每种趋势类型的浮盈 / 浮亏都不自相矛盾", () => {
  const TRENDS = ["横盘震荡", "健康上涨", "极度超买", "健康下跌", "极度超卖", "过渡态（排列或方向不一致）"];
  const withTrend = (t: string, score: number, conflict: "反弹受压" | "回调有撑" | null = null) => {
    const a = structuredClone(bear);
    a.trend = t;
    a.lean = { ...a.lean, score, conflict };
    return a;
  };
  const txt = (p: { action: string; items: { text: string }[] }) => [p.action, ...p.items.map((i) => i.text)].join("｜");
  // 只遍历真实数据里会出现的组合：classify 只在分数 ≥ 0.6 时给上涨一侧、≤ -0.6 时给下跌一侧，
  // 横盘和过渡态可以配任何分数（看方向分三档：≤ -0.25、中间、≥ 0.25）。打架只出现在过渡态。
  const SCORES: Record<string, number[]> = { 健康上涨: [0.8], 极度超买: [0.8], 健康下跌: [-0.8], 极度超卖: [-0.8] };
  const CASES: [string, number, "反弹受压" | "回调有撑" | null][] = [
    ...TRENDS.flatMap((t) => (SCORES[t] ?? [-0.4, 0, 0.4]).map((s): [string, number, null] => [t, s, null])),
    [TRENDS[5], 0.4, "反弹受压"], [TRENDS[5], -0.4, "回调有撑"],
  ];
  for (const [t, score, conflict] of CASES) {
    test(`${t}${conflict ? `·${conflict}` : ""}，lean ${score}`, () => {
      const p = buildPlans(withTrend(t, score, conflict));
      expect(txt(p.profit)).toContain("{cost}");
      expect(txt(p.profit)).not.toMatch(/浮亏|不等回本/);
      expect(txt(p.loss)).not.toMatch(/止盈|浮盈|保本/); // 亏着钱谈不上止盈、保本
      expect(txt(p.loss)).toMatch(/摊低|不等回本/); // 浮亏时最常见的错：加仓摊低、死等回本
      for (const k of ["holding", "profit", "loss"] as const) {
        const all = txt(p[k]);
        // 同一张计划里不能既说不加仓、又说可以加
        expect(/不加仓/.test(all) && /再加|(?<!不)加仓。|可以加仓|小级别确认后加/.test(all)).toBe(false);
        const timing = p[k].items[0].text;
        expect(timing).not.toMatch(/「([^」]+)」不变：\1/); // 时机行不把做法原话再说一遍
        if (/^(拿着|持有)/.test(p[k].action)) expect(timing).not.toMatch(/^支持.*就执行/); // 拿着的计划没有"执行"可支持
      }
      if (t !== "健康上涨") expect(txt(p.loss)).not.toContain("趋势还向上"); // 只有健康上涨才能这么说
      for (const k of ["profit", "loss"] as const) {
        // 盈亏行提到的「减仓位」「离场条件」，同一张计划里要真的有这一条
        if (/减仓位/.test(p[k].items.find((i) => i.label === "盈亏")!.text)) expect(p[k].items.some((i) => i.label === "减仓位")).toBe(true);
      }
    });
  }
});

/** 过渡态里方向和排布打架：反弹受压（多数线向上、20 组在 60 组下方）/ 回调有撑（反过来）。 */
function conflict(kind: "反弹受压" | "回调有撑"): Analysis {
  const a = structuredClone(bear);
  a.trend = "过渡态（排列或方向不一致）";
  const score = kind === "反弹受压" ? 0.4 : -0.4;
  a.lean = { ...a.lean, score, label: kind === "反弹受压" ? "偏多" : "偏空", conflict: kind,
    after: { ...a.lean.after, score, conflict: kind } };
  return a;
}
const all = (p: { action: string; items: { text: string }[] }) => [p.action, ...p.items.map((i) => i.text)].join("");

describe("反弹受压 / 回调有撑进入策略", () => {
  test("反弹受压：空仓不买，持仓逢高减仓；看方向不说「买点窗口」", () => {
    const a = conflict("反弹受压");
    const p = buildPlans(a);
    expect(p.flat.action).toContain("不买");
    expect(all(p.flat)).toContain("212.35"); // 等 20 线组站上 60 线组：MA60
    expect(p.holding.action).toContain("逢高减仓");
    const o = buildOutlook(a);
    expect(o.effect.flat.text).not.toMatch(/买点|窗口/);
    expect(o.effect.flat.text).toContain("不买");
  });
  test("回调有撑：空仓等回调结束再买，持仓持有观察，20/60 双死叉才走", () => {
    const p = buildPlans(conflict("回调有撑"));
    expect(p.flat.action).toMatch(/回调结束|再买/);
    expect(p.holding.action).toContain("持有");
    expect(all(p.holding)).toContain("双死叉");
    expect(buildOutlook(conflict("回调有撑")).effect.holding.text).toContain("持有");
  });
  test("反弹受压：浮盈先锁利保本，浮亏不等回本、反弹到减仓位就减", () => {
    const p = buildPlans(conflict("反弹受压"));
    expect(all(p.profit)).toContain("保本");
    expect(all(p.loss)).toContain("不等回本");
  });
  test("回调有撑：浮盈有安全垫、不在回调里卖；浮亏不加仓摊低", () => {
    const p = buildPlans(conflict("回调有撑"));
    expect(all(p.profit)).toContain("安全垫");
    expect(all(p.loss)).toContain("不加仓摊低");
    expect(all(p.loss)).toContain("双死叉");
  });
  test("反弹受压、价格已经在 MA60 上方：减仓位说「现在」，不说「反弹到」", () => {
    const a = conflict("反弹受压");
    a.close = 220; // MA60 212.35 在下方
    const p = buildPlans(a);
    const sell = p.holding.items.find((i) => i.label === "减仓位")!.text;
    expect(sell).toContain("现在");
    expect(sell).not.toMatch(/^反弹到/);
    expect(p.holding.items[0].text).toContain("现在");
  });
  test("没有冲突的过渡态，打法不变", () => {
    const a = conflict("反弹受压");
    a.lean = { ...a.lean, conflict: null };
    expect(buildPlans(a).flat.action).toBe("条件不满足，不做。");
  });
});

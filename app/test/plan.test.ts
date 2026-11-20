import { describe, expect, test } from "bun:test";
import type { Analysis } from "../src/citations.ts";
import { buildOutlook, buildPlans, ma20Claim, playKey } from "../src/plan.ts";
import nvda from "./fixtures/nvda-analysis.json";

const bear = nvda as Analysis; // 明显偏空 · 加速下跌，三条 MA 未来都扣高值

/** 偏多的例子：把 NVDA 改成稳定上涨，价格 230，MA20 前 4 天扣低值、之后扣高值。 */
function bullish(): Analysis {
  const a = structuredClone(bear);
  a.close = 230;
  a.play = { ...a.play, key: "稳定上涨" };
  a.lean = { ...a.lean, score: 0.8, label: "明显偏多",
    flips: [
      { line: "EMA20", price: 221.5, toward: "空", text: "收盘跌破 EMA20（221.50），EMA20 拐头向下" },
      { line: "MA20", price: 224.0, toward: "空", text: "收盘跌破 MA20 的抵扣价（224.00），MA20 拐头向下" },
    ],
    after: { ...a.lean.after, label: "明显偏多", score: 0.8 } };
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
  test("偏多时空仓等回调，给出回撤到 60 线组的价位和吃回撤四个条件的状态", () => {
    const p = buildPlans(bullish());
    expect(p.flat.action).toMatch(/回调/);
    const wait = p.flat.items.find((i) => i.label === "等什么")!;
    expect(wait.text).toContain("205.00"); // MA60
    expect(wait.text).toContain("（P11）");
    expect(wait.rules).toEqual(["P10", "P11", "P12", "P13"]);
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
  const TRENDS = ["横盘", "稳定上涨", "加速上涨", "稳定下跌", "加速下跌", "过渡"];
  const withTrend = (t: string, score: number, conflict: "空头结构反弹中" | "多头结构回撤中" | null = null) => {
    const a = structuredClone(bear);
    a.play = { ...a.play, key: conflict ?? t };
    a.lean = { ...a.lean, score };
    return a;
  };
  const txt = (p: { action: string; items: { text: string }[] }) => [p.action, ...p.items.map((i) => i.text)].join("｜");
  // 遍历打法和典型分数的组合：上涨类配偏多、下跌类配偏空，横盘和过渡配三档（≤ -0.25、中间、≥ 0.25），
  // 加上 60/120 定不出类型时的两种打架（空头结构反弹中、多头结构回撤中）。
  const SCORES: Record<string, number[]> = { 稳定上涨: [0.8], 加速上涨: [0.8], 稳定下跌: [-0.8], 加速下跌: [-0.8] };
  const CASES: [string, number, "空头结构反弹中" | "多头结构回撤中" | null][] = [
    ...TRENDS.flatMap((t) => (SCORES[t] ?? [-0.4, 0, 0.4]).map((s): [string, number, null] => [t, s, null])),
    [TRENDS[5], 0.4, "空头结构反弹中"], [TRENDS[5], -0.4, "多头结构回撤中"],
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
      if (t !== "稳定上涨") expect(txt(p.loss)).not.toContain("趋势还向上"); // 只有稳定上涨才能这么说
      for (const k of ["profit", "loss"] as const) {
        // 盈亏行提到的「减仓位」「离场条件」，同一张计划里要真的有这一条
        if (/减仓位/.test(p[k].items.find((i) => i.label === "盈亏")!.text)) expect(p[k].items.some((i) => i.label === "减仓位")).toBe(true);
      }
    });
  }
});

/** 过渡里方向和排布打架：空头结构反弹中（多数线向上、20 组在 60 组下方）/ 多头结构回撤中（反过来）。 */
function conflict(kind: "空头结构反弹中" | "多头结构回撤中"): Analysis {
  const a = structuredClone(bear);
  a.play = { ...a.play, key: kind };
  const score = kind === "空头结构反弹中" ? 0.4 : -0.4;
  a.lean = { ...a.lean, score, label: kind === "空头结构反弹中" ? "偏多" : "偏空",
    after: { ...a.lean.after, score } };
  return a;
}
const all = (p: { action: string; items: { text: string }[] }) => [p.action, ...p.items.map((i) => i.text)].join("");

describe("空头结构反弹中 / 多头结构回撤中进入策略", () => {
  test("空头结构反弹中：空仓不买，持仓逢高减仓；看方向不说「买点窗口」", () => {
    const a = conflict("空头结构反弹中");
    const p = buildPlans(a);
    expect(p.flat.action).toContain("不买");
    expect(all(p.flat)).toContain("212.35"); // 等 20 线组站上 60 线组：MA60
    expect(p.holding.action).toContain("逢高减仓");
    const o = buildOutlook(a);
    expect(o.effect.flat.text).not.toMatch(/买点|窗口/);
    expect(o.effect.flat.text).toContain("不买");
  });
  test("多头结构回撤中：空仓等回调结束再买，持仓持有观察，20/60 双死叉才走", () => {
    const p = buildPlans(conflict("多头结构回撤中"));
    expect(p.flat.action).toMatch(/回调结束|再买/);
    expect(p.holding.action).toContain("持有");
    expect(all(p.holding)).toContain("双死叉");
    expect(buildOutlook(conflict("多头结构回撤中")).effect.holding.text).toContain("持有");
  });
  test("空头结构反弹中：浮盈先锁利保本，浮亏不等回本、反弹到减仓位就减", () => {
    const p = buildPlans(conflict("空头结构反弹中"));
    expect(all(p.profit)).toContain("保本");
    expect(all(p.loss)).toContain("不等回本");
  });
  test("多头结构回撤中：浮盈有安全垫、不在回调里卖；浮亏不加仓摊低", () => {
    const p = buildPlans(conflict("多头结构回撤中"));
    expect(all(p.profit)).toContain("安全垫");
    expect(all(p.loss)).toContain("不加仓摊低");
    expect(all(p.loss)).toContain("双死叉");
  });
  test("空头结构反弹中、价格已经在 MA60 上方：减仓位说「现在」，不说「反弹到」", () => {
    const a = conflict("空头结构反弹中");
    a.close = 220; // MA60 212.35 在下方
    const p = buildPlans(a);
    const sell = p.holding.items.find((i) => i.label === "减仓位")!.text;
    expect(sell).toContain("现在");
    expect(sell).not.toMatch(/^反弹到/);
    expect(p.holding.items[0].text).toContain("现在");
  });
  test("横盘带冲突：还按横盘打（页面上的趋势类型也是横盘）", () => {
    const a = conflict("多头结构回撤中");
    a.play = { ...a.play, key: "横盘" };
    expect(buildPlans(a).flat.action).toBe("中段不做，等末期条件齐了再埋伏。");
    expect(buildOutlook(a).effect.flat.text).not.toContain("回调");
  });
  test("价位相对现价说对：「站上 / 反弹到 X」的 X 在现价上方，「回踩到 / 跌破 X」的 X 在现价下方", () => {
    // MA60 212.35、EMA60 203.13、EMA20 183.08：现价分别在 EMA20 下方、EMA20 和 MA60 之间、MA60 上方
    for (const kind of ["空头结构反弹中", "多头结构回撤中"] as const) for (const close of [150.96, 195, 230]) {
      const a = conflict(kind);
      a.close = close;
      a.drops = a.drops.map((d) => (d.period === 20 ? { ...d, tomorrow: 190 } : d)); // MA20 抵扣价在 EMA20 和 MA60 之间
      const p = buildPlans(a);
      const o = buildOutlook(a);
      const texts = [...Object.values(p).flatMap((x) => [x.action, ...x.items.map((i) => i.text)]), ...Object.values(o.effect).map((e) => e.text)];
      for (const t of texts) {
        for (const m of t.matchAll(/(站上|反弹到|高于|回踩到|跌破)[^。；，]*?(\d+\.\d{2})/g)) {
          const price = Number(m[2]);
          const up = ["站上", "反弹到", "高于"].includes(m[1]);
          expect({ kind, close, t, ok: up ? price > close : price < close }).toEqual({ kind, close, t, ok: true });
        }
        expect(t).not.toContain("））"); // 括号不套括号
      }
    }
  });
  test("没有冲突的过渡，打法不变", () => {
    const a = conflict("空头结构反弹中");
    a.play = { ...a.play, key: "过渡" };
    expect(buildPlans(a).flat.action).toBe("条件不满足，不做。");
  });
});

/** 所有打法（六种类型按真实会出现的分数 + 过渡的两种打架）× 现价在 EMA20 下方 / EMA20 和 MA60 之间 / MA60 上方。 */
function everyPlay(): { name: string; a: Analysis }[] {
  const CASES: [string, number, "空头结构反弹中" | "多头结构回撤中" | null][] = [
    ["横盘", -0.4, null], ["横盘", 0, null], ["横盘", 0.4, null],
    ["稳定上涨", 0.8, null], ["加速上涨", 0.8, null], ["稳定下跌", -0.8, null], ["加速下跌", -0.8, null],
    ["过渡", -0.4, null], ["过渡", 0, null], ["过渡", 0.4, null],
    ["过渡", 0.4, "空头结构反弹中"], ["过渡", -0.4, "多头结构回撤中"],
  ];
  return CASES.flatMap(([trend, score, conflict]) => [150.96, 195, 230].map((close) => {
    const a = structuredClone(bear);
    a.play = { ...a.play, key: conflict ?? trend };
    a.close = close;
    a.lean = { ...a.lean, score };
    a.drops = a.drops.map((d) => (d.period === 20 ? { ...d, tomorrow: 190 } : d)); // MA20 抵扣价在 EMA20 和 MA60 之间
    a.lean.flips = a.lean.flips.filter((f) => f.price > close); // 夹具的门槛按原现价算，越过的不留
    return { name: `${trend}${conflict ? `·${conflict}` : ""} ${score} @${close}`, a };
  })).concat(
    // 夹具是 20/60 双死叉、线都向下；再加上 20/60 金叉、EMA20 向上的排布（横盘没破位、过渡偏多那一边）
    ["横盘", "过渡"].flatMap((trend) => [-0.4, 0, 0.4].flatMap((score) => [150.96, 195, 230].map((close) => {
      const a = shaped(trend, score, { r2060: 1, ema20Dir: 1, close });
      a.drops = a.drops.map((d) => (d.period === 20 ? { ...d, tomorrow: 190 } : d));
      a.lean.flips = a.lean.flips.filter((f) => f.price > close);
      return { name: `${trend} 20/60 金叉 ${score} @${close}`, a };
    }))),
  );
}
const LABEL_ORDER = ["时机", "盈亏", "止损", "失效", "仓位"];

describe("每份计划都有止损和失效（判断错了的标志）", () => {
  for (const { name, a } of everyPlay()) {
    test(name, () => {
      const plans = buildPlans(a);
      for (const k of ["flat", "holding", "profit", "loss"] as const) {
        const items = plans[k].items;
        const stop = items.find((i) => i.label === "止损");
        const wrong = items.find((i) => i.label === "失效");
        expect({ k, stop: !!stop, wrong: !!wrong }).toEqual({ k, stop: true, wrong: true });
        expect(wrong!.text).toMatch(/\d+\.\d{2}/); // 失效要带价位
        expect(items.some((i) => i.label === "离场")).toBe(false); // 硬离场就叫止损，不另起一条
        // 顺序：时机 → 盈亏 → …… → 止损 → 失效 → 仓位
        const idx = LABEL_ORDER.map((l) => items.findIndex((i) => i.label === l)).filter((i) => i >= 0);
        expect(idx).toEqual([...idx].sort((x, y) => x - y));
        expect(items.at(-1)!.label === "仓位" || items.at(-1)!.label === "失效").toBe(true);
        expect(items.find((i) => i.label === "盈亏")?.text ?? "").not.toMatch(/离场条件|离场底线/);
      }
    });
  }
});

describe("所有打法：价位相对现价说对", () => {
  for (const { name, a } of everyPlay()) {
    test(name, () => {
      const p = buildPlans(a);
      const o = buildOutlook(a);
      const texts = [...Object.values(p).flatMap((x) => [x.action, ...x.items.map((i) => i.text)]),
        ...Object.values(o.effect).map((e) => e.text), o.verdict, o.change];
      for (const t of texts) {
        for (const m of t.matchAll(/(站上|反弹到|高于|回踩到|跌破|收紧到)[^。；，：]*?(\d+\.\d{2})/g)) {
          const price = Number(m[2]);
          const up = ["站上", "反弹到", "高于"].includes(m[1]);
          expect({ t, ok: up ? price > a.close : price < a.close }).toEqual({ t, ok: true });
        }
      }
    });
  }
});

describe("止损和失效的内容来自 playbooks", () => {
  const at = (trend: string, score: number) => {
    const a = structuredClone(bear);
    a.play = { ...a.play, key: trend };
    a.lean = { ...a.lean, score };
    return buildPlans(a);
  };
  const item = (p: ReturnType<typeof buildPlans>[keyof ReturnType<typeof buildPlans>], l: string) => p.items.find((i) => i.label === l)!.text;
  test("横盘：止损是 20/60 死叉；空仓埋伏还要防假突破", () => {
    const p = buildPlans(shaped("横盘", 0, { r2060: 1, ema20Dir: 1 })); // 夹具本身已死叉，那是「横盘破位」
    expect(item(p.holding, "止损")).toContain("死叉");
    expect(item(p.flat, "止损")).toContain("假突破");
  });
  test("稳定上涨：碰到 MA60 不算，60 线组拐头或 20/60 双死叉才走", () => {
    const s = item(at("稳定上涨", 0.8).holding, "止损");
    expect(s).toContain("双死叉");
    expect(s).toContain("不算");
  });
  test("稳定下跌：站上 MA20 抵扣价 + 20/60 双金叉，下跌判断失效；空仓进场后跌回 EMA20 下方就走", () => {
    const p = at("稳定下跌", -0.8);
    expect(item(p.flat, "失效")).toContain("212.21");
    expect(item(p.flat, "失效")).toContain("双金叉");
    expect(item(p.flat, "止损")).toMatch(/跌回 EMA20/);
  });
});

/**
 * 改 20/60 的状态和 EMA20 方向，照脚本的输出改：MA、EMA 两对的上下（1 在上、-1 在下、0 贴着）。
 * 两对都在下方才算双死叉（steps 的 side 换成空头）；任一对已在下方，埋伏的底线 P3 就满足。
 */
function shaped(trend: string, score: number, o: { r2060: -1 | 0 | 1; ema20Dir: -1 | 0 | 1; close?: number; emaRel?: -1 | 0 | 1 }): Analysis {
  const a = structuredClone(bear);
  const emaRel = o.emaRel ?? o.r2060;
  a.play = { ...a.play, key: trend };
  a.close = o.close ?? a.close;
  a.lean = { ...a.lean, score,
    pairs: a.lean.pairs.map((x) => (x.pair === "MA20/MA60" ? { ...x, rel: o.r2060 } : x.pair === "EMA20/EMA60" ? { ...x, rel: emaRel } : x)),
    dirs: { ...a.lean.dirs, EMA20: o.ema20Dir } };
  const side = o.r2060 < 0 && emaRel < 0 ? "空头" : "多头";
  const broken = o.r2060 < 0 || emaRel < 0;
  a.steps = a.steps.map((p) => (p.pair === "20/60" ? { ...p, side } : p));
  a.rules = a.rules.map((r) => (r.id !== "P3" ? r : broken
    ? { ...r, status: "满足", basis: "20/60 已经出现第一个交叉" }
    : { ...r, status: "不满足", basis: "5 天内避免 20/60 双死叉要持平在 140.00（-7.3%）以上" }));
  return a;
}
const label = (p: { items: { label: string; text: string }[] }, l: string) => p.items.find((i) => i.label === l)!.text;

describe("止损、失效看当下：已经成立的照实说", () => {
  test("横盘、20/60 已经死叉：持仓按硬止损离场，空仓不埋伏；看方向不说「拿着」", () => {
    const a = shaped("横盘", 0, { r2060: -1, ema20Dir: -1 });
    const p = buildPlans(a);
    expect(p.holding.action).toContain("离场");
    expect(label(p.holding, "止损")).toContain("已经");
    expect(label(p.flat, "止损")).toContain("别进");
    for (const k of ["holding", "profit", "loss"] as const) expect(buildOutlook(a).effect[k].text).toContain("离场");
    for (const k of ["profit", "loss"] as const) expect(label(p[k], "盈亏")).not.toContain("磨蹭");
    expect(all(p.profit)).not.toContain("把止损提到成本");
  });
  test("横盘、20/60 没死叉：照旧拿着", () => {
    const p = buildPlans(shaped("横盘", 0, { r2060: 1, ema20Dir: 1 }));
    expect(p.holding.action).toBe("拿着，但守住底线。");
    expect(label(p.holding, "止损")).not.toContain("已经");
  });
  test("横盘的失效用脚本判横盘的判据（6 条线相差超过 thresholds.RANGE_SPREAD_PCT），横盘时按定义还没发生", () => {
    expect(label(buildPlans(shaped("横盘", 0, { r2060: 1, ema20Dir: 1 })).flat, "失效")).toContain("超过 5%");
  });
  test("过渡的失效用分数门槛 ±0.6（过渡时按定义还没到），不用 20/60 排布（常常已经成立）", () => {
    for (const r2060 of [-1, 1] as const) {
      const p = buildPlans(shaped("过渡", 0.4, { r2060, ema20Dir: 1 }));
      for (const k of ["flat", "holding"] as const) {
        expect(label(p[k], "失效")).toContain("0.6");
        expect(label(p[k], "失效")).not.toMatch(/20 线组(升到|落到)/);
      }
    }
  });
  test("过渡持仓：已经在 EMA20 下方、EMA20 也向下，止损已经满足，反弹到 EMA20 附近减掉", () => {
    const s = label(buildPlans(shaped("过渡", -0.4, { r2060: -1, ema20Dir: -1 })).holding, "止损");
    expect(s).toContain("已经满足");
    expect(s).toContain("183.08");
  });
  test("下跌类持仓：现价上方的 EMA20 不叫止损位，照实说下方没有均线托底", () => {
    for (const t of ["稳定下跌", "加速下跌"]) {
      const s = label(buildPlans(shaped(t, -0.8, { r2060: -1, ema20Dir: -1 })).holding, "止损");
      expect(s).not.toContain("就是止损位");
      expect(s).toContain("离场点");
    }
  });
  test("多头结构回撤中持仓：失效不另编规则（没有 0.5%、不说别等双死叉）", () => {
    const a = shaped("过渡", -0.4, { r2060: 1, ema20Dir: -1 });
    a.play = { ...a.play, key: "多头结构回撤中" };
    const w = label(buildPlans(a).holding, "失效");
    expect(w).not.toContain("0.5%");
    expect(w).not.toContain("别等双死叉");
  });
  test("看方向：已经在 EMA20 上方，不再说「更早的信号是收盘站上 EMA20」", () => {
    const a = shaped("稳定下跌", -0.8, { r2060: -1, ema20Dir: -1, close: 190 });
    a.drops = a.drops.map((d) => (d.period === 20 ? { ...d, first_low: 5 } : d));
    expect(buildOutlook(a).change).not.toMatch(/站上 EMA20 183/);
  });
});

describe("空仓「不做」的计划，看方向不说「机会 / 买点」", () => {
  for (const t of ["横盘", "过渡"]) for (const r2060 of [-1, 1] as const) {
    test(`${t} 20/60 ${r2060 > 0 ? "金叉" : "死叉"}，偏多`, () => {
      const a = shaped(t, 0.4, { r2060, ema20Dir: 1 });
      expect(buildOutlook(a).effect.flat.text).not.toMatch(/机会|买点/);
      a.drops = a.drops.map((d) => (d.period === 20 ? { ...d, path: d.path.map((p, i) => ({ ...p, close: i < 3 ? 100 : 999 })) } : d));
      expect(buildOutlook(a).effect.flat.text).not.toMatch(/机会|买点/); // 顺风在减弱那一支
    });
  }
});

describe("只成立一半的条件也照实说（第二轮审查）", () => {
  test("横盘：MA20 已在 MA60 下方、EMA20 贴着 EMA60（即将死叉）→ 也按横盘破位离场", () => {
    const p = buildPlans(shaped("横盘", 0, { r2060: -1, emaRel: 0, ema20Dir: -1 }));
    expect(p.holding.action).toContain("离场");
  });
  test("横盘：两对都在上方 → 照旧拿着", () => {
    expect(buildPlans(shaped("横盘", 0, { r2060: 1, ema20Dir: 1 })).holding.action).toBe("拿着，但守住底线。");
  });
  test("过渡分数接近 0：失效也带价位，分数不显示 -0.00", () => {
    const a = shaped("过渡", -1e-17, { r2060: 1, ema20Dir: 1 });
    a.lean.flips = [];
    const w = label(buildPlans(a).flat, "失效");
    expect(w).toMatch(/\d+\.\d{2}/);
    expect(w).not.toContain("-0.00");
  });
  test("空头结构反弹中、已在 MA60 上方：止损不再说「没到减仓位」", () => {
    const a = shaped("过渡", 0.4, { r2060: -1, ema20Dir: 1, close: 230 });
    a.play = { ...a.play, key: "空头结构反弹中" };
    expect(label(buildPlans(a).holding, "止损")).not.toContain("没到减仓位");
  });
  test("稳定上涨空仓、价格已在 MA20 抵扣价下方：不说「仍在抵扣价上方」，止损先说别买", () => {
    const a = shaped("稳定上涨", 0.8, { r2060: 1, ema20Dir: 1, close: 200 }); // 夹具 MA20 抵扣价 212.21
    const p = buildPlans(a);
    expect(label(p.flat, "等什么")).not.toContain("仍在");
    expect(label(p.flat, "止损")).toContain("先别买");
  });
  test("过渡空仓、20/60 已经金叉：等什么不再说「升到 60 线组上方」", () => {
    const p = buildPlans(shaped("过渡", 0.4, { r2060: 1, ema20Dir: 1 }));
    expect(label(p.flat, "等什么")).not.toContain("升到");
  });
});

test("顺风、明天起 MA20 就扣高值：时机行不说「第 1 天前…买点窗口」", () => {
  const a = bullish();
  a.drops = a.drops.map((d) => (d.period === 20 ? { ...d, path: d.path.map((p) => ({ ...p, close: 999 })) } : d));
  const o = buildOutlook(a);
  expect(o.effect.flat.text).not.toMatch(/第 1 天|买点窗口/);
  expect(o.effect.holding.text).not.toContain("第 1 天");
});

test("下跌类空仓的进场条件：已经站上的那条照实说，读起来通顺", () => {
  for (const close of [150.96, 195, 230]) {
    const a = structuredClone(bear);
    a.close = close;
    a.drops = a.drops.map((d) => (d.period === 20 ? { ...d, tomorrow: 190 } : d));
    const t = buildPlans(a).flat.items.find((i) => i.label === "等什么")!.text;
    expect(t).not.toContain("再已经");
    expect(t).toContain(close >= 183.08 ? "已经在 EMA20" : "站上 EMA20");
    expect(t).toContain(close >= 190 ? "已经在 MA20 抵扣价" : "站上 MA20 抵扣价");
  }
});

test("playKey：横盘已死叉是横盘破位，过渡打架用打架的键", () => {
  expect(playKey(bear)).toBe("加速下跌");
  const a = structuredClone(bear);
  a.play = { ...a.play, key: "横盘" };
  expect(playKey(a)).toBe("横盘破位");
  a.play = { ...a.play, key: "空头结构反弹中" };
  expect(playKey(a)).toBe("空头结构反弹中");
});

test("ma20Claim 和看方向的结论说的是同一件事", () => {
  expect(buildOutlook(bear).verdict).toContain("20 天内 MA20 都会向下");
  expect(ma20Claim(bear)).toEqual({ dir: -1, days: 20 });
  const b = bullish(); // MA20 第 5 天起扣高值
  expect(buildOutlook(b).verdict).toContain("未来 4 天 MA20 扣低值");
  expect(ma20Claim(b)).toEqual({ dir: 1, days: 4 });
  const flat = structuredClone(bear);
  flat.lean = { ...flat.lean, score: 0 };
  expect(ma20Claim(flat)).toBeNull();
  const soon = structuredClone(bear);
  soon.drops = soon.drops.map((d) => (d.period === 20 ? { ...d, first_low: 1 } : d));
  expect(buildOutlook(soon).verdict).toContain("明天起");
  expect(ma20Claim(soon)).toBeNull();
  const later = structuredClone(bear);
  later.drops = later.drops.map((d) => (d.period === 20 ? { ...d, first_low: 6 } : d));
  expect(buildOutlook(later).verdict).toContain("MA20 还要向下 5 天");
  expect(ma20Claim(later)).toEqual({ dir: -1, days: 5 });
  const allLow = bullish();
  allLow.drops = allLow.drops.map((d) => (d.period === 20 ? { ...d, path: d.path.map((p) => ({ ...p, close: 1 })) } : d));
  expect(buildOutlook(allLow).verdict).toContain(`未来 ${allLow.drops[0].path.length} 天 MA20 都扣低值`);
  expect(ma20Claim(allLow)).toEqual({ dir: 1, days: allLow.drops[0].path.length });
  const weak = bullish();
  weak.drops = weak.drops.map((d) => (d.period === 20 ? { ...d, path: d.path.map((p) => ({ ...p, close: 999 })) } : d));
  expect(buildOutlook(weak).verdict).toContain("顺风在减弱");
  expect(ma20Claim(weak)).toBeNull();
});

describe("判据和阈值读脚本结果，不在这里重算", () => {
  const withThreshold = (trend: string, key: string, value: number) => {
    const a = shaped(trend, 0.4, { r2060: 1, ema20Dir: 1 });
    a.thresholds = { ...a.thresholds, [key]: { ...a.thresholds[key], value } };
    return buildPlans(a);
  };
  test("横盘末期的 2% 来自 thresholds.DENSE_PCT，三个条件的状态来自 J12–J14", () => {
    const wait = label(withThreshold("横盘", "DENSE_PCT", 3).flat, "等什么");
    expect(wait).toContain("< 3%");
    expect(wait).toMatch(/（J12）.*（J13）.*（J14）/);
  });
  test("过渡的失效门槛来自 thresholds.LEAN_CLEAR", () => {
    expect(label(withThreshold("过渡", "LEAN_CLEAR", 0.7).holding, "失效")).toContain("升到 0.7 以上");
  });
  test("看方向的三档来自 thresholds.LEAN_SOME", () => {
    const a = shaped("过渡", 0.3, { r2060: 1, ema20Dir: 1 });
    expect(buildOutlook(a).verdict).toContain("顺风");
    a.thresholds = { ...a.thresholds, LEAN_SOME: { ...a.thresholds.LEAN_SOME, value: 0.35 } };
    expect(buildOutlook(a).verdict).toContain("没有明确方向");
  });
  test("横盘破位看 P3（埋伏的底线），不看排布", () => {
    const a = shaped("横盘", 0, { r2060: 1, ema20Dir: 1 });
    expect(playKey(a)).toBe("横盘");
    a.rules = a.rules.map((r) => (r.id === "P3" ? { ...r, status: "满足" } : r));
    expect(playKey(a)).toBe("横盘破位");
  });
});

describe("加速上涨有仓位：没见顶部构造不下车，见了也只是提醒（playbooks 0.5 改正）", () => {
  const accel = (p8: "满足" | "不满足") => {
    const a = shaped("加速上涨", 0.8, { r2060: 1, ema20Dir: 1, close: 230 });
    a.rules = a.rules.map((r) => (r.id === "P8" ? { ...r, status: p8 } : r));
    return buildPlans(a);
  };
  test("顶部构造没出现：拿着不下车，不提分批止盈", () => {
    const p = accel("满足");
    expect(p.holding.action).toContain("不下车");
    for (const k of ["holding", "profit"] as const) expect(all(p[k])).not.toMatch(/分批止盈|先止盈/);
  });
  test("顶部构造出现了：只是提醒，等 20 线组拐头（关键性波动）", () => {
    const p = accel("不满足");
    expect(p.holding.action).toContain("只是提醒");
    expect(label(p.holding, "止损")).toContain("关键性波动");
    expect(p.holding.items.find((i) => i.label === "构造")!.rules).toContain("P9");
  });
});

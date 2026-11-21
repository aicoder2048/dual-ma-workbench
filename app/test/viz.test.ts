import { describe, expect, test } from "bun:test";
import { cardQuestions } from "../public/askmenu.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { conclusionCard, holdingRow, parseCost, pnlText, situationOf } from "../public/viz.js";
import type { Analysis } from "../src/citations.ts";
import { EVALUATION_NOTE } from "../src/record.ts";
import { buildReport } from "../src/report.ts";
import nvda from "./fixtures/nvda-analysis.json";
import spyFixture from "./fixtures/spy-2024-04-19-analysis.json";

describe("成本价：浏览器端解析和处境", () => {
  test("逗号、全角数字、空格都能认", () => {
    expect(parseCost("1,200")).toBe(1200);
    expect(parseCost("２００．５")).toBe(200.5);
    expect(parseCost(" 133 ")).toBe(133);
  });
  test("看不懂的、0、负数：不算填了成本", () => {
    for (const s of ["abc", "0", "-5", ""]) expect(parseCost(s)).toBeNull();
  });
  test("逗号只当千分位：133,5 这种看不懂（不悄悄变成 1335）；十六进制、科学计数也不认", () => {
    for (const s of ["133,5", "1,33", "0x10", "1e2", "1.2.3"]) expect(parseCost(s)).toBeNull();
    expect(parseCost("1,234,567.5")).toBe(1234567.5);
  });
  test("处境：价格不低于成本算浮盈，低于算浮亏，没填算持仓", () => {
    expect(situationOf({ pos: "holding", cost: "133" }, 150)).toBe("profit");
    expect(situationOf({ pos: "holding", cost: "150.01" }, 150)).toBe("loss");
    expect(situationOf({ pos: "holding", cost: "200" }, 150)).toBe("loss");
    expect(situationOf({ pos: "holding", cost: "" }, 150)).toBe("holding");
    expect(situationOf({ pos: "flat", cost: "133" }, 150)).toBe("flat");
  });
  test("持平（显示出来一样）：按没填成本给计划，不说「还有浮盈」", () => {
    expect(situationOf({ pos: "holding", cost: "150" }, 150)).toBe("holding");
    expect(situationOf({ pos: "holding", cost: "133.004" }, 133)).toBe("holding");
    expect(pnlText("133.004", 133)).toContain("持平");
  });
  test("提示：持平、看不懂", () => {
    expect(pnlText("150", 150)).toContain("持平");
    expect(pnlText("abc", 150)).toContain("看不懂");
  });
});

describe("盈亏比两位小数：结论卡的小标签和问鸿雁的问题", () => {
  const withRr = (rr: number, verdict: "不做" | "可做") => {
    const a = structuredClone(nvda) as Analysis;
    a.trade_plan.flat = { ...a.trade_plan.flat, rr, rr_verdict: verdict };
    return { a, r: buildReport(a) };
  };
  const chip = (html: string) => html.match(/data-item="rr"[\s\S]*?<b class="num">([^<]+)<\/b>/)![1];
  test("0.0349 写 0.03:1，不写 0.0:1", () => {
    const { a, r } = withRr(0.0349, "不做");
    const card = conclusionCard(r, a.close, { pos: "flat", cost: "" });
    expect(chip(card)).toBe("0.03:1");
    expect(card).toContain("不做：盈亏比 0.03:1，不到 3:1。");
    expect(cardQuestions("verdict", a, r).map((q) => q.text).join("\n")).toContain("盈亏比 0.03:1 是怎么算的");
  });
  test("正好 3 写 3.00:1", () => {
    const { a, r } = withRr(3, "可做");
    expect(chip(conclusionCard(r, a.close, { pos: "flat", cost: "" }))).toBe("3.00:1");
    expect(cardQuestions("verdict", a, r).map((q) => q.text).join("\n")).toContain("盈亏比 3.00:1 是怎么算的");
  });
});

describe("触发价离现价还远（ADR 0026）：结论卡的盈亏比标签写到时重算", () => {
  const a = structuredClone(nvda) as Analysis;
  a.trade_plan.flat = { ...a.trade_plan.flat, entry: { ...a.trade_plan.flat.entry!, far: { level: 190, day: 6, days: 10 } } };
  const r = buildReport(a);
  const card = conclusionCard(r, a.close, { pos: "flat", cost: "" });
  const chip = card.match(/<span class="pchip rr[^>]*>\s*<span class="ck">盈亏比<\/span>[\s\S]*?<\/span>/)![0];
  test("标签不写几比几、不写不做，标灰；悬停里有按明天算的数", () => {
    expect(chip).toContain("pchip rr far");
    expect(chip).toContain("到时重算");
    expect(chip).not.toContain("不做");
    expect(chip).toContain("按明天的触发价 212.21 算是 0.57:1");
    expect(card).not.toContain("不做：盈亏比");
  });
  test("股数标签也写到时重算、标灰；悬停里有按明天算的股数", () => {
    const size = card.match(/<span class="pchip size[^>]*>\s*<span class="ck">股数<\/span>[\s\S]*?<\/span>/)![0];
    expect(size).toContain("pchip size far");
    expect(size).toContain("到时重算");
    expect(size).not.toContain("343</b>");
    expect(size).toContain("按明天的触发价 212.21 算：单位亏损 29.13；没填账户，每 1 万元风险对应 343 股");
  });
  test("问鸿雁问的是什么时候拐头，不问盈亏比怎么算", () => {
    const qs = cardQuestions("verdict", a, r).map((q) => q.text).join("\n");
    expect(qs).toContain("触发价为什么离现价还远，20 线组最早什么时候拐头？");
    expect(qs).not.toContain("盈亏比 0.57:1 是怎么算的");
  });
});

describe("结论卡片读起来（ADR 0028）", () => {
  const nv = structuredClone(nvda) as Analysis;
  const r = buildReport(nv);
  const spyA = structuredClone(spyFixture) as Analysis;
  const spy = buildReport(spyA);
  const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, "");
  const tipOf = (html: string, cls: string) => html.match(new RegExp(`class="${cls}"[^>]*data-tip="([^"]+)"`))![1];
  const card = conclusionCard(r, nv.close, { pos: "flat", cost: "" });
  const spyCard = conclusionCard(spy, spyA.close, { pos: "flat", cost: "" });

  test("标题分两段：现在（看大局的类型·阶段）、模糊判断 · 接下来几周（做推演的倾向）", () => {
    expect(text(card)).toContain("现在加速下跌·延伸");
    expect(text(card)).toContain("模糊判断·接下来几周明显偏空");
    expect(tipOf(card, "concl-now")).toContain("看大局");
    expect(tipOf(card, "concl-lean")).toContain("做推演");
    expect(tipOf(card, "concl-lean")).toContain("不预测明天涨跌");
  });

  test("填了成本、浮盈：持仓一行写浮盈时怎么办，成本填进去", () => {
    const row = holdingRow(r, nv.close, { cost: "133" });
    expect(text(row)).toContain("还有浮盈：止损跟着趋势结构走，不按成本133.00定");
    expect(row).not.toContain("{cost}");
  });
  test("填了成本、浮亏：持仓一行写浮亏时怎么办", () => {
    expect(text(holdingRow(r, nv.close, { cost: "200" }))).toContain("已经浮亏：不等回本");
  });
  test("没填成本：持仓一行没有浮盈亏的建议，成本那里提示可填", () => {
    expect(text(holdingRow(r, nv.close, { cost: "" }))).not.toMatch(/浮盈|浮亏/);
    expect(pnlText("", nv.close)).toContain("填了成本价");
  });

  test("对照一句话：MA200 规则怎么说｜双均线怎么说｜一不一致；评估的数放悬停，写成整句、不用缩写", () => {
    const line = card.match(/<p class="naive[^"]*"[\s\S]*?<\/p>/)![0];
    expect(text(line)).toBe("对照MA200规则：空仓｜双均线：空仓｜一致");
    const t = tipOf(card, "naive same");
    expect(t).toContain("MA200 朴素规则 0.26");
    expect(t).toContain("双均线照方向持有 0.14");
    expect(t).toContain("朴素规则比双均线好");
    expect(t).not.toContain("vs");
  });
  test("对照不一致：标出来", () => {
    const m = nv.ma200 as Extract<Analysis["ma200"], { available: true }>;
    const r2 = buildReport({ ...nv, ma200: { ...m, close_above: true, distance_pct: 3.04, stance: "持有", agrees: false } });
    const line = conclusionCard(r2, nv.close, { pos: "flat", cost: "" }).match(/<p class="naive[^"]*"[\s\S]*?<\/p>/)![0];
    expect(text(line)).toBe("对照MA200规则：持有｜双均线：空仓｜不一致");
    expect(line).toContain('class="naive differ"');
  });

  test("回测：空仓不买的打法没有记录，整行不显示", () => {
    expect(card).not.toContain('class="record"');
  });
  test("回测：有记录时只说本打法：笔数、比随机进场差多少、区间", () => {
    const line = text(spyCard.match(/<p class="record"[\s\S]*?<\/p>/)![0]);
    expect(line).toContain("5笔");
    expect(line).toContain("比随机进场少7.6%");
    expect(line).toContain("90%区间-10.7%~-4.4%");
  });

  test("整套方法的评估免责不在卡片上；页面上固定写一次", () => {
    for (const html of [card, spyCard]) {
      expect(html).not.toContain(EVALUATION_NOTE);
      expect(html).not.toContain("可验证的交易优势");
    }
    const page = readFileSync(resolve(import.meta.dir, "../public/index.html"), "utf8");
    expect(page.split(EVALUATION_NOTE).length - 1).toBe(1);
  });
});

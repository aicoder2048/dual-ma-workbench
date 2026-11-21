import { describe, expect, test } from "bun:test";
import { cardQuestions } from "../public/askmenu.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { conclusionCard, forecastAnswer, holdingRow, parseCost, planBody, pnlText, situationOf, stepVisuals } from "../public/viz.js";
import type { Analysis } from "../src/citations.ts";
import { LEAN_EVIDENCE, SOLVER_EVIDENCE } from "../src/plan.ts";
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

describe("找打法排成固定的格子，按做决定的顺序（ADR 0029）", () => {
  const FLAT = ["能不能做", "等什么信号", "进场价", "止损", "目标和盈亏比", "仓位"];
  const HOLD = ["拿着还是走", "盯什么信号", "止损 / 离场价", "目标", "浮盈 / 浮亏怎么办"];
  const ENT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
  const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENT[m]).replace(/\s+/g, "");
  /** 计划正文按格子切开：标题、正文、依据（折叠的那段）。 */
  const cells = (html: string) => html.split('<li class="pcell"').slice(1).map((c) => {
    const [main, basis = ""] = c.split('<div class="pc-main">')[1].split('<details class="basis"');
    return { key: c.match(/data-cell="(\w+)"/)![1], title: c.match(/<b class="pc-title">([^<]+)<\/b>/)![1], main: text(main), basis: text(basis) };
  });
  const cell = (html: string, key: string) => cells(html).find((c) => c.key === key)!;
  const nv = structuredClone(nvda) as Analysis;
  const spyA = structuredClone(spyFixture) as Analysis;
  const flat = { pos: "flat", cost: "" };
  const hold = { pos: "holding", cost: "" };

  /** 换成另一套打法（和 plan.test 的 setKey 同一个做法）：不买的打法空仓没有进场、止损、股数。 */
  const BUYS = new Set(["横盘", "稳定上涨", "多头结构回撤中", "加速下跌"]);
  const withKey = (key: string) => {
    const a = structuredClone(nvda) as Analysis;
    a.play = { ...a.play, key: key === "横盘破位" ? "横盘" : key }; // 横盘破位只是交易计划的键（脚本的 plan_key）
    const neutral = { rr: null, rr_verdict: null, rr_gap: null };
    const f = BUYS.has(key) ? { ...a.trade_plan.flat, ...neutral } : { ...a.trade_plan.flat, ...neutral, entry: null, stop: null, size: null, risk_pct: null, targets: [], at_target: null };
    a.trade_plan = { ...a.trade_plan, key, flat: f };
    return a;
  };
  const KEYS = ["横盘", "横盘破位", "稳定上涨", "加速上涨", "稳定下跌", "加速下跌", "过渡", "空头结构反弹中", "多头结构回撤中"];

  test("空仓六格、持仓五格，顺序固定", () => {
    for (const [a, r] of [[nv, buildReport(nv)], [spyA, buildReport(spyA)]] as const) {
      expect(cells(planBody(r, flat, a.close)).map((c) => c.title)).toEqual(FLAT);
      expect(cells(planBody(r, hold, a.close)).map((c) => c.title)).toEqual(HOLD);
    }
  });

  test("每套打法、每种处境：格子一个不少，计划的每一条只出现在一格里", () => {
    for (const key of KEYS) {
      const a = withKey(key);
      const r = buildReport(a);
      for (const [k, p] of [["flat", flat], ["holding", hold], ["profit", { pos: "holding", cost: "1" }], ["loss", { pos: "holding", cost: "9999" }]] as const) {
        const html = planBody(r, p, a.close);
        const cs = cells(html);
        expect({ key, k, titles: cs.map((c) => c.title) }).toEqual({ key, k, titles: k === "flat" ? FLAT : HOLD });
        for (const c of cs) expect({ key, k, cell: c.key, filled: c.main.length > 0 }).toEqual({ key, k, cell: c.key, filled: true });
        for (const i of r.plans[k].items) {
          const body = text(i.text.replaceAll("{cost}", k === "profit" ? "1.00" : k === "loss" ? "9999.00" : "成本"));
          const hits = cs.filter((c) => (c.main + c.basis).includes(body)).length;
          expect({ key, k, label: i.label, hits }).toEqual({ key, k, label: i.label, hits: 1 });
        }
      }
    }
  });

  test("空仓（SPY 稳定上涨·回撤中）：结论一个词在前；进场价、止损、目标和盈亏比、股数各在各的格子", () => {
    const r = buildReport(spyA);
    const html = planBody(r, flat, spyA.close);
    const t = r.plans.flat.trade;
    expect(cell(html, "go").main).toBe("不做盈亏比1.94:1，不到3:1。"); // 做法以"不做："开头，这个词不写两遍
    expect(cell(html, "entry").main).toContain(t.entry!.price!.toFixed(2));
    expect(cell(html, "stop").main).toContain(t.stop!.price!.toFixed(2));
    expect(cell(html, "stop").main).toContain("60线组拐头向下");
    expect(cell(html, "target").main).toContain(`目标1：${t.targets[0].kind}`);
    expect(cell(html, "target").main).toContain("盈亏比");
    expect(cell(html, "size").main).toContain(String(t.size!.per_10k));
    expect(cell(html, "signal").main).toContain("吃回撤四个条件");
  });

  test("技术细节挂在它支撑的那一格下面当依据：条件清单在等什么信号，筹码山在目标，推演求解在进场价", () => {
    const a = structuredClone(nvda) as Analysis;
    a.trade_plan.flat = { ...a.trade_plan.flat, entry: { ...a.trade_plan.flat.entry!, far: { level: 190, day: 6, days: 30 } },
      mountain: { foot: 240, top: 250, date: "2026-01-02~2026-06-30" } };
    const r = buildReport(a);
    const html = planBody(r, flat, a.close);
    expect(cell(html, "signal").basis).toContain("J21");
    expect(cell(html, "signal").main).not.toContain("形成中");
    expect(cell(html, "target").basis).toContain("上方最近的筹码山");
    expect(cell(html, "target").main).not.toContain("筹码山");
    expect(cell(html, "entry").basis).toContain("辅助·触发价");
    expect(cell(html, "entry").basis).toContain("（H4）");
    expect(cell(html, "entry").main).not.toContain("按收盘持平推演");
    expect(html).toContain('<button type="button" class="cite src rule-ref" data-kind="S" data-ref="rules#P38"');
  });

  test("空仓不买的打法（稳定下跌）：没有内容的格子写「—」和为什么，格子不消失", () => {
    const a = withKey("稳定下跌");
    const html = planBody(buildReport(a), flat, a.close);
    expect(cell(html, "go").main).toContain("不做");
    for (const k of ["target", "size"]) expect(cell(html, k).main).toMatch(/^—.*不进场/);
    expect(cell(html, "entry").main).toContain("先看");
  });

  test("持仓（加速下跌）：结论是减仓；盯住减仓位；下跌趋势不找目标写为什么；浮盈时写浮盈怎么办，成本填进去", () => {
    const a = structuredClone(nvda) as Analysis; // 像 QQQ 2026-11-20：持仓没有目标位，脚本写了为什么
    a.trade_plan.holding = { ...a.trade_plan.holding, targets: [], at_target: null,
      notes: ["下跌趋势还没拐头向上，持仓不找目标位：上方的缺口、均线密集是拐头向上以后才当目标的（P25）"] };
    const r = buildReport(a);
    const html = planBody(r, hold, nv.close);
    expect(cell(html, "go").main).toContain("减仓");
    expect(cell(html, "signal").main).toContain("减仓位");
    expect(cell(html, "target").main).toContain("持仓不找目标位");
    expect(cell(html, "pnl").main).toContain("没填成本");
    const profit = planBody(r, { pos: "holding", cost: "133" }, nv.close);
    expect(cell(profit, "pnl").main).toContain("还有浮盈：止损跟着趋势结构走，不按成本133.00定");
    expect(profit).not.toContain("{cost}");
  });
});

describe("做推演：先给结论，再给数据（ADR 0030）", () => {
  const nv = structuredClone(nvda) as Analysis;
  const r = buildReport(nv);
  const html = forecastAnswer(r);
  const text = (h: string) => h.replace(/<[^>]+>/g, "").replace(/\s+/g, "");
  const at = (needle: string) => {
    const i = html.indexOf(needle);
    if (i < 0) throw new Error(`做推演里没有 ${needle}`);
    return i;
  };
  /** 一块：从 data-part="name" 所在的标签起，到下一块之前。 */
  const part = (name: string) => {
    const start = html.lastIndexOf("<", at(`data-part="${name}"`));
    const next = html.slice(start + 1).search(/<[a-z]+ [^>]*data-part="/);
    return next < 0 ? html.slice(start) : html.slice(start, start + 1 + next);
  };

  test("第一句是模糊判断翻成的动作，大字，在推翻条件和关键变化前面", () => {
    expect(text(part("call"))).toContain("接下来几周均线向下：反弹是减仓机会，不是抄底机会");
    expect(part("call")).toContain('class="fc-headline');
    expect(at('data-part="call"')).toBeLessThan(at('data-part="invalid"'));
    expect(at('data-part="invalid"')).toBeLessThan(at('data-part="changes"'));
  });
  test("结论句上面写「模糊判断 · 接下来几周」和档位，和结论卡片同一个说法", () => {
    expect(text(part("call"))).toContain("模糊判断·接下来几周明显偏空");
  });
  test("历史评估小标签（H1）挨着模糊判断，悬停写清结论和出处", () => {
    const tag = part("call").match(/<span class="ev-tag fc-h1"[^>]*>([^<]+)<\/span>/)!;
    expect(tag[1]).toBe(LEAN_EVIDENCE.tag);
    expect(tag[0].match(/data-tip="([^"]+)"/)![1]).toBe(LEAN_EVIDENCE.tip);
  });
  test("推翻条件：收盘到哪个价位、多少天内；来自推演求解时标辅助，附 H4", () => {
    const inv = text(part("invalid"));
    expect(inv).toContain("推翻条件");
    expect(inv).toContain("206.26");
    expect(inv).toContain("30天内");
    expect(part("invalid")).toContain("辅助 · 推演求解");
    expect(html).toContain(SOLVER_EVIDENCE);
  });
  test("最近的关键变化：20 线组、60 线组各一行，写站上 / 跌破什么价才拐头", () => {
    const ch = part("changes");
    expect(ch.match(/data-group="\d+"/g)).toEqual(['data-group="20"', 'data-group="60"']);
    expect(text(ch)).toContain("20线组向下");
    expect(text(ch)).toContain("MA20抵扣价212.21");
  });
  test("数据不在第一眼：抵扣价表、持平情景、全部求解都折叠在依据里，默认收起", () => {
    expect(html).not.toContain("hurdles");
    const data = stepVisuals("forecast", r.visual, r.forecast);
    expect(data.trimStart()).toStartWith('<details class="ref more fc-data">');
    expect(data).not.toMatch(/<details[^>]*\sopen/);
    for (const s of ['table class="vt hurdles"', 'class="drops"', "flow scenario", 'class="solves"', "lean-evidence"]) expect(data).toContain(s);
    expect(text(data)).toContain("打法的条件最早哪天齐");
  });
  test("偏多（SPY 2024-04-19）：回撤是加仓机会；推翻条件不是求解给的，不标辅助", () => {
    const h = forecastAnswer(buildReport(structuredClone(spyFixture) as Analysis));
    expect(text(h)).toContain("接下来几周均线向上：回撤是加仓机会");
    expect(h).not.toContain("辅助 · 推演求解");
  });
  test("结论卡片的「模糊判断 · 接下来几周」悬停：依据在做推演（不再说更多推演）", () => {
    const tip = conclusionCard(r, nv.close, { pos: "flat", cost: "" }).match(/class="concl-lean"[^>]*data-tip="([^"]+)"/)![1];
    expect(tip).toContain("依据在下面「做推演」");
    expect(tip).not.toContain("更多推演");
  });
});

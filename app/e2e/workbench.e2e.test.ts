/**
 * 端到端：真的服务端代码（进程内，假行情 + 假语音合成）+ 真的 Chrome。
 * 运行：bun run e2e（用本机安装的 Chrome，不下载浏览器）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { Analyzer, pythonRunner } from "../src/analyze.ts";
import { Backtests } from "../src/backtest/service.ts";
import type { Analysis } from "../src/citations.ts";
import { createHandler } from "../src/http.ts";
import { Journal } from "../src/journal.ts";
import { DrillBank } from "../src/practice/drills.ts";
import { seeded } from "../src/practice/pool.ts";
import { Practice } from "../src/practice/service.ts";
import { SessionStore } from "../src/practice/session.ts";
import { prices, REAL, REAL_TICKER } from "../test/fixtures/practice-prices.ts";
import { SettingsStore, sizingArgs } from "../src/settings.ts";
import { SourceLibrary } from "../src/sources.ts";
import { Speaker } from "../src/tts.ts";
import { Watchlist } from "../src/watchlist.ts";
import nvda from "../test/fixtures/nvda-analysis.json";
import spy from "../test/fixtures/spy-2024-04-19-analysis.json";

/** 300 个交易日的合成日线：图表工具（范围、读数、门槛线）要有真数据才能测。 */
const CHART = (() => {
  const days: string[] = [];
  for (let d = new Date("2025-08-01"); days.length < 300; d.setDate(d.getDate() + 1)) {
    if (d.getDay() % 6) days.push(d.toISOString().slice(0, 10));
  }
  const close = days.map((_, i) => 200 + 30 * Math.sin(i / 25) - i * 0.1);
  const line = (k: number) => days.map((time, i) => ({ time, value: close[i] + k }));
  // tone：每根 K 线的颜色（脚本算好的），「着色」图层开着才用。这份没有 tone_source，像旧的分析结果
  const candles = days.map((time, i) => ({ time, open: close[i] - 1, high: close[i] + 2, low: close[i] - 2, close: close[i], tone: ["bull", "mixed", "bear"][i % 3] }));
  // 周线：按周五结束的自然周合并，时间是那一周最后一个交易日（和 skill 的 weekly.to_weekly 一样）；最后一周没走完
  const friday = (t: string) => { const d = new Date(`${t}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 5 - d.getUTCDay()); return d.toISOString().slice(0, 10); };
  const groups = new Map<string, typeof candles>();
  for (const c of candles) groups.set(friday(c.time), [...(groups.get(friday(c.time)) ?? []), c]);
  const weeks = [...groups.values()].map((g) => ({ time: g.at(-1)!.time, open: g[0].open, high: Math.max(...g.map((c) => c.high)),
    low: Math.min(...g.map((c) => c.low)), close: g.at(-1)!.close }));
  const wline = (k: number) => weeks.map((w) => ({ time: w.time, value: w.close + k }));
  const weekly = {
    candles: weeks, volume: weeks.map((w) => ({ time: w.time, value: 169e6, spike: false })),
    lines: { MA20: wline(6), EMA20: wline(5), MA60: wline(12), EMA60: wline(11), MA120: wline(18).slice(30), EMA120: wline(17).slice(30) },
    drops: [{ time: weeks.at(-20)!.time, period: 20 }], partial: true,
  };
  return {
    candles, weekly,
    // 量 33.8M、1.2 倍均量；最后一根是大量（2.4 倍，读数条标黄）
    volume: days.map((time, i) => (i === 299 ? { time, value: 81.1e6, spike: true, ratio: 2.4 } : { time, value: 33.8e6, spike: false, ratio: 1.2 })),
    lines: { MA20: line(5), EMA20: line(4), MA60: line(10), EMA60: line(9), MA120: line(15), EMA120: line(14), MA200: line(20).slice(199) },
    drops: [{ time: days[280], period: 20 }],
  };
})();

/** 财报日替身：图上三次过去的财报，下一次在最后一根之后 3 个交易日（提醒窗口 10 天内）。 */
const EARN_NEXT = (() => {
  const d = new Date(`${CHART.candles.at(-1)!.time}T00:00:00Z`);
  for (let n = 0; n < 3;) { d.setUTCDate(d.getUTCDate() + 1); if (d.getUTCDay() % 6) n++; }
  return d.toISOString().slice(0, 10);
})();
const EARNINGS = { available: true, past: [CHART.candles[120].time, CHART.candles[183].time, CHART.candles[246].time], next: EARN_NEXT, days_to_next: 3, source: "yfinance" };

/** 结构标注替身：落在 CHART 上的波段、完成的顶部构造、只差一根的底部构造、已形成的 M 顶和 2B 顶。 */
const STRUCTURE = (() => {
  const d = (i: number) => CHART.candles[i].time;
  const hi = (i: number) => CHART.candles[i].high, lo = (i: number) => CHART.candles[i].low;
  const construct = { extreme: false, broken_date: null, complete_at: null, next_at: null, bars_left: null };
  const next = (nvda as Analysis).structure.bottom!.next_at; // 找打法里"还差"读这个价位，要和 NVDA 替身的规则对得上
  return {
    available: true,
    top: { ...construct, side: "顶部构造", state: "已完成", pivot_date: d(240), pivot_price: hi(240), lh_date: d(241), done_date: d(242), invalidation: hi(240) },
    bottom: { ...construct, side: "底部构造", state: "形成中", pivot_date: d(290), pivot_price: lo(290), lh_date: d(291), done_date: null,
      invalidation: lo(290), complete_at: next, next_at: next, bars_left: 1 },
    pivots: [{ kind: "低", date: d(200), price: lo(200) }, { kind: "高", date: d(215), price: hi(215) },
      { kind: "低", date: d(225), price: lo(225) }, { kind: "高", date: d(240), price: hi(240) }],
    patterns: [
      { name: "M 顶", state: "已形成", dates: [d(215), d(225), d(240)], level: lo(225), confirmed: d(250) },
      { name: "2B 顶", state: "已形成", dates: [d(255), d(262)], level: hi(255), confirmed: d(264) },
    ],
  };
})();

/** 标记挤在最右边的替身：底部构造在倒数第 3 根、顶部构造在倒数第 2 根、2B 顶确认在最新一根，正好在价格轴标签旁边。 */
const EDGE_STRUCTURE = (() => {
  const d = (i: number) => CHART.candles[i].time;
  return { ...STRUCTURE,
    top: { ...STRUCTURE.top, pivot_date: d(298), pivot_price: CHART.candles[298].high, lh_date: d(299), done_date: d(299) },
    bottom: { ...STRUCTURE.bottom, pivot_date: d(297), pivot_price: CHART.candles[297].low, lh_date: d(298) },
    patterns: [{ name: "2B 顶", state: "已形成", dates: [d(290), d(298)], level: CHART.candles[290].high, confirmed: d(299) }] };
})();

/** 缺口替身：第 150、270 根跳空向下，之后没补满（下沿是之后最高价够到的地方）。 */
const GAPS = [150, 270].map((i) => ({ date: CHART.candles[i].time, top: CHART.candles[i - 1].low + 6, bottom: CHART.candles[i - 1].low + 1 }));

/** 挤的替身（像 NVDA）：8 个没补的缺口挤在 200 ~ 220，和结论的价位线（触发 212.21、判断失效 206.26……）叠在一起；最远那个是目标位。 */
const CROWD_GAPS = [60, 90, 110, 130, 160, 180, 200, 230].map((i, k) => ({ date: CHART.candles[i].time, bottom: 200 + k * 2.5, top: 202 + k * 2.5 }));

/**
 * 带颜色来源的替身（像本机配了着色插件）：日线、周线各有各的 tone_source，名字和说明一眼看得出是假的。
 * 日线的颜色十根一轮：绿 4 根、灰 1 根、黑 3 根、灰 2 根，最前面 5 根没有颜色（像均线还没算出来的那段）。
 * 所以第 10、20 … 290 根转绿，第 15、25 … 295 根转黑；第 5 根是黑的，但上一根没有颜色，不算变色。
 * 第 240、250 根（转绿）正好是 STRUCTURE 的顶部构造和 M 顶标记所在的那根。
 * 周线两绿两黑一轮：第 4、8 … 根转绿，第 2、6 … 根转黑。
 */
const TONE_DAY = { key: "plugin", name: "假规则：按日期单双", legend: ["单号绿、双号黑（测试用，不是真规则）", "第二行：灰色是凑数的"], warning: null };
const TONE_WEEK = { key: "plugin", name: "假规则：周线版", legend: ["周线的假说明（测试用）"], warning: null };
const TONE_WARNING = "着色插件 /tmp/fake_tones.py 没用上，退回自带规则：文件不存在";
const TONE_CHART = {
  ...CHART,
  candles: CHART.candles.map((c, i) => ({ ...c, tone: i < 5 ? undefined : ["bull", "bull", "bull", "bull", "mixed", "bear", "bear", "bear", "mixed", "mixed"][i % 10] })),
  tone_source: TONE_DAY,
  weekly: { ...CHART.weekly, candles: CHART.weekly.candles.map((c, k) => ({ ...c, tone: ["bull", "bull", "bear", "bear"][k % 4] })), tone_source: TONE_WEEK },
};
/** 夹具里日线变色的那几根：照上面的说明写出来，不用页面里的规则算。upTo：只数到第几根（回放）。 */
const dayTurns = (upTo = 299) => CHART.candles.flatMap((c, i) => (i > upTo ? [] : i >= 10 && i % 10 === 0 ? [[c.time, "bull"]] : i >= 15 && i % 10 === 5 ? [[c.time, "bear"]] : []));
const weekTurns = () => CHART.weekly.candles.flatMap((c, k) => (k >= 4 && k % 4 === 0 ? [[c.time, "bull"]] : k % 4 === 2 ? [[c.time, "bear"]] : []));

/** 计划记下的上方筹码山替身（P38，只作参考）：山脚 175、山顶 185，落在 CHART 的价格范围里。 */
const PROFILE_REF = { foot: 175, top: 185, date: `${CHART.candles[48].time}~${CHART.candles[299].time}` };

const MP3 = readFileSync(resolve(import.meta.dir, "../test/fixtures/tts-sample.mp3"));
const ttsCalls: { text: string; voice: string }[] = [];
const wsSent: any[] = [];
const analyzeCalls: string[][] = []; // 工作台交给脚本的参数（看仓位设置传没传过去）
let staleNext = false;
let warningNext: string | null = null;
const sockets = new Set<any>(); // 连着的页面，用来模拟服务端推消息
const lastPrompt = () => wsSent.filter((m) => m.type === "prompt").at(-1);
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
let base = "";
let practiceDir = "";
/** 识别题库（测试这边读标准答案，像出题人一样知道答案在哪根）。 */
let drillBank: DrillBank;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "dma-e2e-"));
  // 盲测练习：假的"真实"行情（代码 ZQXT，价格 3000 ~ 6000），真的 dma_analyze.py
  practiceDir = join(dir, "practice");
  const journal = new Journal(join(dir, "journal.json"));
  const practice = new Practice({ store: new SessionStore(join(dir, "sessions.json")), journal, prices, run: pythonRunner,
    dir: practiceDir, pool: [{ ticker: REAL_TICKER }], random: seeded(3) }); // 和单元测试同一道题：之后 40 根会碰到止损
  const settings = new SettingsStore(join(dir, "s.json"));
  const analyzer = new Analyzer(async (args) => {
      analyzeCalls.push(args);
      if (args[0] === "ANT") throw new Error("取不到 ANT 的行情");
      if (args[0] === "SLOW") { await Bun.sleep(1500); throw new Error("SLOW 超时"); }
      if (args[0] === "SPY") { // 稳定上涨·回撤中：交易日志用；带了 --account 就照脚本给股数（替身：按 1000 ÷ 单位亏损）
        const a = structuredClone(spy) as Analysis;
        const z = a.trade_plan.flat.size!;
        if (args.includes("--account")) a.trade_plan.flat.size = { ...z, shares: Math.floor(1000 / z.unit_risk), risk_amount: 1000, basis: `1000 ÷ 单位亏损 ${z.unit_risk.toFixed(2)}` };
        const rp = args.indexOf("--risk-pct"); // 替身照脚本算仓位比例：比例 ÷ 止损幅度（ADR 0039）
        if (rp >= 0) {
          const risk = Number(args[rp + 1]), stop = (z.unit_risk / a.trade_plan.flat.entry!.price!) * 100;
          a.trade_plan.flat.size = { ...a.trade_plan.flat.size!, risk_pct: risk, stop_pct: stop, account_pct: (risk / stop) * 100 };
        }
        return JSON.stringify({ analysis: a, chart: CHART });
      }
      if (args[0] === "DEEP") { // 稳定上涨里 20/60 已交叉：仍叫回撤中，是深回撤（J7）
        const a = structuredClone(spy) as Analysis;
        return JSON.stringify({ analysis: { ...a, label: "DEEP", regime: { ...a.regime, crossed: true } }, chart: CHART });
      }
      if (args[0] === "TRANS") { // 过渡状态：第 ④ 问写明是哪一种、凭什么，不画阶段树
        const a = structuredClone(spy) as Analysis;
        const why = "60 在 120 上方，但 60 线组已经向下；20/60 已是空头、20 线组正往上走：结构已经坏了，这是反弹";
        return JSON.stringify({ analysis: { ...a, label: "TRANS", regime: { ...a.regime, type: null, stage: null, depth: null, transition: "空头结构反弹中", name: "空头结构反弹中", why } }, chart: CHART });
      }
      if (args[0] === "BOUNCE") { // 空头结构反弹中：计划里有推演求解的辅助条，清单里有回测不支持的 J18
        const n = nvda as Analysis;
        const flat = { ...n.trade_plan.flat, entry: null, stop: null, targets: [], rr: null, rr_verdict: null, rr_gap: null, risk_pct: null, size: null };
        return JSON.stringify({ analysis: { ...n, label: "BOUNCE", play: { ...n.play, key: "空头结构反弹中", rules: ["P17", "J18", "J17"] },
          trade_plan: { ...n.trade_plan, key: "空头结构反弹中", flat } }, chart: CHART });
      }
      if (args[0] === "STRUCT") { // 结构标注和缺口：两个没补的缺口，近的那个是交易计划的目标位
        const n = nvda as Analysis;
        const flat = { ...n.trade_plan.flat, targets: [{ price: GAPS[1].bottom, kind: "缺口", rule: "P25", source: "视频" as const, date: GAPS[1].date }] };
        return JSON.stringify({ analysis: { ...n, label: "STRUCT", structure: STRUCTURE, gaps: GAPS, trade_plan: { ...n.trade_plan, flat } }, chart: CHART });
      }
      if (args[0] === "FAR") { // 触发价离现价还远（ADR 0026）：明天要站上 212.21，按收盘持平推演第 6 个交易日站上 190.00 就一起拐头
        const n = nvda as Analysis;
        const entry = { ...n.trade_plan.flat.entry!, far: { level: 190, day: 6, days: 10 } };
        return JSON.stringify({ analysis: { ...n, label: "FAR", trade_plan: { ...n.trade_plan, flat: { ...n.trade_plan.flat, entry } } }, chart: CHART });
      }
      if (args[0] === "PROFILE") { // 交易计划记下了上方的筹码山（P38）：图上画参考带，目标照旧
        const n = nvda as Analysis;
        const flat = { ...n.trade_plan.flat, mountain: PROFILE_REF };
        return JSON.stringify({ analysis: { ...n, label: "PROFILE", trade_plan: { ...n.trade_plan, flat } }, chart: CHART });
      }
      if (args[0] === "CROWD") {
        const n = nvda as Analysis;
        const far = CROWD_GAPS.at(-1)!;
        const flat = { ...n.trade_plan.flat, targets: [{ price: far.bottom, kind: "缺口", rule: "P25", source: "视频" as const, date: far.date }] };
        return JSON.stringify({ analysis: { ...n, label: "CROWD", structure: STRUCTURE, gaps: CROWD_GAPS, trade_plan: { ...n.trade_plan, flat } }, chart: CHART });
      }
      if (args[0] === "TONE") { // 颜色是着色插件算的；带结构标注，看小三角和构造、形态的标记在同一根上怎么放
        return JSON.stringify({ analysis: { ...(nvda as Analysis), label: "TONE", structure: STRUCTURE }, chart: TONE_CHART });
      }
      if (args[0] === "EDGE") { // 结构标记、变色提示都在最右边几根，挨着价格轴标签
        return JSON.stringify({ analysis: { ...(nvda as Analysis), label: "EDGE", structure: EDGE_STRUCTURE }, chart: TONE_CHART });
      }
      if (args[0] === "TONEWARN") { // 着色插件没用上：退回自带规则，tone_source 里带着原因
        return JSON.stringify({ analysis: { ...(nvda as Analysis), label: "TONEWARN" },
          chart: { ...TONE_CHART, tone_source: { key: "builtin", name: "假的自带规则", legend: ["自带规则的假说明（测试用）"], warning: TONE_WARNING } } });
      }
      if (args[0] === "EARN") { // 3 天后财报：图上标 E，结论卡片提醒跳空
        const n = nvda as Analysis;
        return JSON.stringify({ analysis: { ...n, label: "EARN", earnings: EARNINGS,
          thresholds: { ...n.thresholds, EARNINGS_WARN_DAYS: { value: 10, source: "脚本自定" } } }, chart: CHART });
      }
      return JSON.stringify({ analysis: { ...(nvda as Analysis), label: args[0], warning: warningNext ?? nvda.warning }, chart: CHART });
  }, Date.now, () => "polygon", () => sizingArgs(settings.get()));
  analyzer.mount(practice);
  // 识别题库：同一段假"真实"行情，真的 scan.py；先出好几段的题
  const drills = new DrillBank({ prices, dir: join(dir, "drills"), pool: [{ ticker: REAL_TICKER }], random: seeded(5) });
  await drills.fill(3);
  drillBank = drills;
  // 回测：真的服务端和子进程，planrun.py 换成替身（同样的输出格式，结果是 CLI 真跑出来的 NVDA）
  const backtests = new Backtests({ dir: join(dir, "backtests"), watchlist: () => ["NVDA"],
    command: (args) => ["bun", resolve(import.meta.dir, "../test/fixtures/fake-planrun.ts"), ...args] });
  const handler = createHandler({
    analyzer, practice, drills, backtests,
    watchlist: new Watchlist(join(dir, "w.json")), journal,
    library: SourceLibrary.load(),
    publicDir: resolve(import.meta.dir, "../public"),
    settings,
    // 假清单：不读本机 pi 的登录
    catalog: { list: async () => [
      { id: "openai-codex/gpt-6.1-sol", provider: "openai-codex", name: "GPT-6.1 Sol", billing: "订阅", verified: true, image: true,
        thinking: ["minimal", "low", "medium", "high", "xhigh", "max"] },
      { id: "openai-codex/gpt-6.1-terra", provider: "openai-codex", name: "GPT-6.1 Terra", billing: "订阅", verified: false, image: true,
        thinking: ["low", "medium", "high"] },
      { id: "deepseek/deepseek-flash", provider: "deepseek", name: "DeepSeek Flash", billing: "按量计费", verified: true, image: true,
        thinking: ["off", "low", "high", "max"] },
    ] },
    tts: new Speaker(async (text, voice) => { ttsCalls.push({ text, voice }); return new Uint8Array(MP3); }),
  });
  // WebSocket 替身：记下浏览器发来的消息；连上就告诉两个面板"空闲"，输入框才可用
  server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: (req, srv) => (new URL(req.url).pathname === "/ws" ? (srv.upgrade(req) ? undefined : new Response("", { status: 400 })) : handler(req)),
    websocket: {
      maxPayloadLength: 24 * 1024 * 1024,
      open(ws) {
        sockets.add(ws);
        if (staleNext) ws.send(JSON.stringify({ type: "stale", message: "服务端代码更新过：按 Ctrl+C 后运行 just wildgoose" }));
        for (const agent of ["analyst", "advisor"]) ws.send(JSON.stringify({ type: "status", agent, busy: false }));
      },
      message(_ws, m) { wsSent.push(JSON.parse(String(m))); },
      close(ws) { sockets.delete(ws); },
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ channel: "chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
}, 120_000);

// 本机 Chrome 关闭要 10 秒左右，超过 bun 钩子默认的 5 秒
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
}, 30_000);

/** 打开工作台，等模糊判断卡片出来。errors 收集页面里没接住的异常。 */
async function open(setup?: (p: Page) => Promise<void>, ticker = "NVDA") {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await setup?.(page);
  await page.goto(`${base}/#${ticker}`);
  await page.waitForSelector(".lean-label");
  return { page, errors };
}

/** 在鸿雁面板里放一条回答（不经过模型）。 */
async function addAdvisorAnswer(page: Page, text: string) {
  await page.evaluate(async (text) => {
    const { panels } = await import("/app.js");
    panels.advisor.history([
      { role: "user", text: "抵扣价是什么？" },
      { role: "assistant", text, tools: [], checks: [], book: null },
    ]);
  }, text);
}

describe("设置", () => {
  test("仓位：账户规模、按比例（默认 1%）或固定金额，默认视图看得见；填了账户就把参数交给脚本，结论卡片换成股数", async () => {
    const { page, errors } = await open(undefined, "SPY@2024-04-19");
    await page.click("#settings-btn");
    for (const sel of ["#sp-account", "#sp-riskPct", "#sp-riskAmount", "input[name=riskMode][value=pct]"]) {
      await page.locator(sel).scrollIntoViewIfNeeded();
      expect({ sel, ok: await notCovered(page, sel) }).toEqual({ sel, ok: true });
    }
    expect(await page.inputValue("#sp-riskPct")).toBe("1");
    expect(await page.isChecked("input[name=riskMode][value=pct]")).toBe(true);
    await page.fill("#sp-account", "100000");
    await page.press("#sp-account", "Enter");
    await page.waitForFunction(() => document.getElementById("sp-status")?.textContent?.includes("重算股数"));
    await page.waitForFunction(() => document.querySelector('#verdict .concl-row[data-situation="flat"] [data-item=size]')?.textContent?.includes("/万元") === false);
    expect(analyzeCalls.some((a) => a[0] === "SPY" && a.join(" ").includes("--account 100000 --risk-pct 1"))).toBe(true);
    expect(await page.textContent('#verdict .concl-row[data-situation="flat"] [data-item=size]')).toContain("80");
    // 清空账户：回到每 1 万元风险
    await page.fill("#sp-account", "");
    await page.press("#sp-account", "Enter");
    await page.waitForFunction(() => document.querySelector('#verdict .concl-row[data-situation="flat"] [data-item=size]')?.textContent?.includes("/万元"));
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  test("能打开，默认长风云希、鸿雁晓晓", async () => {
    const { page, errors } = await open();
    await page.click("#settings-btn");
    await expect(page.isVisible("#settings-panel")).resolves.toBe(true);
    expect(await page.inputValue("select[name=voiceAnalyst]")).toBe("zh-CN-YunxiNeural");
    expect(await page.inputValue("select[name=voiceAdvisor]")).toBe("zh-CN-XiaoxiaoNeural");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("打开设置：后面的页面压暗，面板比卡片高一层；点暗处关闭（深色主题也分得清）", async () => {
    const { page, errors } = await open(async (p) => {
      await p.addInitScript(() => localStorage.setItem("dma-theme", "dark"));
    });
    const scrim = () => page.evaluate(() => getComputedStyle(document.body, "::after").backgroundColor);
    expect(await scrim()).toBe("rgba(0, 0, 0, 0)");
    await page.click("#settings-btn");
    expect(await scrim()).not.toBe("rgba(0, 0, 0, 0)");
    const bg = await page.evaluate(() => [
      getComputedStyle(document.getElementById("settings-panel")!).backgroundColor,
      getComputedStyle(document.querySelector(".card")!).backgroundColor,
    ]);
    expect(bg[0]).not.toBe(bg[1]);
    await page.mouse.click(300, 600); // 压暗的地方
    expect(await page.isVisible("#settings-panel")).toBe(false);
    expect(await scrim()).toBe("rgba(0, 0, 0, 0)");
    // 面板开着时设置按钮被压在暗幕下：点它（落在暗幕上）也是关
    await page.click("#settings-btn");
    await page.click("#settings-btn", { force: true });
    expect(await page.isVisible("#settings-panel")).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("模型从 pi 动态列出，按 provider 分组；思考程度两个下拉，默认都是 medium", async () => {
    const { page, errors } = await open();
    await page.click("#settings-btn");
    const ids = await page.$$eval("select[name=model] option", (os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(ids).toEqual(["openai-codex/gpt-6.1-sol", "openai-codex/gpt-6.1-terra", "deepseek/deepseek-flash"]);
    expect(await page.$$eval("select[name=model] optgroup", (gs) => gs.map((g) => g.getAttribute("label")))).toEqual(["openai-codex · 订阅", "deepseek · 按量计费"]);
    expect(await page.inputValue("select[name=model]")).toBe("openai-codex/gpt-6.1-sol");
    expect(await page.inputValue("select[name=thinkingAnalyst]")).toBe("medium");
    expect(await page.inputValue("select[name=thinkingAdvisor]")).toBe("medium");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("选按量计费的模型要先确认；取消不切，确认才切；它没有 medium 时写明实际用 low", async () => {
    const { page, errors } = await open();
    await page.click("#settings-btn");
    await page.selectOption("select[name=model]", "deepseek/deepseek-flash");
    await page.waitForSelector("#sp-confirm", { state: "visible" });
    expect(await page.textContent("#sp-confirm")).toContain("按量计费");
    await page.click("#sp-confirm-no");
    expect(await page.inputValue("select[name=model]")).toBe("openai-codex/gpt-6.1-sol");
    expect((await (await page.request.get(`${base}/api/settings`)).json()).settings.model).toBe("openai-codex/gpt-6.1-sol");

    await page.selectOption("select[name=model]", "deepseek/deepseek-flash");
    // 确认框开着时，服务端广播设置（比如自己上一次保存的回声）：确认框不能被冲掉
    const current = (await (await page.request.get(`${base}/api/settings`)).json()).settings;
    const marker = { type: "status", agent: "analyst", busy: true };
    for (const ws of sockets) { ws.send(JSON.stringify({ type: "settings", settings: current })); ws.send(JSON.stringify(marker)); }
    await page.waitForSelector("#analyst-chips.dim", { state: "attached" });
    await page.waitForTimeout(300); // 重新取设置是异步的
    expect(await page.isVisible("#sp-confirm")).toBe(true);
    await page.click("#sp-confirm-yes");
    await page.waitForFunction(() => document.getElementById("sp-status")?.textContent?.includes("已切换到"));
    for (const ws of sockets) ws.send(JSON.stringify({ type: "settings", settings: { ...current, model: "deepseek/deepseek-flash" } }));
    await page.waitForTimeout(300);
    expect(await page.textContent("#sp-status")).toContain("已切换到");
    await page.waitForFunction(() => document.querySelector("[data-model-badge]")?.textContent === "deepseek-flash");
    expect(await page.textContent("#settings-panel")).toContain("没有 medium，实际用 low");
    // 订阅模型不用确认
    await page.selectOption("select[name=model]", "openai-codex/gpt-6.1-sol");
    await page.waitForFunction(() => document.querySelector("[data-model-badge]")?.textContent === "gpt-6.1-sol");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("长风的思考程度改成 high：保存，刷新后还是 high", async () => {
    const { page, errors } = await open();
    await page.click("#settings-btn");
    await page.selectOption("select[name=thinkingAnalyst]", "high");
    await page.waitForFunction(() => document.getElementById("sp-status")?.textContent?.includes("已保存"));
    await page.reload();
    await page.waitForSelector(".lean-label");
    await page.click("#settings-btn");
    expect(await page.inputValue("select[name=thinkingAnalyst]")).toBe("high");
    await page.selectOption("select[name=thinkingAnalyst]", "medium"); // 复位，别影响别的用例
    await page.waitForFunction(() => document.getElementById("sp-status")?.textContent?.includes("已保存"));
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("服务端是旧版本（pull 了新页面、旧进程还在跑）：设置照样能打开，提示重启，不显示 undefined", async () => {
    const { page, errors } = await open(async (p) => {
      // main 上旧服务端真实返回的样子：两个写死的模型，没有 provider、思考程度、effective
      await p.route("**/api/settings", (route) => route.fulfill({ json: {
        settings: { model: "openai-codex/gpt-6.1-sol", dataSource: "polygon", voiceAnalyst: "zh-CN-YunxiNeural", voiceAdvisor: "zh-CN-XiaoxiaoNeural", autoSpeak: false },
        models: [
          { id: "openai-codex/gpt-6.1-sol", label: "Codex · gpt-6.1-sol", billing: "订阅", note: "", authHint: "", ready: true },
          { id: "deepseek/deepseek-flash", label: "DeepSeek · deepseek-flash", billing: "按量计费", note: "", authHint: "", ready: true },
        ],
        dataSources: [{ id: "polygon", label: "Polygon / Massive", note: "" }, { id: "yfinance", label: "yfinance", note: "" }],
        voices: [{ id: "zh-CN-YunxiNeural", label: "云希", gender: "男", note: "" }],
      } }));
    });
    await page.click("#settings-btn");
    await expect(page.isVisible("#settings-panel")).resolves.toBe(true);
    const text = await page.textContent("#settings-panel");
    expect(text).toContain("重启");
    expect(text).not.toContain("undefined");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
});

describe("朗读", () => {
  test("点「朗读」：用鸿雁的声音读去掉引用的文字，读完按钮复原", async () => {
    const { page, errors } = await open();
    await addAdvisorAnswer(page, "抵扣价是要扣掉的收盘价 [[S:article#2.3]]。");
    const btn = page.locator("#advisor-thread .speak");
    await btn.click();
    await page.waitForFunction(() => document.querySelector("#advisor-thread .speak")?.textContent?.includes("暂停"));
    await page.waitForFunction(() => document.querySelector("#advisor-thread .speak")?.textContent?.includes("朗读"), null, { timeout: 15_000 });
    expect(ttsCalls.at(-1)).toEqual({ text: "抵扣价是要扣掉的收盘价。", voice: "zh-CN-XiaoxiaoNeural" });
    expect(await btn.textContent()).not.toContain("失败");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("朗读失败要看得见（例如服务端没有语音接口）", async () => {
    const { page, errors } = await open(async (p) => {
      await p.route("**/api/tts", (route) => route.fulfill({ status: 404, json: { error: "没有这个接口" } }));
    });
    await addAdvisorAnswer(page, "均线向上。");
    await page.click("#advisor-thread .speak");
    await page.waitForFunction(() => document.querySelector("#advisor-thread .speak")?.textContent?.includes("失败"));
    expect(await page.getAttribute("#advisor-thread .speak", "title")).toContain("重启");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
});

describe("搜索框", () => {
  test("输入中文名「台积电」：换成 TSM 打开，并在搜索框下说明", async () => {
    const { page, errors } = await open();
    await page.fill("#load-ticker", "台积电");
    await page.press("#load-ticker", "Enter");
    await page.waitForFunction(() => document.getElementById("ticker")?.textContent === "TSM");
    expect(await page.textContent("#search-msg")).toContain("TSM");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("认不出的输入：搜索框下直接显示原因，不是没反应", async () => {
    const { page, errors } = await open();
    await page.fill("#load-ticker", "某某科技");
    await page.press("#load-ticker", "Enter");
    await page.waitForSelector("#search-msg.bad", { state: "visible" });
    expect(await page.textContent("#search-msg")).toContain("某某科技");
    expect(await page.textContent("#ticker")).toBe("NVDA");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
});

describe("附件", () => {
  test("粘贴截图：托盘出现缩略图，发出去的问题带上图片，托盘清空", async () => {
    const { page, errors } = await open();
    await page.waitForFunction(() => !(document.getElementById("analyst-input") as HTMLTextAreaElement).disabled);
    await page.evaluate(async () => {
      const c = document.createElement("canvas");
      c.width = 40; c.height = 30;
      c.getContext("2d")!.fillRect(0, 0, 20, 20);
      const blob: Blob = await new Promise((ok) => c.toBlob((b) => ok(b!), "image/png"));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], "image.png", { type: "image/png" }));
      document.getElementById("analyst-input")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForSelector(".att img");
    await page.fill("#analyst-input", "这张图怎么看？");
    await page.press("#analyst-input", "Enter");
    await page.waitForFunction(() => !document.querySelector(".att"));
    await Bun.sleep(100);
    const m = lastPrompt();
    expect(m.text).toBe("这张图怎么看？");
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0]).toMatchObject({ kind: "image", mimeType: "image/png", name: "image.png" });
    expect(m.attachments[0].data.length).toBeGreaterThan(20);
    expect(m.attachments[0].preview).toBeUndefined();
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("导入 csv：作为文本附件发出；没写问题也能发", async () => {
    const { page } = await open();
    await page.waitForFunction(() => !(document.getElementById("advisor-input") as HTMLTextAreaElement).disabled);
    await page.setInputFiles(".role-advisor input[type=file]", { name: "持仓.csv", mimeType: "text/csv", buffer: Buffer.from("代码,股数\nNVDA,10") });
    await page.waitForSelector(".role-advisor .att");
    await page.click("#advisor-send");
    await Bun.sleep(200);
    const m = lastPrompt();
    expect(m.agent).toBe("advisor");
    expect(m.attachments).toEqual([{ kind: "text", name: "持仓.csv", text: "代码,股数\nNVDA,10" }]);
    await page.close();
  }, 30_000);

  test("导入 PDF：托盘里直接说明，提示用截图", async () => {
    const { page } = await open();
    await page.setInputFiles("#analyst-composer input[type=file]", { name: "研报.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") });
    await page.waitForSelector(".att-note");
    expect(await page.textContent(".att-note")).toContain("截图");
    await page.close();
  }, 30_000);
});

describe("服务端比页面旧", () => {
  test("服务端说代码更新过：顶部出现红条，提示重启", async () => {
    const { page, errors } = await open();
    // WebSocket 替身下次连上时推 stale（真服务端在页面连上时比对代码指纹）
    staleNext = true;
    await page.reload();
    await page.waitForSelector("#stale-bar");
    expect(await page.textContent("#stale-bar")).toContain("just wildgoose");
    expect(errors).toEqual([]);
    staleNext = false;
    await page.close();
  }, 30_000);
});

describe("盘中提醒", () => {
  const PARTIAL = "今日 K 线未完成（美东 13:03，收盘 16:00）。";
  test("可以关掉；当天换股票、刷新都不再弹出，顶部仍标「盘中」", async () => {
    warningNext = PARTIAL;
    // 分析结果按代码缓存，用别的用例没打开过的代码
    const { page, errors } = await open(undefined, "AMD").finally(() => { warningNext = null; });
    expect(await page.isVisible("#warning")).toBe(true);
    expect(await page.textContent("#warning")).toContain("K 线未完成");
    await page.click("#warning-close");
    expect(await page.isVisible("#warning")).toBe(false);
    await page.reload();
    await page.waitForSelector(".lean-label");
    expect(await page.isVisible("#warning")).toBe(false);
    expect(await page.textContent("#data-status-v")).toContain("盘中");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("关掉的是那一个交易日：换一天的盘中提醒照样出现", async () => {
    warningNext = PARTIAL;
    const { page, errors } = await open(async (p) => {
      await p.addInitScript(() => localStorage.setItem("dma-partial-dismissed", "2000-01-03"));
    }, "INTC").finally(() => { warningNext = null; });
    expect(await page.isVisible("#warning")).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
});

describe("取数失败", () => {
  /** 从搜索框打开一只票，等中栏标题换过去。 */
  async function search(page: Page, ticker: string) {
    await page.fill("#load-ticker", ticker);
    await page.press("#load-ticker", "Enter");
    await page.waitForFunction((t) => document.getElementById("ticker")?.textContent === t, ticker);
  }

  test("中栏直接显示这只票的错误，不留上一只票的内容和盘中提醒", async () => {
    warningNext = "今日 K 线未完成（美东 13:03，收盘 16:00）。";
    const { page, errors } = await open(undefined, "AMZN").finally(() => { warningNext = null; });
    expect(await page.isVisible("#warning")).toBe(true);
    // 长风对话很长、滚过了结论：提示条出现
    await page.evaluate(async () => {
      const { panels } = await import("/app.js");
      panels.analyst.history([{ role: "user", text: "长对话" },
        { role: "assistant", text: "很长的回答。\n\n".repeat(400), tools: [], checks: [], book: null }]);
      const s = document.getElementById("center-scroll")!;
      s.scrollTop = 1500;
      s.dispatchEvent(new Event("scroll"));
    });
    await page.waitForSelector("#peek", { state: "visible" });
    await search(page, "ANT");
    await page.waitForSelector("#load-error", { state: "visible" });
    const msg = await page.textContent("#load-error");
    expect(msg).toContain("ANT");
    expect(msg).toContain("取不到 ANT 的行情");
    for (const sel of ["#verdict", ".chart-card", "#steps", "#warning"]) {
      expect(await page.isVisible(sel)).toBe(false);
    }
    expect((await page.textContent("#kpis"))?.trim()).toBe("");
    // 推荐问法是按上一只票生成的，也要清掉；之后才到的也不显示
    const late = { type: "suggestions", agent: "analyst", items: [{ intent: "看状态", text: "AMZN 现在什么状态？" }], source: "ai" };
    // WebSocket 按顺序到：后面这条生效了，前面那条一定处理过
    const marker = { type: "status", agent: "analyst", busy: true };
    for (const ws of sockets) { ws.send(JSON.stringify(late)); ws.send(JSON.stringify(marker)); }
    await page.waitForSelector("#analyst-chips.dim", { state: "attached" });
    expect(await page.$$("#analyst-chips .chip, #advisor-chips .chip")).toHaveLength(0);
    expect(page.url()).toEndWith("#ANT");
    // 告诉服务端：页面现在是 ANT，取数失败（长风、鸿雁据此不再用上一只票）
    expect(wsSent.filter((m) => m.type === "view").at(-1)).toEqual({ type: "view", ticker: "ANT", asof: null, error: "取不到 ANT 的行情" });
    expect(await page.textContent("#data-status-v")).not.toContain("盘中");
    expect(await page.isVisible("#peek")).toBe(false);
    // 重试：按钮先变成不可点，失败后恢复，仍是错误卡片
    await page.click("#load-error-retry");
    await page.waitForSelector("#load-error-retry:not([disabled])");
    expect(await page.isVisible("#load-error")).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("慢的那只后来失败了，不会盖掉已经打开的票", async () => {
    const { page, errors } = await open();
    const slow = page.waitForResponse((r) => r.url().includes("ticker=SLOW"));
    await page.fill("#load-ticker", "SLOW");
    await page.press("#load-ticker", "Enter");
    await search(page, "TSLA");
    await slow; // SLOW 的失败回来了
    await page.evaluate(() => new Promise(requestAnimationFrame));
    expect(await page.textContent("#ticker")).toBe("TSLA");
    expect(await page.isVisible("#load-error")).toBe(false);
    expect(page.url()).toEndWith("#TSLA");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("再打开一只能取到的票：错误消失，内容回来", async () => {
    const { page, errors } = await open();
    await search(page, "ANT");
    await page.waitForSelector("#load-error", { state: "visible" });
    await search(page, "NVDA");
    await page.waitForSelector(".lean-label");
    expect(await page.isVisible("#load-error")).toBe(false);
    for (const sel of ["#verdict", ".chart-card", "#steps"]) {
      expect(await page.isVisible(sel)).toBe(true);
    }
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
});

describe("K 线图工具", () => {
  const range = (page: Page) => page.evaluate(async () => {
    const { getChart } = await import("/app.js");
    return getChart().chart.timeScale().getVisibleRange();
  });

  test("滚轮不缩放图表（只滚动页面）", async () => {
    const { page, errors } = await open();
    await page.waitForSelector("#chart canvas");
    await page.locator("#chart").scrollIntoViewIfNeeded();
    const before = await range(page);
    const box = (await page.locator("#chart").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(300);
    expect(await range(page)).toEqual(before);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("范围按钮：默认近 1 年，点「全部」看到第一根 K 线", async () => {
    const { page } = await open();
    await page.waitForSelector("#chart canvas");
    expect(await page.getAttribute(".range-btn[data-range='1y']", "aria-pressed")).toBe("true");
    const oneYear = await range(page);
    expect(oneYear!.from > CHART.candles[0].time).toBe(true);
    await page.click(".range-btn[data-range='all']");
    await page.waitForTimeout(200);
    expect((await range(page))!.from).toBe(CHART.candles[0].time);
    await page.close();
  }, 30_000);

  test("悬停读数：显示当天收盘和 6 条线；移开显示最新一天", async () => {
    const { page } = await open();
    await page.waitForSelector("#chart canvas");
    await page.locator("#chart").scrollIntoViewIfNeeded();
    const last = CHART.candles.at(-1)!.time;
    expect(await page.textContent("#chart-readout")).toContain(last);
    const box = (await page.locator("#chart").boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
    await page.waitForFunction((last) => !document.getElementById("chart-readout")!.textContent!.includes(last), last);
    const text = (await page.textContent("#chart-readout"))!;
    expect(text).toMatch(/\d{4}-\d{2}-\d{2}/);
    for (const k of ["收", "MA20", "EMA120"]) expect(text).toContain(k);
    await page.close();
  });

  test("读数条照 TradingView：开高低收、涨跌、量和量比一行，均线值另起；第一行不被截掉，每条均线的值都完整看得见", async () => {
    const { page } = await open();
    await page.waitForSelector("#chart canvas");
    await page.locator("#chart-readout").scrollIntoViewIfNeeded();  // 图在结论卡片下面，用户往下滚就看到读数条
    const c = CHART.candles.at(-1)!, prev = CHART.candles.at(-2)!;
    const ohlc = (await page.textContent("#chart-readout .ro-ohlc"))!;
    for (const [k, v] of [["开", c.open], ["高", c.high], ["低", c.low], ["收", c.close]] as const) expect(ohlc).toContain(`${k}${v.toFixed(2)}`);
    const chg = c.close - prev.close;
    expect(ohlc).toContain(`${chg >= 0 ? "+" : "−"}${Math.abs(chg).toFixed(2)}`);
    expect(ohlc).toContain(`${((chg / prev.close) * 100).toFixed(2).replace("-", "−")}%`);
    expect(ohlc).toContain("量81.1M2.4× 均量");
    expect(await page.getAttribute("#chart-readout .ro-ratio", "class")).toContain("spike"); // 大量标黄
    expect(await page.textContent("#chart-readout .ro-lines")).toContain("MA20");
    // 两行各自不换行（默认视图下），且都没被挡住；第一行放得下（窄栏收起涨跌额，量和量比不被省略号截掉）
    const rows = () => page.$$eval("#chart-readout > div", (els) => els.map((el) => {
      const r = el.getBoundingClientRect(), lh = parseFloat(getComputedStyle(el).lineHeight) || 16;
      const hit = document.elementFromPoint(r.x + 4, r.y + r.height / 2);
      return { lines: Math.round(r.height / lh), fits: el.scrollWidth <= el.clientWidth, visible: !!hit && el.contains(hit) };
    }));
    expect((await rows())[0]).toEqual({ lines: 1, fits: true, visible: true });
    // 第二行：6 条线的值一个不少、都完整看得见（窄栏折成两行也行，不能被省略号截掉、不能伸出栏外）
    const lineCells = () => page.$$eval("#chart-readout .ro-line", (els) => els.map((el) => {
      const r = el.getBoundingClientRect(), row = el.closest(".ro-lines")!.getBoundingClientRect();
      const hit = document.elementFromPoint(r.right - 2, r.y + r.height / 2);
      const inside = r.left >= row.left - 0.5 && r.right <= row.right + 0.5 && r.top >= row.top - 0.5 && r.bottom <= row.bottom + 0.5;
      return { text: el.textContent, whole: inside && !!hit && el.contains(hit) };
    }));
    const wholeLines = (i: number) => ["MA20", "EMA20", "MA60", "EMA60", "MA120", "EMA120"]
      .map((k) => ({ text: `${k} ${CHART.lines[k as keyof typeof CHART.lines][i].value.toFixed(2)}`, whole: true }));
    expect(await lineCells()).toEqual(wholeLines(299));
    // 悬停到普通的一天：1.2× 均量，不标黄
    const box = (await page.locator("#chart").boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4);
    await page.waitForFunction(() => document.querySelector("#chart-readout .ro-vol")?.textContent?.includes("1.2×"));
    expect(await page.getAttribute("#chart-readout .ro-ratio", "class")).not.toContain("spike");
    expect((await rows())[0]).toEqual({ lines: 1, fits: true, visible: true });
    expect((await lineCells()).every((c) => c.whole)).toBe(true);
    await page.close();
  }, 30_000);

  test("均线都是实线：MA 粗、EMA 细；右端价格轴写 MA 的值、不在绘图区写名字（让给筹码分布）；换主题颜色跟着换", async () => {
    const { page, errors } = await open();
    await page.waitForSelector("#chart canvas");
    const styles = () => page.evaluate(async () => (await import("/app.js")).getChart().lineStyles());
    const light = await styles();
    for (const [key, s] of Object.entries<any>(light)) expect({ key, style: s.lineStyle }).toEqual({ key, style: 0 });
    for (const n of [20, 60, 120]) expect(light[`MA${n}`].lineWidth).toBeGreaterThan(light[`EMA${n}`].lineWidth);
    expect(["MA20", "EMA20", "MA60", "MA120"].map((k) => [light[k].lastValueVisible, light[k].title])).toEqual([[true, ""], [false, ""], [true, ""], [true, ""]]);
    // 图例和读数条的小样：EMA 也是实线
    const swatches = await page.$$eval("#legend i, #chart-readout i", (els) => els.map((e) => getComputedStyle(e).borderTopStyle));
    expect(new Set(swatches)).toEqual(new Set(["solid"]));
    await page.click('#theme [data-value="dark"]');
    await page.waitForFunction(async (c) => (await import("/app.js")).getChart().lineStyles().MA20.color !== c, light.MA20.color);
    expect((await styles()).MA20.color).toBe("#e5e9f0");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("价位线：结论里的触发、止损、目标和推翻判断的价位画在图上，在「图层」里可以关掉", async () => {
    const { page } = await open();
    await page.waitForSelector("#chart canvas");
    const levels = () => page.evaluate(async () => (await import("/app.js")).getChart().levels());
    // NVDA 加速下跌：等构造完成、20 线组一起拐头（212.21），拐头失败止损 183.08，目标缺口 228.86；推翻判断：30 天内 20/60 双金叉的价位
    const on = await levels();
    expect(on.map((l: { kind: string; title: string }) => [l.kind, l.title]))
      .toEqual([["trigger", "触发"], ["stop", "进场后止损"], ["target", "第一阻力/目标位"], ["invalid", "判断失效"]]);
    expect(on[0].price).toBe(212.21);
    expect(on[1].price).toBeCloseTo(183.08, 2);
    expect(on[2].price).toBe(228.86);
    expect(on[3].price).toBeCloseTo(206.26, 2);
    await switchLayer(page, "levels");
    expect(await levels()).toEqual([]);
    await page.close();
  }, 30_000);
});

describe("自己画水平线", () => {
  const drawn = (page: Page) => page.evaluate(async () => (await import("/app.js")).getChart().drawn());

  test("点「画线」再点图：在那个价位画一条线；刷新后还在；「清除」删掉", async () => {
    const { page, errors } = await open();
    await page.waitForSelector("#chart canvas");
    await page.locator("#chart").scrollIntoViewIfNeeded();
    expect(await drawn(page)).toEqual([]);
    // 「问鸿雁」浮钮每次弹出都会把文字改成"问鸿雁：<日期>"，用它判断点图有没有触发问鸿雁
    const askLabel = () => page.evaluate(() => document.getElementById("ask-advisor")!.textContent);
    const before = await askLabel();
    await page.click(".draw-toggle");
    // 点按钮会滚动页面；把图表放回滚动区顶部再取坐标，点的位置才一定落在图上（不落到下面的输入区）
    await page.evaluate(() => document.getElementById("chart")!.scrollIntoView({ block: "start" }));
    const box = (await page.locator("#chart").boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.3);
    await page.waitForTimeout(300);
    const lines = await drawn(page);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBeGreaterThan(100);
    expect(await askLabel()).toBe(before); // 画线模式下点图，不触发问鸿雁
    await page.waitForTimeout(600); // 隔开一点、换个位置，免得图表当成双击
    await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.45);
    await page.waitForTimeout(300);
    expect(await askLabel()).toContain("问鸿雁："); // 对照：画完退出画线模式，点图照常问鸿雁
    expect(await drawn(page)).toHaveLength(1);
    await page.reload();
    await page.waitForSelector("#chart canvas");
    expect(await drawn(page)).toEqual(lines);
    await page.click(".draw-clear");
    expect(await drawn(page)).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("「怎么用」讲清四种用法", async () => {
    const { page } = await open();
    await page.click(".chart-help-toggle");
    const text = (await page.textContent(".chart-help"))!;
    for (const k of ["悬停读数", "范围", "画线", "量"]) expect(text).toContain(k);
    await page.close();
  }, 30_000);
});


describe("测量工具和交互模式", () => {
  const api = <T,>(page: Page, fn: string) => page.evaluate(async (fn) => (await import("/app.js")).getChart()[fn](), fn) as Promise<T>;
  /** 第 i 根 K 线、图高 frac 处的屏幕坐标（先把图放到滚动区顶部，坐标才稳）。 */
  async function at(page: Page, i: number, frac: number) {
    await page.evaluate(() => document.getElementById("chart")!.scrollIntoView({ block: "start" }));
    const x = await page.evaluate(async (t) => (await import("/app.js")).getChart().chart.timeScale().timeToCoordinate(t), CHART.candles[i].time);
    const box = (await page.locator("#chart").boundingBox())!;
    return { x: box.x + x!, y: box.y + box.height * frac };
  }
  async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
  }
  const range = (page: Page) => page.evaluate(async () => (await import("/app.js")).getChart().chart.timeScale().getVisibleLogicalRange());

  test("点「测量」再按住拖动：框里写涨跌、涨跌幅、根数、天数、几个 ATR；图不跟着平移；Esc 清掉", async () => {
    const { page, errors } = await open();
    await page.waitForSelector("#chart canvas");
    await scrollIntoCenter(page, ".chart-card"); // 图在结论下面：像用户一样滚到图
    expect(await notCovered(page, ".measure-toggle")).toBe(true);
    await page.click(".measure-toggle");
    expect(await page.getAttribute(".measure-toggle", "aria-pressed")).toBe("true");
    const askLabel = () => page.evaluate(() => document.getElementById("ask-advisor")!.textContent);
    const ask = await askLabel();
    const before = await range(page);
    await drag(page, await at(page, 230, 0.6), await at(page, 260, 0.3));
    const m = (await api<any>(page, "measured"))!;
    expect([m.a.index, m.b.index, m.bars]).toEqual([230, 260, 30]);
    expect(m.days).toBe(Math.round((Date.parse(CHART.candles[260].time) - Date.parse(CHART.candles[230].time)) / 864e5));
    expect(m.change).toBeGreaterThan(0); // 从下往上拉
    const label = (await page.textContent(".measure-label"))!;
    expect(label).toContain(`+${m.change.toFixed(2)}（+${m.pct.toFixed(2)}%）`);
    expect(label).toContain(`30 根 · ${m.days} 天`);
    expect(label).toContain(`${m.atrUnits.toFixed(1)} ATR（ATR ${m.atr.toFixed(2)}）`);
    expect(await page.isVisible(".measure-label")).toBe(true);
    expect(await range(page)).toEqual(before); // 按住拖动是量，不是平移
    expect(await askLabel()).toBe(ask); // 测量时点图不问鸿雁
    await page.keyboard.press("Escape");
    expect(await page.isVisible(".measure-layer")).toBe(false);
    expect(await api(page, "tool")).toBe("none");
    expect(await page.getAttribute(".measure-toggle", "aria-pressed")).toBe("false");
    // 退出测量后按住拖动照常平移
    const p = await at(page, 250, 0.5);
    await drag(page, p, { x: p.x + 120, y: p.y });
    expect((await range(page))!.to).not.toBe(before!.to);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("四种模式互斥：画线、测量、选回放起点一次只有一个；再点一次或 Esc 回到无", async () => {
    const { page, errors } = await open();
    await page.waitForSelector("#chart canvas");
    await scrollIntoCenter(page, ".chart-card");
    const state = async () => ({
      tool: await api(page, "tool"),
      draw: await page.getAttribute(".draw-toggle", "aria-pressed"),
      measure: await page.getAttribute(".measure-toggle", "aria-pressed"),
      replay: await page.textContent(".replay-toggle"),
      bar: await page.isVisible(".replay-bar"),
    });
    const none = { tool: "none", draw: "false", measure: "false", replay: "回放", bar: false };
    expect(await state()).toEqual(none);
    await page.click(".draw-toggle");
    expect(await state()).toEqual({ ...none, tool: "draw", draw: "true" });
    await page.click(".measure-toggle");
    expect(await state()).toEqual({ ...none, tool: "measure", measure: "true" });
    await drag(page, await at(page, 240, 0.6), await at(page, 270, 0.4));
    expect(await page.isVisible(".measure-layer")).toBe(true);
    await page.click(".replay-toggle");
    expect(await state()).toEqual({ ...none, tool: "pick-start", replay: "取消选起点", bar: true });
    expect(await page.isVisible(".measure-layer")).toBe(false); // 换模式清掉量的框
    await page.click(".draw-toggle");
    expect(await state()).toEqual({ ...none, tool: "draw", draw: "true" });
    await page.click(".draw-toggle");
    expect(await state()).toEqual(none);
    await page.click(".measure-toggle");
    await page.click(".measure-toggle");
    expect(await state()).toEqual(none);
    await page.click(".draw-toggle");
    await page.keyboard.press("Escape");
    expect(await state()).toEqual(none);
    expect(await api(page, "drawn")).toEqual([]); // 切来切去没画出线
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("回放中也能测量：只量到回放那天，往后放一根框还在；退回到量的那根之前就清掉", async () => {
    const { page, errors } = await open(undefined, "MEAS");
    await page.waitForSelector("#chart canvas");
    await scrollIntoCenter(page, ".chart-card");
    await page.click(".replay-toggle");
    await page.selectOption(".replay-speed", "0.1");
    const p = await at(page, 200, 0.4);
    await page.mouse.click(p.x, p.y);
    await page.waitForFunction(async () => (await import("/app.js")).getChart().replay().mode === "replay");
    await page.click(".replay-play"); // 暂停
    await page.click(".measure-toggle");
    expect(await notCovered(page, ".measure-toggle")).toBe(true);
    await drag(page, await at(page, 170, 0.5), await at(page, 200, 0.7));
    const m = (await api<any>(page, "measured"))!;
    expect([m.a.index, m.b.index]).toEqual([170, 200]);
    expect(m.change).toBeLessThan(0);
    expect(await page.getAttribute(".measure-layer", "class")).toContain("down");
    await page.click(".replay-forward");
    expect((await api<any>(page, "replay")).index).toBe(201);
    expect(await page.isVisible(".measure-layer")).toBe(true);
    expect(await api(page, "tool")).toBe("measure");
    await page.click(".replay-back");
    await page.click(".replay-back");
    expect(await page.isVisible(".measure-layer")).toBe(false); // 第 200 根已经不在图上
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
});

/** 元素在当前视图里看得见、没被别的东西挡住（elementFromPoint 落在它自己身上）。 */
const notCovered = (page: Page, sel: string) => page.evaluate((sel) => {
  const el = document.querySelector<HTMLElement>(sel)!;
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.x + Math.min(20, r.width / 2), r.y + r.height / 2);
  return r.height > 0 && !!hit && el.contains(hit);
}, sel);
/**
 * 等页面里的条件成立（每 50ms 读一次）。读图表状态要 await import("/app.js")，而 page.waitForFunction 遇到 async 函数会立刻返回
 * （它拿到的是 Promise，本身就是真值），等于没等；所以在测试这边轮询。
 */
async function until<T = undefined>(page: Page, what: string, cond: (arg: T) => Promise<boolean>, timeout = 5000, arg?: T) {
  for (const end = Date.now() + timeout; !(await page.evaluate(cond as (arg: unknown) => Promise<boolean>, arg));) {
    if (Date.now() > end) throw new Error(`等了 ${timeout}ms：${what}`);
    await page.waitForTimeout(50);
  }
}
/** 「图层 ▾」菜单里的一项。 */
const layerBtn = (key: string) => `.layers-menu [data-layer="${key}"]`;
/** 像用户一样点开「图层 ▾」（已经开着就不动）。 */
const openLayers = async (page: Page) => {
  if (await page.getAttribute(".layers-toggle", "aria-expanded") !== "true") await page.click(".layers-toggle");
};
/** 点开菜单选一个预设，再按 Esc 收起（菜单开着会盖住一部分图）。 */
const pickPreset = async (page: Page, preset: "simple" | "structure" | "all") => {
  await openLayers(page);
  await page.click(`.layers-menu [data-preset="${preset}"]`);
  await page.keyboard.press("Escape");
};
/** 点开菜单开 / 关一个图层，再按 Esc 收起。 */
const switchLayer = async (page: Page, key: string) => {
  await openLayers(page);
  await page.click(layerBtn(key));
  await page.keyboard.press("Escape");
};
/** 菜单里这一项现在的样子：能不能点、勾没勾、整行的字（不能用时写着原因）。 */
const layerItem = async (page: Page, key: string) => {
  await openLayers(page);
  const item = page.locator(layerBtn(key));
  return { disabled: await item.isDisabled(), pressed: await item.getAttribute("aria-pressed"), text: (await item.textContent())! };
};
/** 像用户一样把这一块滚进中栏视野（滚到它的开头）。 */
const scrollIntoCenter = (page: Page, sel: string) => page.evaluate(async (sel) => {
  const s = document.getElementById("center-scroll")!;
  const el = document.querySelector<HTMLElement>(sel)!;
  s.scrollTop += el.getBoundingClientRect().top - s.getBoundingClientRect().top - 40;
  await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
}, sel);

/** 把图的底边（时间轴）滚进中栏视野：默认视口里图在结论下面，底边要往下滚才看得见。 */
const scrollChartBottomIntoView = (page: Page) => page.evaluate(async () => {
  const s = document.getElementById("center-scroll")!;
  s.scrollTop += document.getElementById("chart")!.getBoundingClientRect().bottom - s.getBoundingClientRect().bottom + 12;
  await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
});

describe("财报日", () => {
  test("结论卡片：3 天后财报、跳空可能越过止损价，默认视图看得见、没被挡；打法不变", async () => {
    const { page, errors } = await open(undefined, "EARN");
    const sel = "#verdict [data-item=earnings]";
    expect(await notCovered(page, sel)).toBe(true);
    expect((await page.textContent(sel))!.replace(/\s+/g, "")).toContain(`3天后财报（${EARN_NEXT}）：跳空可能越过止损价183.08`);
    expect(await page.textContent('#verdict .concl-row[data-situation="flat"]')).toContain("不做：盈亏比 0.57:1"); // 和 NVDA 一样
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("图上：过去的财报和下一次标 E（下一次在右边留白里），看得见、没被挡；没有财报日的票不标", async () => {
    const { page, errors } = await open(undefined, "EARN");
    await page.waitForSelector("#chart .e-mark.next");
    await scrollChartBottomIntoView(page); // E 在图的底边：像用户一样往下滚到看见时间轴
    const marks = await page.$$eval("#chart .e-mark", (els) => els.map((e) => [(e as HTMLElement).dataset.date, e.classList.contains("next")]));
    expect(marks).toEqual([...EARNINGS.past.map((d) => [d, false]), [EARN_NEXT, true]]);
    for (const d of [EARNINGS.past[2], EARN_NEXT]) expect(await notCovered(page, `#chart .e-mark[data-date="${d}"]`)).toBe(true);
    expect(await page.getAttribute("#chart .e-mark.next", "title")).toContain("跳空");
    // E 在时间轴上方、图内：底边不超过图的绘图区
    const inPane = await page.evaluate(async () => {
      const { getChart } = await import("/app.js");
      const box = document.getElementById("chart")!.getBoundingClientRect();
      const m = document.querySelector("#chart .e-mark")!.getBoundingClientRect();
      return m.bottom <= box.bottom - getChart().chart.timeScale().height() + 1 && m.top > box.top;
    });
    expect(inPane).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
    const nv = await open(); // NVDA 的替身没有财报日
    await nv.page.waitForSelector("#chart canvas");
    expect(await nv.page.locator("#chart .e-mark").count()).toBe(0);
    expect(await nv.page.locator("#verdict [data-item=earnings]").count()).toBe(0);
    await nv.page.close();
  }, 30_000);
});

describe("结构标注", () => {
  const scene = (page: Page) => page.evaluate(async () => (await import("/app.js")).getChart().structure());
  const shown = (page: Page) => page.$$eval("#chart .struct-mark", (els) => els.filter((e) => !(e as HTMLElement).hidden).map((e) => e.textContent));

  test("默认不画；选「结构」预设：波段、最近的构造、M 顶和 2B 顶都画出来；回「简洁」全收起，再选回来", async () => {
    const { page, errors } = await open(undefined, "STRUCT");
    await page.waitForSelector("#chart canvas");
    await scrollIntoCenter(page, ".chart-card"); // 像用户一样滚到图
    expect(await shown(page)).toEqual([]);
    expect((await scene(page)).segments).toEqual([]);
    await pickPreset(page, "structure");
    expect(await shown(page)).toEqual(["顶·已完成", "底·形成中", "M顶", "2B顶"]);
    for (const rule of ["J25", "J26"]) expect(await notCovered(page, `#chart .struct-mark[data-ref="rules#${rule}"]`)).toBe(true);
    const s = await scene(page);
    expect(s.segments.filter((x: any) => x.kind === "swing")).toHaveLength(3);
    expect(s.segments.filter((x: any) => x.kind === "neck").map((x: any) => x.label)).toEqual(["颈线", "A"]);
    expect(s.levels.map((x: any) => x.text)).toEqual([`下一根高 > ${STRUCTURE.bottom.next_at!.toFixed(2)} 底构造完成`]);
    await pickPreset(page, "simple");
    expect(await shown(page)).toEqual([]);
    expect((await scene(page)).segments).toEqual([]);
    await pickPreset(page, "structure");
    expect(await shown(page)).toHaveLength(4);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("点 M 顶标记：弹窗先说颈线和跌破那天，下面是 rules.md J25 原文", async () => {
    const { page, errors } = await open(undefined, "STRUCT");
    await page.waitForSelector("#chart canvas");
    await scrollIntoCenter(page, ".chart-card");
    await pickPreset(page, "structure");
    await page.click('#chart .struct-mark[data-ref="rules#J25"]');
    await page.waitForSelector("#popover .pop-body p");
    const pop = (await page.textContent("#popover"))!;
    expect(pop).toContain(`颈线 ${STRUCTURE.patterns[0].level.toFixed(2)}`);
    expect(pop).toContain(`${STRUCTURE.patterns[0].confirmed} 收盘跌破`);
    expect(pop).toContain("rules.md");
    expect(pop).toContain("J25");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("回放时收起（结构按最新一天算，会露出之后的走势），菜单里这几项不能点、写着原因；退出回放画回来", async () => {
    const { page, errors } = await open(undefined, "STRUCT");
    await page.waitForSelector("#chart canvas");
    await scrollIntoCenter(page, ".chart-card");
    await pickPreset(page, "structure");
    await page.click(".replay-toggle");
    await page.click(".replay-start");
    await page.click('[data-start="earliest"]');
    await page.waitForFunction(async () => (await import("/app.js")).getChart().replay().mode === "replay");
    for (const key of ["constructs", "patterns", "swings"]) {
      const item = await layerItem(page, key);
      expect({ key, disabled: item.disabled, pressed: item.pressed }).toEqual({ key, disabled: true, pressed: "false" });
      expect(item.text).toContain("回放时收起：结构是按最新一天算的");
      expect(await notCovered(page, layerBtn(key))).toBe(true); // 原因写在这一行，看得见
    }
    await page.keyboard.press("Escape");
    expect(await shown(page)).toEqual([]);
    await page.click(".replay-exit");
    expect((await layerItem(page, "constructs")).disabled).toBe(false);
    await page.keyboard.press("Escape");
    expect(await shown(page)).toHaveLength(4);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("最右边几根上的标记、变色三角和小字，不盖住价格轴上的标签（价位线的名字和价格、最新价、均线值）", async () => {
    const { page, errors } = await open(undefined, "EDGE");
    await page.waitForSelector("#chart canvas");
    await scrollIntoCenter(page, ".chart-card");
    await pickPreset(page, "all");
    await switchLayer(page, "profile"); // 筹码开着时图让出右边一截；关掉，标记才挨着价格轴
    // 价位线就在最新一根旁边：上面「先看」、下面「进场后止损」（名字最长的那种）
    const c = CHART.candles.at(-1)!;
    await page.evaluate(async (c) => (await import("/app.js")).getChart().setLevels([
      { kind: "trigger", price: c.high + 1, title: "先看" }, { kind: "stop", price: c.low - 1.5, title: "进场后止损" }]), c);
    await page.mouse.move(1, 1); // 十字线不在图上
    expect(await shown(page)).toEqual(["顶·已完成", "底·形成中", "2B顶"]);
    await until(page, "价格轴标签和变色三角都画出来", async () => {
      const g = (await import("/app.js")).getChart();
      return g.axisLabels().length >= 6 && g.turns().length > 0;
    });
    const seen = await page.evaluate(async () => {
      const g = (await import("/app.js")).getChart();
      const chart = document.getElementById("chart")!, origin = chart.getBoundingClientRect();
      const [paneTd, axisTd] = [...chart.querySelectorAll("table tr:first-child > td")].slice(1, 3);
      const paneRight = axisTd.getBoundingClientRect().left - origin.left;
      const boxes: { left: number; top: number; width: number; height: number }[] = g.axisLabels();
      const hit = (a: any, b: any) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
      const marks = [...chart.querySelectorAll<HTMLElement>(".struct-mark")].filter((e) => !e.hidden).map((e) => {
        const r = e.getBoundingClientRect();
        const box = { left: r.left - origin.left, top: r.top - origin.top, width: r.width, height: r.height };
        return { text: e.textContent, box, inPane: box.left + box.width <= paneRight + 0.5, clear: !boxes.some((b) => hit(b, box)) };
      });
      const apart = marks.every((a, k) => marks.slice(k + 1).every((b) => !hit(a.box, b.box))); // 让开以后也不叠在一起
      const labels = g.labels().labels.filter((l: any) => !l.hidden).map((l: any) => ({ text: l.text, clear: !boxes.some((b) => hit(b, l)) }));
      // 变色三角和小字画在绘图区的上层画布：价格轴标签（名字那一截在绘图区里）的范围内这层一个像素都不画
      const [main, top] = paneTd.querySelectorAll("canvas");
      const dpr = top.width / top.getBoundingClientRect().width;
      const covered = boxes.filter((b) => b.left < paneRight).map((b) => {
        const px = top.getContext("2d")!.getImageData(Math.floor(b.left * dpr), Math.floor(Math.max(b.top, 0) * dpr),
          Math.ceil((paneRight - b.left) * dpr), Math.ceil(b.height * dpr)).data;
        return px.some((v, k) => k % 4 === 3 && v > 0);
      });
      // 名字那一截确实在算出来的地方：底下的画布在框的中线上有颜色，不是图的底色
      const bg = getComputedStyle(document.documentElement).getPropertyValue("--card").trim();
      const hex = (d: Uint8ClampedArray) => "#" + [...d.slice(0, 3)].map((v) => v.toString(16).padStart(2, "0")).join("");
      const titled = boxes.filter((b) => b.left < paneRight).map((b) => hex(main.getContext("2d")!.getImageData(
        Math.round((b.left + 4) * dpr), Math.round((b.top + b.height / 2) * dpr), 1, 1).data) !== bg);
      return { marks: marks.map(({ box, ...m }) => m), apart, labels, covered, titled };
    });
    for (const m of seen.marks) expect(m).toEqual({ text: m.text, inPane: true, clear: true });
    expect(seen.apart).toBe(true);
    for (const l of seen.labels) expect(l).toEqual({ text: l.text, clear: true });
    expect(seen.titled).toEqual([true, true]); // 「先看」「进场后止损」两个名字
    expect(seen.covered).toEqual([false, false]);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
});

describe("缺口", () => {
  test("默认不画；在「图层」里打开：没补的缺口画成色带，被交易计划用作目标的标「目标位」；关掉收起；周线上不画、菜单里变灰", async () => {
    const { page, errors } = await open(undefined, "STRUCT");
    await page.waitForSelector("#chart canvas");
    await scrollIntoCenter(page, ".chart-card");
    const bands = async () => (await page.evaluate(async () => (await import("/app.js")).getChart().structure())).bands;
    expect(await bands()).toEqual([]);
    await switchLayer(page, "gaps");
    expect((await layerItem(page, "gaps")).pressed).toBe("true");
    await page.keyboard.press("Escape");
    expect((await bands()).map((b: any) => [b.date, b.from, b.to, b.target])).toEqual([
      [GAPS[0].date, 150, CHART.candles.length - 1, false], [GAPS[1].date, 270, CHART.candles.length - 1, true],
    ]);
    expect((await bands())[1].label).toBe(`缺口 ${GAPS[1].bottom.toFixed(2)}–${GAPS[1].top.toFixed(2)} · 阻力位`);
    // 色带真的画在图上：关掉缺口后图的样子变了（结构标注没动）
    const shot = () => page.locator("#chart").screenshot();
    const on = await shot();
    await switchLayer(page, "gaps");
    expect(await bands()).toEqual([]);
    expect(Buffer.compare(on, await shot())).not.toBe(0);
    await switchLayer(page, "gaps");
    expect(await bands()).toHaveLength(2);
    await page.click('[data-frame="week"]');
    const item = await layerItem(page, "gaps");
    expect([item.disabled, item.text]).toEqual([true, "缺口缺口按日线算：切回日线看"]);
    await page.keyboard.press("Escape");
    expect(await bands()).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
});

describe("筹码分布", () => {
  const profile = (page: Page) => page.evaluate(async () => (await import("/app.js")).getChart().profile());
  /** 图上第一根、最后一根看得见的 K 线（逻辑范围取整，右边的空位不算）。 */
  const visible = (page: Page) => page.evaluate(async () => {
    const r = (await import("/app.js")).getChart().chart.timeScale().getVisibleLogicalRange();
    return { first: Math.max(0, Math.ceil(r.from)), last: Math.floor(r.to) };
  });
  const overlap = (a: any, b: any) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
  /** 最新一根 K 线的右边缘和直方图（连山框）的左边缘，绘图区坐标；没画筹码时 left 是 null。 */
  const room = (page: Page) => page.evaluate(async () => {
    const c = (await import("/app.js")).getChart();
    const ts = c.chart.timeScale(), r = ts.getVisibleLogicalRange()!;
    const spacing = ts.width() / (r.to - r.from);
    return { right: ts.logicalToCoordinate(c.replay().bars - 1)! + spacing / 2, left: c.profile().drawn?.left ?? null, width: ts.width() };
  });
  /** 等到最新一根停在直方图左边、只隔一点间隙（不压在直方图上，也不空出一大截）。 */
  const parked = (page: Page, what: string) => until(page, `最新一根停在直方图左边（${what}）`, async () => {
    const c = (await import("/app.js")).getChart();
    const ts = c.chart.timeScale(), r = ts.getVisibleLogicalRange()!;
    const right = ts.logicalToCoordinate(c.replay().bars - 1)! + ts.width() / (r.to - r.from) / 2;
    const left = c.profile().drawn?.left;
    return left != null && right <= left && left - right <= 14;
  });
  const range = (page: Page) => page.evaluate(async () => (await import("/app.js")).getChart().chart.timeScale().getVisibleLogicalRange()!);
  const zoom = async (page: Page, dy: number) => {
    const box = (await page.locator("#chart").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, dy);
    await page.keyboard.up("Control");
  };

  test("筹码默认不画；在「图层」里打开：贴着价格轴画可见范围的筹码，写出日期，标山脚山顶和计划的参考带，找打法里单列一行「参考」；缩放后重算；周线不画", async () => {
    const { page, errors } = await open(undefined, "PROFILE");
    await page.waitForSelector("#chart canvas");
    await scrollIntoCenter(page, ".chart-card");
    expect((await profile(page)).on).toBe(false);
    const shot = () => page.locator("#chart").screenshot();
    const off = await shot();
    await switchLayer(page, "profile");
    const p = await profile(page);
    const v = await visible(page);
    expect(p.on).toBe(true);
    expect([p.from, p.to]).toEqual([CHART.candles[v.first].time, CHART.candles.at(-1)!.time]); // 默认 1 年，右边空位不算
    expect(p.bars).toBe(CHART.candles.length - v.first);
    expect(p.mountains.length).toBeGreaterThan(0);
    for (const m of p.mountains) expect(m.top).toBeGreaterThan(m.foot);
    expect(p.ref).toEqual({ foot: 175, top: 185 });
    expect(Buffer.compare(off, await shot())).not.toBe(0); // 真的画在图上
    // 只占绘图区右边一条，不伸到价格轴上（价格轴上的标签不被挡）
    const paneW = await page.evaluate(async () => (await import("/app.js")).getChart().chart.timeScale().width());
    expect(p.drawn.right).toBe(paneW);
    expect(p.drawn.left).toBeGreaterThan(paneW * 0.7);
    const shown = p.drawn.labels.filter((l: any) => !l.hidden);
    expect(shown.map((l: any) => l.text)).toContain(`筹码 ${p.from} ~ ${p.to} · ${p.bars} 根`);
    expect(shown.map((l: any) => l.text)).toContain("参考带（P38）");
    expect(shown.some((l: any) => l.text.includes("目标"))).toBe(false); // 筹码山不叫目标
    expect(shown.some((l: any) => /^山(脚|顶) \d/.test(l.text))).toBe(true);
    for (const a of shown) for (const b of shown) if (a !== b) expect({ a: a.text, b: b.text, hit: overlap(a, b) }).toEqual({ a: a.text, b: b.text, hit: false });
    // 工具栏、读数条照样看得见、没被挡
    for (const sel of [".layers-toggle", ".chart-help-toggle", ".measure-toggle", "#chart-readout"]) {
      expect({ sel, ok: await notCovered(page, sel) }).toEqual({ sel, ok: true });
    }
    // 找打法里筹码山是「目标和盈亏比」那一格的依据（ADR 0029）：点开依据，滚到时看得见、没被挡；「目标」一行还是原来的缺口，图上的目标线也没挪到山脚
    const targetCell = '[data-step="play"] .pcell[data-cell="target"]';
    const planRows = `${targetCell} .plan-items li`;
    const refRow = page.locator(planRows, { hasText: "上方最近的筹码山" });
    expect(await refRow.count()).toBe(1);
    await scrollIntoCenter(page, `${targetCell} details.basis > summary`);
    await page.click(`${targetCell} details.basis > summary`);
    await scrollIntoCenter(page, `${targetCell} details.basis .plan-items`);
    expect(await refRow.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.height > 0 && el.contains(document.elementFromPoint(r.x + 20, r.y + r.height / 2));
    })).toBe(true);
    const refText = (await refRow.textContent())!;
    expect(refText).toContain("参考上方最近的筹码山：山脚 175.00");
    expect(refText).toContain("到山顶 185.00 这条带。只作参考，不排进第一阻力，不算进盈亏比。");
    expect(refText).toContain("P38");
    const targetText = (await page.locator(planRows, { hasText: "第一阻力/目标位：" }).textContent())!;
    expect([targetText.includes("缺口"), targetText.includes("筹码山")]).toEqual([true, false]);
    const lines = await page.evaluate(async () => (await import("/app.js")).getChart().levels());
    expect(lines.find((l: any) => l.title === "第一阻力/目标位").price).toBe((nvda as Analysis).trade_plan.flat.targets[0].price);
    await scrollIntoCenter(page, ".chart-card");
    // ⌘ + 滚轮放大：可见范围变短，筹码按新的范围重算
    const box = (await page.locator("#chart").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -400);
    await page.keyboard.up("Control");
    await page.waitForFunction(async (bars) => (await import("/app.js")).getChart().profile().bars < bars, p.bars);
    const z = await profile(page), zv = await visible(page);
    expect([z.from, z.bars]).toEqual([CHART.candles[zv.first].time, CHART.candles.length - zv.first]);
    // 刷新后还记得开着；周线上不能点
    await page.reload();
    await page.waitForSelector("#chart canvas");
    expect((await profile(page)).on).toBe(true);
    await page.click('[data-frame="week"]');
    const item = await layerItem(page, "profile");
    expect([item.disabled, item.text]).toEqual([true, "筹码筹码按日线算：切回日线看"]);
    await page.keyboard.press("Escape");
    expect((await profile(page)).drawn).toBeNull();
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("打开筹码：图右边留出直方图那么宽的空白，最新一根停在直方图左边；缩放、平移、范围按钮、复位、切周线再切回都对；关掉恢复原来的留白", async () => {
    const { page, errors } = await open(undefined, "PROFILE");
    await page.waitForSelector("#chart canvas");
    await scrollIntoCenter(page, ".chart-card");
    const before = await range(page);
    const off = await room(page);
    expect(off.left).toBeNull();
    await switchLayer(page, "profile");
    await parked(page, "打开");
    expect((await range(page)).from).toBeCloseTo(before.from, 3); // 左边看得见的那段不变
    // 关掉：恢复原来的留白（最新一根右边几根空位）
    await switchLayer(page, "profile");
    await until(page, "关掉后留白恢复", async (b) => {
      const r = (await import("/app.js")).getChart().chart.timeScale().getVisibleLogicalRange()!;
      return Math.abs(r.from - b.from) < 0.01 && Math.abs(r.to - b.to) < 0.01;
    }, 5000, before);
    await switchLayer(page, "profile");
    await parked(page, "再打开");
    // ⌘ + 滚轮放大、缩小
    let bars = (await profile(page)).bars;
    await zoom(page, -400);
    await until(page, "放大后重算", async (n) => (await import("/app.js")).getChart().profile().bars < n, 5000, bars);
    await parked(page, "放大");
    // 以最新一根为锚放大：看得见的 K 线按比例变少（滚 400 是 e^(-4/3) 倍），不是以右边的空白为锚、只剩最后几根
    expect(Math.abs((await profile(page)).bars - bars * Math.exp(-400 / 300))).toBeLessThan(3);
    bars = (await profile(page)).bars;
    await zoom(page, 600);
    await until(page, "缩小后重算", async (n) => (await import("/app.js")).getChart().profile().bars > n, 5000, bars);
    await parked(page, "缩小");
    // 范围按钮、复位
    await page.click('.range-btn[data-range="6m"]');
    await parked(page, "半年");
    await page.click('.range-btn[data-range="reset"]');
    await parked(page, "复位");
    // 往右拖一点（最新一根挪到直方图下面）：松手后停回直方图左边
    const box = (await page.locator("#chart").boundingBox())!;
    const drag = async (dx: number) => {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + dx / 2, box.y + box.height / 3, { steps: 4 });
      await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 3, { steps: 4 });
      await page.mouse.up();
    };
    await drag(40);
    await parked(page, "拖一点");
    // 拖得远，最新一根出了右边：不拉回来（用户在看以前的 K 线）
    await drag(box.width * 0.6);
    await page.waitForTimeout(200);
    const far = await room(page);
    expect(far.right).toBeGreaterThan(far.width);
    await page.click('.range-btn[data-range="reset"]');
    await parked(page, "拖远后复位");
    // 周线不画筹码、恢复原来的留白；切回日线又让出来
    await page.click('[data-frame="week"]');
    await until(page, "周线不画筹码", async () => (await import("/app.js")).getChart().profile().drawn === null);
    await page.click('[data-frame="day"]');
    await parked(page, "切回日线");
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  test("「怎么用」讲了筹码怎么读：上方是阻力、下方山路轻松，反弹看上方最近那座山，只给价位不给买卖信号", async () => {
    const { page } = await open();
    await page.click(".chart-help-toggle");
    const text = (await page.textContent(".chart-help"))!;
    for (const k of ["山在价格上方是阻力", "山路轻松（J49）", "上方最近那座山的山脚到山顶大概率是这次反弹的目标区间", "不给买卖信号"]) expect(text).toContain(k);
    await page.close();
  }, 30_000);

  test("计划的参考带只描框、写标签，不整块填色：带里面和带外面的空白一样", async () => {
    const { page, errors } = await open((p) => p.addInitScript(() => localStorage.setItem("dma-layers", JSON.stringify({ profile: true }))), "PROFILE");
    await page.waitForSelector("#chart canvas");
    await scrollIntoCenter(page, ".chart-card");
    await parked(page, "打开");
    // 带里面（山框左边那条留给小字的空白，没有直方图）和同一高度、山框外面一点的空白比颜色：整块填色时里面会偏色
    const px = await page.evaluate(async () => {
      const c = (await import("/app.js")).getChart();
      const { left, ref } = c.profile().drawn;
      const shot = c.chart.takeScreenshot();
      const k = shot.width / document.getElementById("chart")!.clientWidth;
      const g = shot.getContext("2d")!;
      const at = (x: number, y: number) => [...g.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data].join(",");
      const rows = [];
      for (let y = ref.top + 16; y < ref.bottom - 2; y += 3) rows.push({ y, inside: at(left + 2, y), outside: at(left - 3, y) });
      return rows;
    });
    expect(px.length).toBeGreaterThan(0);
    for (const r of px) expect(r.inside).toBe(r.outside);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("回放：只用回放那天及以前的 K 线，往后放一根就多算一根；参考带属于最新一天，回放时收起", async () => {
    const { page, errors } = await open((p) => p.addInitScript(() => localStorage.setItem("dma-layers", JSON.stringify({ profile: true }))), "PROFILE");
    await page.waitForSelector("#chart canvas");
    await scrollIntoCenter(page, ".chart-card");
    await page.click(".replay-toggle");
    await page.click(".replay-start");
    await page.fill(".replay-menu input", CHART.candles[200].time);
    await page.waitForFunction(async () => (await import("/app.js")).getChart().replay().mode === "replay");
    await page.click(".replay-play"); // 暂停
    const idx = (await page.evaluate(async () => (await import("/app.js")).getChart().replay())).index;
    let p = await profile(page);
    expect(p.to).toBe(CHART.candles[idx].time);
    expect(p.ref).toBeNull();
    expect(p.drawn.labels.some((l: any) => l.text.startsWith("参考带"))).toBe(false);
    await page.click(".replay-forward");
    p = await profile(page);
    expect(p.to).toBe(CHART.candles[idx + 1].time);
    await parked(page, "回放");
    await page.click(".replay-exit");
    p = await profile(page);
    expect([p.to, p.ref]).toEqual([CHART.candles.at(-1)!.time, { foot: 175, top: 185 }]);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
});

describe("聚焦一组", () => {
  const focus = (page: Page) => page.evaluate(async () => (await import("/app.js")).getChart().focus());
  const styles = (page: Page) => page.evaluate(async () => (await import("/app.js")).getChart().lineStyles());

  test("点「20 线组」：20 组的 MA、EMA 之间填色带，另外两组变淡；再点一次取消；按 Esc 也取消；刷新后还记得", async () => {
    const { page, errors } = await open();
    await page.waitForSelector("#chart canvas");
    await scrollIntoCenter(page, ".chart-card");
    for (const n of [20, 60, 120]) expect({ n, ok: await notCovered(page, `.group-focus[data-group="${n}"]`) }).toEqual({ n, ok: true });
    expect(await focus(page)).toEqual({ group: null, band: [] });
    const shot = () => page.locator("#chart").screenshot();
    const plain = await shot();
    await page.click('.group-focus[data-group="20"]');
    const on = await focus(page);
    expect(on.group).toBe(20);
    // 色带从两条线都有值的第一根画到最新一根，值就是这两条线的值
    expect(on.band).toHaveLength(CHART.candles.length);
    expect(on.band.at(-1)).toEqual({ i: CHART.candles.length - 1, ma: CHART.lines.MA20.at(-1)!.value, ema: CHART.lines.EMA20.at(-1)!.value });
    expect(await page.getAttribute('.group-focus[data-group="20"]', "aria-pressed")).toBe("true");
    const s = await styles(page);
    expect(s.MA20.color).toBe("#1c2430");
    expect([s.MA60.color, s.EMA120.color].every((c: string) => c.startsWith("rgba(") && c.endsWith(",0.2)"))).toBe(true);
    expect([s.EMA20.lastValueVisible, s.MA60.lastValueVisible]).toEqual([true, false]);
    expect(Buffer.compare(plain, await shot())).not.toBe(0); // 色带真的画在图上
    // 图例里一条线的开关照常：隐藏 EMA20，色带没了；再打开，色带回来
    await page.click('#legend button[data-line="EMA20"]');
    expect((await focus(page)).band).toEqual([]);
    await page.click('#legend button[data-line="EMA20"]');
    expect((await focus(page)).band.length).toBeGreaterThan(0);
    await page.click('.group-focus[data-group="20"]');
    expect(await focus(page)).toEqual({ group: null, band: [] });
    await page.click('.group-focus[data-group="60"]');
    await page.reload();
    await page.waitForSelector("#chart canvas");
    expect((await focus(page)).group).toBe(60);
    await page.keyboard.press("Escape");
    expect(await focus(page)).toEqual({ group: null, band: [] });
    expect((await styles(page)).MA20.color).toBe("#1c2430");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("回放时色带跟着截到的那天走，往后放一根就多一根", async () => {
    const { page, errors } = await open();
    await page.waitForSelector("#chart canvas");
    await scrollIntoCenter(page, ".chart-card");
    await page.click('.group-focus[data-group="120"]');
    await page.click(".replay-toggle");
    await page.click(".replay-start");
    await page.fill(".replay-menu input", CHART.candles[200].time);
    await page.waitForFunction(async () => (await import("/app.js")).getChart().replay().mode === "replay");
    await page.click(".replay-play"); // 暂停
    const at = async () => (await focus(page)).band.at(-1)?.i;
    const idx = (await page.evaluate(async () => (await import("/app.js")).getChart().replay())).index;
    expect(await at()).toBe(idx);
    expect((await focus(page)).band).toHaveLength(idx + 1); // 回放那天之后的线不画
    await page.click(".replay-forward");
    expect(await at()).toBe(idx + 1);
    await page.click(".replay-exit");
    expect(await at()).toBe(CHART.candles.length - 1);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
});

describe("图面去杂：缺口只画要紧的，小字不压在一起", () => {
  const api = <T,>(page: Page, fn: string) => page.evaluate(async (fn) => (await import("/app.js")).getChart()[fn](), fn) as Promise<T>;
  const bandDates = async (page: Page) => (await api<any>(page, "structure")).bands.map((b: any) => b.date);
  /** 画出来的小字两两不重叠，也不压在价位线上。 */
  const tidy = async (page: Page) => {
    const { labels, guides } = await api<any>(page, "labels");
    const shown = labels.filter((l: any) => !l.hidden);
    const hit = (a: any, b: any) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
    const pairs = shown.flatMap((a: any, k: number) => shown.slice(k + 1).filter((b: any) => hit(a, b)).map((b: any) => [a.text, b.text]));
    const onLine = shown.filter((l: any) => guides.some((y: number) => y > l.top && y < l.top + l.height)).map((l: any) => l.text);
    return { count: shown.length, pairs, onLine };
  };

  test("缺口只画目标位和离现价最近的；菜单里「全部」写着还有 6 个、看得见没被挡，勾上画全部、小字照样不重叠；再点收回", async () => {
    const { page, errors } = await open(undefined, "CROWD");
    await page.waitForSelector("#chart canvas");
    await scrollIntoCenter(page, ".chart-card");
    await pickPreset(page, "structure");
    expect(await bandDates(page)).toEqual([CROWD_GAPS[0].date, CROWD_GAPS[7].date]);
    const more = await layerItem(page, "gapsAll");
    expect([more.disabled, more.pressed, more.text]).toEqual([false, "false", "全部离得远、不是阻力位的那 6 个也画"]);
    expect(await notCovered(page, layerBtn("gapsAll"))).toBe(true);
    await page.keyboard.press("Escape");
    const before = await tidy(page);
    expect(before).toMatchObject({ pairs: [], onLine: [] });
    expect(before.count).toBeGreaterThan(2);
    await switchLayer(page, "gapsAll");
    expect(await bandDates(page)).toEqual(CROWD_GAPS.map((g) => g.date));
    expect((await layerItem(page, "gapsAll")).pressed).toBe("true");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100); // 等图重画一帧，小字重新摆过
    const all = await tidy(page);
    expect(all).toMatchObject({ pairs: [], onLine: [] });
    // 目标位那条一定写出来
    expect((await api<any>(page, "labels")).labels.find((l: any) => l.text.includes("阻力位")).hidden).toBe(false);
    await switchLayer(page, "gapsAll");
    expect(await bandDates(page)).toHaveLength(2);
    // 「缺口」关掉时「全部」也不能点，写着要先打开缺口
    await switchLayer(page, "gaps");
    expect(await bandDates(page)).toEqual([]);
    const sub = await layerItem(page, "gapsAll");
    expect([sub.disabled, sub.text]).toEqual([true, "全部先打开「缺口」"]);
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("关掉价位线：小字就不用再躲它们", async () => {
    const { page, errors } = await open(undefined, "CROWD");
    await page.waitForSelector("#chart canvas");
    expect((await api<any>(page, "labels")).guides.length).toBeGreaterThan(0);
    await switchLayer(page, "levels");
    expect((await api<any>(page, "labels")).guides).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
});

describe("日 / 周切换", () => {
  const chartApi = <T,>(page: Page, fn: string) => page.evaluate(async (fn) => (await import("/app.js")).getChart()[fn](), fn) as Promise<T>;
  const W = CHART.weekly;

  test("点「周」：周 K 线、读数写那一周和比上一周的涨跌；只在日线上的按钮不能点；点「日」回来", async () => {
    const { page, errors } = await open();
    await page.waitForSelector("#chart canvas");
    await scrollIntoCenter(page, ".chart-card");
    for (const sel of ['[data-frame="day"]', '[data-frame="week"]']) expect({ sel, ok: await notCovered(page, sel) }).toEqual({ sel, ok: true });
    expect(await page.getAttribute('[data-frame="day"]', "aria-pressed")).toBe("true");
    await page.click('[data-frame="week"]');
    expect(await chartApi(page, "frame")).toBe("week");
    expect((await chartApi<any>(page, "replay")).bars).toBe(W.candles.length);
    expect(await page.textContent(".chart-card .chart-frame")).toBe("周线");
    const [prev, last] = W.candles.slice(-2);
    const ro = (await page.textContent("#chart-readout"))!;
    expect(ro).toContain(`周 ${last.time}（本周未完）`);
    expect(ro).toContain(`${((last.close / prev.close - 1) * 100).toFixed(2).replace("-", "−")}%`);
    expect(ro).toContain(`MA20 ${W.lines.MA20.at(-1)!.value.toFixed(2)}`);
    expect(ro).not.toContain("MA200");
    for (const sel of [".replay-toggle", ".measure-toggle", ".range-btn[data-range='1w']", ".range-btn[data-range='1m']"]) {
      expect({ sel, off: await page.isDisabled(sel) }).toEqual({ sel, off: true });
    }
    expect(await page.getAttribute(".range-btn[data-range='all']", "aria-pressed")).toBe("true");
    expect(await page.isDisabled(".draw-toggle")).toBe(false); // 画线、价位线是价格，周线上照常
    await page.click('[data-frame="day"]');
    expect(await chartApi(page, "frame")).toBe("day");
    expect((await chartApi<any>(page, "replay")).bars).toBe(CHART.candles.length);
    expect(await page.textContent("#chart-readout")).toContain(CHART.candles.at(-1)!.time);
    expect(await page.getAttribute(".range-btn[data-range='1y']", "aria-pressed")).toBe("true");
    expect(await page.isDisabled(".replay-toggle")).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("测量中、回放中切到周线：先退出（模式互斥，回放只在日线上）", async () => {
    const { page, errors } = await open();
    await page.waitForSelector("#chart canvas");
    await scrollIntoCenter(page, ".chart-card");
    await page.click(".measure-toggle");
    expect(await chartApi(page, "tool")).toBe("measure");
    await page.click('[data-frame="week"]');
    expect(await chartApi(page, "tool")).toBe("none");
    expect(await page.getAttribute(".measure-toggle", "aria-pressed")).toBe("false");
    await page.click('[data-frame="day"]');
    await page.click(".replay-toggle");
    await page.click(".replay-start");
    await page.click('[data-start="earliest"]');
    await page.waitForFunction(async () => (await import("/app.js")).getChart().replay().mode === "replay");
    await page.click('[data-frame="week"]');
    expect((await chartApi<any>(page, "replay")).mode).toBe("off");
    expect(await page.isVisible(".replay-bar")).toBe(false);
    expect(await chartApi(page, "frame")).toBe("week");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
});

describe("中栏：结论 → 看大局 → 找打法 → 做推演", () => {
  test("顺序：结论、K 线图、看大局、找打法、做推演；没有单独的规则清单卡", async () => {
    const { page, errors } = await open();
    const order = await page.evaluate(() => [...document.querySelectorAll("#verdict, .chart-card, #steps .step")]
      .map((e) => (e as HTMLElement).dataset.step || e.id || "chart"));
    expect(order).toEqual(["verdict", "chart", "big_picture", "play", "forecast"]);
    expect(await page.locator("#steps .step h2").allTextContents()).toEqual(["看大局", "找打法", "做推演"]);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("结论：默认视图第一眼就是现在 / 模糊判断两段标题和空仓、持仓两行，带价位；看得见、没被挡；空仓不买没有回测一行", async () => {
    const { page, errors } = await open();
    for (const sel of ["#verdict .concl-now", "#verdict .concl-lean", '#verdict .concl-row[data-situation="flat"] .what b', '#verdict .concl-row[data-situation="holding"] .what b']) {
      expect({ sel, ok: await notCovered(page, sel) }).toEqual({ sel, ok: true });
    }
    expect((await page.textContent("#verdict .concl-now"))!.replace(/\s+/g, "")).toBe("现在加速下跌·延伸");
    expect((await page.textContent("#verdict .concl-lean"))!.replace(/\s+/g, "")).toBe("大方向·接下来约6周明显偏空");
    expect(await page.getAttribute("#verdict .concl-lean", "data-tip")).toContain("不预测明天涨跌");
    const flat = (await page.textContent('#verdict .concl-row[data-situation="flat"]'))!;
    expect(flat).toContain("不做：盈亏比 0.57:1"); // 加速下跌等构造和 20 线组拐头再进，但到缺口的空间不够 3:1
    expect(flat).toContain("触发");
    expect(flat).toContain("212.21");
    const holding = (await page.textContent('#verdict .concl-row[data-situation="holding"]'))!;
    expect(holding).toContain("反弹再减仓");
    expect(holding).toContain("183.08");
    expect(await page.locator("#verdict .record").count()).toBe(0); // 加速下跌空仓不买：没有本打法的记录
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("整套方法的评估免责全页只说一次：不在结论卡片里，在中栏三步下面，滚到时看得见", async () => {
    const { page, errors } = await open(undefined, "SPY@2024-04-19");
    const shown = await page.evaluate(() => document.body.innerText.split("没找到可验证的交易优势").length - 1);
    expect(shown).toBe(1);
    expect(await page.textContent("#verdict")).not.toContain("没找到可验证的交易优势");
    await scrollIntoCenter(page, "#method-note");
    expect(await notCovered(page, "#method-note")).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("结论：触发价离现价还远时盈亏比写到时重算、不写不做，默认视图看得见；找打法里写推演最早哪天站上哪个价位", async () => {
    const { page, errors } = await open(undefined, "FAR");
    const flat = '#verdict .concl-row[data-situation="flat"]';
    expect(await notCovered(page, `${flat} [data-item=rr]`)).toBe(true);
    const row = (await page.textContent(flat))!.replace(/\s+/g, "");
    expect(row).toContain("不抢反弹，等底部构造和均线拐头");
    expect(row).toContain("盈亏比到时重算");
    expect(row).not.toContain("不做");
    expect(await page.getAttribute(`${flat} [data-item=rr]`, "data-tip")).toContain("按明天的触发价 212.21 算是 0.57:1");
    expect(await notCovered(page, `${flat} [data-item=size]`)).toBe(true);
    expect((await page.textContent(`${flat} [data-item=size]`))!.replace(/\s+/g, "")).toBe("股数到时重算");
    expect(await page.getAttribute(`${flat} [data-item=size]`, "data-tip")).toContain("每 1 万元风险对应 343 股");
    const plan = page.locator('[data-step="play"] .plan-body');
    await scrollIntoCenter(page, '[data-step="play"]');
    const text = (await plan.textContent())!;
    expect(text).toContain("最早约 6 个交易日后（2026-11-26）、收盘站上 190.00");
    expect(text).toContain("明天要拐头得站上 212.21");
    expect(text).toContain("触发价离现价还远，到时重算。");
    expect(text).not.toContain("343 股");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("结论：空仓五样（触发、止损、目标、盈亏比、股数）、持仓的止损和目标，默认视图看得见、没被挡；图上画目标线", async () => {
    const { page, errors } = await open(undefined, "SPY@2024-04-19");
    const flat = '#verdict .concl-row[data-situation="flat"]';
    const holding = '#verdict .concl-row[data-situation="holding"]';
    for (const sel of [`${flat} [data-item=trigger]`, `${flat} [data-item=stop]`, `${flat} [data-item=target]`, `${flat} [data-item=rr]`, `${flat} [data-item=size]`,
      `${holding} [data-item=stop]`, `${holding} [data-item=target]`]) {
      expect({ sel, ok: await notCovered(page, sel) }).toEqual({ sel, ok: true });
    }
    const f = (await page.textContent(flat))!.replace(/\s+/g, "");
    expect(f).toContain("不做：盈亏比1.94:1");
    expect(f).toContain("触发500.45");
    expect(f).toContain("止损488.03-2.5%"); // 60 线组拐头（解读），风险按触发价算
    expect(f).toContain("阻力524.61"); // 前高（解读），说明在悬停里
    expect(await page.getAttribute(`${flat} [data-item=target]`, "data-tip")).toContain("中长线完好（现在是稳定上涨）就继续拿"); // P25：到目标是检查点
    expect(await page.getAttribute(`${flat} [data-item=target]`, "data-tip")).toStartWith("第一阻力/目标位："); // 卡片上只写「阻力」，悬停写全称（ADR 0031）
    expect(f).toContain("股数804/万元"); // 没填账户：每 1 万元风险对应的股数
    expect(await page.getAttribute(`${flat} [data-item=rr]`, "class")).toContain("bad");
    expect(await page.textContent(`${holding} [data-item=stop]`)).toContain("488.03"); // 持仓止损按进场原则，不按成本
    await scrollIntoCenter(page, "#verdict .record"); // 卡片最后一行，1280×720 下要往下滚一点
    expect(await notCovered(page, "#verdict .record")).toBe(true); // 稳定上涨有本打法的回测记录
    const rec = (await page.textContent("#verdict .record"))!.replace(/\s+/g, "");
    expect(rec).toContain("5笔");
    expect(rec).toContain("比随机进场少7.6%");
    const kinds = await page.evaluate(async () => {
      const { chartLevels } = await import("/viz.js");
      const d = await (await fetch("/api/analyze?ticker=SPY&asof=2024-04-19")).json();
      return chartLevels(d.report, { pos: "flat", cost: "" }, d.analysis.close).map((l: { kind: string; title: string }) => `${l.kind}:${l.title}`);
    });
    expect(kinds).toEqual(expect.arrayContaining(["trigger:触发", "stop:进场后止损", "target:第一阻力/目标位"]));
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("结论：MA200 朴素规则对照一行，默认视图看得见、没被挡；图上 MA200 默认不画，图例里点开", async () => {
    const { page, errors } = await open();
    expect(await notCovered(page, "#verdict .naive")).toBe(true);
    const naive = (await page.textContent("#verdict .naive"))!;
    expect(naive.replace(/\s+/g, "")).toBe("对照MA200规则：空仓｜双均线：空仓｜一致");
    const tip = (await page.getAttribute("#verdict .naive", "data-tip"))!;
    expect(tip).toContain("收盘在下方 25.9%");
    expect(tip).toContain("朴素规则比双均线好");
    await page.waitForSelector("#chart canvas");
    const btn = '#legend button[data-line="MA200"]';
    expect(await page.getAttribute(btn, "aria-pressed")).toBe("false");
    expect(await page.textContent("#chart-readout")).not.toContain("MA200");
    await scrollIntoCenter(page, ".chart-card"); // 图在结论下面：像用户一样滚到图
    expect(await notCovered(page, btn)).toBe(true);
    await page.click(btn);
    expect(await page.getAttribute(btn, "aria-pressed")).toBe("true");
    expect(await page.textContent("#chart-readout")).toContain(`MA200 ${CHART.lines.MA200.at(-1)!.value.toFixed(2)}`);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("结论：窄屏 390px 下对照一句的「一致」不被截掉，浮盈建议看得见", async () => {
    const { page, errors } = await open();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#verdict .naive").scrollIntoViewIfNeeded(); // 窄屏整页滚动，不是中栏自己滚
    expect(await notCovered(page, "#verdict .naive-agree")).toBe(true);
    const [agree, line] = await page.evaluate(() => ["#verdict .naive-agree", "#verdict .naive"].map((s) => document.querySelector(s)!.getBoundingClientRect().right));
    expect(agree).toBeLessThanOrEqual(line);
    await page.fill("#pos-cost", "133");
    await page.locator("#verdict .pnl-advice").scrollIntoViewIfNeeded();
    expect(await notCovered(page, "#verdict .pnl-advice")).toBe(true);
    await page.fill("#pos-cost", "");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("看大局：第一眼就是趋势类型；类型对照表在这里，不在找打法", async () => {
    const { page, errors } = await open();
    const step = page.locator('[data-step="big_picture"]');
    expect(await step.locator(".answer").textContent()).toContain("加速下跌");
    expect(await step.locator("table.trend").count()).toBe(1);
    expect(await page.locator('[data-step="play"] table.trend').count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("找打法（ADR 0029）：空仓六格、持仓五格，按做决定的顺序；滚到时每格标题看得见、没被挡；依据默认折叠", async () => {
    const { page, errors } = await open();
    const card = '[data-step="play"]';
    const shown = async (titles: string[]) => {
      expect(await page.locator(`${card} .pc-title`).allTextContents()).toEqual(titles);
      for (let n = 1; n <= titles.length; n++) {
        const sel = `${card} .pcell:nth-child(${n}) .pc-title`;
        await scrollIntoCenter(page, sel);
        expect({ n, ok: await notCovered(page, sel) }).toEqual({ n, ok: true });
      }
      const open = await page.locator(`${card} .plan-cells details.basis`).evaluateAll((els) => els.filter((e) => (e as HTMLDetailsElement).open).length);
      expect(open).toBe(0);
    };
    await shown(["能不能做", "等什么信号", "进场价", "止损", "第一阻力/目标位和盈亏比", "仓位"]);
    expect((await page.textContent(`${card} .pcell[data-cell="go"] .pc-main`))!.replace(/\s+/g, "")).toContain("不做盈亏比0.57:1，不到3:1");
    expect(await page.textContent(`${card} .pcell[data-cell="entry"] .pc-main`)).toContain("212.21");
    expect(await page.textContent(`${card} .pcell[data-cell="stop"] .pc-main`)).toContain("183.08");
    await scrollIntoCenter(page, `${card} .pos-row`);
    await page.click(`${card} [data-pos="holding"]`);
    await shown(["拿着还是走", "盯什么信号", "止损 / 离场价", "第一阻力/目标位", "浮盈 / 浮亏怎么办"]);
    expect(await page.textContent(`${card} .pcell[data-cell="go"] .pc-main`)).toContain("减仓");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("找打法的仓位格：股数后面一行仓位比例，没填账户也有；默认视图看得见、没被挡（ADR 0039）", async () => {
    const { page, errors } = await open(undefined, "SPY@2024-04-19");
    expect(analyzeCalls.some((a) => a[0] === "SPY" && a.join(" ").includes("--risk-pct 1") && !a.includes("--account"))).toBe(true);
    const cell = '[data-step="play"] .pcell[data-cell="size"] .pc-main';
    await scrollIntoCenter(page, cell);
    expect(await notCovered(page, cell)).toBe(true);
    expect((await page.textContent(cell))!.replace(/\s+/g, " ")).toMatch(/用账户的 \d+(\.\d)?%（止损幅度 [\d.]+%，每笔亏账户的 1%）/);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("找打法：条件清单逐条 ✓ / ✗ / 需看图，没满足的写还差什么；点开「等什么信号」的依据，看得见、没被挡", async () => {
    const { page, errors } = await open();
    const card = '[data-step="play"]';
    const basis = `${card} .pcell[data-cell="signal"] details.basis`;
    await scrollIntoCenter(page, `${basis} > summary`);
    await page.click(`${basis} > summary`);
    await scrollIntoCenter(page, `${card} .checklist`);
    expect(await notCovered(page, `${card} .checklist li`)).toBe(true);
    const rows = await page.locator(`${card} .checklist li`).evaluateAll((els) =>
      els.map((e) => [(e as HTMLElement).dataset.rule, e.querySelector(".mark")!.textContent]));
    expect(rows).toEqual([["P7", "✓"], ["P8", "✓"], ["P9", "✗"], ["J19", "✗"], ["J21", "✗"], ["J37", "✗"], ["P24", "✓"]]);
    expect(await page.textContent(`${card} .checklist li[data-rule="J21"] .need`)).toContain("170.00");
    expect(await page.textContent(`${card} .missing`)).toContain("170.00"); // 加速下跌会买（等构造完成），还差构造下一步
    expect(await page.locator(`${card} details.all-rules`).getAttribute("open")).toBeNull(); // 全部规则折叠在最下面
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("找打法：空仓 / 持仓切换，做法和图上的价位线跟着变；刷新后记住", async () => {
    const { page } = await open();
    await page.waitForSelector("#chart canvas");
    const plan = page.locator('[data-step="play"] .plan-body');
    const titles = () => page.evaluate(async () => (await import("/app.js")).getChart().levels().map((l: { title: string }) => l.title));
    expect(await plan.textContent()).toContain("不做盈亏比 0.57:1");
    expect(await titles()).toEqual(["触发", "进场后止损", "第一阻力/目标位", "判断失效"]);
    await page.click('[data-pos="holding"]');
    expect(await plan.textContent()).toContain("反弹再减仓");
    expect(await titles()).toEqual(["盯住", "第一阻力/目标位", "判断失效"]);
    await page.fill("#pos-cost", "200");
    expect(await page.textContent(".pnl")).toContain("-24.5%");
    await page.reload();
    await page.waitForSelector(".lean-label");
    expect(await page.getAttribute('[data-pos="holding"]', "aria-pressed")).toBe("true");
    expect(await page.inputValue("#pos-cost")).toBe("200");
    await page.close();
  }, 30_000);

  test("做推演：滚到这一步，第一眼是结论句（大字）和历史评估标签，然后推翻条件、关键变化；数据默认折叠（ADR 0030）", async () => {
    const { page, errors } = await open();
    const card = '[data-step="forecast"]';
    await scrollIntoCenter(page, card); // 像用户一样把这一步滚到中栏上方
    const headline = `${card} .fc-headline`;
    expect(await page.locator(headline).isVisible()).toBe(true);
    expect(await notCovered(page, headline)).toBe(true);
    expect(await page.textContent(headline)).toBe("接下来约 6 周均线向下：反弹是减仓机会，不是抄底机会");
    // 结论句在推翻条件、关键变化上面
    const tops = await page.$$eval([headline, `${card} .fc-invalid`, `${card} .fc-changes`].join(","), (els) => els.map((e) => e.getBoundingClientRect().top));
    expect([...tops].sort((x, y) => x - y)).toEqual(tops);
    // H1 标签看得见、没被挡；悬停写出评估结论和出处
    const tag = `${card} .fc-h1`;
    expect(await notCovered(page, tag)).toBe(true);
    expect(await page.textContent(tag)).toBe("历史评估：没验证出效果");
    await page.hover(tag);
    await page.waitForSelector("#viz-tip:not([hidden])");
    expect(await page.textContent("#viz-tip")).toContain("方向和主张相反");
    // 推翻条件：206.26，来自求解，标辅助；附 H4
    expect(await page.textContent(`${card} .fc-invalid`)).toContain("206.26");
    expect(await page.textContent(`${card} .fc-invalid .aux-tag`)).toContain("辅助");
    expect(await page.textContent(`${card} .answer .ev-note`)).toContain("97% 真的发生了，但未达到事先定的有用标准（H4）");
    expect(await page.locator(`${card} .fc-changes li`).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.group))).toEqual(["20", "60"]);
    // 数据默认折叠：门槛表、持平情景看不见
    expect(await page.locator(`${card} details.fc-data`).getAttribute("open")).toBeNull();
    expect(await page.locator(`${card} table.hurdles`).first().isVisible()).toBe(false);
    expect(await page.locator(`${card} .flow.scenario`).isVisible()).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("做推演：窄屏 390px 下结论句整句看得见、不溢出，历史评估标签没被挡", async () => {
    const { page, errors } = await open();
    await page.setViewportSize({ width: 390, height: 844 });
    const card = '[data-step="forecast"]';
    await page.locator(`${card} .fc-call`).scrollIntoViewIfNeeded(); // 窄屏整页滚动
    for (const sel of [`${card} .fc-headline`, `${card} .fc-h1`]) expect({ sel, ok: await notCovered(page, sel) }).toEqual({ sel, ok: true });
    const fits = await page.$eval(`${card} .fc-headline`, (el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= innerWidth);
    expect(fits).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("找打法：「就别等」那条推演标辅助、附评估结论；回测不支持的规则带小标签；滚到时看得见、没被挡", async () => {
    const { page, errors } = await open(undefined, "BOUNCE");
    const card = '[data-step="play"]';
    const basis = `${card} .pcell[data-cell="signal"] details.basis`;
    await scrollIntoCenter(page, `${basis} > summary`);
    await page.click(`${basis} > summary`);
    await scrollIntoCenter(page, `${card} .checklist`);
    const tag = `${card} .checklist li[data-rule="J18"] .ev-tag`;
    expect(await notCovered(page, tag)).toBe(true);
    expect(await page.textContent(tag)).toContain("回测不支持");
    await scrollIntoCenter(page, `${basis} .plan-items li.aux`);
    expect(await notCovered(page, `${basis} .plan-items li.aux`)).toBe(true);
    const aux = (await page.textContent(`${basis} .plan-items li.aux`))!;
    expect(aux).toContain("辅助 · 等多久");
    expect(aux).toContain("就别等");
    expect(aux).toContain("（H4）");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("要点和出处默认折叠", async () => {
    const { page } = await open();
    expect(await page.locator('[data-step="big_picture"] details.points-box').getAttribute("open")).toBeNull();
    await page.close();
  }, 30_000);
});

describe("抽屉：结论和 K 线图滚上去以后还能拉回来", () => {
  const scrollDown = (page: Page) => page.evaluate(() => {
    const s = document.getElementById("center-scroll")!;
    s.scrollTop = s.scrollHeight;
    return s.scrollTop;
  });

  test("滚到下面：顶部出现提示条；点「K 线图」拉出抽屉，「收起」放回原处，滚动位置不变", async () => {
    const { page, errors } = await open();
    await page.waitForSelector("#chart canvas");
    expect(await page.isVisible("#peek")).toBe(false);
    const top = await scrollDown(page);
    await page.waitForSelector("#peek", { state: "visible" });
    expect(await page.textContent("#peek")).toContain("明显偏空");
    await page.click('[data-peek="chart"]');
    await page.waitForSelector("#drawer", { state: "visible" });
    expect(await page.locator("#drawer #chart canvas").count()).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.getElementById("center-scroll")!.scrollTop)).toBe(top);
    await page.click("#drawer .drawer-close");
    expect(await page.isVisible("#drawer")).toBe(false);
    expect(await page.locator(".chart-card #chart").count()).toBe(1);
    expect(await page.evaluate(() => document.getElementById("center-scroll")!.scrollTop)).toBe(top);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("点「结论」拉出结论卡片", async () => {
    const { page } = await open();
    await scrollDown(page);
    await page.waitForSelector("#peek", { state: "visible" });
    await page.click('[data-peek="verdict"]');
    expect(await page.locator("#drawer .lean-label").textContent()).toBe("明显偏空");
    await page.keyboard.press("Escape");
    expect(await page.isVisible("#drawer")).toBe(false);
    expect(await page.locator("#center-scroll #verdict").count()).toBe(1);
    await page.close();
  }, 30_000);
});



describe("修正：抽屉条件、图表缩放", () => {
  test("结论一滚出视野就出现提示条（K 线图还露着也一样）", async () => {
    const { page } = await open();
    await page.waitForSelector("#chart canvas");
    await page.evaluate(() => {
      const s = document.getElementById("center-scroll")!;
      const v = document.getElementById("verdict")!;
      s.scrollTop = v.offsetTop + v.offsetHeight + 10; // 刚好滚过结论
    });
    await page.waitForSelector("#peek", { state: "visible" });
    expect(await page.evaluate(() => {
      const c = document.querySelector(".chart-card")!.getBoundingClientRect();
      const s = document.getElementById("center-scroll")!.getBoundingClientRect();
      return c.bottom > s.top; // K 线图还在视野里
    })).toBe(true);
    await page.close();
  }, 30_000);

  test("⌘ 或 Ctrl + 滚轮缩放图表；「1 周」只看最近 5 根左右", async () => {
    const { page } = await open();
    await page.waitForSelector("#chart canvas");
    await page.evaluate(() => document.getElementById("chart")!.scrollIntoView({ block: "start" }));
    const range = () => page.evaluate(async () => (await import("/app.js")).getChart().chart.timeScale().getVisibleLogicalRange());
    const before = (await range())!;
    const box = (await page.locator("#chart").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -400);
    await page.keyboard.up("Control");
    await page.waitForTimeout(200);
    const zoomed = (await range())!;
    expect(zoomed.to - zoomed.from).toBeLessThan(before.to - before.from);
    await page.click(".range-btn[data-range='1w']");
    const week = (await range())!;
    expect(week.to - week.from).toBeLessThan(12);
    await page.close();
  }, 30_000);
});

describe("朗读：暂停和继续", () => {
  test("朗读中可以暂停、继续、停止", async () => {
    const { page, errors } = await open();
    await addAdvisorAnswer(page, "这是一段要朗读的回答。");
    const main = page.locator("#advisor-thread .speak");
    const stop = page.locator("#advisor-thread .speak-stop");
    const audioPaused = () => page.evaluate(async () => (await import("/speech.js")).speechState());
    expect(await stop.isVisible()).toBe(false);
    const at = (await main.boundingBox())!; // 点之前的位置
    await main.click();
    await page.waitForFunction(() => document.querySelector("#advisor-thread .speak")?.textContent?.includes("暂停"));
    expect(await stop.isVisible()).toBe(true);
    // 主按钮不挪位置：在开始朗读的同一个地方再点，就是暂停（不会点到停止）
    const moved = (await main.boundingBox())!;
    expect(Math.abs(moved.x + moved.width - (at.x + at.width))).toBeLessThan(2);
    await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2); // 暂停
    expect(await main.textContent()).toContain("继续");
    expect(await audioPaused()).toBe("paused");
    await page.waitForTimeout(400);
    expect(await audioPaused()).toBe("paused"); // 暂停期间不会自己往下播
    await main.click(); // 继续
    expect(await main.textContent()).toContain("暂停");
    expect(await audioPaused()).toBe("playing");
    await stop.click();
    expect(await main.textContent()).toContain("朗读");
    expect(await stop.isVisible()).toBe(false);
    expect(await audioPaused()).toBe("idle");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
});

describe("抽屉：五块，滚过哪块就出现哪块的按钮", () => {
  const shown = (page: Page) => page.evaluate(() =>
    [...document.querySelectorAll<HTMLButtonElement>("#peek [data-peek]")].filter((b) => !b.hidden).map((b) => b.dataset.peek));
  const scrollPast = (page: Page, sel: string) => page.evaluate(async (sel) => {
    const s = document.getElementById("center-scroll")!;
    const el = document.querySelector<HTMLElement>(sel)!;
    s.scrollTop += el.getBoundingClientRect().top - s.getBoundingClientRect().top + 4; // 刚好把这一块的开头滚出视野
    await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
  }, sel);

  test("按顺序往下读，每读到一块，它的按钮就出现（最后一块也行）", async () => {
    const { page, errors } = await open();
    await page.waitForSelector("#chart canvas");
    expect(await page.isVisible("#peek")).toBe(false);
    await scrollPast(page, "#verdict");
    expect(await shown(page)).toEqual(["verdict"]);
    await scrollPast(page, ".chart-card");
    expect(await shown(page)).toEqual(["verdict", "chart"]);
    await scrollPast(page, '[data-step="big_picture"]');
    expect(await shown(page)).toEqual(["verdict", "chart", "big_picture"]);
    await scrollPast(page, '[data-step="play"]');
    expect(await shown(page)).toEqual(["verdict", "chart", "big_picture", "play"]);
    await scrollPast(page, '[data-step="forecast"]');
    expect(await shown(page)).toEqual(["verdict", "chart", "big_picture", "play", "forecast"]);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("抽屉里的找打法照样能用（切持仓），收起后放回原处", async () => {
    const { page } = await open();
    await scrollPast(page, '[data-step="forecast"]');
    await page.click('#peek [data-peek="play"]');
    await page.click('#drawer [data-pos="holding"]');
    expect(await page.locator('#drawer [data-step="play"] .plan-body').textContent()).toContain("反弹再减仓");
    await page.click("#drawer .drawer-close");
    expect(await page.locator('#steps [data-step="play"]').count()).toBe(1);
    await page.click('[data-pos="flat"]'); // 还原，别影响其他测试
    await page.close();
  }, 30_000);

  test("抽屉开着时换股票：抽屉收起，不留下过期的内容", async () => {
    const { page, errors } = await open();
    await scrollPast(page, '[data-step="forecast"]');
    await page.click('#peek [data-peek="big_picture"]');
    await page.evaluate(async () => (await import("/app.js")).loadAnalysis("TSLA", null));
    await page.waitForFunction(() => document.getElementById("ticker")!.textContent === "TSLA");
    expect(await page.isVisible("#drawer")).toBe(false);
    expect(await page.locator('[data-step="big_picture"]').count()).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
});

describe("十字线日期", () => {
  test("十字线底部的日期写成 2026-10-22", async () => {
    const { page } = await open();
    await page.waitForSelector("#chart canvas");
    const out = await page.evaluate(async () => {
      const f = (await import("/app.js")).getChart().chart.options().localization.timeFormatter;
      return f ? [f({ year: 2026, month: 10, day: 22 }), f("2026-10-22"), f(Date.UTC(2026, 9, 22) / 1000)] : null;
    });
    expect(out).toEqual(["2026-10-22", "2026-10-22", "2026-10-22"]);
    await page.close();
  }, 30_000);
});

describe("看大局的证据：按判断顺序的五问", () => {
  // 按脚本的判断顺序（rules.md J1–J7）：类型看 60/120 线组和钟表，加速看钟表或乖离，阶段看 20 线组；最后看大一级、小一级
  test("五问依次是：60/120 排好没有、60 线几点钟、是不是加速、20 线组走到哪一步、周线和小时线；每问先给判断；最后接回结论", async () => {
    const { page, errors } = await open();
    const step = page.locator('[data-step="big_picture"]');
    const qs = await step.locator(".check h3").allTextContents();
    expect(qs.map((q) => q.replace(/\s+/g, ""))).toEqual(["①60/120线组排好了吗？", "②60线几点钟？", "③是不是加速？", "④20线组走到哪一步？", "⑤大一级（周线）是什么背景？"]);
    for (const q of await step.locator(".check h3").all()) expect(await q.isVisible()).toBe(true);
    const verdicts = await step.locator(".check .judge").allTextContents();
    expect(verdicts[0]).toMatch(/能定(类型|成加速下跌)/); // 先写结论：能不能定类型、从哪条路定的
    expect(verdicts[1]).toMatch(/点.*：(走平|稳定向下|加速向下)/); // 钟点 + 落在哪一档
    expect(verdicts[2]).toContain("加速出现在趋势刚开始");
    // 每问都有一句「所以」，看得见；② 画钟面，③ 把"是不是加速"和"出现在哪一头"分成两行
    for (const so of await step.locator(".check .so").all()) expect(await so.isVisible()).toBe(true);
    expect(await step.locator(".check .so").count()).toBe(6); // 五问各一句，④ 的 LEI 五步再一句
    expect(await step.locator(".check").nth(1).locator(".viz.clockface svg .hand").count()).toBe(1);
    expect((await step.locator("table.accel-why").textContent())!.replace(/\s+/g, "")).toContain("出现在哪一头");
    expect(await step.locator(".check").nth(0).locator("figcaption").textContent()).toMatch(/6 条线全部(下方|上方)|收盘夹在中间/);
    expect(verdicts[3]).toContain("延伸");
    expect(verdicts[4]).toContain("周线 MA 多头");
    expect(verdicts[4]).not.toContain("小时线"); // 小时线是进场时机，挪到吃回撤的「等什么信号」
    // ④ 先给 LEI 的趋势五步，结论写走到第几步
    expect(await step.locator("table.lei5 tbody tr").count()).toBe(5);
    expect(await step.locator(".check").nth(3).locator(".so").first().textContent()).toMatch(/走到第 \d 步|第 1 步还没走出来/);
    // ⑤「看周线」把 K 线图切到周线
    await step.locator("[data-show-week]").click();
    await until(page, "K 线图切到周线", async () => document.querySelector('.chart-card [data-frame="week"]')?.getAttribute("aria-pressed") === "true");
    // 五步进度：60/120 这一轮向下走到第一个交叉，日期写出来
    const row = step.locator("table.steps5 tbody tr").nth(1);
    expect(await row.textContent()).toContain("11-13");
    expect(await row.textContent()).toContain("4/5");
    expect(await step.locator(".check-sum").textContent()).toContain("加速下跌·延伸");
    expect(await step.locator("table.vt th:text('MA 方向')").count()).toBe(0); // 和结论卡片重复的均线表去掉了
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
});

describe("看大局第 ④ 问：深回撤（J7）、阶段决策树、过渡状态的原因", () => {
  test("顶上小格标深回撤；第 ④ 问写 20/60 已交叉、类型不变，不再说还没交叉", async () => {
    const { page, errors } = await open(undefined, "DEEP");
    const kpi = page.locator(".kpi").filter({ hasText: "趋势类型" });
    expect(await kpi.locator(".kpi-deep").textContent()).toBe("深回撤");
    expect(await notCovered(page, ".kpi .kpi-deep")).toBe(true);
    const q4 = page.locator('[data-step="big_picture"] .check').nth(3);
    await q4.locator(".judge").scrollIntoViewIfNeeded();
    expect(await q4.locator(".judge").textContent()).toContain("深回撤");
    const so = (await q4.locator(".so").last().textContent())!.replace(/\s+/g, "");
    expect(so).toContain("20/60已交叉");
    expect(so).not.toContain("还没交叉");
    // 阶段决策树：默认视图下滚到就看得见，亮的是「深回撤」那一格
    const tree = q4.locator("svg.stage-tree");
    await tree.scrollIntoViewIfNeeded();
    expect(await tree.isVisible()).toBe(true);
    expect(await tree.getAttribute("data-result")).toBe("深回撤");
    expect(await q4.locator(".st-res.on").count()).toBe(1);
    expect(await q4.locator("figure.stagetree figcaption").textContent()).toContain("深回撤");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("过渡状态：第 ④ 问写出是哪一种、凭什么，不画阶段树", async () => {
    const { page, errors } = await open(undefined, "TRANS");
    const q4 = page.locator('[data-step="big_picture"] .check').nth(3);
    await q4.scrollIntoViewIfNeeded();
    expect(await q4.locator("svg.stage-tree").count()).toBe(0);
    const so = (await q4.locator(".so").last().textContent())!.replace(/\s+/g, "");
    expect(so).toContain("「空头结构反弹中」");
    expect(so).toContain("20/60已是空头");
    expect(so).not.toContain("类型没定");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
});

describe("成本价决定浮盈 / 浮亏的做法", () => {
  test("结论里填成本：高于现价，持仓那行变成浮亏；低于现价变成浮盈；找打法的做法跟着变", async () => {
    const { page } = await open();
    const plan = page.locator('[data-step="play"] .plan-body');
    const row = page.locator('#verdict .concl-row[data-situation="holding"]');
    await page.click('[data-pos="holding"]');
    await page.fill("#pos-cost", "200");
    expect(await plan.textContent()).toContain("不等回本");
    expect(await row.locator(".who").textContent()).toBe("持仓 · 浮亏");
    await scrollIntoCenter(page, "#verdict .holding-row"); // 填完成本，往上看一眼持仓那一行
    expect(await notCovered(page, '#verdict .concl-row[data-situation="holding"] .pnl-advice')).toBe(true);
    expect(await row.locator(".pnl-advice").textContent()).toContain("已经浮亏：不等回本");
    await page.fill("#pos-cost", "133");
    expect(await row.locator(".pnl-advice").textContent()).toContain("还有浮盈：止损跟着趋势结构走，不按成本 133.00 定");
    const t = (await plan.textContent())!;
    expect(t).toContain("133.00");
    expect(t).not.toContain("{cost}");
    expect(t).not.toContain("浮亏影响心情");
    expect(await row.locator(".who").textContent()).toBe("持仓 · 浮盈");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("pos-cost"); // 边打字边更新，不丢焦点
    // 填了成本再切空仓、切回持仓：还是浮盈那一版
    await page.click('[data-pos="flat"]');
    await page.click('[data-pos="holding"]');
    expect(await page.inputValue("#pos-cost")).toBe("133");
    expect(await plan.textContent()).toContain("133.00");
    await page.fill("#pos-cost", "");
    await page.click('[data-pos="flat"]');
    await page.close();
  }, 30_000);
});

describe("K 线回放", () => {
  const rp = (page: Page) => page.evaluate(async () => (await import("/app.js")).getChart().replay());
  const levels = (page: Page) => page.evaluate(async () => (await import("/app.js")).getChart().levels());
  const tool = (page: Page) => page.evaluate(async () => (await import("/app.js")).getChart().tool());
  /** 等回放状态满足条件（轮询，最多 10 秒）。 */
  async function waitRp(page: Page, ok: (r: any) => boolean) {
    for (const end = Date.now() + 10_000; Date.now() < end; await page.waitForTimeout(50)) if (ok(await rp(page))) return;
    throw new Error(`回放状态一直不满足：${JSON.stringify(await rp(page))}`);
  }
  /** 图上第 i 根 K 线的屏幕坐标（先把图表放到滚动区顶部，坐标才稳）。 */
  async function barPoint(page: Page, i: number) {
    await page.evaluate(() => document.getElementById("chart")!.scrollIntoView({ block: "start" }));
    const x = await page.evaluate(async (t) => (await import("/app.js")).getChart().chart.timeScale().timeToCoordinate(t), CHART.candles[i].time);
    const box = (await page.locator("#chart").boundingBox())!;
    return { x: box.x + x!, y: box.y + box.height * 0.4 };
  }
  async function start(ticker: string) {
    const r = await open(undefined, ticker);
    await r.page.waitForSelector("#chart canvas");
    return r;
  }
  /** 选好起点就会开始播放：先调到最慢（10 秒一根），断言时位置不会跑。 */
  const slow = (page: Page) => page.selectOption(".replay-speed", "0.1");

  test("默认滚动位置下：点「回放」立刻看得见提示和控制条（不被下面的输入框挡住）；按钮跟着状态变；选好起点就开始放", async () => {
    const { page, errors } = await start("RPLV");
    const visibleAt = (sel: string) => page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + Math.min(20, r.width / 2), r.y + r.height / 2);
      return r.height > 0 && !!hit && el.contains(hit);
    }, sel);
    expect(await page.textContent(".replay-toggle")).toBe("回放");
    await page.click(".replay-toggle");
    expect(await visibleAt(".replay-bar")).toBe(true);
    expect(await page.textContent(".replay-label")).toContain("点图上的一天");
    expect(await page.textContent(".replay-toggle")).toBe("取消选起点");
    const p = await barPoint(page, 150);
    await page.mouse.click(p.x, p.y);
    await waitRp(page, (r) => r.mode === "replay");
    expect((await rp(page)).playing).toBe(true);
    expect(await page.textContent(".replay-toggle")).toContain("退出回放");
    expect(await page.textContent(".replay-play")).toContain("暂停");
    // 用户看得见「回放」按钮的地方，就看得见播放 / 暂停
    await page.evaluate(() => document.querySelector(".replay-toggle")!.scrollIntoView({ block: "center" }));
    expect(await visibleAt(".replay-play")).toBe(true);
    await page.click(".replay-play");
    expect((await rp(page)).playing).toBe(false);
    expect(await page.textContent(".replay-play")).toContain("播放");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("选起点：竖线跟着鼠标、右边变暗、写出日期；点下去只剩那天以前的 K 线，门槛线收起", async () => {
    const { page, errors } = await start("RPLA");
    expect(await page.isVisible(".replay-bar")).toBe(false);
    await page.click(".replay-toggle");
    await slow(page);
    expect(await tool(page)).toBe("pick-start");
    expect(await page.textContent(".replay-label")).toContain("点图上的一天作为回放起点");
    const askLabel = () => page.evaluate(() => document.getElementById("ask-advisor")!.textContent);
    const before = await askLabel();
    const p = await barPoint(page, 200);
    await page.mouse.move(p.x, p.y);
    await page.waitForSelector(".replay-overlay", { state: "visible" });
    expect(await page.textContent(".replay-overlay")).toContain(`回放起点 ${CHART.candles[200].time}`);
    const dim = (await page.locator(".replay-dim").boundingBox())!;
    expect(Math.abs(dim.x - p.x)).toBeLessThan(3); // 暗块从竖线开始往右
    expect(dim.width).toBeGreaterThan(10);
    await page.mouse.click(p.x, p.y);
    await waitRp(page, (r) => r.mode === "replay");
    expect(await rp(page)).toMatchObject({ mode: "replay", index: 200, playing: true, date: CHART.candles[200].time, bars: 201 });
    await page.waitForSelector(".replay-overlay", { state: "hidden" });
    expect(await levels(page)).toEqual([]);
    expect(await page.isVisible(".replay-badge")).toBe(true);
    expect(await page.textContent(".replay-label")).toContain(`第 201/300 根`);
    expect(await askLabel()).toBe(before); // 选起点那一下不触发问鸿雁
    // 鼠标移开，读数条显示回放到的那天
    await page.mouse.move(5, 5);
    await page.waitForFunction((t) => document.getElementById("chart-readout")!.textContent!.includes(t), CHART.candles[200].time);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("前进一根、Shift+→、Shift+↓ 播放暂停（暂停后不再走）；回到最新恢复全部 K 线和门槛线", async () => {
    const { page, errors } = await start("RPLB");
    await page.click(".replay-toggle");
    await slow(page);
    const p = await barPoint(page, 200);
    await page.mouse.click(p.x, p.y);
    await waitRp(page, (r) => r.mode === "replay");
    await page.click(".replay-play"); // 先停下，一根一根看
    // 图表库在下一帧才把视图改好：等两帧再读
    const lr = () => page.evaluate(async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return (await import("/app.js")).getChart().chart.timeScale().getVisibleLogicalRange();
    });
    const r0 = (await lr())!;
    expect(r0.to).toBeGreaterThan(200); // 回放那天在视图里，右边留着空位
    await page.click(".replay-forward");
    expect(await rp(page)).toMatchObject({ index: 201, bars: 202 });
    const r1 = (await lr())!;
    expect(Math.abs((r1.to - r1.from) - (r0.to - r0.from))).toBeLessThan(1); // 视图不跳、不复位
    expect(r1.to).toBeGreaterThanOrEqual(r0.to);
    expect(r1.to).toBeGreaterThan(201);
    await page.keyboard.press("Shift+ArrowRight");
    expect(await rp(page)).toMatchObject({ index: 202, bars: 203 });
    await page.selectOption(".replay-speed", "10");
    await page.locator(".replay-speed").blur(); // 焦点在下拉框里时快捷键不生效（和输入框一样）
    await page.keyboard.press("Shift+ArrowDown");
    await waitRp(page, (r) => r.index >= 206);
    await page.keyboard.press("Shift+ArrowDown");
    const paused = await rp(page);
    expect(paused.playing).toBe(false);
    await page.waitForTimeout(400); // 10x 是 100ms 一根：定时器没清掉的话这里会多走几根
    expect((await rp(page)).index).toBe(paused.index);
    await page.click(".replay-realtime");
    expect(await rp(page)).toMatchObject({ mode: "off", bars: 300 });
    expect((await levels(page)).length).toBeGreaterThan(0);
    expect(await page.isVisible(".replay-badge")).toBe(false);
    expect(await page.isVisible(".replay-bar")).toBe(false);
    // 控制条收起后图往上挪，鼠标正好落在图上（读数条显示停着的那天）：移开才是最新一天
    await page.mouse.move(5, 5);
    await page.waitForFunction((t) => document.getElementById("chart-readout")!.textContent!.includes(t), CHART.candles.at(-1)!.time);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("选日期：落到那天；放到最新一根自动停下", async () => {
    const { page, errors } = await start("RPLC");
    await page.click(".replay-toggle");
    await slow(page);
    await page.click(".replay-start");
    await page.fill(".replay-menu input[type=date]", CHART.candles[296].time);
    await waitRp(page, (r) => r.mode === "replay");
    expect((await rp(page)).index).toBe(296);
    await page.selectOption(".replay-speed", "10"); // 正在放：换速度立刻生效
    await waitRp(page, (r) => r.index === 299 && !r.playing);
    expect(await page.textContent(".replay-label")).toContain("已到最新");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("最早一天：6 条线都有值的第一根（假数据从第一根起就齐）；随机一天落在中间；× 退出", async () => {
    const { page } = await start("RPLD");
    await page.click(".replay-toggle");
    await slow(page);
    await page.click(".replay-start");
    await page.click(".replay-menu [data-start=earliest]");
    expect(await rp(page)).toMatchObject({ mode: "replay", index: 0 });
    await page.click(".replay-start");
    await page.click(".replay-menu [data-start=random]");
    const r = await rp(page);
    expect(r.index).toBeGreaterThanOrEqual(0);
    expect(r.index).toBeLessThanOrEqual(298);
    await page.click(".replay-exit");
    expect(await rp(page)).toMatchObject({ mode: "off", bars: 300 });
    await page.close();
  }, 30_000);

  test("Esc 取消选起点；换一只票退出回放", async () => {
    const { page } = await start("RPLE");
    await page.click(".replay-toggle");
    await page.keyboard.press("Escape");
    expect((await rp(page)).mode).toBe("off");
    await page.click(".replay-toggle");
    await page.click(".replay-start");
    await page.click(".replay-menu [data-start=earliest]");
    await page.evaluate(async () => (await import("/app.js")).loadAnalysis("RPLF", null));
    await page.waitForFunction(() => document.getElementById("ticker")!.textContent === "RPLF");
    expect(await rp(page)).toMatchObject({ mode: "off", bars: 300 });
    expect(await page.isVisible(".replay-badge")).toBe(false);
    await page.close();
  }, 30_000);

  test("按这一天分析：退出回放，载入那天的历史分析", async () => {
    const { page } = await start("RPLG");
    await page.click(".replay-toggle");
    await slow(page);
    await page.click(".replay-start");
    await page.click(".replay-menu [data-start=earliest]");
    const date = CHART.candles[0].time;
    await page.click(".replay-analyze");
    await page.waitForFunction((h) => location.hash === h, `#RPLG@${date}`);
    await page.waitForFunction(() => document.getElementById("meta-line")!.textContent!.includes("回放"));
    expect((await rp(page)).mode).toBe("off");
    await page.close();
  }, 30_000);

  test("回放中同一只票被重新载入（长风调了取数）：停在原来那天，不露出后面的 K 线；换票才退出", async () => {
    const { page, errors } = await start("RPLH");
    await page.click(".replay-toggle");
    await page.click(".replay-start");
    await page.fill(".replay-menu input[type=date]", CHART.candles[150].time);
    await page.dispatchEvent(".replay-menu input[type=date]", "change");
    await waitRp(page, (r) => r.mode === "replay" && r.index === 150);
    expect((await rp(page)).playing).toBe(true);
    // 长风工具推来同一只票的最新分析 → showAnalysis → setData
    await page.evaluate(async () => {
      const app = await import("/app.js");
      const data = await (await fetch("/api/analyze?ticker=RPLH")).json();
      app.showAnalysis(data);
    });
    const r = await rp(page);
    expect(r.mode).toBe("replay");
    expect(r.playing).toBe(false);
    expect(r.bars).toBe(r.index + 1);
    expect(r.index).toBeLessThan(160);
    expect(await levels(page)).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("回放中重选起点：视图留在原处，不跳回最新一年", async () => {
    const { page } = await start("RPLI");
    await page.click(".replay-toggle");
    await slow(page);
    await page.click(".replay-start");
    await page.fill(".replay-menu input[type=date]", CHART.candles[60].time);
    await page.dispatchEvent(".replay-menu input[type=date]", "change");
    await waitRp(page, (r) => r.mode === "replay" && r.index === 60);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const range = () => page.evaluate(async () => (await import("/app.js")).getChart().chart.timeScale().getVisibleLogicalRange());
    const before = (await range())!;
    await page.click(".replay-start");
    await page.click(".replay-menu [data-start=click]");
    expect(await tool(page)).toBe("pick-start");
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const after = (await range())!;
    expect(Math.abs(after.to - before.to)).toBeLessThan(1);
    await page.close();
  }, 30_000);

  test("回放中打开一只取数失败的票：回放停下，不在藏起来的图上接着走", async () => {
    const { page } = await start("RPLJ");
    await page.click(".replay-toggle");
    await page.click(".replay-start");
    await page.click(".replay-menu [data-start=earliest]");
    expect((await rp(page)).playing).toBe(true);
    await page.evaluate(async () => (await import("/app.js")).loadAnalysis("ANT", null));
    await page.waitForSelector("#load-error", { state: "visible" });
    expect((await rp(page)).mode).toBe("off");
    await page.close();
  }, 30_000);

  test("正在播放（默认 1x）时打开「选起点 ▾」：菜单不会每走一根就被关掉，向下展开不被挡", async () => {
    const { page, errors } = await start("RPLK");
    await page.click(".replay-toggle");
    await page.click(".replay-start");
    await page.click(".replay-menu [data-start=earliest]");
    expect((await rp(page)).playing).toBe(true);
    const i0 = (await rp(page)).index;
    await page.click(".replay-start");
    await waitRp(page, (r) => r.index >= i0 + 2); // 至少走了两根
    expect(await page.isVisible(".replay-menu")).toBe(true);
    const [menu, btn] = await Promise.all([page.locator(".replay-menu").boundingBox(), page.locator(".replay-start").boundingBox()]);
    expect(menu!.y).toBeGreaterThanOrEqual(btn!.y + btn!.height - 1); // 在「选起点」按钮下面展开
    expect(await page.textContent(".replay-toggle")).toBe("退出回放");
    await page.click(".replay-toggle");
    await page.click(".replay-toggle");
    expect(await page.textContent(".replay-toggle")).toBe("取消选起点");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("回退一根：在「前进一根」左边；退一根、停下播放、视图跨度不变；Shift+← 也行；第一根时不能点", async () => {
    const { page, errors } = await start("RPLL");
    await page.click(".replay-toggle");
    await slow(page);
    const order = await page.$$eval(".replay-bar button", (bs) => bs.map((b) => b.className));
    expect(order.indexOf("replay-back")).toBe(order.indexOf("replay-forward") - 1);
    const p = await barPoint(page, 200);
    await page.mouse.click(p.x, p.y);
    await waitRp(page, (r) => r.mode === "replay" && r.playing);
    const lr = () => page.evaluate(async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return (await import("/app.js")).getChart().chart.timeScale().getVisibleLogicalRange();
    });
    const r0 = (await lr())!;
    await page.click(".replay-back");
    expect(await rp(page)).toMatchObject({ index: 199, bars: 200, playing: false });
    expect(await page.textContent(".replay-label")).toContain(CHART.candles[199].time);
    const r1 = (await lr())!;
    expect(Math.abs((r1.to - r1.from) - (r0.to - r0.from))).toBeLessThan(1);
    await page.keyboard.press("Shift+ArrowLeft");
    expect(await rp(page)).toMatchObject({ index: 198, bars: 199 });
    // 暂停时把图拖到更早的地方看：回退不把视图拉回来
    await page.evaluate(async () => (await import("/app.js")).getChart().chart.timeScale().setVisibleLogicalRange({ from: 40, to: 120 }));
    await lr(); // 图表库下一帧才应用新范围（真拖动不会和按键在同一帧）
    await page.keyboard.press("Shift+ArrowLeft");
    expect(await rp(page)).toMatchObject({ index: 197, bars: 198 });
    const dragged = (await lr())!;
    expect(Math.abs(dragged.from - 40)).toBeLessThan(1);
    expect(Math.abs(dragged.to - 120)).toBeLessThan(1);
    await page.click(".replay-forward");
    await page.click(".replay-forward");
    expect(await rp(page)).toMatchObject({ index: 199, bars: 200 });
    await page.click(".replay-start");
    await page.click(".replay-menu [data-start=earliest]");
    await waitRp(page, (r) => r.index === 0);
    await page.click(".replay-play"); // 停下，留在第一根
    expect(await page.isDisabled(".replay-back")).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("「怎么用」讲了回放和三个快捷键", async () => {
    const { page } = await start("RPLH");
    await page.click(".chart-help-toggle");
    const text = (await page.textContent(".chart-help"))!;
    for (const k of ["回放", "Shift+↓", "Shift+→", "Shift+←"]) expect(text).toContain(k);
    await page.close();
  }, 30_000);
});

describe("规则编号都能点到 rules.md", () => {
  test("找打法清单里点规则编号：弹出 rules.md 那一条的 IF / THEN 和出处；改名后的类型在页面上", async () => {
    const { page, errors } = await open();
    const basis = '[data-step="play"] .pcell[data-cell="signal"] details.basis';
    await scrollIntoCenter(page, `${basis} > summary`);
    await page.click(`${basis} > summary`);
    await page.click('[data-step="play"] .checklist li[data-rule="P7"] .rule-ref');
    await page.waitForSelector("#popover .pop-body");
    expect(await page.textContent("#popover .pop-head")).toContain("P7（动作）");
    expect(await page.textContent("#popover .pop-body")).toContain("THEN");
    expect(await page.textContent("#popover .pop-path")).toContain("rules.md");
    const body = (await page.textContent("#center-scroll"))!;
    expect(body).toContain("加速下跌");
    expect(body).not.toMatch(/极度超卖|极度超买|健康上涨|健康下跌/);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("具体做法的条件也带规则编号，点开是同一个弹窗", async () => {
    const { page } = await open();
    const chip = page.locator('[data-step="play"] .plan-rules .rule-ref').first();
    expect(await chip.textContent()).toBe("P7");
    await chip.click();
    await page.waitForSelector("#popover .pop-body");
    expect(await page.textContent("#popover .pop-head")).toContain("P7");
    await page.close();
  }, 30_000);

  test("做推演的依据：点开先是打法的条件和相关求解，再是 MA60、MA120 的 30 天门槛，持平情景也在里面", async () => {
    const { page } = await open();
    const card = page.locator('[data-step="forecast"]');
    const data = card.locator("details.fc-data");
    await scrollIntoCenter(page, '[data-step="forecast"] details.fc-data > summary');
    await data.locator("> summary").click();
    expect(await data.locator(".fc-earliest").textContent()).toContain("空仓不买");
    expect(await data.locator("ul.solves").first().locator("li").count()).toBeLessThanOrEqual(3);
    const first = data.locator("table.hurdles").first();
    expect(await first.isVisible()).toBe(true);
    expect(await first.locator("tbody tr").count()).toBe(2);
    expect(await first.textContent()).toContain("239.24"); // MA60 30 天抵扣价最高
    expect(await data.locator(".flow").textContent()).toContain("30 个交易日");
    await page.close();
  }, 30_000);
});

describe("两个 agent 都写角色 + 名字", () => {
  test("默认视图下：中栏「分析师·长风」、右栏「解语花·鸿雁」，名字完整、没被截断或挡住", async () => {
    const { page, errors } = await open();
    for (const [sel, full] of [["#analyst-composer .role-bar b", "分析师·长风"], ['.panel.right .role-bar b', "解语花·鸿雁"]] as const) {
      const name = page.locator(sel);
      expect(await name.textContent()).toBe(full);
      expect(await name.isVisible()).toBe(true);
      // 没被截断：内容宽度不超过元素宽度；没被挡住：元素中心点落在它自己身上
      const ok = await name.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return el.scrollWidth <= el.clientWidth + 1 && !!hit && el.contains(hit);
      });
      expect({ sel, ok }).toEqual({ sel, ok: true });
    }
    expect(await page.getAttribute("main.panel.center", "aria-label")).toBe("分析师·长风");
    expect(await page.getAttribute("aside.panel.right", "aria-label")).toBe("解语花·鸿雁");
    expect(await page.textContent(".panel.right .panel-head b")).toBe("解语花·鸿雁");
    // 标题、说明各占一行：标题不换行，说明放不下就省略号，不折成两行
    const lines = await page.$$eval(".panel.right .panel-head > *", (els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight || "0") || 0)));
    expect(lines).toEqual([1, 1]);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
});

describe("交易日志", () => {
  /** 控件在当前视图里看得见、没被挡住（不先滚动，照用户看到的样子）。 */
  const usable = (page: Page, sel: string) => page.locator(sel).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + Math.min(20, r.width / 2), r.y + r.height / 2);
    return r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && !!hit && el.contains(hit);
  });
  const shot = (page: Page, name: string) => process.env.JOURNAL_SHOTS
    ? page.screenshot({ path: join(process.env.JOURNAL_SHOTS, `${name}.png`) }) : Promise.resolve();

  test("回放 SPY 2024-04-19：记入日志 → 进场 → 离场 → 复盘，左栏汇总跟着变；刷新后还在", async () => {
    const { page, errors } = await open(undefined, "SPY@2024-04-19");
    expect(await usable(page, "#journal-add")).toBe(true);
    await shot(page, "1-default-view");
    await page.click("#journal-add");
    const dlg = page.locator("#journal-dialog");
    expect(await dlg.locator("h2").textContent()).toBe("记入日志：SPY 2024-04-19");
    expect(await dlg.locator(".j-plan").textContent()).toContain("稳定上涨");
    await dlg.locator("input[name=size]").fill("1/3 仓");
    await dlg.locator("textarea[name=reason]").fill("回撤到 60 线组，等吃回撤条件齐");
    expect(await usable(page, "#journal-save")).toBe(true);
    await shot(page, "2-record-dialog");
    await page.click("#journal-save");

    // 记完：对话框关上，左栏切到交易日志，新的一笔在最上面
    await page.waitForSelector("#journal-dialog", { state: "hidden" });
    expect(await page.getAttribute("#tab-journal", "aria-selected")).toBe("true");
    const item = page.locator("#journal-list .j-item").first();
    expect(await item.textContent()).toContain("SPY");
    expect(await item.locator(".j-state").textContent()).toBe("计划");
    expect(await usable(page, "#journal-list .j-item")).toBe(true);
    expect(await page.textContent("#journal-summary")).toContain("计划 1");

    await item.click();
    const detail = page.locator("#journal-detail");
    expect(await detail.locator(".j-plan").textContent()).toContain("记入后不能改");
    await detail.locator('[data-act="enter"] input[name=date]').fill("2024-04-22");
    await detail.locator('[data-act="enter"] input[name=price]').fill("499.5");
    expect(await usable(page, '#journal-detail [data-act="enter"] button')).toBe(true);
    await detail.locator('[data-act="enter"] button').click();
    await page.waitForSelector('#journal-detail [data-act="exit"]');
    expect(await page.locator("#journal-list .j-state").first().textContent()).toBe("已进场");

    await detail.locator('[data-act="exit"] input[name=date]').fill("2024-05-15");
    await detail.locator('[data-act="exit"] input[name=price]').fill("529.47");
    await detail.locator('[data-act="exit"] input[name=reason]').fill("主动止盈");
    await detail.locator('[data-act="exit"] button').click();
    await page.waitForSelector('#journal-detail [data-act="review"]');
    expect(await detail.locator(".j-outcome").textContent()).toContain("+6.00%");
    expect(await detail.locator(".j-outcome").textContent()).toContain("23");

    await detail.locator('[data-act="review"] input[value=yes]').check();
    await detail.locator('[data-act="review"] textarea[name=lesson]').fill("按计划拿住了");
    const review = page.locator('#journal-detail [data-act="review"] button');
    await review.scrollIntoViewIfNeeded();
    expect(await usable(page, '#journal-detail [data-act="review"] button')).toBe(true);
    await review.click();
    await page.waitForFunction(() => document.querySelector("#journal-list .j-line")?.textContent?.includes("照计划"));
    await shot(page, "3-detail-closed");
    await page.click("#journal-detail header .j-close");

    const sum = page.locator("#journal-summary");
    expect(await sum.textContent()).toContain("已离场 1");
    expect(await sum.locator("tbody tr").first().textContent()).toContain("100%"); // 照计划：1 笔，胜率 100%
    expect(await sum.locator(".j-small").first().textContent()).toContain("少于 10 笔");
    expect(await usable(page, "#journal-summary .j-stats")).toBe(true);
    // 汇总表在左栏里放得下：不出框、不被截断
    expect(await page.locator("#journal-summary").evaluate((el) => {
      const t = el.querySelector(".j-stats")!.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return t.right <= box.right - 4 && el.scrollWidth <= el.clientWidth;
    })).toBe(true);
    await shot(page, "4-summary");

    await page.reload();
    await page.waitForSelector(".lean-label");
    expect(await page.getAttribute("#tab-journal", "aria-selected")).toBe("true"); // 记住选的标签
    expect(await page.locator("#journal-list .j-line").first().textContent()).toContain("+6.0%");
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  test("记入时处境可以换成持仓，预览跟着换；取消不记", async () => {
    const { page } = await open(undefined, "SPY@2024-04-19");
    const before = await (await fetch(`${base}/api/journal`)).json();
    await page.click("#journal-add");
    const dlg = page.locator("#journal-dialog");
    const flat = await dlg.locator(".j-action").textContent();
    await dlg.locator('[data-situation="holding"]').click();
    expect(await dlg.locator(".j-action").textContent()).not.toBe(flat);
    expect(await dlg.locator('[data-situation="holding"]').getAttribute("aria-pressed")).toBe("true");
    await dlg.locator("footer .j-close").click();
    expect(await dlg.getAttribute("open")).toBeNull();
    expect((await (await fetch(`${base}/api/journal`)).json()).entries.length).toBe(before.entries.length);
    await page.close();
  }, 30_000);

  test("还没进场就想填离场：页面上没有离场的表；服务端也拒绝", async () => {
    const id = "e2e-illegal-01";
    await fetch(`${base}/api/journal`, { method: "POST", body: JSON.stringify({ id, ticker: "SPY", asof: "2024-04-19", situation: "flat", cost: null, size: "", reason: "" }) });
    const { page } = await open(async (p) => { await p.addInitScript(() => localStorage.setItem("dma-left-tab", "journal")); }, "SPY@2024-04-19");
    await page.click(`#journal-list [data-id="${id}"]`);
    expect(await page.locator('#journal-detail [data-act="exit"]').count()).toBe(0);
    expect(await page.locator('#journal-detail [data-act="cancel"]').count()).toBe(1);
    const res = await fetch(`${base}/api/journal/${id}`, { method: "POST", body: JSON.stringify({ type: "exit", date: "2024-05-01", price: 500, reason: "" }) });
    expect(res.status).toBe(409);
    await page.close();
  }, 30_000);
});

describe("盲测练习", () => {
  /** 控件在当前视图里看得见、没被挡住（不先滚动，照用户看到的样子）。 */
  const usable = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + Math.min(20, r.width / 2), r.y + r.height / 2);
    return r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth && !!hit && el.contains(hit);
  });
  const shot = (page: Page, name: string) => process.env.PRACTICE_SHOTS
    ? page.screenshot({ path: join(process.env.PRACTICE_SHOTS, `${name}.png`) }) : Promise.resolve();
  /** 页面上看得到的文字里有没有真实代码、这段真实行情里的日期、真实价位（3000 ~ 6000）。回测记录的区间是固定文字，不算。 */
  const visibleLeaks = (page: Page) => page.evaluate(([ticker, from, to]) => {
    const text = document.body.innerText + " " + document.title + " " + location.hash;
    const out: string[] = [];
    if (text.includes(ticker)) out.push(ticker);
    for (const d of text.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []) if (d >= from && d <= to) out.push(d);
    for (const n of text.match(/\b\d{4}\.\d{1,2}\b/g) ?? []) if (Number(n) >= 2500 && Number(n) <= 7000) out.push(n);
    return out;
  }, [REAL_TICKER, REAL[0].date, REAL.at(-1)!.date]);

  test("出题 → 记计划 → 往后放到进场、止损 → 揭晓；控件都在默认视图里，揭晓前看不到真实信息", async () => {
    // 平时聚焦着 20 线组：练习时图例收起了，没法取消，所以不聚焦
    // 平时开着筹码分布：练习里照样算，但只用已经发到页面的 K 线，日期写 T+n，没有计划的参考带
    // 平时开着着色和变色提示：练习里着色照常，变色提示不标
    const { page, errors } = await open((p) => p.addInitScript(() => { localStorage.setItem("dma-focus", "20"); localStorage.setItem("dma-layers", JSON.stringify({ profile: true, tone: true, toneTurns: true })); }));
    expect(await usable(page, "#practice-btn")).toBe(true);
    await page.click("#practice-btn");
    await page.click("#pp-tab-combo");
    expect(await usable(page, "#practice-new")).toBe(true);
    await page.click("#practice-new");
    await page.waitForSelector("#practice-page", { state: "hidden" }); // 综合题在工作台里做
    await page.waitForSelector("#practice .pr-tools");
    await page.waitForFunction(() => document.getElementById("ticker")?.textContent === "练习 #1" && document.querySelector(".lean-label"));
    await page.waitForFunction(() => document.getElementById("meta-line")?.textContent?.includes("T0"));
    await shot(page, "1-question");
    expect(await visibleLeaks(page)).toEqual([]);
    expect(await page.evaluate(() => location.hash)).toMatch(/^#practice:/);
    // 回放日期、自选、图表自己的回放都收起来了
    expect(await page.isVisible(".asof")).toBe(false);
    expect(await page.isVisible("#star")).toBe(false);
    expect(await page.isVisible(".replay-toggle")).toBe(false);
    // 图上的时间写成 T+n
    expect(await page.textContent("#chart-readout")).toContain("T0");
    // 结构标注、缺口不画（会提前说出答案）：菜单里这几项不能点，写着原因，看得见、没被挡
    expect(await page.locator("#chart .struct-mark").count()).toBe(0);
    for (const key of ["constructs", "patterns", "swings", "gaps"]) {
      const item = await layerItem(page, key);
      expect({ key, disabled: item.disabled }).toEqual({ key, disabled: true });
      expect(item.text).toContain("练习里不画，免得提前看到答案");
      expect({ key, ok: await notCovered(page, layerBtn(key)) }).toEqual({ key, ok: true });
    }
    // 着色照常能用（练习只用自带规则），来源的名字写在那一行；变色提示在练习里不能开：认变色是题目要自己做的事，标出来等于给答案
    const practiceTone = (await (await fetch(`${base}/api/practice/${await page.evaluate(() => location.hash.slice("#practice:".length))}`)).json()).chart.tone_source;
    expect(await page.textContent(`${layerBtn("tone")} .li-lead`)).toBe(practiceTone.name);
    expect(await layerItem(page, "tone")).toMatchObject({ disabled: false, pressed: "true" });
    const turnsItem = await layerItem(page, "toneTurns");
    expect({ disabled: turnsItem.disabled, pressed: turnsItem.pressed }).toEqual({ disabled: true, pressed: "false" });
    expect(turnsItem.text).toContain("练习里不标：这是题目要你自己看的");
    expect(await notCovered(page, layerBtn("toneTurns"))).toBe(true);
    expect(await page.evaluate(async () => { const c = (await import("/app.js")).getChart(); return { toned: c.toned() > 0, turns: c.turns() }; })).toEqual({ toned: true, turns: [] });
    await page.keyboard.press("Escape");
    // 周线不能切（练习的图只到现在那根，周线会用到之后的 K 线）
    expect(await page.isDisabled('[data-frame="week"]')).toBe(true);
    expect(await page.evaluate(async () => (await import("/app.js")).getChart().focus())).toEqual({ group: null, band: [] });
    const profile = () => page.evaluate(async () => (await import("/app.js")).getChart().profile());
    const lastBar = () => page.evaluate(async () => (await import("/app.js")).getChart().chart.timeScale().getVisibleRange()?.to);
    const p0 = await profile();
    expect([p0.on, p0.ref, p0.to]).toEqual([true, null, await lastBar()]); // 算到现在那根为止，之后的 K 线页面上本来就没有
    expect(p0.drawn.labels.find((l: any) => l.text.startsWith("筹码 ")).text).toMatch(/^筹码 T-\d+ ~ T0 · \d+ 根$/);
    for (const sel of ['[data-act="plan"]', '[data-act="step"]', '[data-act="play"]', '[data-act="reveal"]']) {
      expect({ sel, ok: await usable(page, `#practice ${sel}`) }).toEqual({ sel, ok: true });
    }

    // 记计划：下一根开盘买；止损放在之后 40 根最低收盘上方一点（测试能读到服务端的练习数据，保证会碰到）
    const id = await page.evaluate(() => location.hash.slice("#practice:".length));
    const csv = readFileSync(join(practiceDir, `${id}.csv`), "utf8").trim().split("\n").slice(1).map((r) => r.split(","));
    const view = await (await fetch(`${base}/api/practice/${id}`)).json();
    const start = csv.findIndex((r) => r[0] === view.t0);
    const stop = Math.min(...csv.slice(start + 1, start + 41).map((r) => Number(r[4]))) + 0.01;
    expect(stop).toBeLessThan(Number(csv[start][4]));
    await page.click('#practice [data-act="plan"]');
    const dlg = page.locator("#practice-plan");
    await dlg.waitFor();
    expect(await dlg.locator("h2").textContent()).toBe("记下计划：练习 #1 T0");
    await dlg.locator('input[value="now"]').check();
    await dlg.locator("input[name=stop]").fill(stop.toFixed(2));
    await dlg.locator("textarea[name=reason]").fill("试试止损");
    expect(await usable(page, "#practice-save")).toBe(true);
    await shot(page, "2-plan");
    await page.click("#practice-save");
    await page.waitForSelector("#practice-plan", { state: "hidden" });
    expect(await page.textContent("#practice .pr-order")).toContain("下一根开盘买入");

    // 往后一根：进场
    await page.click('#practice [data-act="step"]');
    await page.waitForFunction(() => document.getElementById("practice-msg")?.textContent?.includes("开盘买入"));
    expect(await page.textContent("#practice .pr-order")).toContain("已进场 T+1");
    expect(await page.textContent("#chart-readout")).toContain("T+1");
    const p1 = await profile();
    expect(p1.to > p0.to && p1.to === await lastBar()).toBe(true); // 往后一根：筹码多算这一根
    // 往后一根，再开关一次着色（菜单重写一遍）：来源还写着，变色提示还是不标
    await openLayers(page);
    await page.click(layerBtn("tone"));
    await page.click(layerBtn("tone"));
    expect(await page.textContent(`${layerBtn("tone")} .li-lead`)).toBe(practiceTone.name);
    await page.keyboard.press("Escape");
    expect(await page.evaluate(async () => (await import("/app.js")).getChart().turns())).toEqual([]);
    expect(await page.isDisabled(layerBtn("toneTurns"))).toBe(true);
    await shot(page, "3-filled");
    // 一根一根往后，直到止损卖出（控件一直在默认视图里）
    for (let i = 0; i < 41; i++) {
      if ((await page.textContent("#practice-msg"))?.includes("卖出")) break;
      expect(await usable(page, '#practice [data-act="step"]')).toBe(true);
      await page.click('#practice [data-act="step"]');
      await page.waitForFunction((t) => document.querySelector("#practice .num")?.textContent?.startsWith(`T+${t} `), i + 2);
    }
    expect(await page.textContent("#practice-msg")).toContain("跌破止损");
    expect(await page.textContent("#practice .pr-phase")).toBe("决策中");
    await shot(page, "4-stopped");
    expect(await visibleLeaks(page)).toEqual([]);
    // 练习的单不进交易日志的列表：只在汇总下面提一句
    await page.click("#tab-journal");
    expect(await page.textContent("#journal-list")).not.toContain("练习 #1");
    expect(await page.textContent("#journal-summary")).toContain("练习的 1 笔另算");
    expect(await visibleLeaks(page)).toEqual([]);

    // 揭晓：点两下
    await page.click('#practice [data-act="reveal"]');
    expect(await page.textContent('#practice [data-act="reveal"]')).toContain("再点一次");
    await page.click('#practice [data-act="reveal"]');
    await page.waitForFunction((t) => document.getElementById("practice")?.textContent?.includes(t), REAL_TICKER);
    expect(await page.textContent("#ticker")).toBe(`练习 #1 · ${REAL_TICKER}`);
    expect(await page.textContent("#practice .pr-result")).toContain("同期买入持有");
    expect(await page.textContent("#chart-readout")).toMatch(/20\d\d-\d\d-\d\d/); // 图上换回真实日期
    expect(await usable(page, '#practice [data-act="new"]')).toBe(true);
    // 照打法：揭晓后才有；四项，每项写哪一根、为什么；止损是自动卖的，不会晚
    expect(await usable(page, "#practice .pr-disc h4")).toBe(true);
    expect(await page.textContent("#practice .pr-disc h4")).toMatch(/照打法 纪律 \d\/\d/);
    const rows = await page.locator("#practice .pr-disc-list li").allTextContents();
    expect(rows.map((r) => r.replace(/\s+/g, "").slice(1, 3))).toEqual(["打法", "条件", "止损", "仓位"]);
    expect(rows[2]).toContain("✓");
    expect(await usable(page, "#practice .pr-disc-list li:nth-child(3)")).toBe(true);
    await shot(page, "5-reveal");
    // 复盘：揭晓页上每一笔后面的按钮打开这一笔（换回真实代码）
    expect(await usable(page, "#practice [data-review]")).toBe(true);
    await page.click("#practice [data-review]");
    await page.waitForFunction((t) => document.querySelector("#journal-detail h2")?.textContent?.includes(t), REAL_TICKER);
    await page.click("#journal-detail .j-close");
    // 练习的统计在练习页「综合题」：1 题已揭晓
    await page.click('#practice [data-act="list"]');
    await page.waitForSelector("#practice-stats .j-stats");
    expect(await page.textContent("#practice-stats")).toContain("已揭晓 1");
    const split = await page.locator("#practice-stats .j-stats tbody th").allTextContents();
    expect(split).toEqual(["照计划", "没照", "纪律高", "纪律低", "全部"]);
    expect(await usable(page, "#practice-stats .pr-disc-sum")).toBe(true);
    expect(await page.textContent("#practice-list")).toMatch(/纪律 \d\/\d/);
    await shot(page, "6-stats");
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  test("识别题：顶栏进入，五种题都能答，答完有依据和规则编号；回到工作台原样不动", async () => {
    const { page, errors } = await open();
    const ticker = await page.textContent("#ticker");
    const hash = await page.evaluate(() => location.hash);
    expect(await usable(page, "#practice-btn")).toBe(true);
    await page.click("#practice-btn");
    expect(await page.getAttribute("#pp-tab-drill", "aria-selected")).toBe("true");
    await page.waitForSelector("#dr-question[data-drill]");
    expect(await usable(page, "#practice-close")).toBe(true);
    const kinds = [["chart", "看图"], ["signal", "看信号"], ["dropoff", "看抵扣价"], ["construct", "看构造和 2B"], ["play", "看打法"]];
    for (const [kind, label] of kinds) {
      expect({ kind, chip: await usable(page, `.dr-kinds [data-kind="${kind}"]`) }).toEqual({ kind, chip: true });
      const shown = await page.getAttribute("#dr-question", "data-drill");
      await page.click(`.dr-kinds [data-kind="${kind}"]`);
      await page.waitForFunction(([t, was]) => document.querySelector(".dr-kind")?.textContent === t && document.getElementById("dr-question")?.dataset.drill !== was, [label, shown]);
      expect(await page.locator("#dr-chart canvas").count()).toBeGreaterThan(0);
      expect(await page.textContent("#dr-readout")).toContain("T0");
      const parts = await page.locator(".dr-part").count();
      for (let i = 0; i < parts; i++) {
        const n = await page.locator(`.dr-part[data-part="${i}"] .dr-choice`).count();
        for (let j = 0; j < n; j++) {
          expect({ kind, i, j, ok: await usable(page, `.dr-part[data-part="${i}"] .dr-choice[data-choice="${j}"]`) }).toEqual({ kind, i, j, ok: true });
        }
      }
      expect(await visibleLeaks(page)).toEqual([]);
      await shot(page, `drill-${kind}-question`);
      for (let i = 0; i < parts; i++) await page.click(`.dr-part[data-part="${i}"] .dr-choice[data-choice="0"]`);
      await page.waitForSelector(".dr-verdict");
      for (const sel of [".dr-verdict", '.dr-feedback [data-act="next"]', ".dr-rule", ".dr-evidence li"]) {
        expect({ kind, sel, ok: await usable(page, sel) }).toEqual({ kind, sel, ok: true });
      }
      expect(await page.locator(".dr-choice.right").count()).toBe(parts); // 每问都标出对的那个
      expect(await page.textContent(".dr-rule b")).toMatch(/^[AJP]\d+$/);
      expect(await visibleLeaks(page)).toEqual([]);
      await shot(page, `drill-${kind}-feedback`);
    }
    // 统计：答了 5 题，每种题的正确率和答题时间写在题型按钮上
    expect(await usable(page, "#dr-stats")).toBe(true);
    expect(await page.textContent("#dr-stats")).toMatch(/共 5 题，答对 \d+% · 连对 \d+（最长 \d+）/);
    expect(await page.textContent('.dr-kinds [data-kind="signal"] small')).toMatch(/\d+% · \d+\.\d 秒/);
    expect(await (await fetch(`${base}/api/drills`)).json()).toMatchObject({ stats: { total: { n: 5 } } });
    await shot(page, "drill-stats");
    // 键盘：Enter 下一题，数字键选
    const last = await page.getAttribute("#dr-question", "data-drill");
    await page.keyboard.press("Enter");
    await page.waitForFunction((was) => document.getElementById("dr-question")?.dataset.drill !== was && !document.querySelector(".dr-verdict"), last);
    const parts = await page.locator(".dr-part").count();
    for (let i = 0; i < parts; i++) await page.keyboard.press("1");
    await page.waitForSelector(".dr-verdict");
    // 回到工作台：票、地址都没变；Esc 也能关
    await page.click("#practice-close");
    await page.waitForSelector("#practice-page", { state: "hidden" });
    expect(await page.textContent("#ticker")).toBe(ticker);
    expect(await page.evaluate(() => location.hash)).toBe(hash);
    expect(await usable(page, "#load-ticker")).toBe(true);
    await page.click("#practice-btn");
    await page.waitForSelector("#practice-page", { state: "visible" });
    await page.keyboard.press("Escape");
    await page.waitForSelector("#practice-page", { state: "hidden" });
    expect(await page.textContent("#ticker")).toBe(ticker);
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  test("识别题：推演揭晓交卷后放出 T0 之后的真实走势；五步点图在图上点 K 线、撤销、交卷，标出标准答案", async () => {
    const { page, errors } = await open();
    await page.click("#practice-btn");
    await page.waitForSelector("#dr-question[data-drill]");
    /** 切到某种题，等新的一题出来。 */
    const switchTo = async (kind: string, label: string) => {
      expect({ kind, chip: await usable(page, `.dr-kinds [data-kind="${kind}"]`) }).toEqual({ kind, chip: true });
      const shown = await page.getAttribute("#dr-question", "data-drill");
      await page.click(`.dr-kinds [data-kind="${kind}"]`);
      await page.waitForFunction(([t, was]) => document.querySelector(".dr-kind")?.textContent === t && document.getElementById("dr-question")?.dataset.drill !== was, [label, shown]);
    };
    /** 页面上这一题在题库里的样子（带答案）。 */
    const stored = async () => {
      const id = await page.getAttribute("#dr-question", "data-drill");
      return drillBank.drills().find((d) => d.id === id)!;
    };
    /** 读数条第一段：鼠标所在那根是 T 几。 */
    const readT = async () => {
      const t = (await page.textContent("#dr-readout"))!.split(/\s/)[0];
      return t === "T0" ? 0 : Number(t.slice(1));
    };

    // ---- 推演揭晓：选推演的答案 → 交卷 → 放出之后的 K 线（读数条到 T+n），逐问对照推演和真实 ----
    await switchTo("project", "推演揭晓");
    const p = await stored();
    if (p.kind !== "project") throw new Error("kind");
    expect(await page.textContent(".dr-context")).toContain("不算分");
    expect(await page.textContent("#dr-readout")).toMatch(/^T0\s/);
    for (let i = 0; i < p.parts.length; i++) {
      expect({ i, ok: await usable(page, `.dr-part[data-part="${i}"] .dr-choice[data-choice="${p.parts[i].answer}"]`) }).toEqual({ i, ok: true });
    }
    expect(await visibleLeaks(page)).toEqual([]);
    await shot(page, "drill-project-question");
    for (let i = 0; i < p.parts.length; i++) await page.click(`.dr-part[data-part="${i}"] .dr-choice[data-choice="${p.parts[i].answer}"]`);
    await page.waitForSelector(".dr-reveal");
    const horizon = Math.max(...p.reveal.parts.map((r) => (r.q === "dir" ? r.n : r.q === "cross" ? 30 : r.days)));
    expect(await page.textContent(".dr-verdict")).toContain("答对了"); // 评分按推演
    expect(await page.textContent("#dr-readout")).toMatch(new RegExp(`^T\\+${horizon}\\s`)); // 图接上了之后的 K 线
    for (const sel of [".dr-verdict", ".dr-reveal-note", '.dr-feedback [data-act="next"]']) {
      expect({ sel, ok: await usable(page, sel) }).toEqual({ sel, ok: true });
    }
    expect(await page.locator(".dr-reveal li").count()).toBe(p.parts.length);
    const reveal = (await page.textContent(".dr-reveal"))!;
    expect(reveal).toContain("推演（评分）");
    expect(reveal).toContain("真实走势");
    expect(await visibleLeaks(page)).toEqual([]);
    await shot(page, "drill-project-reveal");

    // ---- 五步点图：点错一根 → 撤销 → 依次点对 → 交卷 → 逐步对错、定义、规则编号 ----
    await switchTo("steps", "五步点图");
    const s = await stored();
    if (s.kind !== "steps") throw new Error("kind");
    for (const sel of [".dr-steps", "#dr-chart"]) expect({ sel, ok: await usable(page, sel) }).toEqual({ sel, ok: true });
    expect(await page.isDisabled('[data-act="submit"]')).toBe(true);
    expect(await page.isDisabled('[data-act="undo"]')).toBe(true);
    const box = (await page.locator("#dr-chart").boundingBox())!;
    const y = box.y + box.height * 0.4;
    /** 像用户一样在图上找那一根：鼠标左右移，看读数条的 T 几（K 线从左到右 T 越来越大）。 */
    /** 移到 x，等读数条不再变（十字线在下一帧才更新，机器忙时更慢）再读。 */
    const tAt = async (x: number) => {
      await page.mouse.move(x, y);
      let prev = NaN;
      for (let n = 0; n < 40; n++) {
        await page.waitForTimeout(40);
        const t = await readT();
        if (t === prev) return t;
        prev = t;
      }
      throw new Error("读数条一直在变");
    };
    const xOf = async (k: number) => {
      let lo = box.x + 4, hi = box.x + box.width - 80;
      for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) / 2;
        const t = await tAt(mid);
        if (t === k) return mid;
        if (t < k) lo = mid; else hi = mid;
      }
      throw new Error(`图上找不到 T${k}`);
    };
    const label = (k: number) => (k === 0 ? "T0" : `T${k}`);
    const first = s.click.steps[0].t;
    // 点偏了，还连着点了两下（同一根点两下要记两步，不能被当成双击吞掉）→ 撤销按钮、Backspace 各撤一步
    const wrongX = await xOf(first - 3);
    await page.mouse.click(wrongX, y);
    await page.mouse.click(wrongX, y);
    expect(await page.textContent('[data-step-at="0"]')).toBe(label(first - 3));
    if (s.click.steps.length > 1) {
      expect(await page.textContent('[data-step-at="1"]')).toBe(label(first - 3));
      await page.click('[data-act="undo"]');
      expect(await page.textContent('[data-step-at="1"]')).toBe("—");
    }
    await page.keyboard.press("Backspace");
    expect(await page.textContent('[data-step-at="0"]')).toBe("—");
    for (const [i, step] of s.click.steps.entries()) {
      await page.mouse.click(await xOf(step.t), y);
      expect({ i, at: await page.textContent(`[data-step-at="${i}"]`) }).toEqual({ i, at: label(step.t) });
    }
    expect(await usable(page, '[data-act="submit"]')).toBe(true);
    await shot(page, "drill-steps-question");
    await page.click('[data-act="submit"]');
    await page.waitForSelector(".dr-stepres");
    expect(await page.textContent(".dr-verdict")).toContain("答对了");
    expect(await page.locator(".dr-stepres li.ok").count()).toBe(s.click.steps.length);
    expect(await usable(page, ".dr-stepres")).toBe(true);
    expect(await page.locator(".dr-stepres .dr-def .dr-rule b").allTextContents()).toEqual(s.click.steps.map((x) => ({ 破线: "J15", "EMA 拐头": "A3", "MA 拐头": "A1", 第一个交叉: "J15", 双交叉: "J16" })[x.step]));
    expect(await visibleLeaks(page)).toEqual([]);
    await shot(page, "drill-steps-feedback");
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  test("识别题：打法补全先判类型再逐格选；类型选错时每格写出按你选的类型该填什么；空仓、持仓都出", async () => {
    const { page, errors } = await open();
    await page.click("#practice-btn");
    await page.waitForSelector("#dr-question[data-drill]");
    const stored = async () => {
      const id = await page.getAttribute("#dr-question", "data-drill");
      return drillBank.drills().find((d) => d.id === id)!;
    };
    /** 切到打法补全，直到出一道 want（空仓 / 持仓）的题。 */
    const fillOf = async (want: "空仓" | "持仓") => {
      for (let n = 0; n < 12; n++) {
        const shown = await page.getAttribute("#dr-question", "data-drill");
        if (n === 0) await page.click('.dr-kinds [data-kind="fill"]');
        else await page.click('.dr-feedback [data-act="next"]');
        await page.waitForFunction((was) => document.querySelector(".dr-kind")?.textContent === "打法补全" && document.getElementById("dr-question")?.dataset.drill !== was && !document.querySelector(".dr-verdict"), shown);
        const d = await stored();
        if (d.kind !== "fill") throw new Error("kind");
        if ((d.context ?? "").startsWith(want)) return d;
        // 不是要的处境：随便答掉换下一题
        for (let i = 0; i < d.parts.length; i++) await page.click(`.dr-part[data-part="${i}"] .dr-choice[data-choice="0"]`);
        await page.waitForSelector(".dr-verdict");
      }
      throw new Error(`题库里没有${want}的打法补全`);
    };
    expect(await usable(page, '.dr-kinds [data-kind="fill"]')).toBe(true);

    // ---- 空仓：六问（类型 + 五格），题干不说类型；每个选项都点得到 ----
    const d = await fillOf("空仓");
    if (d.kind !== "fill") throw new Error("kind");
    expect(await page.locator(".dr-part").count()).toBe(6);
    expect(await page.textContent(".dr-context")).not.toContain(d.parts[0].choices[d.parts[0].answer]);
    const prompts = await page.locator(".dr-prompt").allTextContents();
    expect(prompts.join(" ")).toContain("能不能做");
    expect(prompts.join(" ")).toContain("止损");
    // 六问放不进一屏：右栏自己滚动，像用户一样滚到那一问再点
    expect(await page.evaluate(() => { const el = document.querySelector(".dr-panel")!; return el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === "auto"; })).toBe(true);
    for (let i = 0; i < d.parts.length; i++) {
      await page.locator(`.dr-part[data-part="${i}"]`).scrollIntoViewIfNeeded();
      for (let j = 0; j < d.parts[i].choices.length; j++) {
        expect({ i, j, ok: await usable(page, `.dr-part[data-part="${i}"] .dr-choice[data-choice="${j}"]`) }).toEqual({ i, j, ok: true });
      }
    }
    expect(await visibleLeaks(page)).toEqual([]);
    await page.locator('.dr-part[data-part="1"]').scrollIntoViewIfNeeded();
    await shot(page, "drill-fill-flat-question");
    // 类型故意选错（选一个打法不同的），格子全按归雁的答案选
    const wrong = d.parts[0].choices.findIndex((_, i) => i !== d.parts[0].answer && d.alts[i] !== null);
    expect(wrong).toBeGreaterThanOrEqual(0);
    await page.click(`.dr-part[data-part="0"] .dr-choice[data-choice="${wrong}"]`);
    for (let i = 1; i < d.parts.length; i++) await page.click(`.dr-part[data-part="${i}"] .dr-choice[data-choice="${d.parts[i].answer}"]`);
    await page.waitForSelector(".dr-verdict");
    expect(await page.textContent(".dr-verdict")).toContain("答错了");
    for (const sel of [".dr-fill-note", ".dr-answers", ".dr-evidence li", '.dr-feedback [data-act="next"]']) {
      expect({ sel, ok: await usable(page, sel) }).toEqual({ sel, ok: true });
    }
    expect(await page.textContent(".dr-fill-note")).toContain(d.parts[0].choices[wrong]);
    const alts = (d.alts[wrong] ?? []).filter((x) => x !== null);
    expect(await page.locator(".dr-alt").count()).toBe(alts.length);
    if (alts.length) expect(await usable(page, ".dr-alt")).toBe(true);
    expect(await page.textContent(".dr-evidence")).toContain("归雁判的类型");
    expect(await page.locator(".dr-choice.right").count()).toBe(6);
    expect(await visibleLeaks(page)).toEqual([]);
    await shot(page, "drill-fill-flat-feedback");

    // ---- 持仓：五格换成拿着还是走、浮盈 / 浮亏；全选对就答对，不写"按你选的类型" ----
    const h = await fillOf("持仓");
    if (h.kind !== "fill") throw new Error("kind");
    const hp = (await page.locator(".dr-prompt").allTextContents()).join(" ");
    expect(hp).toContain("拿着还是走");
    expect(hp).toContain("浮盈 / 浮亏");
    expect(await visibleLeaks(page)).toEqual([]);
    await shot(page, "drill-fill-holding-question");
    for (let i = 0; i < h.parts.length; i++) await page.click(`.dr-part[data-part="${i}"] .dr-choice[data-choice="${h.parts[i].answer}"]`);
    await page.waitForSelector(".dr-verdict");
    expect(await page.textContent(".dr-verdict")).toContain("答对了");
    expect(await page.locator(".dr-fill-note, .dr-alt").count()).toBe(0);
    await shot(page, "drill-fill-holding-feedback");
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);
});

describe("回测页", () => {
  /** 在默认视图里看得见、整块在窗口里、没被挡住。 */
  const usable = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + Math.min(20, r.width / 2), r.y + r.height / 2);
    return r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth && !!hit && el.contains(hit);
  });
  const shot = (page: Page, name: string) => process.env.BACKTEST_SHOTS
    ? page.screenshot({ path: join(process.env.BACKTEST_SHOTS, `${name}.png`) }) : Promise.resolve();

  test("顶栏「回测」→ 只选 NVDA → 先看规模 → 运行 → 汇总和逐笔 → 点一笔回到工作台那天", async () => {
    const { page, errors } = await open();
    await page.click("#backtest-btn");
    await page.waitForSelector("#backtest-page", { state: "visible" });
    await page.waitForFunction(() => (document.getElementById("bt-name") as HTMLInputElement).value !== "");
    for (const sel of ["#bt-plan-select", "#bt-tickers", "#bt-start", "#bt-end", "#bt-save", "#bt-run", "#backtest-close"]) {
      expect({ sel, ok: await usable(page, sel) }).toEqual({ sel, ok: true });
    }
    expect(await page.textContent("#bt-form")).toContain("第二期");
    await page.fill("#bt-tickers", "nvda");
    await shot(page, "1-form");
    // 先看规模，再开始
    await page.click("#bt-run");
    await page.waitForSelector("#bt-go", { state: "visible" });
    expect(await page.textContent("#bt-estimate")).toContain("1 只 × 这段时间 = 975 个决定点");
    expect(await usable(page, "#bt-go")).toBe(true);
    await shot(page, "2-estimate");
    await page.click("#bt-go");
    await page.waitForSelector("#bt-progress", { state: "visible" });
    expect(await usable(page, "#bt-cancel")).toBe(true);
    await page.waitForSelector(".bt-summary");
    await page.waitForSelector("#bt-progress", { state: "hidden" });
    // 汇总：完整计划和两个对照并排；期望带区间、每笔占净值
    const head = await page.locator(".bt-summary thead").textContent();
    expect(head).toContain("完整计划");
    expect(head).toContain("买入持有");
    expect(head).toContain("MA200 朴素规则");
    const summary = await page.locator(".bt-summary tbody").textContent();
    for (const label of ["期望：平均 R（90% 区间）", "每笔盈亏占净值", "胜率", "年化（CAGR）", "最大回撤", "MAR", "有持仓的天数"]) {
      expect(summary).toContain(label);
    }
    expect(await usable(page, ".bt-summary")).toBe(true);
    expect(await page.locator(".bt-trades tbody tr").count()).toBe(4);
    expect(await page.locator("#bt-runs [data-run]").count()).toBe(1);
    expect(await page.textContent("#bt-runs")).toContain("完成");
    await shot(page, "3-result");
    // 点第一笔：回测关掉，工作台回放到信号日
    const row = page.locator(".bt-trades tbody tr").first();
    const date = (await row.locator("td").nth(1).textContent())!.trim();
    await row.scrollIntoViewIfNeeded();
    expect(await usable(page, ".bt-trades tbody tr td.tk button")).toBe(true);
    await row.locator("td.tk button").click();
    await page.waitForSelector("#backtest-page", { state: "hidden" });
    await page.waitForFunction((d) => location.hash === `#NVDA@${d}`, date);
    expect(await page.inputValue("#load-asof")).toBe(date);
    expect(await usable(page, "#verdict")).toBe(true);
    await shot(page, "4-workbench-at-date");
    // 再打开：结果还在，Esc 关掉
    await page.click("#backtest-btn");
    await page.waitForSelector(".bt-summary");
    await page.keyboard.press("Escape");
    await page.waitForSelector("#backtest-page", { state: "hidden" });
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  test("方案碰到新验证集的票：规模那里标出来、说已经跑过几次，照样能开始", async () => {
    const { page, errors } = await open();
    await page.click("#backtest-btn");
    await page.waitForFunction(() => (document.getElementById("bt-name") as HTMLInputElement).value !== "");
    await page.fill("#bt-tickers", "nvda vti");
    await page.click("#bt-run");
    await page.waitForSelector("#bt-go", { state: "visible" });
    const warn = page.locator("#bt-estimate .bad");
    expect(await warn.textContent()).toBe("VTI 在新验证集里（已经跑过 1 次）。照跑，但会记为第 2 次；拿它调参数，验证集就作废了。");
    expect(await usable(page, "#bt-estimate .bad")).toBe(true);
    expect(await usable(page, "#bt-go")).toBe(true);
    await shot(page, "5-holdout-warning");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("填错了：底部直接说哪里不对，不开始", async () => {
    const { page } = await open();
    await page.click("#backtest-btn");
    await page.waitForFunction(() => (document.getElementById("bt-name") as HTMLInputElement).value !== "");
    await page.fill("#bt-risk-pct", "0");
    await page.click("#bt-run");
    await page.waitForFunction(() => document.getElementById("bt-msg")!.textContent!.includes("每笔风险比例"));
    expect(await usable(page, "#bt-msg")).toBe(true);
    expect(await page.isVisible("#bt-estimate")).toBe(false);
    await page.close();
  }, 30_000);
});

describe("图层菜单", () => {
  const api = <T,>(page: Page, fn: string) => page.evaluate(async (fn) => (await import("/app.js")).getChart()[fn](), fn) as Promise<T>;
  /** 图上现在画着什么：都是图表自己的读数（线、标记、色带、筹码），不是开关的状态。 */
  const drawn = async (page: Page) => {
    const s = await api<any>(page, "structure");
    const p = await api<any>(page, "profile");
    return {
      ma: (await api<any>(page, "lineStyles")).MA20.visible as boolean,
      levels: (await api<any[]>(page, "levels")).length,
      drops: await api<string[]>(page, "drops"),
      toned: (await api<number>(page, "toned")) > 0,
      marks: await page.$$eval("#chart .struct-mark", (els) => els.filter((e) => !(e as HTMLElement).hidden).map((e) => e.textContent)),
      swings: s.segments.filter((x: any) => x.kind === "swing").length as number,
      necks: s.segments.filter((x: any) => x.kind === "neck").length as number,
      nextBar: s.levels.length as number,
      bands: s.bands.length as number,
      profile: p.on && p.bars > 0,
    };
  };
  const SIMPLE = { ma: true, levels: 4, drops: ["20扣"], toned: false, marks: [], swings: 0, necks: 0, nextBar: 0, bands: 0, profile: false };
  const STRUCT = { ...SIMPLE, marks: ["顶·已完成", "底·形成中", "M顶", "2B顶"], swings: 3, necks: 2, nextBar: 1, bands: 2 };
  const ALL = { ...STRUCT, toned: true, bands: CROWD_GAPS.length, profile: true };
  const presets = (page: Page) => page.$$eval(".layers-menu [data-preset]", (els) => els.map((e) => [e.textContent, e.getAttribute("aria-pressed")]));
  const start = async (ticker: string) => {
    const opened = await open(undefined, ticker);
    await opened.page.waitForSelector("#chart canvas");
    await scrollIntoCenter(opened.page, ".chart-card"); // 像用户一样滚到图
    return opened;
  };

  test("默认视图：工具栏只有一行，「图层」和留下的按钮都看得见、没被挡；默认是「简洁」，图上只有均线、价位线、抵扣价", async () => {
    const { page, errors } = await start("CROWD");
    // 一行：每个控件的上沿在同一条线上，没有谁被挤到下一行，也没有谁被挤出工具栏
    const row = await page.evaluate(() => {
      const t = document.querySelector<HTMLElement>(".chart-tools")!;
      const tops = [...t.children].map((e) => e.getBoundingClientRect().top);
      return { spread: Math.max(...tops) - Math.min(...tops), overflow: t.scrollWidth - t.clientWidth, controls: t.querySelectorAll(":scope > *").length };
    });
    expect(row.spread).toBeLessThan(8);
    expect(row.overflow).toBe(0);
    // 「图层」在最右，紧挨「?」左边：两个按钮之间没有别的控件，「?」贴着工具栏右边
    const ends = await page.evaluate(() => {
      const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
      return { tools: r(".chart-tools").right, help: r(".chart-help-toggle"), layers: r(".layers-toggle"),
        rest: Math.max(...[...document.querySelectorAll(".chart-tools button:not(.layers-toggle):not(.chart-help-toggle):not(.layers-menu button)")].map((b) => b.getBoundingClientRect().right)) };
    });
    expect(ends.tools - ends.help.right).toBeLessThan(2);
    expect(ends.help.left - ends.layers.right).toBeGreaterThanOrEqual(0);
    expect(ends.help.left - ends.layers.right).toBeLessThan(8);
    expect(ends.rest).toBeLessThan(ends.layers.left);
    const kept = [".layers-toggle", '[data-frame="day"]', '[data-frame="week"]', ...["1w", "1m", "6m", "1y", "all", "reset"].map((k) => `.range-btn[data-range="${k}"]`),
      ".replay-toggle", ".measure-toggle", ".draw-toggle", ".draw-clear", ".chart-help-toggle"];
    for (const sel of kept) expect({ sel, ok: await notCovered(page, sel) }).toEqual({ sel, ok: true });
    // 画什么的开关不再散在工具栏里
    expect(await page.locator(".tone-toggle, .levels-toggle, .struct-toggle, .gaps-toggle, .gaps-all, .profile-toggle").count()).toBe(0);
    expect(await page.getAttribute(".layers-toggle", "aria-expanded")).toBe("false");
    expect(await page.isVisible(".layers-menu")).toBe(false);
    expect(await drawn(page)).toEqual(SIMPLE);
    expect((await api<any>(page, "layers")).preset).toBe("simple");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("点开「图层 ▾」：菜单在视口里、每一项都没被挡，分组齐全；选「结构」「全部」图上跟着多出来，回「简洁」收掉；菜单一直开着", async () => {
    const { page, errors } = await start("CROWD");
    await page.click(".layers-toggle");
    expect(await page.getAttribute(".layers-toggle", "aria-expanded")).toBe("true");
    const box = (await page.locator(".layers-menu").boundingBox())!;
    const vp = page.viewportSize()!;
    expect(box.x >= 0 && box.y >= 0 && box.x + box.width <= vp.width && box.y + box.height <= vp.height).toBe(true);
    // 从右边往下展开：菜单右边缘和「图层」按钮的右边缘对齐
    const btn = (await page.locator(".layers-toggle").boundingBox())!;
    expect(Math.abs(box.x + box.width - (btn.x + btn.width))).toBeLessThan(1);
    expect(box.y).toBeGreaterThan(btn.y + btn.height - 1);
    const keys = ["ma", "levels", "drops", "tone", "toneTurns", "constructs", "patterns", "swings", "gaps", "gapsAll", "profile"];
    for (const sel of [...["simple", "structure", "all"].map((k) => `.layers-menu [data-preset="${k}"]`), ...keys.map(layerBtn)]) {
      expect({ sel, ok: await notCovered(page, sel) }).toEqual({ sel, ok: true });
    }
    expect(await page.$$eval(".layers-menu .li-label", (els) => els.map((e) => e.textContent)))
      .toEqual(["均线", "价位线", "抵扣价", "着色", "变色提示", "顶底构造", "形态", "波段", "缺口", "全部", "筹码"]);
    expect(await page.textContent(layerBtn("patterns"))).toBe("形态M 顶、W 底、2B 和颈线");
    expect(await presets(page)).toEqual([["简洁", "true"], ["结构", "false"], ["全部", "false"]]);
    expect(await page.isVisible(".layers-custom")).toBe(false);

    await page.click('.layers-menu [data-preset="structure"]');
    expect(await drawn(page)).toEqual(STRUCT);
    expect(await presets(page)).toEqual([["简洁", "false"], ["结构", "true"], ["全部", "false"]]);
    for (const key of ["constructs", "patterns", "swings", "gaps"]) expect({ key, on: await page.getAttribute(layerBtn(key), "aria-pressed") }).toEqual({ key, on: "true" });
    for (const key of ["tone", "toneTurns", "gapsAll", "profile"]) expect({ key, on: await page.getAttribute(layerBtn(key), "aria-pressed") }).toEqual({ key, on: "false" });

    await page.click('.layers-menu [data-preset="all"]');
    expect(await drawn(page)).toEqual(ALL);
    expect(await page.isVisible(".layers-menu")).toBe(true);

    await page.click('.layers-menu [data-preset="simple"]');
    expect(await drawn(page)).toEqual(SIMPLE);

    // 「图层」贴着中栏底边时点开：菜单自己滚进视野，最后一项也点得到
    await page.keyboard.press("Escape");
    expect(await page.isVisible(".layers-menu")).toBe(false);
    await page.evaluate(async () => {
      const s = document.getElementById("center-scroll")!;
      s.scrollTop += document.querySelector(".chart-tools")!.getBoundingClientRect().bottom - s.getBoundingClientRect().bottom + 4;
      await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
    });
    const scrolled = () => page.evaluate(() => document.getElementById("center-scroll")!.scrollTop);
    const before = await scrolled();
    await page.click(".layers-toggle");
    expect(await notCovered(page, layerBtn("profile"))).toBe(true);
    await page.click(layerBtn("profile"));
    expect((await drawn(page)).profile).toBe(true);
    // 为了露出菜单滚走的那一段：按 Esc、再点一次「图层」关上就滚回原处；点菜单外面关的不动（鼠标正按着别的东西，页面一动就点偏了）
    const opened = await scrolled();
    expect(opened).toBeGreaterThan(before);
    await page.keyboard.press("Escape");
    expect(await scrolled()).toBe(before);
    await page.click(".layers-toggle");
    expect(await scrolled()).toBe(opened);
    await page.click(".layers-toggle");
    expect(await scrolled()).toBe(before);
    await page.click(".layers-toggle");
    await page.mouse.click(80, 25); // 顶栏的标志：在菜单外面，点它不用滚动
    expect(await page.isVisible(".layers-menu")).toBe(false);
    expect(await scrolled()).toBe(opened);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("手动开关：预设那行亮出「自定」、三个预设都不亮；构造、形态、波段各开各的；均线、抵扣价、价位线、着色单独关开；刷新后还记得，点「简洁」回去", async () => {
    const { page, errors } = await start("CROWD");
    await page.click(".layers-toggle");
    await page.click(layerBtn("swings"));
    expect(await drawn(page)).toEqual({ ...SIMPLE, swings: 3 });
    expect(await page.textContent(".layers-custom")).toBe("自定");
    expect(await notCovered(page, ".layers-custom")).toBe(true);
    expect(await presets(page)).toEqual([["简洁", "false"], ["结构", "false"], ["全部", "false"]]);
    expect(await page.getAttribute(".layers-toggle", "title")).toContain("自定");

    await page.click(layerBtn("patterns"));
    expect(await drawn(page)).toEqual({ ...SIMPLE, swings: 3, marks: ["M顶", "2B顶"], necks: 2 });
    await page.click(layerBtn("constructs"));
    expect(await drawn(page)).toEqual({ ...STRUCT, bands: 0 });
    await page.click(layerBtn("swings"));
    expect(await drawn(page)).toEqual({ ...STRUCT, bands: 0, swings: 0 });

    await page.click(layerBtn("drops"));
    await page.click(layerBtn("levels"));
    await page.click(layerBtn("tone"));
    await page.click(layerBtn("ma"));
    const custom = { ...STRUCT, bands: 0, swings: 0, drops: [], levels: 0, toned: true, ma: false };
    expect(await drawn(page)).toEqual(custom);
    // 均线图层关着：读数条不写均线的值，图例点不了
    expect(await page.textContent("#chart-readout .ro-lines")).toBe("");
    expect(await page.isDisabled('#legend [data-line="MA20"]')).toBe(true);
    expect(await page.isDisabled('#legend .group-focus[data-group="20"]')).toBe(true);

    await page.reload();
    await page.waitForSelector("#chart .struct-mark");
    expect(await drawn(page)).toEqual(custom);
    await scrollIntoCenter(page, ".chart-card");
    await page.click(".layers-toggle");
    expect(await page.isVisible(".layers-custom")).toBe(true);
    await page.click('.layers-menu [data-preset="simple"]');
    expect(await page.isVisible(".layers-custom")).toBe(false);
    expect(await presets(page)).toEqual([["简洁", "true"], ["结构", "false"], ["全部", "false"]]);
    expect(await drawn(page)).toEqual(SIMPLE);
    expect(await page.textContent("#chart-readout .ro-lines")).toContain("MA20");
    expect(await page.isDisabled('#legend [data-line="MA20"]')).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("键盘：焦点在「图层」上按 Enter 打开，↓ 走到「着色」按空格勾上，不能用的项跳过；Esc 只关菜单（不顺带退出测量），焦点回到按钮；点菜单外面也关", async () => {
    const { page, errors } = await start("CROWD");
    const focused = () => page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el?.dataset.layer ?? el?.dataset.preset ?? el?.className ?? null;
    });
    await page.click(".measure-toggle");
    await page.focus(".layers-toggle");
    await page.keyboard.press("Enter");
    expect(await page.isVisible(".layers-menu")).toBe(true);
    const walked: (string | null)[] = [];
    for (let n = 0; n < 7; n++) { await page.keyboard.press("ArrowDown"); walked.push(await focused()); }
    expect(walked).toEqual(["simple", "structure", "all", "ma", "levels", "drops", "tone"]);
    await page.keyboard.press("Space");
    expect(await api<number>(page, "toned")).toBeGreaterThan(0);
    expect(await page.getAttribute(layerBtn("tone"), "aria-pressed")).toBe("true");
    expect(await focused()).toBe("tone"); // 勾完焦点还在这一项上，可以接着走
    // 着色开了，「变色提示」能走到；缺口关着，「全部」不能用：从「缺口」往下直接到「筹码」
    await page.keyboard.press("ArrowDown");
    expect(await focused()).toBe("toneTurns");
    for (let n = 0; n < 5; n++) await page.keyboard.press("ArrowDown");
    expect(await focused()).toBe("profile");
    await page.keyboard.press("ArrowUp");
    expect(await focused()).toBe("gaps");

    await page.keyboard.press("Escape");
    expect(await page.isVisible(".layers-menu")).toBe(false);
    expect(await focused()).toBe("layers-toggle");
    expect(await api<string>(page, "tool")).toBe("measure");
    await page.keyboard.press("Escape"); // 菜单关了以后，Esc 照旧退出测量
    expect(await api<string>(page, "tool")).toBe("none");

    await page.click(".layers-toggle");
    expect(await page.isVisible(".layers-menu")).toBe(true);
    await page.click(".chart-card .card-head h2"); // 菜单外面的任何地方
    expect(await page.isVisible(".layers-menu")).toBe(false);
    expect(await page.getAttribute(".layers-toggle", "aria-expanded")).toBe("false");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("用不了的图层变灰、写明原因：周线上构造、形态、波段、缺口、筹码按日线算；回放时价位线、结构、缺口收起，筹码照常；回来以后原样画回", async () => {
    const { page, errors } = await start("CROWD");
    await pickPreset(page, "all");
    expect(await drawn(page)).toEqual(ALL);

    await page.click('[data-frame="week"]');
    const weekOff: [string, string][] = [["constructs", "结构按日线算：切回日线看"], ["patterns", "结构按日线算：切回日线看"], ["swings", "结构按日线算：切回日线看"],
      ["gaps", "缺口按日线算：切回日线看"], ["gapsAll", "缺口按日线算：切回日线看"], ["profile", "筹码按日线算：切回日线看"]];
    for (const [key, why] of weekOff) {
      const item = await layerItem(page, key);
      expect({ key, disabled: item.disabled, pressed: item.pressed, why: item.text.endsWith(why) }).toEqual({ key, disabled: true, pressed: "false", why: true });
      expect({ key, ok: await notCovered(page, layerBtn(key)) }).toEqual({ key, ok: true });
    }
    for (const key of ["ma", "levels", "drops", "tone"]) {
      const item = await layerItem(page, key);
      expect({ key, disabled: item.disabled, pressed: item.pressed }).toEqual({ key, disabled: false, pressed: "true" });
    }
    expect(await presets(page)).toEqual([["简洁", "false"], ["结构", "false"], ["全部", "true"]]); // 选的还是「全部」，只是有几样现在画不了
    await page.keyboard.press("Escape");
    expect(await drawn(page)).toMatchObject({ ma: true, levels: 4, drops: ["20周扣"], marks: [], swings: 0, necks: 0, nextBar: 0, bands: 0, profile: false });

    await page.click('[data-frame="day"]');
    expect(await drawn(page)).toEqual(ALL);

    await page.click(".replay-toggle");
    await page.click(".replay-start");
    await page.fill(".replay-menu input", CHART.candles[200].time);
    await until(page, "进入回放", async () => (await import("/app.js")).getChart().replay().mode === "replay");
    await page.click(".replay-play"); // 暂停
    const replayOff: [string, string][] = [["levels", "回放时收起：价位线属于最新一天的结论"], ["constructs", "回放时收起：结构是按最新一天算的，会露出之后的走势"],
      ["gaps", "回放时收起：缺口补没补要看之后的 K 线"], ["gapsAll", "回放时收起：缺口补没补要看之后的 K 线"]];
    for (const [key, why] of replayOff) {
      const item = await layerItem(page, key);
      expect({ key, disabled: item.disabled, why: item.text.endsWith(why) }).toEqual({ key, disabled: true, why: true });
      expect({ key, ok: await notCovered(page, layerBtn(key)) }).toEqual({ key, ok: true });
    }
    expect(await layerItem(page, "profile")).toMatchObject({ disabled: false, pressed: "true" });
    await page.keyboard.press("Escape");
    expect(await drawn(page)).toMatchObject({ ma: true, levels: 0, toned: true, marks: [], swings: 0, necks: 0, nextBar: 0, bands: 0, profile: true });

    await page.click(".replay-exit");
    expect(await drawn(page)).toEqual(ALL);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  /** 「着色」那一行现在写着什么：来源的名字、小字、悬停的说明、下面那句提醒（没显示是 null）。 */
  const toneRow = async (page: Page) => {
    await openLayers(page);
    const note = page.locator('.layers-menu [data-note="tone"]');
    return {
      lead: await page.textContent(`${layerBtn("tone")} .li-lead`), leadShown: await page.isVisible(`${layerBtn("tone")} .li-lead`),
      text: await page.textContent(`${layerBtn("tone")} .li-text`), title: await page.getAttribute(layerBtn("tone"), "title"),
      note: (await note.isVisible()) ? await note.textContent() : null,
    };
  };
  /** 「?」面板里讲着色的那段（面板没开就点开）。 */
  const toneHelpText = async (page: Page) => {
    if (await page.getAttribute(".chart-help-toggle", "aria-expanded") !== "true") await page.click(".chart-help-toggle");
    return (await page.textContent('.chart-help [data-help="tone"]'))!;
  };

  test("「着色」那一行照颜色的来源写：名字、说明的第一行，悬停和「?」里是整段；日线、周线各写各的；没有来源的旧数据写一行兜底说明", async () => {
    const { page, errors } = await start("TONE");
    const day = await toneRow(page);
    expect(day).toEqual({ lead: TONE_DAY.name, leadShown: true, text: TONE_DAY.legend[0], title: [TONE_DAY.name, ...TONE_DAY.legend].join("\n"), note: null });
    expect(await notCovered(page, layerBtn("tone"))).toBe(true);
    expect(await notCovered(page, `${layerBtn("tone")} .li-lead`)).toBe(true);
    expect(await page.textContent(`${layerBtn("tone")} .li-label`)).toBe("着色");
    const dayHelp = await toneHelpText(page);
    for (const part of [TONE_DAY.name, ...TONE_DAY.legend]) expect(dayHelp).toContain(part);
    expect(await page.locator(".chart-help .help-warn").count()).toBe(0);

    await page.click('[data-frame="week"]');
    const week = await toneRow(page);
    expect(week).toEqual({ lead: TONE_WEEK.name, leadShown: true, text: TONE_WEEK.legend[0], title: [TONE_WEEK.name, ...TONE_WEEK.legend].join("\n"), note: null });
    const weekHelp = await toneHelpText(page);
    expect(weekHelp).toContain(TONE_WEEK.legend[0]);
    expect(weekHelp).not.toContain(TONE_DAY.name);
    await page.click('[data-frame="day"]');
    expect((await toneRow(page)).lead).toBe(TONE_DAY.name);
    expect(errors).toEqual([]);
    await page.close();

    // 旧的分析结果没有 tone_source：不写名字，小字是一行说明，着色照常能开
    const old = await start("NVDA");
    const row = await toneRow(old.page);
    expect({ lead: row.lead, leadShown: row.leadShown, note: row.note }).toEqual({ lead: "", leadShown: false, note: null });
    expect(row.text).toContain("重新分析一次就有");
    expect(row.title).toBe(row.text);
    expect(await toneHelpText(old.page)).toContain(row.text!);
    await openLayers(old.page);
    await old.page.click(layerBtn("tone"));
    expect(await api<number>(old.page, "toned")).toBeGreaterThan(0);
    expect(old.errors).toEqual([]);
    await old.page.close();
  }, 30_000);

  test("着色插件没用上：原因直接写在「着色」那一行下面，看得见、没被挡、没撑出菜单；「?」里也有", async () => {
    const { page, errors } = await start("TONEWARN");
    const row = await toneRow(page);
    expect(row).toMatchObject({ lead: "假的自带规则", note: TONE_WARNING });
    expect(await notCovered(page, '.layers-menu [data-note="tone"]')).toBe(true);
    const [menu, note, vp] = [(await page.locator(".layers-menu").boundingBox())!, (await page.locator('.layers-menu [data-note="tone"]').boundingBox())!, page.viewportSize()!];
    expect(note.x >= menu.x && note.x + note.width <= menu.x + menu.width).toBe(true);
    expect(menu.y >= 0 && menu.y + menu.height <= vp.height).toBe(true);
    // 多了这句话，下面的每一项还点得到
    for (const key of ["toneTurns", "constructs", "gaps", "profile"]) expect({ key, ok: await notCovered(page, layerBtn(key)) }).toEqual({ key, ok: true });
    expect(await toneHelpText(page)).toContain(TONE_WARNING);
    expect(await page.textContent(".chart-help .help-warn")).toBe(TONE_WARNING);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("变色提示：着色关着时是灰的；打开后转绿、转黑的那几根上方各有一个小三角，和构造、形态的标记不叠；悬停读数写「转绿」「转黑」；回放只标放出来的；周线也标；关掉收起", async () => {
    const { page, errors } = await start("TONE");
    const turns = () => api<{ time: string; to: string; left: number; top: number; width: number; height: number }[]>(page, "turns");
    const marked = async () => (await turns()).map((t) => [t.time, t.to]);
    const count = (n: number) => until(page, `图上有 ${n} 个变色标记`, async (n) => (await import("/app.js")).getChart().turns().length === n, 5000, n);

    let item = await layerItem(page, "toneTurns");
    expect(item).toEqual({ disabled: true, pressed: "false", text: "变色提示先打开「着色」" });
    expect(await page.locator(layerBtn("toneTurns")).evaluate((el) => el.classList.contains("sub"))).toBe(true);
    expect(await notCovered(page, layerBtn("toneTurns"))).toBe(true);

    await page.click(layerBtn("tone"));
    item = await layerItem(page, "toneTurns");
    expect(item).toEqual({ disabled: false, pressed: "false", text: "变色提示转绿标 ▲、转黑标 ▼" });
    expect(await turns()).toEqual([]);
    expect(await page.locator("#chart-readout .ro-turn").count()).toBe(0);

    await page.click(layerBtn("toneTurns"));
    await count(58);
    expect(await marked()).toEqual(dayTurns());
    expect((await api<any>(page, "layers")).rows.find((r: any) => r.key === "toneTurns")).toEqual({ key: "toneTurns", on: true, shown: true, why: null });

    // 第 240、250 根既转绿、上方又有构造和形态的标记：小三角贴着 K 线的最高价，标记紧挨在它外面，不叠
    await page.click(layerBtn("constructs"));
    await page.click(layerBtn("patterns"));
    await page.keyboard.press("Escape");
    await page.waitForSelector("#chart .struct-mark");
    const boxes = await page.evaluate(() => {
      const origin = document.getElementById("chart")!.getBoundingClientRect();
      return [...document.querySelectorAll<HTMLElement>("#chart .struct-mark")].filter((e) => !e.hidden).map((e) => {
        const r = e.getBoundingClientRect();
        return { text: e.textContent, x: r.x + r.width / 2 - origin.x, top: r.top - origin.y, bottom: r.bottom - origin.y };
      });
    });
    const drawnNow = await turns();
    for (const [i, text] of [[240, "顶·已完成"], [250, "M顶"]] as const) {
      const tri = drawnNow.find((t) => t.time === CHART.candles[i].time)!;
      const mark = boxes.find((b) => b.text === text)!;
      expect(Math.abs(mark.x - (tri.left + tri.width / 2))).toBeLessThan(1); // 同一根 K 线
      const gap = tri.top - mark.bottom; // 标记的下沿离最高价 8px，小三角占中间那几像素
      expect({ text, clear: gap >= 0 && gap <= 3 }).toEqual({ text, clear: true });
    }

    // 鼠标停在变色的那根上：读数条的日期后面写一句，看得见、没被截掉；旁边没变色的那根不写
    const pane = (await page.locator("#chart").boundingBox())!;
    const xOf = (i: number) => { const t = drawnNow.find((d) => d.time === CHART.candles[i].time)!; return t.left + t.width / 2; };
    const barStep = (xOf(290) - xOf(280)) / 10;
    /** 鼠标移到第 i 根（off：再往右几根），返回读数条开头的两格。 */
    const hover = async (i: number, off = 0) => {
      await page.mouse.move(pane.x + xOf(i) + off * barStep, pane.y + 60);
      await page.waitForFunction((t) => document.querySelector("#chart-readout .ro-ohlc b")?.textContent === t, CHART.candles[i + off].time);
      return page.$$eval("#chart-readout .ro-ohlc > *", (els) => els.slice(0, 2).map((e) => [e.className, e.textContent]));
    };
    expect(await hover(290)).toEqual([["", CHART.candles[290].time], ["ro-turn bull", "转绿"]]);
    // 多了这两个字，第一行还是放得下：量和量比的倍数没被截掉（窄栏里收起的是涨跌额和「均量」两个字）
    const row = await page.evaluate(() => {
      const el = document.querySelector("#chart-readout .ro-ohlc")!;
      const shown = (sel: string) => (el.querySelector<HTMLElement>(sel)?.getBoundingClientRect().width ?? 0) > 0;
      return { fits: el.scrollWidth <= el.clientWidth, turn: shown(".ro-turn"), volume: shown(".ro-vol b"), ratio: shown(".ro-ratio") };
    });
    expect(row).toEqual({ fits: true, turn: true, volume: true, ratio: true });
    expect(await notCovered(page, "#chart-readout .ro-turn")).toBe(true);
    expect(await hover(295)).toEqual([["", CHART.candles[295].time], ["ro-turn bear", "转黑"]]);
    expect((await hover(290, 2))[1][0]).not.toContain("ro-turn");
    await page.mouse.move(pane.x - 30, pane.y - 30);

    // 回放：只标已经放出来的 K 线，往后放到变色的那根才多一个
    await page.click(".replay-toggle");
    await page.click(".replay-start");
    await page.fill(".replay-menu input", CHART.candles[200].time);
    await until(page, "进入回放", async () => (await import("/app.js")).getChart().replay().mode === "replay");
    await page.click(".replay-play"); // 暂停
    const at = (await api<any>(page, "replay")).index as number;
    await count(dayTurns(at).length);
    expect(await marked()).toEqual(dayTurns(at));
    for (let i = at; i < 205; i++) await page.click(".replay-forward");
    await count(dayTurns(205).length);
    expect(dayTurns(205).length).toBe(dayTurns(204).length + 1); // 第 205 根转黑
    expect(await marked()).toEqual(dayTurns(205));
    expect((await layerItem(page, "toneTurns")).disabled).toBe(false);
    await page.keyboard.press("Escape");
    await page.click(".replay-exit");
    await count(58);

    // 周线：按周线自己的颜色标
    await page.click('[data-frame="week"]');
    await count(weekTurns().length);
    expect(await marked()).toEqual(weekTurns());
    expect(await layerItem(page, "toneTurns")).toMatchObject({ disabled: false, pressed: "true" });
    await page.click('[data-frame="day"]');
    await count(58);

    // 关掉着色：变色提示跟着收起、变灰；只属于「全部」预设
    await openLayers(page);
    await page.click(layerBtn("tone"));
    await count(0);
    expect(await layerItem(page, "toneTurns")).toMatchObject({ disabled: true, pressed: "false" });
    await page.click('.layers-menu [data-preset="all"]');
    await count(58);
    await page.click('.layers-menu [data-preset="structure"]');
    await count(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);
});

describe("结论卡片上的价位：点一下，图上那条线亮几秒", () => {
  const flashing = (page: Page) => page.evaluate(async () => (await import("/app.js")).getChart().flashing());
  const levels = (page: Page) => page.evaluate(async () => (await import("/app.js")).getChart().levels());
  const gone = (page: Page) => until(page, "亮着的线收掉", async () => (await import("/app.js")).getChart().flashing() === null, 8000);
  const chip = (item: string) => `#verdict .concl-row[data-situation="flat"] [data-item="${item}"]`;
  /** 亮着的那条线在屏幕上看得见：它的纵坐标落在图里，那个位置上是图，没被输入框之类的挡住。 */
  const lineOnScreen = (page: Page) => until(page, "亮着的线在屏幕上看得见", async () => {
    const c = (await import("/app.js")).getChart();
    const f = c.flashing();
    const el = document.getElementById("chart")!;
    const r = el.getBoundingClientRect();
    if (!f || f.y === null || f.y < 0 || f.y > r.height - c.chart.timeScale().height()) return false;
    const hit = document.elementFromPoint(r.left + 60, r.top + f.y);
    return !!hit && el.contains(hit);
  }, 3000);

  test("默认视图点「止损」：图滚进视野，那条线亮起来、看得见没被挡，几秒后自己收掉；价位线图层关着、用键盘点也一样；很远的价位也看得见", async () => {
    const { page, errors } = await open();
    await page.waitForSelector("#chart canvas");
    for (const item of ["trigger", "stop", "target"]) expect({ item, ok: await notCovered(page, chip(item)) }).toEqual({ item, ok: true });
    expect(await flashing(page)).toBeNull();
    const before = await levels(page);
    expect(before).toHaveLength(4);

    await page.click(chip("stop"));
    const stop = (await flashing(page))!;
    expect([stop.kind, stop.title]).toEqual(["stop", "止损"]);
    expect(stop.price).toBeCloseTo(183.08, 2);
    await lineOnScreen(page);
    expect(await levels(page)).toEqual(before); // 平时的价位线不动
    await gone(page);
    expect(await levels(page)).toEqual(before);

    // 价位线图层关着：图上没有价位线，点了照样亮；用键盘点（Tab 到标签上按 Enter）
    await switchLayer(page, "levels");
    expect(await levels(page)).toEqual([]);
    await page.focus(chip("target"));
    await page.keyboard.press("Enter");
    expect(await flashing(page)).toMatchObject({ kind: "target", title: "第一阻力/目标位", price: 228.86 });
    await lineOnScreen(page);
    // 亮着的时候再点另一个：换成那一条，不是两条
    await page.click(chip("trigger"));
    expect(await flashing(page)).toMatchObject({ kind: "trigger", title: "触发", price: 212.21 });
    await lineOnScreen(page);
    expect(await levels(page)).toEqual([]);
    await gone(page);

    // 价位在图的价格范围外面（替身里没有这么远的目标，直接叫图表亮一个）：价格轴撑到它，线还是看得见
    await page.evaluate(async () => (await import("/app.js")).getChart().flashLevel({ kind: "target", price: 400, title: "目标" }));
    await lineOnScreen(page);
    expect(errors).toEqual([]);
    await page.close();
  }, 40_000);
});

describe("悬停提示的位置", () => {
  // 中栏滚动时，鼠标不动、元素滚到鼠标下面：浏览器只发 pointerover，不发 pointermove。
  // 提示框以前只在 pointermove 里定位，于是出现在页面左上角（或上一次的位置）。
  test("只有 pointerover、没有 pointermove 时，提示框也出现在鼠标旁边，不在左上角", async () => {
    const { page, errors } = await open();
    const at = await page.locator("#verdict .concl-lean").evaluate((el) => {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, clientX: x, clientY: y }));
      return { x, y };
    });
    await page.waitForSelector("#viz-tip:not([hidden])");
    const box = (await page.locator("#viz-tip").boundingBox())!;
    expect(Math.abs(box.y - (at.y + 14))).toBeLessThan(2);
    expect(box.x).toBeGreaterThan(at.x - box.width); // 靠右放不下时会往左挪，但不会回到 0
    expect(box.x).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    await page.close();
  });
});

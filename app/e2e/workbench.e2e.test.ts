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
  return {
    candles: days.map((time, i) => ({ time, open: close[i] - 1, high: close[i] + 2, low: close[i] - 2, close: close[i] })),
    volume: days.map((time) => ({ time, value: 1e6, spike: false })),
    lines: { MA20: line(5), EMA20: line(4), MA60: line(10), EMA60: line(9), MA120: line(15), EMA120: line(14), MA200: line(20).slice(199) },
    drops: [{ time: days[280], period: 20 }],
  };
})();

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
        return JSON.stringify({ analysis: a, chart: CHART });
      }
      if (args[0] === "BOUNCE") { // 空头结构反弹中：计划里有推演求解的辅助条，清单里有回测不支持的 J18
        const n = nvda as Analysis;
        const flat = { ...n.trade_plan.flat, entry: null, stop: null, targets: [], rr: null, rr_verdict: null, rr_gap: null, risk_pct: null, size: null };
        return JSON.stringify({ analysis: { ...n, label: "BOUNCE", play: { ...n.play, key: "空头结构反弹中", rules: ["P17", "J18", "J17"] },
          trade_plan: { ...n.trade_plan, key: "空头结构反弹中", flat } }, chart: CHART });
      }
      return JSON.stringify({ analysis: { ...(nvda as Analysis), label: args[0], warning: warningNext ?? nvda.warning }, chart: CHART });
  }, Date.now, () => "polygon", () => sizingArgs(settings.get()));
  analyzer.mount(practice);
  // 识别题库：同一段假"真实"行情，真的 scan.py；先出好几段的题
  const drills = new DrillBank({ prices, dir: join(dir, "drills"), pool: [{ ticker: REAL_TICKER }], random: seeded(5) });
  await drills.fill(3);
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

  test("读数条照 TradingView：开高低收和涨跌一行，均线值一行，各占一行不挤", async () => {
    const { page } = await open();
    await page.waitForSelector("#chart canvas");
    await page.locator("#chart-readout").scrollIntoViewIfNeeded();  // 图在结论卡片下面，用户往下滚就看到读数条
    const c = CHART.candles.at(-1)!, prev = CHART.candles.at(-2)!;
    const ohlc = (await page.textContent("#chart-readout .ro-ohlc"))!;
    for (const [k, v] of [["开", c.open], ["高", c.high], ["低", c.low], ["收", c.close]] as const) expect(ohlc).toContain(`${k} ${v.toFixed(2)}`);
    const chg = c.close - prev.close;
    expect(ohlc).toContain(`${chg >= 0 ? "+" : "−"}${Math.abs(chg).toFixed(2)}`);
    expect(ohlc).toContain(`${((chg / prev.close) * 100).toFixed(2).replace("-", "−")}%`);
    expect(await page.textContent("#chart-readout .ro-lines")).toContain("MA20");
    // 两行各自不换行（默认视图下），且都没被挡住
    const rows = await page.$$eval("#chart-readout > div", (els) => els.map((el) => {
      const r = el.getBoundingClientRect(), lh = parseFloat(getComputedStyle(el).lineHeight) || 16;
      const hit = document.elementFromPoint(r.x + 4, r.y + r.height / 2);
      return { lines: Math.round(r.height / lh), visible: !!hit && el.contains(hit) };
    }));
    expect(rows).toEqual([{ lines: 1, visible: true }, { lines: 1, visible: true }]);
    await page.close();
  }, 30_000);

  test("价位线：结论里的触发、止损、目标和推翻判断的价位画在图上，可以关掉", async () => {
    const { page } = await open();
    await page.waitForSelector("#chart canvas");
    const levels = () => page.evaluate(async () => (await import("/app.js")).getChart().levels());
    // NVDA 加速下跌：等构造完成、20 线组一起拐头（212.21），拐头失败止损 183.08，目标缺口 228.86；推翻判断：30 天内 20/60 双金叉的价位
    const on = await levels();
    expect(on.map((l: { kind: string; title: string }) => [l.kind, l.title]))
      .toEqual([["trigger", "触发"], ["stop", "进场后止损"], ["target", "目标"], ["invalid", "判断失效"]]);
    expect(on[0].price).toBe(212.21);
    expect(on[1].price).toBeCloseTo(183.08, 2);
    expect(on[2].price).toBe(228.86);
    expect(on[3].price).toBeCloseTo(206.26, 2);
    await page.click(".levels-toggle");
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


/** 元素在当前视图里看得见、没被别的东西挡住（elementFromPoint 落在它自己身上）。 */
const notCovered = (page: Page, sel: string) => page.evaluate((sel) => {
  const el = document.querySelector<HTMLElement>(sel)!;
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.x + Math.min(20, r.width / 2), r.y + r.height / 2);
  return r.height > 0 && !!hit && el.contains(hit);
}, sel);
/** 像用户一样把这一块滚进中栏视野（滚到它的开头）。 */
const scrollIntoCenter = (page: Page, sel: string) => page.evaluate(async (sel) => {
  const s = document.getElementById("center-scroll")!;
  const el = document.querySelector<HTMLElement>(sel)!;
  s.scrollTop += el.getBoundingClientRect().top - s.getBoundingClientRect().top - 40;
  await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
}, sel);

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

  test("结论：默认视图第一眼就是空仓、持仓两行，带价位；看得见、没被挡；回测照实说不买", async () => {
    const { page, errors } = await open();
    for (const sel of ['#verdict .concl-row[data-situation="flat"] .what b', '#verdict .concl-row[data-situation="holding"] .what b', "#verdict .record"]) {
      expect({ sel, ok: await notCovered(page, sel) }).toEqual({ sel, ok: true });
    }
    const flat = (await page.textContent('#verdict .concl-row[data-situation="flat"]'))!;
    expect(flat).toContain("不做：盈亏比 0.6:1"); // 加速下跌等构造和 20 线组拐头再进，但到缺口的空间不够 3:1
    expect(flat).toContain("触发");
    expect(flat).toContain("212.21");
    const holding = (await page.textContent('#verdict .concl-row[data-situation="holding"]'))!;
    expect(holding).toContain("反弹再减仓");
    expect(holding).toContain("183.08");
    expect(await page.textContent("#verdict .record")).toContain("空仓不买，回测没有进场");
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
    expect(f).toContain("不做：盈亏比1.9:1");
    expect(f).toContain("触发500.45");
    expect(f).toContain("止损488.03-2.5%"); // 60 线组拐头（解读），风险按触发价算
    expect(f).toContain("目标524.61"); // 前高（解读），说明在悬停里
    expect(await page.getAttribute(`${flat} [data-item=target]`, "data-tip")).toContain("中长线完好（现在是稳定上涨）就继续拿"); // P25：到目标是检查点
    expect(f).toContain("股数804/万元"); // 没填账户：每 1 万元风险对应的股数
    expect(await page.getAttribute(`${flat} [data-item=rr]`, "class")).toContain("bad");
    expect(await page.textContent(`${holding} [data-item=stop]`)).toContain("488.03"); // 持仓止损按进场原则，不按成本
    const kinds = await page.evaluate(async () => {
      const { chartLevels } = await import("/viz.js");
      const d = await (await fetch("/api/analyze?ticker=SPY&asof=2024-04-19")).json();
      return chartLevels(d.report, { pos: "flat", cost: "" }, d.analysis.close).map((l: { kind: string; title: string }) => `${l.kind}:${l.title}`);
    });
    expect(kinds).toEqual(expect.arrayContaining(["trigger:触发", "stop:进场后止损", "target:目标"]));
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("结论：MA200 朴素规则对照一行，默认视图看得见、没被挡；图上 MA200 默认不画，图例里点开", async () => {
    const { page, errors } = await open();
    expect(await notCovered(page, "#verdict .naive")).toBe(true);
    const naive = (await page.textContent("#verdict .naive"))!;
    expect(naive).toContain("MA200 朴素规则：收盘在下方 -25.9%，空仓");
    expect(naive.replace(/\s+/g, "")).toContain("双均线也空仓一致");
    expect(naive).toContain("评估 MAR 0.26 vs 0.14");
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

  test("看大局：第一眼就是趋势类型；类型对照表在这里，不在找打法", async () => {
    const { page, errors } = await open();
    const step = page.locator('[data-step="big_picture"]');
    expect(await step.locator(".answer").textContent()).toContain("加速下跌");
    expect(await step.locator("table.trend").count()).toBe(1);
    expect(await page.locator('[data-step="play"] table.trend').count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("找打法：条件清单逐条 ✓ / ✗ / 需看图，没满足的写还差什么；滚到它时看得见、没被挡", async () => {
    const { page, errors } = await open();
    const card = '[data-step="play"]';
    await scrollIntoCenter(page, card);
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
    expect(await plan.textContent()).toContain("不做：盈亏比 0.6:1");
    expect(await titles()).toEqual(["触发", "进场后止损", "目标", "判断失效"]);
    await page.click('[data-pos="holding"]');
    expect(await plan.textContent()).toContain("反弹再减仓");
    expect(await titles()).toEqual(["盯住", "目标", "判断失效"]);
    await page.fill("#pos-cost", "200");
    expect(await page.textContent(".pnl")).toContain("-24.5%");
    await page.reload();
    await page.waitForSelector(".lean-label");
    expect(await page.getAttribute('[data-pos="holding"]', "aria-pressed")).toBe("true");
    expect(await page.inputValue("#pos-cost")).toBe("200");
    await page.close();
  }, 30_000);

  test("做推演：三问只看 30 天，推翻判断的价位写出来；只给 2–3 个求解，其余折叠", async () => {
    const { page } = await open();
    const card = '[data-step="forecast"]';
    await scrollIntoCenter(page, card);
    expect(await notCovered(page, `${card} .q3 li`)).toBe(true);
    const qs = await page.locator(`${card} .q3 li .pl`).allTextContents();
    expect(qs).toEqual(["类型线能撑多久", "条件最早哪天齐", "什么价位推翻判断"]);
    const ans = (await page.textContent(`${card} .answer`))!;
    expect(ans).toContain("30 天");
    expect(ans).toContain("206.26");
    expect(await page.locator(`${card} .answer ul.solves li`).count()).toBeLessThanOrEqual(3);
    expect(await page.locator(`${card} details.more`).getAttribute("open")).toBeNull();
    await page.close();
  }, 30_000);

  test("做推演：求解给的答案标「辅助」，相关求解折叠，评估结论（H4）一行小字；滚到时看得见、没被挡", async () => {
    const { page, errors } = await open();
    const card = '[data-step="forecast"] .answer';
    await scrollIntoCenter(page, card);
    expect(await page.textContent(`${card} .q3 li.invalid .aux-tag`)).toContain("辅助");
    expect(await page.locator(`${card} details.aux-solves`).getAttribute("open")).toBeNull();
    expect(await notCovered(page, `${card} .ev-note`)).toBe(true);
    expect(await page.textContent(`${card} .ev-note`)).toContain("97% 真的发生了，但未达到事先定的有用标准（H4）");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("找打法：「就别等」那条推演标辅助、附评估结论；回测不支持的规则带小标签；滚到时看得见、没被挡", async () => {
    const { page, errors } = await open(undefined, "BOUNCE");
    const card = '[data-step="play"]';
    await scrollIntoCenter(page, `${card} .checklist`);
    const tag = `${card} .checklist li[data-rule="J18"] .ev-tag`;
    expect(await notCovered(page, tag)).toBe(true);
    expect(await page.textContent(tag)).toContain("回测不支持");
    await scrollIntoCenter(page, `${card} .plan-items li.aux`);
    expect(await notCovered(page, `${card} .plan-items li.aux`)).toBe(true);
    const aux = (await page.textContent(`${card} .plan-items li.aux`))!;
    expect(aux).toContain("辅助 · 推演");
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
    expect(qs.map((q) => q.replace(/\s+/g, ""))).toEqual(["①60/120线组排好了吗？", "②60线几点钟？", "③是不是加速？", "④20线组走到哪一步？", "⑤周线、小时线怎么排？"]);
    for (const q of await step.locator(".check h3").all()) expect(await q.isVisible()).toBe(true);
    const verdicts = await step.locator(".check .judge").allTextContents();
    expect(verdicts[0]).toContain("有类型");
    expect(verdicts[1]).toContain("点");
    expect(verdicts[2]).toContain("加速起点");
    expect(verdicts[3]).toContain("延伸");
    expect(verdicts[4]).toContain("周线 MA 多头");
    expect(verdicts[4]).toContain("小时线 MA 空头");
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

describe("成本价决定浮盈 / 浮亏的做法", () => {
  test("结论里填成本：高于现价，持仓那行变成浮亏；低于现价变成浮盈；找打法的做法跟着变", async () => {
    const { page } = await open();
    const plan = page.locator('[data-step="play"] .plan-body');
    const row = page.locator('#verdict .concl-row[data-situation="holding"]');
    await page.click('[data-pos="holding"]');
    await page.fill("#pos-cost", "200");
    expect(await plan.textContent()).toContain("不等回本");
    expect(await row.locator(".who").textContent()).toBe("持仓 · 浮亏");
    await page.fill("#pos-cost", "133");
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
    expect((await rp(page)).mode).toBe("select");
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
    expect(await page.textContent("#chart-readout")).toContain(CHART.candles.at(-1)!.time);
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
    expect((await rp(page)).mode).toBe("select");
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
    await scrollIntoCenter(page, '[data-step="play"]');
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

  test("做推演默认只列 MA60、MA120 的 30 天门槛；持平情景折叠在「更多推演」里", async () => {
    const { page } = await open();
    const card = page.locator('[data-step="forecast"]');
    const first = card.locator("table.hurdles").first();
    expect(await first.locator("tbody tr").count()).toBe(2);
    expect(await first.textContent()).toContain("239.24"); // MA60 30 天抵扣价最高
    expect(await card.locator("details.more .flow").textContent()).toContain("30 个交易日");
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
    const { page, errors } = await open();
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
    await page.waitForSelector(".dr-choice");
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

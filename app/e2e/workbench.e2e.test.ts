/**
 * 端到端：真的服务端代码（进程内，假行情 + 假语音合成）+ 真的 Chrome。
 * 运行：bun run e2e（用本机安装的 Chrome，不下载浏览器）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { Analyzer } from "../src/analyze.ts";
import type { Analysis } from "../src/citations.ts";
import { createHandler } from "../src/http.ts";
import { SettingsStore } from "../src/settings.ts";
import { SourceLibrary } from "../src/sources.ts";
import { Speaker } from "../src/tts.ts";
import { Watchlist } from "../src/watchlist.ts";
import nvda from "../test/fixtures/nvda-analysis.json";

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
    lines: { MA20: line(5), EMA20: line(4), MA60: line(10), EMA60: line(9), MA120: line(15), EMA120: line(14) },
    drops: [{ time: days[280], period: 20 }],
  };
})();

const MP3 = readFileSync(resolve(import.meta.dir, "../test/fixtures/tts-sample.mp3"));
const ttsCalls: { text: string; voice: string }[] = [];
const wsSent: any[] = [];
let staleNext = false;
const lastPrompt = () => wsSent.filter((m) => m.type === "prompt").at(-1);
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
let base = "";

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "dma-e2e-"));
  const handler = createHandler({
    analyzer: new Analyzer(async (args) =>
      JSON.stringify({ analysis: { ...(nvda as Analysis), label: args[0] }, chart: CHART })),
    watchlist: new Watchlist(join(dir, "w.json")),
    library: SourceLibrary.load(),
    publicDir: resolve(import.meta.dir, "../public"),
    settings: new SettingsStore(join(dir, "s.json")),
    tts: new Speaker(async (text, voice) => { ttsCalls.push({ text, voice }); return new Uint8Array(MP3); }),
  });
  // WebSocket 替身：记下浏览器发来的消息；连上就告诉两个面板"空闲"，输入框才可用
  server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: (req, srv) => (new URL(req.url).pathname === "/ws" ? (srv.upgrade(req) ? undefined : new Response("", { status: 400 })) : handler(req)),
    websocket: {
      maxPayloadLength: 24 * 1024 * 1024,
      open(ws) {
        if (staleNext) ws.send(JSON.stringify({ type: "stale", message: "服务端代码更新过：按 Ctrl+C 后运行 just wildgoose" }));
        for (const agent of ["analyst", "advisor"]) ws.send(JSON.stringify({ type: "status", agent, busy: false }));
      },
      message(_ws, m) { wsSent.push(JSON.parse(String(m))); },
    },
  });
  base = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ channel: "chrome", args: ["--autoplay-policy=no-user-gesture-required"] });
});

// 本机 Chrome 关闭要 10 秒左右，超过 bun 钩子默认的 5 秒
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
}, 30_000);

/** 打开工作台，等模糊判断卡片出来。errors 收集页面里没接住的异常。 */
async function open(setup?: (p: Page) => Promise<void>) {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await setup?.(page);
  await page.goto(`${base}/#NVDA`);
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
  test("能打开，默认分析师云希、鸿雁晓晓", async () => {
    const { page, errors } = await open();
    await page.click("#settings-btn");
    await expect(page.isVisible("#settings-panel")).resolves.toBe(true);
    expect(await page.inputValue("select[name=voiceAnalyst]")).toBe("zh-CN-YunxiNeural");
    expect(await page.inputValue("select[name=voiceAdvisor]")).toBe("zh-CN-XiaoxiaoNeural");
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("服务端是旧版本（没有语音选项）时，设置照样能打开，并提示重启", async () => {
    const { page, errors } = await open(async (p) => {
      await p.route("**/api/settings", async (route) => {
        const res = await route.fetch();
        const body = await res.json();
        delete body.voices;
        body.settings = { model: body.settings.model, dataSource: body.settings.dataSource };
        await route.fulfill({ response: res, json: body });
      });
    });
    await page.click("#settings-btn");
    await expect(page.isVisible("#settings-panel")).resolves.toBe(true);
    expect(await page.textContent("#settings-panel")).toContain("重启");
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
  }, 30_000);

  test("门槛线：把「改变判断」的价位画在图上，可以关掉", async () => {
    const { page } = await open();
    await page.waitForSelector("#chart canvas");
    const levels = () => page.evaluate(async () => (await import("/app.js")).getChart().levels());
    const on = await levels();
    expect(on.length).toBeGreaterThan(0);
    expect(on[0]).toMatchObject({ title: "站上 EMA20", price: expect.any(Number) });
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


describe("三步报告：每一步先给结论", () => {
  test("看大局：第一眼就是趋势类型；六种类型的对照表在这里，不在定策略", async () => {
    const { page, errors } = await open();
    const step = page.locator('[data-step="big_picture"]');
    expect(await step.locator(".answer").textContent()).toContain("极度超卖");
    expect(await step.locator("table.trend").count()).toBe(1);
    expect(await page.locator('[data-step="strategy"] table.trend').count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("定策略：空仓 / 持仓切换，做法跟着变；看方向的「对你」也跟着变；刷新后记住", async () => {
    const { page } = await open();
    const plan = page.locator('[data-step="strategy"] .answer');
    const forYou = page.locator('[data-step="direction"] .effect');
    expect(await plan.textContent()).toContain("不抢反弹");
    const flatForYou = await forYou.textContent();
    await page.click('[data-pos="holding"]');
    expect(await plan.textContent()).toContain("反弹再减仓");
    expect(await forYou.textContent()).not.toBe(flatForYou);
    await page.fill("#pos-cost", "200");
    expect(await page.textContent(".pnl")).toContain("-24.5%");
    await page.reload();
    await page.waitForSelector(".lean-label");
    expect(await page.getAttribute('[data-pos="holding"]', "aria-pressed")).toBe("true");
    expect(await page.inputValue("#pos-cost")).toBe("200");
    await page.close();
  }, 30_000);

  test("看方向：有一句结论和「最早什么时候会变」", async () => {
    const { page } = await open();
    const ans = (await page.locator('[data-step="direction"] .answer').textContent())!;
    expect(ans).toContain("逆风");
    expect(ans).toContain("183.08");
    await page.close();
  }, 30_000);

  test("要点和出处默认折叠", async () => {
    const { page } = await open();
    expect(await page.locator('[data-step="big_picture"] details.points-box').getAttribute("open")).toBeNull();
    await page.close();
  }, 30_000);
});

describe("抽屉：总结和 K 线图滚上去以后还能拉回来", () => {
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

  test("点「总结」拉出模糊判断卡片", async () => {
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
  test("总结一滚出视野就出现提示条（K 线图还露着也一样）", async () => {
    const { page } = await open();
    await page.waitForSelector("#chart canvas");
    await page.evaluate(() => {
      const s = document.getElementById("center-scroll")!;
      const v = document.getElementById("verdict")!;
      s.scrollTop = v.offsetTop + v.offsetHeight + 10; // 刚好滚过总结
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
    await scrollPast(page, '[data-step="strategy"]');
    expect(await shown(page)).toEqual(["verdict", "chart", "big_picture", "strategy"]);
    await scrollPast(page, '[data-step="direction"]');
    expect(await shown(page)).toEqual(["verdict", "chart", "big_picture", "strategy", "direction"]);
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);

  test("抽屉里的定策略照样能用（切持仓），收起后放回原处", async () => {
    const { page } = await open();
    await scrollPast(page, '[data-step="direction"]');
    await page.click('#peek [data-peek="strategy"]');
    await page.click('#drawer [data-pos="holding"]');
    expect(await page.locator('#drawer [data-step="strategy"] .answer').textContent()).toContain("反弹再减仓");
    await page.click("#drawer .drawer-close");
    expect(await page.locator('#steps [data-step="strategy"]').count()).toBe(1);
    await page.click('[data-pos="flat"]'); // 还原，别影响其他测试
    await page.close();
  }, 30_000);

  test("抽屉开着时换股票：抽屉收起，不留下过期的内容", async () => {
    const { page, errors } = await open();
    await scrollPast(page, '[data-step="direction"]');
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

describe("看大局的证据：按判断顺序的四问", () => {
  test("四问依次是：横盘、偏哪边、健康还是极度、交叉确认；每问先给判断；最后接回结论", async () => {
    const { page, errors } = await open();
    const step = page.locator('[data-step="big_picture"]');
    const qs = await step.locator(".check h3").allTextContents();
    expect(qs.map((q) => q.replace(/\s+/g, ""))).toEqual(["①是不是横盘？", "②偏哪一边？", "③健康还是极度？", "④交叉确认（参考）"]);
    const verdicts = await step.locator(".check .judge").allTextContents();
    expect(verdicts[0]).toContain("不是横盘");
    expect(verdicts[1]).toContain("明显偏空");
    expect(verdicts[2]).toContain("极度");
    expect(await step.locator(".check-sum").textContent()).toContain("极度超卖");
    expect(await step.locator("table.vt th:text('MA 方向')").count()).toBe(0); // 和总结卡片重复的均线表去掉了
    expect(errors).toEqual([]);
    await page.close();
  }, 30_000);
});

describe("定策略：成本价决定浮盈 / 浮亏的做法", () => {
  test("填成本：高于现价是浮亏的做法，低于现价是浮盈的做法（保本价填成本）；看方向跟着变", async () => {
    const { page } = await open();
    const plan = page.locator('[data-step="strategy"] .plan-body');
    const effect = page.locator('[data-step="direction"] .effect');
    await page.click('[data-pos="holding"]');
    await page.fill("#pos-cost", "200");
    expect(await plan.textContent()).toContain("不等回本");
    expect(await effect.textContent()).toContain("涨回成本");
    await page.fill("#pos-cost", "133");
    const t = (await plan.textContent())!;
    expect(t).toContain("133.00");
    expect(t).not.toContain("{cost}");
    expect(t).not.toContain("浮亏影响心情");
    expect(await effect.textContent()).not.toContain("涨回成本");
    expect(await effect.textContent()).not.toContain("支持支持");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("pos-cost"); // 边打字边更新，不丢焦点
    await page.fill("#pos-cost", "");
    await page.click('[data-pos="flat"]');
    await page.close();
  }, 30_000);
});

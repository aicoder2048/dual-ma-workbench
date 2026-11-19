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
      JSON.stringify({ analysis: { ...(nvda as Analysis), label: args[0] }, chart: { candles: [], volume: [], lines: {}, drops: [] } })),
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
    await page.waitForFunction(() => document.querySelector("#advisor-thread .speak")?.textContent?.includes("停止"));
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

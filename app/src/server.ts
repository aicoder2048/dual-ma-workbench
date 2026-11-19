/**
 * 双均线工作台服务入口：`bun src/server.ts`，然后打开 http://127.0.0.1:5178
 *
 * 只监听本机地址。HTTP 提供页面和数据；WebSocket（/ws）连接两个 Pi agent 会话。
 */
import { resolve } from "node:path";
import { Analyzer } from "./analyze.ts";
import { createHandler } from "./http.ts";
import { SourceLibrary } from "./sources.ts";
import { loadEnvKeys, MODEL_OPTIONS, SettingsStore } from "./settings.ts";
import { Watchlist } from "./watchlist.ts";
import { Workbench, type Client } from "./workbench.ts";

const PORT = Number(process.env.PORT ?? 5178);
const HOST = "127.0.0.1";

// 模型 key 默认放在项目根目录 .env（只读模型要用的那几个，只打印变量名）
const loadedKeys = loadEnvKeys();
if (loadedKeys.length) console.log(`从 .env 读取：${loadedKeys.join(", ")}`);

const settings = new SettingsStore();
const analyzer = new Analyzer(undefined, undefined, () => settings.get().dataSource);
const library = SourceLibrary.load();
const workbench = new Workbench(analyzer, library, { settings });
const handler = createHandler({
  analyzer,
  watchlist: new Watchlist(),
  library,
  publicDir: resolve(import.meta.dir, "../public"),
  settings,
});

type WsData = { client?: Client };

const server = Bun.serve<WsData, never>({
  hostname: HOST,
  port: PORT,
  fetch(req, srv) {
    if (new URL(req.url).pathname === "/ws") {
      // 只接受本机页面发起的连接
      const origin = req.headers.get("origin") ?? "";
      if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) return new Response("Forbidden", { status: 403 });
      return srv.upgrade(req, { data: {} }) ? undefined : new Response("Upgrade failed", { status: 400 });
    }
    return handler(req);
  },
  websocket: {
    open(ws) {
      ws.data.client = { send: (d) => ws.send(d) };
      workbench.connect(ws.data.client);
    },
    message(ws, message) {
      void workbench.handle(ws.data.client!, String(message));
    },
    close(ws) {
      workbench.disconnect(ws.data.client!);
    },
  },
});
const s = settings.get();
const opt = MODEL_OPTIONS.find((m) => m.id === s.model)!;
console.log(`归雁 · 双均线工作台：http://${server.hostname}:${server.port}`);
console.log(`模型：${s.model}（${opt.billing}）· 数据：${s.dataSource}`);

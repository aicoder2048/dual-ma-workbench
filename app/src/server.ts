/**
 * 双均线工作台服务入口：`bun src/server.ts`，然后打开 http://127.0.0.1:5178
 *
 * 只监听本机地址。HTTP 提供页面和数据；WebSocket（/ws）连接两个 Pi agent 会话。
 */
import { resolve } from "node:path";
import { Analyzer } from "./analyze.ts";
import { createHandler } from "./http.ts";
import { SourceLibrary } from "./sources.ts";
import { Watchlist } from "./watchlist.ts";
import { Workbench, type Client } from "./workbench.ts";

const PORT = Number(process.env.PORT ?? 5178);
const HOST = "127.0.0.1";

const analyzer = new Analyzer();
const library = SourceLibrary.load();
const workbench = new Workbench(analyzer, library);
const handler = createHandler({
  analyzer,
  watchlist: new Watchlist(),
  library,
  publicDir: resolve(import.meta.dir, "../public"),
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
console.log(`双均线工作台：http://${server.hostname}:${server.port}`);

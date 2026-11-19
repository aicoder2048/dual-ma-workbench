/**
 * 双均线工作台服务入口：`bun src/server.ts`，然后打开 http://127.0.0.1:5178
 *
 * 只监听本机地址。Stage 4/5 会在这里挂上 WebSocket 和两个 Pi agent 会话。
 */
import { resolve } from "node:path";
import { Analyzer } from "./analyze.ts";
import { createHandler } from "./http.ts";
import { SourceLibrary } from "./sources.ts";
import { Watchlist } from "./watchlist.ts";

const PORT = Number(process.env.PORT ?? 5178);
const HOST = "127.0.0.1";

const handler = createHandler({
  analyzer: new Analyzer(),
  watchlist: new Watchlist(),
  library: SourceLibrary.load(),
  publicDir: resolve(import.meta.dir, "../public"),
});

const server = Bun.serve({ hostname: HOST, port: PORT, fetch: handler });
console.log(`双均线工作台：http://${server.hostname}:${server.port}`);

/** HTTP 路由（不含 WebSocket）。依赖注入，测试时可以换掉 Analyzer 和 Watchlist。 */
import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { explainError, type Analyzer } from "./analyze.ts";
import { buildFacts } from "./citations.ts";
import { buildReport } from "./report.ts";
import { DATA_OPTIONS, MODEL_OPTIONS, modelReadiness, SettingsStore, VOICE_OPTIONS } from "./settings.ts";
import type { SourceLibrary } from "./sources.ts";
import { Speaker } from "./tts.ts";
import type { Watchlist } from "./watchlist.ts";

export interface Deps {
  analyzer: Analyzer;
  watchlist: Watchlist;
  library: SourceLibrary;
  publicDir: string;
  settings: SettingsStore;
  /** 语音合成；不传就用微软 Edge 在线语音。 */
  tts?: Speaker;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const fail = (message: string, status = 400) => json({ error: message }, status);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json",
};

export function createHandler(deps: Deps) {
  const { analyzer, watchlist, library, publicDir, settings } = deps;
  const tts = deps.tts ?? new Speaker();
  const settingsView = () => {
    const ready = modelReadiness();
    return {
      settings: settings.get(),
      models: MODEL_OPTIONS.map((m) => ({ ...m, ready: ready[m.id] })),
      dataSources: DATA_OPTIONS,
      voices: VOICE_OPTIONS,
    };
  };

  async function api(req: Request, url: URL): Promise<Response> {
    const p = url.pathname;
    const q = url.searchParams;

    if (p === "/api/analyze" && req.method === "GET") {
      const r = await analyzer.analyze(q.get("ticker") ?? "", q.get("asof"));
      return json({ ...r, facts: buildFacts(r.analysis), report: buildReport(r.analysis) });
    }
    if (p === "/api/summary" && req.method === "GET") {
      const { analysis: a } = await analyzer.analyze(q.get("ticker") ?? "");
      return json({ ticker: a.label, date: a.date, close: a.close, change_pct: a.change_pct, trend: a.trend,
        lean: { label: a.lean.label, conflict: a.lean.conflict, score: a.lean.score } });
    }
    if (p === "/api/watchlist") {
      if (req.method === "GET") return json(watchlist.list());
      const body = (await req.json().catch(() => ({}))) as { ticker?: string };
      if (req.method === "POST") return json(watchlist.add(body.ticker ?? ""));
      if (req.method === "DELETE") return json(watchlist.remove(body.ticker ?? ""));
    }
    if (p === "/api/settings") {
      if (req.method === "GET") return json(settingsView());
      if (req.method === "PUT") {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        if ("model" in body) patch.model = body.model;
        for (const k of ["dataSource", "voiceAnalyst", "voiceAdvisor", "autoSpeak"]) if (k in body) patch[k] = body[k];
        const ready = modelReadiness();
        if (typeof patch.model === "string" && ready[patch.model] === false) {
          const opt = MODEL_OPTIONS.find((m) => m.id === patch.model)!;
          return fail(`缺少 ${opt.keyEnv}：请在项目根目录 .env 里加上，再重启服务。`);
        }
        settings.update(patch);
        return json(settingsView());
      }
    }
    if (p === "/api/tts" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { text?: unknown; voice?: unknown };
      const audio = await tts.speak(body.text, body.voice);
      return new Response(new Blob([audio as Uint8Array<ArrayBuffer>]), { headers: { "content-type": "audio/mpeg", "cache-control": "private, max-age=3600" } });
    }
    if (p === "/api/sources" && req.method === "GET") {
      return json(library.index());
    }
    if (p === "/api/source" && req.method === "GET") {
      const c = library.get(q.get("id") ?? "");
      return c ? json(c) : fail("没有这个原文片段", 404);
    }
    return fail("没有这个接口", 404);
  }

  function serveStatic(url: URL): Response {
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = resolve(publicDir, rel);
    // 防止 ../ 跳出 public 目录
    if (!file.startsWith(publicDir + "/") || !existsSync(file)) return new Response("Not found", { status: 404 });
    // 本地工具：不缓存，改了前端刷新就生效
    return new Response(Bun.file(file), {
      headers: { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" },
    });
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return serveStatic(url);
    try {
      return await api(req, url);
    } catch (err) {
      return fail(explainError(err), err instanceof Error && /不合法|格式|最多|清单/.test(err.message) ? 400 : 500);
    }
  };
}

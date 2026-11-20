/** HTTP 路由（不含 WebSocket）。依赖注入，测试时可以换掉 Analyzer 和 Watchlist。 */
import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import { explainError, type Analyzer } from "./analyze.ts";
import { buildFacts } from "./citations.ts";
import { captureSnapshot, Journal, JournalError, journalView, parseAction, parseCreate } from "./journal.ts";
import { buildReport } from "./report.ts";
import { nearestThinking, piCatalog, THINKING_LEVELS, type ModelCatalog } from "./agents/catalog.ts";
import { DATA_OPTIONS, SettingsStore, VOICE_OPTIONS } from "./settings.ts";
import type { SourceLibrary } from "./sources.ts";
import { Speaker } from "./tts.ts";
import type { Watchlist } from "./watchlist.ts";

export interface Deps {
  analyzer: Analyzer;
  watchlist: Watchlist;
  journal: Journal;
  library: SourceLibrary;
  publicDir: string;
  settings: SettingsStore;
  /** 语音合成；不传就用微软 Edge 在线语音。 */
  tts?: Speaker;
  /** 可选模型；不传就从 Pi 读（pi 里登录过的 provider 的模型）。 */
  catalog?: ModelCatalog;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const fail = (message: string, status = 400) => json({ error: message }, status);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json",
};

export function createHandler(deps: Deps) {
  const { analyzer, watchlist, journal, library, publicDir, settings } = deps;
  const tts = deps.tts ?? new Speaker();
  const catalog = deps.catalog ?? piCatalog();
  /** effective：两个 agent 实际用的思考程度（模型不支持想要的档位时取最近的）；当前模型不在清单里时是 null。 */
  const settingsView = async () => {
    const models = await catalog.list();
    const s = settings.get();
    const current = models.find((m) => m.id === s.model);
    return {
      settings: s,
      models,
      thinkingLevels: THINKING_LEVELS,
      effective: current ? {
        analyst: nearestThinking(s.thinkingAnalyst, current.thinking),
        advisor: nearestThinking(s.thinkingAdvisor, current.thinking),
      } : null,
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
      return json({ ticker: a.label, date: a.date, close: a.close, change_pct: a.change_pct, trend: a.regime.name,
        lean: { label: a.lean.label, score: a.lean.score } });
    }
    if (p === "/api/watchlist") {
      if (req.method === "GET") return json(watchlist.list());
      const body = (await req.json().catch(() => ({}))) as { ticker?: string };
      if (req.method === "POST") return json(watchlist.add(body.ticker ?? ""));
      if (req.method === "DELETE") return json(watchlist.remove(body.ticker ?? ""));
    }
    if (p === "/api/journal") {
      if (req.method === "GET") return json(journalView(journal.list()));
      if (req.method === "POST") {
        // 快照按页面说的票、日期、处境在这里重新取，不信页面发来的计划
        const input = parseCreate(await req.json().catch(() => null));
        const { analysis } = await analyzer.analyze(input.ticker, input.asof);
        journal.create(input, captureSnapshot(analysis, buildReport(analysis), input));
        return json(journalView(journal.list()));
      }
    }
    const entryId = p.match(/^\/api\/journal\/([^/]+)$/)?.[1];
    if (entryId && req.method === "POST") {
      journal.apply(decodeURIComponent(entryId), parseAction(await req.json().catch(() => null)));
      return json(journalView(journal.list()));
    }
    if (p === "/api/settings") {
      if (req.method === "GET") return json(await settingsView());
      if (req.method === "PUT") {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const patch: Record<string, unknown> = {};
        for (const k of ["model", "thinkingAnalyst", "thinkingAdvisor", "dataSource", "voiceAnalyst", "voiceAdvisor", "autoSpeak"]) {
          if (k in body) patch[k] = body[k];
        }
        if ("model" in patch) {
          const list = await catalog.list();
          const provider = String(patch.model).split("/")[0];
          if (!list.some((m) => m.id === patch.model)) {
            return fail(list.some((m) => m.provider === provider)
              ? `${patch.model} 不能用：${provider} 的模型目录里没有它（套餐里没有，或名字写错了）。`
              : `${patch.model} 不能用：${provider} 还没在 pi 里登录。在终端运行 pi，输入 /login 登录后刷新页面。`);
          }
        }
        settings.update(patch);
        return json(await settingsView());
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
      if (err instanceof JournalError) return fail(err.message, err.status);
      return fail(explainError(err), err instanceof Error && /不合法|格式|最多|清单/.test(err.message) ? 400 : 500);
    }
  };
}

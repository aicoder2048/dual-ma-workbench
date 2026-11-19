// agent 回答里的可视化代码块：mermaid（流程图）、dma-chart（迷你 K 线图）、dma-drops（底扣价小多图）。
// parseBlockSpec 是纯函数，bun test 直接测；enhance 在浏览器里把代码块换成图。
import { dropMultiples } from "./viz.js";

export const BLOCK_LANGS = ["mermaid", "dma-chart", "dma-drops"];
const TICKER = /^[A-Z0-9][A-Z0-9.\-^=]{0,14}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LINE_KEYS = ["MA20", "EMA20", "MA60", "EMA60", "MA120", "EMA120"];

/** 校验代码块内容。返回 { ok, spec } 或 { ok: false, error }。 */
export function parseBlockSpec(lang, text) {
  if (lang === "mermaid") {
    const src = String(text).trim();
    if (!/^(flowchart|graph)\s+(LR|RL|TD|TB|BT)/.test(src)) return { ok: false, error: "只支持 flowchart 流程图" };
    if (src.split("\n").length > 40) return { ok: false, error: "流程图太长（> 40 行）" };
    return { ok: true, spec: { src } };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "代码块不是合法 JSON" };
  }
  const ticker = String(data.ticker ?? "").toUpperCase();
  if (!TICKER.test(ticker)) return { ok: false, error: "缺少或不合法的 ticker" };
  const asof = data.asof ?? null;
  if (asof !== null && !DATE.test(asof)) return { ok: false, error: "asof 应为 YYYY-MM-DD" };
  if (lang === "dma-drops") {
    const periods = (data.periods ?? [20, 60, 120]).map(Number).filter((n) => [20, 60, 120].includes(n));
    if (!periods.length) return { ok: false, error: "periods 只能是 20 / 60 / 120" };
    return { ok: true, spec: { ticker, asof, periods } };
  }
  if (lang === "dma-chart") {
    for (const k of ["from", "to"]) if (data[k] != null && !DATE.test(data[k])) return { ok: false, error: `${k} 应为 YYYY-MM-DD` };
    const lines = (data.lines ?? ["MA20", "MA60", "MA120"]).filter((k) => LINE_KEYS.includes(k));
    const marks = (Array.isArray(data.marks) ? data.marks : [])
      .filter((m) => DATE.test(m?.time ?? ""))
      .slice(0, 12)
      .map((m) => ({ time: m.time, text: String(m.text ?? "").slice(0, 12) }));
    return { ok: true, spec: { ticker, asof, from: data.from ?? null, to: data.to ?? null, lines, marks } };
  }
  return { ok: false, error: `不支持的代码块：${lang}` };
}

// ---------- 浏览器渲染 ----------
const cache = new Map();
function fetchAnalysis(ticker, asof) {
  const key = `${ticker}|${asof ?? ""}`;
  if (!cache.has(key)) {
    const q = new URLSearchParams({ ticker });
    if (asof) q.set("asof", asof);
    cache.set(key, fetch(`/api/analyze?${q}`).then(async (r) => {
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "取数失败");
      return body;
    }));
    cache.get(key).catch(() => cache.delete(key));
  }
  return cache.get(key);
}

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function miniChart(box, data, spec) {
  const inRange = (t) => (!spec.from || t >= spec.from) && (!spec.to || t <= spec.to);
  const candles = data.chart.candles.filter((c) => inRange(c.time));
  if (!candles.length) throw new Error("这个日期范围没有数据");
  const chart = LightweightCharts.createChart(box, {
    autoSize: true, height: 220,
    layout: { background: { type: "solid", color: css("--card") }, textColor: css("--muted"), fontFamily: css("--mono") },
    grid: { vertLines: { visible: false }, horzLines: { color: css("--grid") } },
    rightPriceScale: { borderColor: css("--line") }, timeScale: { borderColor: css("--line") },
    handleScroll: false, handleScale: false, crosshair: { mode: 0 },
  });
  const muted = css("--muted");
  const cs = chart.addCandlestickSeries({ priceLineVisible: false, upColor: "rgba(0,0,0,0)", downColor: muted,
    borderUpColor: muted, borderDownColor: muted, wickUpColor: muted, wickDownColor: muted });
  cs.setData(candles);
  for (const k of spec.lines) {
    const s = chart.addLineSeries({ color: css(`--${k.toLowerCase()}`), lineWidth: k.startsWith("MA") ? 2 : 1,
      lineStyle: k.startsWith("EMA") ? 2 : 0, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    s.setData((data.chart.lines[k] || []).filter((p) => inRange(p.time)));
  }
  const drop = css("--drop");
  cs.setMarkers(spec.marks.filter((m) => inRange(m.time)).sort((a, b) => (a.time < b.time ? -1 : 1))
    .map((m) => ({ time: m.time, position: "aboveBar", color: drop, shape: "arrowDown", text: m.text })));
  chart.timeScale().fitContent();
}

let mermaidMod = null;
async function renderMermaid(box, src) {
  mermaidMod ??= import("https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.esm.min.mjs").then((m) => m.default);
  const mermaid = await mermaidMod;
  const t = document.documentElement.dataset.theme;
  const dark = t === "dark" || (!t && matchMedia("(prefers-color-scheme: dark)").matches);
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "neutral",
    fontFamily: getComputedStyle(document.body).fontFamily });
  const { svg } = await mermaid.render(`mmd-${Math.random().toString(36).slice(2)}`, src);
  box.innerHTML = svg;
}

/** 把 el 里的可视化代码块换成图；失败时保留代码并显示原因。 */
export async function enhance(el) {
  const codes = [...el.querySelectorAll("pre > code")].filter((c) =>
    BLOCK_LANGS.some((l) => c.classList.contains(`language-${l}`)));
  await Promise.all(codes.map(async (code) => {
    const lang = BLOCK_LANGS.find((l) => code.classList.contains(`language-${l}`));
    const pre = code.parentElement;
    const fig = document.createElement("figure");
    fig.className = `viz block block-${lang}`;
    const parsed = parseBlockSpec(lang, code.textContent);
    try {
      if (!parsed.ok) throw new Error(parsed.error);
      const s = parsed.spec;
      if (lang === "mermaid") {
        const box = document.createElement("div");
        fig.appendChild(box);
        pre.replaceWith(fig);
        await renderMermaid(box, s.src);
      } else {
        const data = await fetchAnalysis(s.ticker, s.asof);
        if (lang === "dma-drops") {
          fig.innerHTML = dropMultiples(data.report.visual, { periods: s.periods });
          pre.replaceWith(fig);
        } else {
          const box = document.createElement("div");
          box.className = "mini-chart";
          const cap = document.createElement("figcaption");
          cap.textContent = `${s.ticker}${s.asof ? `（回放 ${s.asof}）` : ""} · ${s.from ?? "起"} ~ ${s.to ?? data.analysis.date} · ${s.lines.join(" / ")}`;
          fig.append(box, cap);
          pre.replaceWith(fig);
          miniChart(box, data, s);
        }
      }
    } catch (err) {
      if (fig.isConnected) fig.replaceWith(pre); // 放回原来的代码
      const note = document.createElement("div");
      note.className = "block-error";
      note.textContent = `图没画出来：${err.message}`;
      pre.after(note);
    }
  }));
}

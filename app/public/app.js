// 页面状态：自选股、当前分析、规则版三步报告。Stage 4/5 在此基础上接两个 agent。
import { createChart } from "./chart.js";
import { installCitationHandlers, loadSourceIndex, renderInline } from "./cite.js";

const $ = (id) => document.getElementById(id);
const STANCE = { 健康上涨: "bullish", 极度超买: "bullish", 健康下跌: "bearish", 极度超卖: "bearish" };
const SHORT_TREND = (t) => t.replace("（排列或方向不一致）", "");

export const state = { ticker: null, asof: null, data: null };
const listeners = new Set();
/** 订阅"当前分析变了"（agent 模块用）。 */
export const onAnalysis = (cb) => listeners.add(cb);

let chartApi = null;
export const getChart = () => chartApi;

async function api(path, init) {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `请求失败（${res.status}）`);
  return body;
}

// ---------- 自选股 ----------
const summaries = new Map();

async function refreshWatchlist() {
  const items = await api("/api/watchlist");
  const ul = $("watchlist");
  ul.innerHTML = "";
  for (const t of items) {
    const li = document.createElement("li");
    li.className = "wl-item" + (t === state.ticker && !state.asof ? " active" : "");
    li.dataset.ticker = t;
    li.tabIndex = 0;
    li.innerHTML = `<span class="sym">${t}</span><span class="px">…</span><span class="trend"></span><span class="chg"></span>
      <button class="del" type="button" aria-label="移出自选股 ${t}">×</button>`;
    ul.appendChild(li);
    paintSummary(li, summaries.get(t));
  }
  // 逐个拉规则初判（不经过 LLM），最多 2 个并发
  const queue = items.filter((t) => !summaries.has(t));
  const worker = async () => {
    for (let t; (t = queue.shift()); ) {
      try {
        summaries.set(t, await api(`/api/summary?ticker=${t}`));
      } catch (err) {
        summaries.set(t, { error: err.message });
      }
      const li = ul.querySelector(`[data-ticker="${t}"]`);
      if (li) paintSummary(li, summaries.get(t));
    }
  };
  await Promise.all([worker(), worker()]);
}

function paintSummary(li, s) {
  if (!s) return;
  if (s.error) {
    li.querySelector(".px").textContent = "—";
    li.querySelector(".trend").textContent = "取数失败";
    li.title = s.error;
    return;
  }
  li.querySelector(".px").textContent = s.close.toFixed(2);
  const chg = li.querySelector(".chg");
  chg.textContent = `${s.change_pct >= 0 ? "+" : ""}${s.change_pct.toFixed(2)}%`;
  chg.className = `chg ${s.change_pct >= 0 ? "bullish" : "bearish"}`;
  li.querySelector(".trend").innerHTML = `<span class="badge ${STANCE[s.trend] ?? "neutral"}">${SHORT_TREND(s.trend)}</span>`;
}

$("watchlist").addEventListener("click", async (e) => {
  const li = e.target.closest(".wl-item");
  if (!li) return;
  if (e.target.closest(".del")) {
    await api("/api/watchlist", { method: "DELETE", body: JSON.stringify({ ticker: li.dataset.ticker }) });
    refreshWatchlist();
    return;
  }
  loadAnalysis(li.dataset.ticker, null);
});
$("watchlist").addEventListener("keydown", (e) => {
  const li = e.target.closest(".wl-item");
  if (li && e.key === "Enter") loadAnalysis(li.dataset.ticker, null);
});

$("wl-add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const t = $("wl-input").value.trim();
  if (!t) return;
  try {
    await api("/api/watchlist", { method: "POST", body: JSON.stringify({ ticker: t }) });
    $("wl-input").value = "";
    refreshWatchlist();
  } catch (err) {
    alertInline(err.message);
  }
});

// ---------- 当前分析 ----------
export async function loadAnalysis(ticker, asof) {
  const box = $("chart");
  box.classList.add("loading");
  try {
    const q = new URLSearchParams({ ticker });
    if (asof) q.set("asof", asof);
    const data = await api(`/api/analyze?${q}`);
    showAnalysis(data, asof);
  } catch (err) {
    alertInline(`${ticker}：${err.message}`);
  } finally {
    box.classList.remove("loading");
  }
}

/** 渲染一份分析结果（HTTP 拿到的，或分析师工具推过来的）。 */
export function showAnalysis(data, asof = null) {
  const a = data.analysis;
  state.ticker = a.label;
  state.asof = asof;
  state.data = data;
  location.hash = asof ? `${a.label}@${asof}` : a.label;

  $("ticker").textContent = a.label;
  $("price").textContent = a.close.toFixed(2);
  const chg = $("chg");
  chg.textContent = `${a.change_pct >= 0 ? "+" : ""}${a.change_pct.toFixed(2)}%`;
  chg.className = `chg num ${a.change_pct >= 0 ? "bullish" : "bearish"}`;
  $("meta-line").textContent = `${asof ? "回放 · " : ""}${a.date} 收盘 · ${a.source}`;
  $("load-ticker").value = a.label;
  $("load-asof").value = asof ?? "";

  const warn = $("warning");
  warn.hidden = !a.warning;
  warn.textContent = a.warning ?? "";

  const r = data.report;
  const v = $("verdict");
  v.hidden = false;
  v.style.setProperty("--stance", `var(--${r.stance === "bullish" ? "up" : r.stance === "bearish" ? "down" : "neutral"})`);
  v.innerHTML = `<b></b><p>规则初判（脚本阈值算的，需结合图形复核）。点标签可以看出处或数据。</p>`;
  renderInline(v.querySelector("b"), `${SHORT_TREND(a.trend)} [[D:趋势初判]] → ${a.strategy} [[S:article#4]]`, data.facts);

  chartApi?.setData(data.chart);

  const steps = $("steps");
  steps.innerHTML = "";
  steps.dataset.meta = `${a.label} ${a.date} · ${a.source}`;
  r.steps.forEach((s, i) => {
    const sec = document.createElement("section");
    sec.className = "card step";
    sec.dataset.step = s.key;
    sec.innerHTML = `<h2>${i + 1}. ${s.title} <span>${s.subtitle}</span></h2><ul></ul>`;
    const ul = sec.querySelector("ul");
    for (const item of s.items) {
      const li = document.createElement("li");
      renderInline(li, item, data.facts);
      ul.appendChild(li);
    }
    steps.appendChild(sec);
  });

  document.querySelectorAll(".wl-item").forEach((li) =>
    li.classList.toggle("active", li.dataset.ticker === a.label && !asof));
  listeners.forEach((cb) => cb(data));
}

$("load-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const t = $("load-ticker").value.trim();
  if (t) loadAnalysis(t, $("load-asof").value || null);
});

function alertInline(message) {
  const warn = $("warning");
  warn.hidden = false;
  warn.textContent = message;
}

// ---------- 主题 ----------
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem("dma-theme"); } catch { /* 隐私模式 */ }
  if (saved) document.documentElement.dataset.theme = saved;
  $("theme").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("dma-theme", next); } catch { /* 忽略 */ }
  });
}

// ---------- 启动 ----------
async function main() {
  initTheme();
  installCitationHandlers(() => (state.data ? `${state.data.analysis.label} ${state.data.analysis.date}` : ""));
  chartApi = createChart($("chart"), $("legend"));
  await loadSourceIndex();
  const [t, asof] = decodeURIComponent(location.hash.slice(1)).split("@");
  const wl = refreshWatchlist();
  const first = t || (await api("/api/watchlist"))[0];
  if (first) await loadAnalysis(first, asof || null);
  await wl;
}

main();

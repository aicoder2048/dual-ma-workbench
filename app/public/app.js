// 页面状态：自选股、当前分析、规则版三步报告。Stage 4/5 在此基础上接两个 agent。
import { connect, Panel, send } from "./agents.js";
import { createChart } from "./chart.js";
import { installCitationHandlers, loadSourceIndex, renderInline } from "./cite.js";
import { initAsofInput, initSplitters } from "./layout.js";
import { initSelection } from "./selection.js";
import { initAskMenu, selectionLabel } from "./askmenu.js";
import { resolveTicker } from "./names.js";
import { applyRemoteSettings, initSettings, openSettings } from "./settings.js";
import { installTips, leanCard, leanName, stanceOf, stepVisuals } from "./viz.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SHORT_TREND = (t) => t.replace("（排列或方向不一致）", "");

export const state = { ticker: null, asof: null, data: null };
const listeners = new Set();
/** 订阅"当前分析变了"（agent 模块用）。 */
export const onAnalysis = (cb) => listeners.add(cb);

let chartApi = null;
let asofUi = null;
let advisorSuggestions = [];
export const getChart = () => chartApi;

async function api(path, init) {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `请求失败（${res.status}）`);
  return body;
}

// ---------- 自选股 ----------
const summaries = new Map();

let wlItems = [];

async function refreshWatchlist() {
  const items = await api("/api/watchlist");
  wlItems = items;
  paintStar();
  $("ticker-options").innerHTML = items.map((t) => `<option value="${t}">`).join("");
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
  const trendEl = li.querySelector(".trend");
  trendEl.innerHTML = `<span class="badge ${stanceOf(s.lean)}">${leanName(s.lean)}</span>`;
  trendEl.title = `模糊判断 ${leanName(s.lean)}；趋势类型 ${SHORT_TREND(s.trend)}`;
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

// ---------- 指标行：收盘 / 趋势 / 乖离 / 量比 ----------
function renderKpis(a) {
  const sign = (x, d = 2) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}`;
  const tiles = [
    { k: "收盘", v: a.close.toFixed(2), s: `<span class="${a.change_pct >= 0 ? "bullish" : "bearish"}">${sign(a.change_pct)}%</span>` },
    { k: "趋势类型", v: `<span class="${stanceOf(a.lean)}">${SHORT_TREND(a.trend)}</span>`, s: `MA ${a.arr_ma} · EMA ${a.arr_ema}` },
    { k: "离 20 线", v: `${sign(a.bias20, 1)}%`, s: `历史 ${Math.round(a.bias_pctl * 100)}% 分位` },
  ];
  if (a.volume) tiles.push({ k: "量比", v: `${a.volume.ratio.toFixed(1)}×`, s: `近 20 日大量 ${a.volume.spikes.length} 天` });
  $("kpis").innerHTML = tiles.map((t) => `<div class="kpi"><div class="k">${t.k}</div><div class="v">${t.v}</div><div class="s">${t.s}</div></div>`).join("");
}

// ---------- 当前分析 ----------
/** 成功返回 null，失败返回原因（已在中栏提示过）。 */
export async function loadAnalysis(ticker, asof) {
  const box = $("chart");
  box.classList.add("loading");
  try {
    const q = new URLSearchParams({ ticker });
    if (asof) q.set("asof", asof);
    const data = await api(`/api/analyze?${q}`);
    showAnalysis(data, asof);
    return null;
  } catch (err) {
    alertInline(`${ticker}：${err.message}`);
    return err.message;
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
  $("meta-line").textContent = asof ? "回放：只用这一天及以前的数据" : `${a.date} 收盘`;
  $("load-asof").value = asof ?? "";
  $("load-asof").type = asof ? "date" : "text";
  $("load-asof").closest(".asof").classList.toggle("replay", Boolean(asof));
  asofUi?.sync();
  paintStar();
  renderKpis(a);
  const status = $("data-status");
  status.classList.toggle("partial", Boolean(a.warning));
  $("data-status-v").textContent = `${a.source.replace("（复权日线）", "")} · ${a.warning ? "盘中" : a.date}`;
  status.title = a.warning ?? `数据来源：${a.source}`;

  const warn = $("warning");
  warn.hidden = !a.warning;
  warn.textContent = a.warning ?? "";

  const r = data.report;
  const v = $("verdict");
  v.hidden = false;
  v.style.setProperty("--stance", `var(--${r.stance === "bullish" ? "up" : r.stance === "bearish" ? "down" : "neutral"})`);
  v.innerHTML = leanCard(r.visual.lean, a.close, SHORT_TREND(a.trend));
  renderInline(v.querySelector(".lean-play"), `${r.visual.lean.play} [[D:模糊判断]] [[S:skill#模糊判断]]`, data.facts);

  chartApi?.setData(data.chart);

  const steps = $("steps");
  steps.innerHTML = "";
  steps.dataset.meta = `${a.label} ${a.date} · ${a.source}`;
  r.steps.forEach((s, i) => {
    const sec = document.createElement("section");
    sec.className = "card step";
    sec.dataset.step = s.key;
    sec.innerHTML = `<div class="step-head"><span class="no">${i + 1}</span><h2>${s.title}</h2><span>${s.subtitle}</span>
        <button type="button" class="ask-card" data-ask-card="${s.key}" aria-haspopup="menu">问鸿雁</button></div>
      <div class="step-viz">${stepVisuals(s.key, r.visual)}</div>
      <p class="points-title">要点（规则生成，点标签看出处）</p><ul class="points"></ul>`;
    const ul = sec.querySelector(".points");
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
  send({ type: "view", ticker: a.label, asof }); // 服务端据此更新问法、给鸿雁准备数据
}

/** 搜索框下面的一行说明：查的是什么、为什么查不了。bad = 出错。 */
function searchMsg(text, bad = false) {
  const el = $("search-msg");
  el.hidden = !text;
  el.textContent = text ?? "";
  el.classList.toggle("bad", bad);
}

// 搜索看最新行情；回放在中栏标题旁设置
$("load-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("load-ticker");
  const r = resolveTicker(input.value);
  if (r.error) { searchMsg(r.error, true); input.select(); return; }
  if (!r.ticker) return;
  const what = r.name ? `${r.name} → ${r.ticker}` : r.ticker;
  searchMsg(`正在查 ${what}…`);
  input.value = "";
  input.blur();
  const err = await loadAnalysis(r.ticker, null);
  searchMsg(err ? `${what}：${err}` : r.name ? `${what}（美股代码）` : null, Boolean(err));
});
$("load-ticker").addEventListener("input", () => $("search-msg").classList.contains("bad") && searchMsg(null));

// 左栏「＋ 自选」：加输入框里的代码；输入框为空时加中栏当前这只
$("wl-add").addEventListener("click", async () => {
  const input = $("load-ticker");
  const r = input.value.trim() ? resolveTicker(input.value) : { ticker: state.ticker };
  if (r.error) { searchMsg(r.error, true); return; }
  const t = r.ticker;
  if (!t) { input.focus(); return; }
  try {
    await api("/api/watchlist", { method: "POST", body: JSON.stringify({ ticker: t }) });
    input.value = "";
    await refreshWatchlist();
  } catch (err) {
    alertInline(err.message);
  }
});

// ---------- 中栏标题：自选开关 ----------
function paintStar() {
  const star = $("star");
  if (!state.ticker) return;
  const on = wlItems.includes(state.ticker);
  star.hidden = false;
  star.setAttribute("aria-pressed", String(on));
  star.textContent = on ? "★ 已自选" : "☆ 加入自选";
  star.title = on ? "移出自选股" : "加入自选股";
}
$("star").addEventListener("click", async () => {
  if (!state.ticker) return;
  const on = wlItems.includes(state.ticker);
  try {
    await api("/api/watchlist", { method: on ? "DELETE" : "POST", body: JSON.stringify({ ticker: state.ticker }) });
    refreshWatchlist();
  } catch (err) {
    alertInline(err.message);
  }
});
document.querySelectorAll("[data-open-settings]").forEach((b) => b.addEventListener("click", () => openSettings()));

function alertInline(message) {
  const warn = $("warning");
  warn.hidden = false;
  warn.textContent = message;
}

// ---------- 主题（跟随系统 / 浅 / 深 / 水墨）----------
const THEMES = ["", "light", "dark", "ink"];

function applyTheme(name) {
  if (name) document.documentElement.dataset.theme = name;
  else delete document.documentElement.dataset.theme; // 跟随系统
}

function initTheme() {
  let saved = "";
  try { saved = localStorage.getItem("dma-theme") ?? ""; } catch { /* 隐私模式 */ }
  if (!THEMES.includes(saved)) saved = "";
  const seg = $("theme");
  const mark = (v) => seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.value === v)));
  applyTheme(saved);
  mark(saved);
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    applyTheme(b.dataset.value);
    mark(b.dataset.value);
    try { localStorage.setItem("dma-theme", b.dataset.value); } catch { /* 忽略 */ }
  });
}

// ---------- 两个 agent ----------
export const panels = {};

function initAgents() {
  panels.analyst = new Panel({
    agent: "analyst", thread: $("analyst-thread"), scroller: $("center-scroll"), chips: $("analyst-chips"),
    form: $("analyst-form"), input: $("analyst-input"), sendBtn: $("analyst-send"), resetBtn: $("analyst-reset"),
  });
  panels.advisor = new Panel({
    agent: "advisor", thread: $("advisor-thread"), scroller: $("advisor-scroll"), chips: $("advisor-chips"),
    form: $("advisor-form"), input: $("advisor-input"), sendBtn: $("advisor-send"), resetBtn: $("advisor-reset"),
    empty: $("advisor-empty"),
    beforeSend: () => ({ selection: takeSelection() }),
  });
  connect((e) => {
    if (e.type === "analysis") return showAnalysis(e.data, e.asof);
    if (e.type === "settings") return applyRemoteSettings(e.settings, { onDataSourceChange: reloadAll });
    const p = panels[e.agent];
    if (!p) return;
    switch (e.type) {
      case "history": p.enable(true); return p.history(e.entries);
      case "status": p.enable(true); return p.setBusy(e.busy);
      case "turn_start": p.addUser(e.user); return p.startTurn();
      case "text_delta": return p.delta(e.delta);
      case "tool": return p.tool(e);
      case "turn_end": return p.endTurn(e.entry);
      case "suggestions":
        if (e.agent === "advisor") advisorSuggestions = e.items;
        return p.suggestions(e.items, e.source);
      case "error": return p.error(e.message);
    }
  });
}

// 划选内容：显示在右栏输入框上方，问鸿雁时一起发出，发完清空
let pendingSelection = null;
export function setSelection(sel) {
  pendingSelection = sel;
  const pill = $("advisor-context");
  if (!sel) { pill.hidden = true; pill.innerHTML = ""; return; }
  const label = selectionLabel(sel);
  pill.innerHTML = `<span>${esc(label)}</span><button type="button" aria-label="去掉划选内容">×</button>`;
  pill.hidden = false;
  pill.querySelector("button").onclick = () => setSelection(null);
}
function takeSelection() { const s = pendingSelection; setSelection(null); return s; }

/** 数据源变了：清掉自选股标签缓存，重新取当前股票和自选股。 */
function reloadAll() {
  summaries.clear();
  refreshWatchlist();
  if (state.ticker) loadAnalysis(state.ticker, state.asof);
}

// ---------- 启动 ----------
async function main() {
  initTheme();
  installTips();
  initSplitters();
  asofUi = initAsofInput({ onChange: (d) => state.ticker && loadAnalysis(state.ticker, d) });
  initAskMenu({
    getState: () => state.data && { analysis: state.data.analysis, visual: state.data.report.visual, aiSuggestions: advisorSuggestions },
    ask: (question, selection) => { setSelection(selection); panels.advisor.submit(question); },
  });
  await initSettings({ onDataSourceChange: reloadAll });
  await loadSourceIndex(); // 先有原文目录，再回放对话记录，否则原文引用会被误判为找不到
  initAgents();
  installCitationHandlers(() => (state.data ? `${state.data.analysis.label} ${state.data.analysis.date}` : ""));
  chartApi = createChart($("chart"), $("legend"));
  initSelection({
    chart: chartApi,
    onAttach(sel, question) {
      setSelection(sel);
      const input = $("advisor-input");
      if (!input.value.trim()) input.value = question;
      input.focus();
      input.select();
    },
  });
  const [t, asof] = decodeURIComponent(location.hash.slice(1)).split("@");
  const wl = refreshWatchlist();
  const first = t || (await api("/api/watchlist"))[0];
  if (first) await loadAnalysis(first, asof || null);
  await wl;
}

main();

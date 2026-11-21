// 回测页：顶栏「回测」打开，盖住整个工作台；关掉回到原样。
// 左边是方案（存成 data/backtests/<名字>.toml）和运行，右边是结果。数字全是 planrun.py 算好的，这里只排版。
// 点一笔交易：关掉回测，工作台回放到那笔的信号日，看那天的结论卡片。

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const POLL_MS = 700;
const STATE_LABEL = { queued: "排队", running: "运行中", done: "完成", failed: "失败", cancelled: "取消" };
const KIND_HINT = {
  tickers: "一只或几只，逗号或空格分开。",
  watchlist: "运行时用当时的自选股；方案里不存代码，自选股变了下次跑跟着变。",
  core: "你的核心名单（38 只：指数 ETF、半导体、大型科技和几只大市值），运行前的规模估计里列出。",
};

let api = null;
let onTrade = () => {};
let beforeOpen = () => {};
let template = null;
let plans = [];
let runs = [];
let viewing = null;
let following = null;
let pending = null; // 估计过、等用户确认的方案
let curve = null;
let returnFocus = null;

export const isOpen = () => !$("backtest-page").hidden;

export function openPage() {
  const page = $("backtest-page");
  if (!page.hidden) return;
  beforeOpen();
  returnFocus = document.activeElement;
  page.hidden = false;
  $("backtest-btn").setAttribute("aria-expanded", "true");
  if (!template) void boot();
}

export function closePage() {
  const page = $("backtest-page");
  if (page.hidden) return;
  page.hidden = true;
  $("backtest-btn").setAttribute("aria-expanded", "false");
  returnFocus?.focus?.();
}

function msg(text, bad = false) {
  $("bt-msg").textContent = text ?? "";
  $("bt-msg").classList.toggle("bad", bad);
}

/** 按钮点了以后跑 f；出错写在底部，不弹窗。 */
const act = (f) => async (e) => {
  e?.preventDefault?.();
  try { await f(e); } catch (err) { msg(err.message, true); }
};

async function boot() {
  msg("正在读方案……");
  try {
    [template, plans, runs] = await Promise.all([api("/api/backtest/template"), api("/api/backtest/plans"), api("/api/backtest/runs")]);
  } catch (err) {
    msg(`回测页打不开：${err.message}`, true);
    return;
  }
  msg("");
  const first = plans.find((p) => p.plan);
  fillForm(first ? first.plan : template);
  paintPlans(first?.name ?? "");
  paintRuns();
  const active = runs.find((r) => r.state === "queued" || r.state === "running");
  const done = runs.find((r) => r.state === "done");
  if (active) follow(active.id);
  else if (done) await show(done.id);
}

// ---------- 方案表单 ----------

const toPct = (f) => +(f * 100).toPrecision(12);
const fromPct = (v) => +(Number(v) / 100).toPrecision(12);
const splitTickers = (s) => s.split(/[\s,，、;；]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
const kindNow = () => document.querySelector('input[name="bt-kind"]:checked').value;

function fillForm(p) {
  $("bt-name").value = p.name;
  document.querySelector(`input[name="bt-kind"][value="${p.universe.kind}"]`).checked = true;
  $("bt-tickers").value = p.universe.kind === "tickers" ? p.universe.tickers.join(", ") : "";
  $("bt-start").value = p.period.start;
  $("bt-end").value = p.period.end;
  const x = p.execution;
  $("bt-stop").value = x.stop;
  $("bt-account").value = x.account;
  $("bt-risk").value = x.risk;
  $("bt-risk-pct").value = x.risk_pct;
  $("bt-risk-amount").value = x.risk_amount;
  $("bt-maxpos").value = toPct(x.max_position);
  $("bt-floor").value = String(x.stop_floor_atr);
  $("bt-cost").value = toPct(x.cost);
  $("bt-rr").checked = x.rr_filter;
  $("bt-targets").checked = x.targets;
  syncForm();
}

function syncForm() {
  const kind = kindNow();
  $("bt-tickers").hidden = kind !== "tickers";
  $("bt-kind-hint").textContent = KIND_HINT[kind];
  const amount = $("bt-risk").value === "amount";
  $("bt-risk-pct-f").hidden = amount;
  $("bt-risk-amount-f").hidden = !amount;
  hideEstimate();
}

/** 表单 → 方案（格式和 data/backtests/*.toml 一样）。校验在服务端，错了它说哪里不对。 */
function readForm() {
  const kind = kindNow();
  const num = (id) => Number($(id).value);
  return {
    version: 1, name: $("bt-name").value.trim(), mode: "fullplan",
    universe: { kind, tickers: kind === "tickers" ? splitTickers($("bt-tickers").value) : [] },
    period: { start: $("bt-start").value, end: $("bt-end").value },
    execution: {
      stop: $("bt-stop").value, risk: $("bt-risk").value, risk_pct: num("bt-risk-pct"), risk_amount: num("bt-risk-amount"),
      account: num("bt-account"), max_position: fromPct($("bt-maxpos").value), rr_filter: $("bt-rr").checked,
      targets: $("bt-targets").checked, stop_floor_atr: num("bt-floor"), cost: fromPct($("bt-cost").value),
    },
  };
}

function paintPlans(selected) {
  const sel = $("bt-plan-select");
  const opts = plans.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}${p.plan ? "" : "（读不了）"}</option>`);
  if (!plans.some((p) => p.name === selected)) opts.unshift(`<option value="">（新方案，还没保存）</option>`);
  sel.innerHTML = opts.join("");
  sel.value = plans.some((p) => p.name === selected) ? selected : "";
  for (const id of ["bt-dup", "bt-delete"]) $(id).disabled = !sel.value;
}

async function refreshPlans(selected) {
  plans = await api("/api/backtest/plans");
  paintPlans(selected);
}

async function savePlan() {
  const plan = await api("/api/backtest/plans", { method: "POST", body: JSON.stringify({ plan: readForm() }) });
  await refreshPlans(plan.name);
  return plan;
}

function freeName(base) {
  const taken = new Set(plans.map((p) => p.name));
  if (!taken.has(base)) return base;
  for (let k = 2; ; k++) if (!taken.has(`${base} ${k}`)) return `${base} ${k}`;
}

async function readFile(input) {
  const file = input.files?.[0];
  input.value = "";
  return file ? file.text() : null;
}

// ---------- 估计和运行 ----------

const fmtSec = (s) => (s < 60 ? `${Math.max(1, Math.round(s))} 秒` : s < 3600 ? `${Math.round(s / 60)} 分钟` : `${(s / 3600).toFixed(1)} 小时`);

function hideEstimate() {
  pending = null;
  $("bt-estimate").hidden = true;
}

async function estimate() {
  const plan = readForm();
  $("bt-run").disabled = true;
  msg("正在估计规模……");
  try {
    const est = await api("/api/backtest/estimate", { method: "POST", body: JSON.stringify({ plan }) });
    msg("");
    pending = plan;
    const n = est.tickers.length;
    const c = est.counts;
    const parts = [];
    if (c.cached) parts.push(`${c.cached} 只有缓存`);
    if (c.compute) parts.push(`${c.compute} 只要从头算每天的计划`);
    if (c.download) parts.push(`${c.download} 只要先下载行情再算`);
    if (c.short) parts.push(`${c.short} 只历史不足 3 年，会跳过`);
    const list = plan.universe.kind === "tickers" && n <= 3 ? "" : `<p class="bt-hint">${esc(est.tickers.join(" "))}</p>`;
    const overlap = est.holdout.overlap.length
      ? `<p class="bad">${esc(est.holdout.overlap.join(" "))} 在新验证集里（已经跑过 ${est.holdout.runs} 次）。照跑，但会记为第 ${est.holdout.runs + 1} 次；拿它调参数，验证集就作废了。</p>`
      : "";
    $("bt-estimate").innerHTML = `<p><b>${n} 只 × 这段时间 = ${est.days.toLocaleString()} 个决定点</b>（每只票每个交易日一份计划）</p>
      <p>${parts.join("，")}。预计 ${fmtSec(est.seconds)}${c.compute + c.download ? `（${est.compute_days.toLocaleString()} 天的计划要算，${est.jobs} 个进程并行；算过的下次直接用缓存）` : ""}。</p>
      ${list}${overlap}
      <div class="row"><button type="button" id="bt-go-cancel">先不跑</button><button type="button" id="bt-go" class="bt-primary">开始</button></div>`;
    $("bt-estimate").hidden = false;
    $("bt-go").onclick = act(start);
    $("bt-go-cancel").onclick = hideEstimate;
    $("bt-go").focus();
  } finally {
    $("bt-run").disabled = Boolean(following);
  }
}

async function start() {
  const plan = pending;
  hideEstimate();
  const run = await api("/api/backtest/runs", { method: "POST", body: JSON.stringify({ plan }) });
  await refreshPlans(plan.name);
  runs = await api("/api/backtest/runs");
  paintRuns();
  follow(run.id);
}

function follow(id) {
  following = id;
  $("bt-run").disabled = true;
  $("bt-progress").hidden = false;
  $("bt-bar-fill").style.width = "0";
  $("bt-progress-text").textContent = "排队中……";
  const tick = async () => {
    if (following !== id) return;
    let view;
    try { view = await api(`/api/backtest/runs/${id}`); } catch (err) { msg(err.message, true); setTimeout(tick, POLL_MS * 3); return; }
    const r = view.run;
    if (r.state === "queued" || r.state === "running") {
      const p = r.state === "running" ? r.progress : null;
      $("bt-bar-fill").style.width = p && p.total ? `${Math.round((p.done / p.total) * 100)}%` : "4%";
      $("bt-progress-text").textContent = r.state === "queued" ? "排队中（前一次还没跑完）" : p ? p.text : "启动中……";
      setTimeout(tick, POLL_MS);
      return;
    }
    following = null;
    $("bt-progress").hidden = true;
    $("bt-run").disabled = false;
    runs = await api("/api/backtest/runs");
    paintRuns();
    if (r.state === "done") { msg(""); await show(id, view); }
    else msg(r.state === "failed" ? `回测失败：${r.error}` : "已取消。", r.state === "failed");
  };
  void tick();
}

// ---------- 运行记录 ----------

const pc = (x, d = 1) => (x == null ? "—" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(d)}%`);
const p0 = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const f2 = (x) => (x == null ? "—" : x.toFixed(2));
const sg = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}`;
const rr = (x) => (x == null ? "—" : `${sg(x)}R`);
const when = (iso) => new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

function runLine(r) {
  if (r.state === "done") {
    const h = r.headline;
    return `${h.tickers} 只 · ${h.trades} 笔 · 平均 ${rr(h.mean_r)} · 年化 ${pc(h.cagr)} · 回撤 ${pc(h.mdd, 0)}${h.nondefault ? " · 参数非默认" : ""}`;
  }
  if (r.state === "failed") return r.error;
  if (r.state === "running") return r.progress?.text ?? "启动中";
  return STATE_LABEL[r.state];
}

function paintRuns() {
  $("bt-runs").innerHTML = runs.length ? runs.map((r) => `<li><button type="button" data-run="${r.id}" aria-current="${r.id === viewing}">
      <span class="bt-state ${r.state}">${STATE_LABEL[r.state]}</span><span>${esc(r.plan)}${r.source === "imported" ? "（导入）" : ""}</span>
      <span class="when">${when(r.createdAt)}</span><span class="line" title="${esc(runLine(r))}">${esc(runLine(r))}</span></button></li>`).join("")
    : `<li class="bt-hint">还没有跑过。</li>`;
}

// ---------- 结果 ----------

function summaryRows(s, bases) {
  const names = Object.keys(bases);
  const row = (label, plan, base = () => "—", lead = false) =>
    `<tr><td class="${lead ? "lead" : ""}">${label}</td><td class="${lead ? "lead" : ""}">${plan}</td>${names.map((n) => `<td>${base(bases[n])}</td>`).join("")}</tr>`;
  const ci = s.ci ? `（${sg(s.ci[0])} ~ ${rr(s.ci[1])}）` : "（区间算不出）";
  return [
    row("期望：平均 R（90% 区间）", `${rr(s.mean_r)}${s.mean_r == null ? "" : ci}`, undefined, true),
    row("每笔盈亏占净值：平均 / 中位", `${pc(s.equity_pct_mean, 2)} / ${pc(s.equity_pct_median, 2)}`, undefined, true),
    row("笔数", s.trades),
    row("胜率", p0(s.win)),
    row("赔率（平均赢 R ÷ 平均亏 R）", f2(s.payoff)),
    row("年化（CAGR）", pc(s.cagr), (b) => pc(b.cagr), true),
    row("最大回撤", pc(s.mdd), (b) => pc(b.mdd)),
    row("MAR（年化 ÷ 最大回撤）", f2(s.mar), (b) => f2(b.mar), true),
    row("有持仓的天数", p0(s.exposure), (b) => p0(b.exposure)),
    row("平均仓位", p0(s.invested)),
    row("最长连亏（笔）", s.streak),
  ].join("");
}

const fmtValue = (k, v) => (k === "max_position" ? (v ? `${toPct(v)}%` : "不限") : k === "cost" ? `${toPct(v)}%`
  : k === "stop" ? (v === "close" ? "按收盘" : "盘中") : k === "stop_floor_atr" ? (v ? `${v} ATR` : "不用") : v === true ? "开" : v === false ? "关" : String(v));

function flags(run, r) {
  const out = [];
  if (r.nondefault.length) {
    const what = r.nondefault.map((x) => `${x.label} ${fmtValue(x.key, x.value)}（默认 ${fmtValue(x.key, x.default)}）`).join("，");
    out.push(`<span class="bt-flag warn" title="和完整计划报告的口径不一样">参数非默认：${esc(what)}</span>`);
  }
  if (run.source === "imported") out.push(`<span class="bt-flag">导入的结果（${esc(r.meta.generated)}，代码 ${esc(r.meta.head.slice(0, 8))}）</span>`);
  const skipped = Object.entries(r.meta.skipped);
  if (skipped.length) out.push(`<span class="bt-flag warn">没测：${esc(skipped.map(([t, why]) => `${t} ${why}`).join("；"))}</span>`);
  if (r.holdout.overlap.length) {
    const nth = r.holdout.runs ? `，这是第 ${r.holdout.runs} 次跑验证集` : "";
    out.push(`<span class="bt-flag warn">含新验证集的票：${esc(r.holdout.overlap.join(" "))}${nth}</span>`);
  }
  return out.join("");
}

function tradeRows(trades) {
  return trades.map((t, i) => `<tr data-trade="${i}" title="回到工作台，看 ${t.ticker} ${t.signal_date} 的结论卡片">
    <td class="tk"><button type="button">${esc(t.ticker)}</button></td><td>${t.signal_date}</td><td class="why">${esc(t.key)}</td>
    <td>${t.entry_date} · ${t.fill.toFixed(2)}</td><td>${t.exit_date} · ${t.exit_px.toFixed(2)}</td><td class="why">${esc(t.reason)}</td>
    <td class="${t.r >= 0 ? "up" : "down"}">${rr(t.r)}</td><td class="${t.equity_pct >= 0 ? "up" : "down"}">${pc(t.equity_pct, 2)}</td></tr>`).join("");
}

const counts = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("、") || "无";

function render(run, r) {
  viewing = run.id;
  paintRuns();
  const s = r.summary.plan;
  const bases = r.summary.baselines;
  const n = r.meta.tickers.length;
  const who = n <= 5 ? r.meta.tickers.join(" ") : `${n} 只`;
  const kind = { tickers: "", watchlist: "自选股 · ", core: "核心名单 · " }[r.plan.universe.kind];
  $("bt-empty").hidden = true;
  const box = $("bt-result");
  box.hidden = false;
  box.innerHTML = `
    <section class="bt-card"><div class="bt-title"><h3>${esc(r.plan.name)}</h3>
      <span class="sub">${kind}${esc(who)} · ${r.meta.start} ~ ${r.meta.end} · ${r.meta.days.toLocaleString()} 个决定点 · 起始资金 ${r.plan.execution.account.toLocaleString()}</span></div>
      <div class="bt-flags">${flags(run, r)}</div></section>
    <section class="bt-card"><h3>汇总</h3>
      <table class="bt-table bt-summary"><thead><tr><th></th><th>完整计划</th>${Object.keys(bases).map((b) => `<th>${esc(b)}</th>`).join("")}</tr></thead>
      <tbody>${summaryRows(s, bases)}</tbody></table>
      <p class="bt-note">R 的分母是这笔的初始风险：止损离进场只有几分钱时 R 会被放大到几十，平均 R 由少数几笔决定，「每笔盈亏占净值」更稳。
        对照（同一批票、同一段时间）每只票分一样多的钱，在场就满仓，没有止损，所以没有 R。<br>
        离场：${esc(counts(s.reasons))}。没成交的单：${esc(counts(s.skipped))}。</p></section>
    <section class="bt-card"><h3>净值（起点 = 1，对数刻度）</h3><div class="bt-legend" id="bt-legend"></div><div class="bt-curve" id="bt-curve"></div></section>
    <section class="bt-card"><h3>逐笔（${r.trades.length} 笔）</h3>
      <p class="bt-note">点一笔：回到工作台，回放到信号日那天（这笔的单就是照那天收盘后的结论卡片下的）。</p>
      <div class="bt-trades-wrap"><table class="bt-table bt-trades"><thead><tr><th>票</th><th>信号日</th><th>打法</th><th>进场 日 · 价</th><th>离场 日 · 价</th><th>原因</th><th>R</th><th>占净值</th></tr></thead>
      <tbody>${tradeRows(r.trades)}</tbody></table></div></section>`;
  box.querySelector(".bt-trades tbody").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-trade]");
    if (!tr) return;
    const t = r.trades[Number(tr.dataset.trade)];
    closePage();
    onTrade(t.ticker, t.signal_date);
  });
  drawCurve(r);
}

function drawCurve(r) {
  curve?.remove();
  curve = null;
  if (typeof LightweightCharts === "undefined") return;
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  curve = LightweightCharts.createChart($("bt-curve"), {
    autoSize: true, layout: { background: { color: "transparent" }, textColor: v("--muted"), fontSize: 11, attributionLogo: false },
    grid: { vertLines: { color: v("--grid") }, horzLines: { color: v("--grid") } },
    rightPriceScale: { borderColor: v("--line"), mode: LightweightCharts.PriceScaleMode.Logarithmic }, timeScale: { borderColor: v("--line") }, handleScroll: false, handleScale: false,
  });
  const series = [["完整计划", r.equity.plan, v("--accent"), 2], ...Object.keys(r.summary.baselines).map((n, i) => [n, r.equity[n], i ? v("--ma200") : v("--faint"), 1])];
  for (const [, values, color, width] of series) {
    curve.addLineSeries({ color, lineWidth: width, priceLineVisible: false, lastValueVisible: false })
      .setData(r.equity.dates.map((time, i) => ({ time, value: values[i] })));
  }
  curve.timeScale().fitContent();
  $("bt-legend").innerHTML = series.map(([name, values, color]) => `<span><i style="background:${color}"></i>${esc(name)} ${values.at(-1).toFixed(2)}</span>`).join("");
}

async function show(id, view) {
  const v = view ?? await api(`/api/backtest/runs/${id}`);
  if (v.run.state === "running" || v.run.state === "queued") return follow(id);
  if (!v.result) {
    viewing = id;
    paintRuns();
    msg(v.run.state === "failed" ? `这次回测失败：${v.run.error}` : "这次回测取消了，没有结果。", v.run.state === "failed");
    return;
  }
  render(v.run, v.result);
}

// ---------- 启动 ----------

/** opts.api(path, init)；opts.onTrade(ticker, date)：点了一笔交易；opts.beforeOpen()：打开前关掉别的整页（练习）。 */
export function initBacktest(opts) {
  api = (path, init) => opts.api(path, init && { headers: { "content-type": "application/json" }, ...init });
  onTrade = opts.onTrade;
  beforeOpen = opts.beforeOpen ?? beforeOpen;
  $("backtest-btn").setAttribute("aria-expanded", "false");
  $("backtest-btn").addEventListener("click", () => (isOpen() ? closePage() : openPage()));
  $("backtest-close").addEventListener("click", closePage);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen() && !document.querySelector("dialog[open]")) closePage();
  });
  $("bt-form").addEventListener("change", syncForm);
  $("bt-form").addEventListener("input", hideEstimate);
  $("bt-plan-select").addEventListener("change", (e) => {
    const p = plans.find((x) => x.name === e.target.value);
    if (!p) return;
    if (p.plan) { fillForm(p.plan); msg(""); } else msg(`${p.name}.toml 读不了：${p.error}`, true);
    paintPlans(p.name);
  });
  $("bt-new").addEventListener("click", () => {
    if (!template) return;
    fillForm({ ...template, name: freeName("新方案") });
    paintPlans("");
    msg("新方案：按完整计划报告的默认口径。改好了点「保存」或直接运行。");
  });
  $("bt-save").addEventListener("click", act(async () => {
    const p = await savePlan();
    msg(`已保存：data/backtests/${p.name}.toml`);
  }));
  $("bt-dup").addEventListener("click", act(async () => {
    const p = await api(`/api/backtest/plans/${encodeURIComponent($("bt-plan-select").value)}/duplicate`, { method: "POST" });
    await refreshPlans(p.name);
    fillForm(p);
    msg(`复制成「${p.name}」。`);
  }));
  $("bt-delete").addEventListener("click", act(async () => {
    const name = $("bt-plan-select").value;
    if (!name || !confirm(`删掉方案「${name}」（data/backtests/${name}.toml）？运行记录不受影响。`)) return;
    plans = await api(`/api/backtest/plans/${encodeURIComponent(name)}`, { method: "DELETE" });
    const first = plans.find((p) => p.plan);
    fillForm(first ? first.plan : template);
    paintPlans(first?.name ?? "");
    msg(`已删除「${name}」。`);
  }));
  $("bt-export").addEventListener("click", act(async () => {
    const p = await savePlan();
    const a = document.createElement("a");
    a.href = `/api/backtest/plans/${encodeURIComponent(p.name)}/export`;
    a.download = `${p.name}.toml`;
    a.click();
    msg(`已保存并导出 ${p.name}.toml。`);
  }));
  $("bt-import").addEventListener("click", () => $("bt-import-file").click());
  $("bt-import-file").addEventListener("change", act(async (e) => {
    const text = await readFile(e.target);
    if (text == null) return;
    const p = await api("/api/backtest/plans/import", { method: "POST", body: JSON.stringify({ text }) });
    await refreshPlans(p.name);
    fillForm(p);
    msg(`已导入「${p.name}」。`);
  }));
  $("bt-import-result").addEventListener("click", () => $("bt-import-result-file").click());
  $("bt-import-result-file").addEventListener("change", act(async (e) => {
    const text = await readFile(e.target);
    if (text == null) return;
    let body;
    try { body = JSON.parse(text); } catch { throw new Error("这不是 JSON 文件"); }
    const run = await api("/api/backtest/runs/import", { method: "POST", body: JSON.stringify(body) });
    runs = await api("/api/backtest/runs");
    await show(run.id);
    msg(`已导入「${run.plan}」的结果。`);
  }));
  $("bt-runs").addEventListener("click", act(async (e) => {
    const b = e.target.closest("[data-run]");
    if (b) await show(b.dataset.run);
  }));
  $("bt-run").addEventListener("click", act(estimate));
  $("bt-cancel").addEventListener("click", act(async () => {
    if (following) await api(`/api/backtest/runs/${following}/cancel`, { method: "POST" });
  }));
}

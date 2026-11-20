// 盲测练习：左栏「练习」出题、列出每一题和统计；中栏顶部的练习条记计划、往后放、揭晓。
// 服务端只发到"现在"那根；这里只负责显示和发操作，成交、揭晓都由服务端算。
import { appendDelta, DEFAULT_SPEED, SPEEDS, speedMs } from "./replay.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const f2 = (x) => Number(x).toFixed(2);
const pct = (x, d = 1) => `${x >= 0 ? "+" : ""}${Number(x).toFixed(d)}%`;
export const tLabel = (k) => (k === 0 ? "T0" : k > 0 ? `T+${k}` : `T${k}`);
const MODE_TEXT = { trigger: "等触发", now: "下一根开盘买", none: "只记判断，不下单" };

let deps;
/** 当前这一题：{ view, chart }，chart 是图上画着的（只到现在那根）。不在练习里为 null。 */
let cur = null;
let timer = null;
let speed = DEFAULT_SPEED;
let busy = false;

export const active = () => cur;

async function post(path, body) {
  return deps.api(path, { method: "POST", body: JSON.stringify(body) });
}

// ---------- 左栏：出题、列表、统计 ----------

function statsHtml(st) {
  const v = st.vsHold;
  const c = st.trades.closed;
  const row = (name, g) => !g.n ? `<tr><th>${name}</th><td class="num">0</td><td colspan="3" class="muted">—</td></tr>`
    : `<tr><th>${name}</th><td class="num">${g.n}</td><td class="num">${Math.round(g.winRate * 100)}%</td>
      <td class="num ${g.mean >= 0 ? "bullish" : "bearish"}">${pct(g.mean)}</td><td class="num">${pct(g.median)}</td></tr>`;
  const hold = v.n ? `跑赢同期买入持有 <b class="num">${v.beat}/${v.n}</b> 题，平均${v.meanExcess >= 0 ? "多" : "少"} <b class="num">${Math.abs(v.meanExcess).toFixed(1)}</b> 个百分点` : "还没有揭晓的题";
  return `<div class="j-counts"><span>题 <b class="num">${st.sessions.total}</b></span><span>已揭晓 <b class="num">${st.sessions.revealed}</b></span><span>没做完 <b class="num">${st.sessions.open}</b></span></div>
    <p class="pr-hold">${hold}</p>
    ${v.n && v.small ? `<p class="j-small">揭晓不到 10 题：数字只当参考。</p>` : ""}
    <table class="j-stats"><thead><tr><th>练习的单</th><th>笔</th><th>胜率</th><th>均值</th><th>中位</th></tr></thead>
      <tbody>${row("照计划", c.followed)}${row("没照", c.deviated)}${row("纪律高", st.discipline.high)}${row("纪律低", st.discipline.low)}${row("全部", c.all)}</tbody></table>
    ${st.discipline.score ? `<p class="pr-disc-sum">照打法：✓ <b class="num">${st.discipline.score.passed}/${st.discipline.score.scored}</b> 项（纪律高 = 这笔没有 ✗）</p>` : ""}
    ${c.all.n && c.all.small ? `<p class="j-small">已离场 ${c.all.n} 笔，少于 10 笔：只当参考。</p>` : ""}
    ${c.unreviewed ? `<p class="j-small">${c.unreviewed} 笔还没复盘（在交易日志里点开填）。</p>` : ""}`;
}

function cardHtml(s) {
  const r = s.reveal;
  const line = r ? `${esc(r.ticker)} · ${esc(r.start)} 起 · 我 <b class="num ${r.result.mine >= 0 ? "bullish" : "bearish"}">${pct(r.result.mine)}</b> / 持有 <span class="num">${pct(r.result.hold)}</span>${
      r.score ? ` · 纪律 <b class="num">${r.score.passed}/${r.score.scored}</b>` : ""}`
    : s.t === null ? "出题中" : `走到 ${tLabel(s.t)}`;
  return `<li class="j-item pr-item" data-id="${esc(s.id)}" tabindex="0"><span class="sym">${esc(s.label)}</span>
    <span class="j-state ${s.phase === "revealed" ? "closed" : "open"}">${esc(s.phaseLabel)}</span><span class="j-line">${line}</span></li>`;
}

export async function refreshList() {
  try {
    const o = await deps.api("/api/practice");
    $("practice-stats").innerHTML = statsHtml(o.stats);
    $("practice-list").innerHTML = o.sessions.length ? o.sessions.map(cardHtml).join("")
      : `<li class="j-empty">点「出一道题」：随机一只票、随机一天，藏起代码和日期，你来判断。</li>`;
  } catch (err) {
    $("practice-stats").innerHTML = `<p class="j-error" role="alert">${esc(err.message)}</p>`;
  }
}

async function start() {
  const btn = $("practice-new");
  btn.disabled = true;
  const note = $("practice-note");
  note.hidden = false;
  note.textContent = "出题中……第一次取这只票的行情要十几秒。";
  try {
    const view = await post("/api/practice", { id: crypto.randomUUID() });
    note.hidden = true;
    await enter(view);
    refreshList();
  } catch (err) {
    note.textContent = `出题失败：${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

export async function open(id) {
  const view = await deps.api(`/api/practice/${encodeURIComponent(id)}`);
  await enter(view);
}

// ---------- 进入 / 离开练习 ----------

/** 时间键 → T+n：T0 那根之前的是负数。图上的 K 线是连续的交易日，按位置数。 */
function labelFn(chart, t0) {
  const at = new Map(chart.candles.map((c, i) => [c.time, i]));
  const zero = at.get(t0);
  return (time) => (at.has(time) ? tLabel(at.get(time) - zero) : null);
}

async function enter(view) {
  stop();
  cur = { view, chart: view.chart };
  document.body.classList.add("practicing");
  document.body.classList.toggle("practice-revealed", view.phase === "revealed");
  deps.chart()?.setPractice(true);
  $("practice").hidden = false;
  if (view.phase === "revealed") return showReveal();
  render();
  // 中栏的分析：现在那根（算过的有缓存）
  await deps.loadAnalysis(view.label, tLabel(view.t));
}

/** 离开练习（换了别的票）：练习留着，左栏点开接着做。 */
export function leave() {
  if (!cur) return;
  stop();
  cur = null;
  document.body.classList.remove("practicing", "practice-revealed");
  $("practice").hidden = true;
  const chart = deps.chart();
  chart?.setTimeLabel(null);
  chart?.setPractice(false);
}

/** 中栏画分析时用的图表：练习里是"到现在那根"的，不是分析那天的。 */
export function chartFor(label) {
  if (!cur || label !== cur.view.label) return null;
  return cur.chart;
}

/** 图上的价位线：有单的时候画自己的触发价、止损，没有就用结论里的。 */
export function levelsFor(label) {
  if (!cur || label !== cur.view.label || !cur.view.active) return null;
  const o = cur.view.active.order;
  const out = [];
  if (o.trigger && cur.view.active.state === "planned") out.push({ kind: "trigger", price: o.trigger.price, title: "我的触发价" });
  if (cur.view.active.entry) out.push({ kind: "invalid", price: cur.view.active.entry.price, title: "我的进场价" });
  if (o.stop) out.push({ kind: "stop", price: o.stop, title: "我的止损" });
  return out;
}

/** showAnalysis 画完之后：时间写成 T+n，标题旁写清楚这是练习。 */
export function afterAnalysis(a) {
  if (!cur || a.label !== cur.view.label) return;
  deps.chart()?.setTimeLabel(labelFn(cur.chart, cur.view.t0));
  $("meta-line").textContent = `盲测练习 · 中栏分析在 ${a.date}`;
  render();
}

// ---------- 练习条 ----------

function orderText(o, close) {
  const parts = [];
  if (o.mode === "trigger") parts.push(`收盘${o.trigger.side === "above" ? "站上" : "跌到"} <b class="num">${f2(o.trigger.price)}</b>，下一根开盘买`);
  else parts.push(MODE_TEXT[o.mode]);
  parts.push(o.stop ? `收盘跌破 <b class="num">${f2(o.stop)}</b> 止损（${pct((o.stop / close - 1) * 100)}）` : "没设止损");
  return parts.join("；");
}

function activeHtml(v) {
  const a = v.active;
  if (!a) return `<span class="muted">手上没有单。看好了就「记下计划」；也可以先往后看。</span>`;
  const head = a.state === "open"
    ? `已进场 ${esc(a.entry.t)} @ <b class="num">${f2(a.entry.price)}</b> · 浮动 <b class="num ${a.pnl >= 0 ? "bullish" : "bearish"}">${pct(a.pnl, 2)}</b>`
    : "计划中";
  return `<span>${head}</span><span class="muted">${orderText(a.order, v.close)}</span>${a.pending ? `<b class="pr-pending">${esc(a.pending)}</b>` : ""}`;
}

function render() {
  if (!cur) return;
  const v = cur.view;
  const analyzedAt = deps.analysisDate();
  const stale = analyzedAt && analyzedAt !== tLabel(v.t);
  $("practice").innerHTML = `
    <div class="pr-head"><b>${esc(v.label)}</b><span class="pr-phase">${esc(v.phaseLabel)}</span>
      <span class="num">${tLabel(v.t)} / ${tLabel(v.last)}</span><span class="muted">指数收盘 <b class="num">${f2(v.close)}</b></span>
      ${analyzedAt ? `<span class="muted${stale ? " pr-stale" : ""}">下方分析在 ${analyzedAt}</span>` : ""}
      <span class="pr-msg" id="practice-msg" role="status" aria-live="polite"></span></div>
    <div class="pr-order">${activeHtml(v)}</div>
    <div class="pr-tools">
      <button type="button" data-act="plan" ${v.phase !== "deciding" ? "disabled" : ""}>记下计划</button>
      <button type="button" data-act="step" title="往后一根（Shift+→）">下一根</button>
      <button type="button" data-act="play" aria-pressed="${Boolean(timer)}" title="自动往后放（Shift+↓）；有成交会停下">${timer ? "⏸ 暂停" : "▶ 自动"}</button>
      <select data-act="speed" title="自动放的速度：1x = 一秒一根">${SPEEDS.map((x) => `<option value="${x}" ${x === speed ? "selected" : ""}>${x}x</option>`).join("")}</select>
      ${v.active?.state === "planned" ? `<button type="button" data-act="enter">现在买（下一根开盘）</button><button type="button" data-act="cancel">放弃计划</button>` : ""}
      ${v.active?.state === "open" ? `<button type="button" data-act="exit">离场（下一根开盘）</button>` : ""}
      ${stale ? `<button type="button" data-act="analyze" title="中栏的分析停在 ${analyzedAt}">按现在分析</button>` : ""}
      <button type="button" data-act="reveal" class="pr-reveal">揭晓</button>
    </div>`;
  deps.setLevels(levelsFor(v.label));
}

function say(text) {
  const el = $("practice-msg");
  if (el) el.textContent = text;
}

/** 这一步有没有成交：比较前后日志，说一句。 */
function fills(before, after) {
  const was = new Map(before.map((e) => [e.id, e]));
  const out = [];
  for (const e of after) {
    const b = was.get(e.id);
    if (e.entry && !b?.entry) out.push(`${e.entry.date} 开盘买入 @ ${f2(e.entry.price)}`);
    if (e.exit && !b?.exit) out.push(`${e.exit.date} 卖出 @ ${f2(e.exit.price)}（${e.exit.reason}）`);
  }
  return out;
}

async function act(body) {
  if (!cur || busy) return null;
  busy = true;
  try {
    const before = cur.view.trades;
    const view = await post(`/api/practice/${encodeURIComponent(cur.view.id)}`, body);
    if (!cur || view.id !== cur.view.id) return null;
    if (view.delta && view.t === cur.view.t + 1) {
      cur.chart = appendDelta(cur.chart, view.delta);
      deps.chart()?.setTimeLabel(labelFn(cur.chart, view.t0));
      deps.chart()?.extend(view.delta);
    }
    const phaseChanged = view.phase !== cur.view.phase;
    cur.view = view;
    const happened = fills(before, view.trades);
    if (view.phase === "revealed") { stop(); showReveal(); }
    else render();
    if (happened.length) { stop(); if (view.phase !== "revealed") render(); say(happened.join("；")); deps.refreshJournal(); }
    if (happened.length || phaseChanged) refreshList();
    return view;
  } catch (err) {
    stop();
    render();
    say(err.message);
    return null;
  } finally {
    busy = false;
  }
}

const step = (type = "step") => act({ type, from: cur.view.t });

function stop() {
  clearTimeout(timer);
  timer = null;
}
function play() {
  if (!cur || cur.view.phase === "revealed") return;
  const tick = async () => {
    const v = await step();
    if (timer && v && v.phase !== "revealed") timer = setTimeout(tick, speedMs(speed));
  };
  timer = setTimeout(tick, 0);
  render();
}

// ---------- 记计划 ----------

export async function planDialog() {
  const v = cur.view;
  const at = tLabel(v.t);
  if (deps.analysisDate() !== at) {
    say(`先按 ${at} 分析……`);
    await deps.loadAnalysis(v.label, at);
    if (!cur || deps.analysisDate() !== at) return;
    say("");
  }
  const { report } = deps.data();
  const plan = report.plans.flat;
  const mode = plan.trigger && plan.stop ? "trigger" : plan.stop ? "now" : "none";
  const d = $("journal-dialog");
  const radio = (k) => `<label><input type="radio" name="mode" value="${k}" ${k === mode ? "checked" : ""}> ${MODE_TEXT[k]}</label>`;
  d.innerHTML = `<form method="dialog" class="j-dialog" id="practice-plan">
      <header><h2>记下计划：${esc(v.label)} ${at}</h2><button type="button" class="j-close" aria-label="关闭">×</button></header>
      <p class="j-note">此刻指数收盘 <b class="num">${f2(v.close)}</b>。系统按「${esc(report.playKey)}」给的空仓做法：<b>${esc(plan.action)}</b>
        ${plan.trigger ? `（${esc(plan.trigger.label)} ${f2(plan.trigger.price)}）` : ""}${plan.stop ? `；止损 ${esc(plan.stop.label)} ${f2(plan.stop.price)}` : ""}。下面填你自己的单，记入后不能改。</p>
      <fieldset class="j-yn"><legend>进场</legend>${["trigger", "now", "none"].map(radio).join("")}</fieldset>
      <div class="j-fields">
        <label class="j-field"><span>触发价（收盘碰到，下一根开盘买）</span><input name="trigger" inputmode="decimal" value="${plan.trigger ? f2(plan.trigger.price) : ""}"></label>
        <label class="j-field"><span>止损（收盘跌破，下一根开盘卖；留空不设）</span><input name="stop" inputmode="decimal" value="${plan.stop ? f2(plan.stop.price) : ""}"></label>
      </div>
      <label class="j-field"><span>打算用多大仓位</span><input name="size" maxlength="200" placeholder="例如 1/3 仓"></label>
      <label class="j-field"><span>自己的理由</span><textarea name="reason" rows="3" maxlength="2000" placeholder="看到了什么、为什么这样做"></textarea></label>
      <p class="j-error" role="alert" hidden></p>
      <footer><button type="button" class="ghost j-close">取消</button><button type="submit" id="practice-save">记入</button></footer>
    </form>`;
  if (!d.open) d.showModal();
  const form = $("practice-plan");
  // 触发价只在"等触发"时用
  const syncMode = () => { form.trigger.disabled = form.mode.value !== "trigger"; };
  form.querySelectorAll("input[name=mode]").forEach((r) => r.addEventListener("change", syncMode));
  syncMode();
  const num =(s) => (String(s).trim() === "" ? null : Number(String(s).replace(/,/g, "")));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const body = { type: "plan", id: crypto.randomUUID(), mode: f.mode, trigger: f.mode === "trigger" ? num(f.trigger) : null, stop: num(f.stop), size: f.size, reason: f.reason };
    const err = form.querySelector(".j-error");
    try {
      const view = await post(`/api/practice/${encodeURIComponent(v.id)}`, body);
      cur.view = view;
      d.close();
      render();
      say("计划记下了，往后放吧。");
      deps.refreshJournal();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
}

// ---------- 揭晓 ----------

function showReveal() {
  const v = cur.view;
  const r = v.reveal;
  const res = r.result;
  const diff = res.mine - res.hold;
  document.body.classList.add("practice-revealed");
  const chart = deps.chart();
  chart?.setTimeLabel(null);
  chart?.setData(r.chart, `reveal:${v.id}`);
  chart?.setLevels([]);
  $("ticker").textContent = `${v.label} · ${r.ticker}`;
  $("meta-line").textContent = `开局 ${r.start} · 揭晓在 ${r.at}`;
  // 日志里记的是指数，这里换回真实价格，和图对得上
  const px = (x) => f2(x * r.priceFactor);
  const trades = v.trades.filter((e) => e.state === "closed").map((e) =>
    `<li>${esc(e.entry.date)} 买 @ ${px(e.entry.price)} → ${esc(e.exit.date)} 卖 @ ${px(e.exit.price)}（${esc(e.exit.reason.replace(/\d+\.\d+/g, (n) => px(Number(n))))}）</li>`).join("");
  $("practice").innerHTML = `
    <div class="pr-head"><b>${esc(v.label)} 揭晓：${esc(r.ticker)}</b><span class="pr-phase">揭晓</span>
      <span>开局 <b class="num">${esc(r.start)}</b>，揭晓在 <b class="num">${esc(r.at)}</b>（${tLabel(v.t)}），图上一直画到 ${esc(r.end)}</span></div>
    <div class="pr-result">
      <span>我这一题 <b class="num ${res.mine >= 0 ? "bullish" : "bearish"}">${pct(res.mine, 2)}</b>（${res.trades} 笔）</span>
      <span>同期买入持有 <b class="num ${res.hold >= 0 ? "bullish" : "bearish"}">${pct(res.hold, 2)}</b>（T+1 开盘买，${tLabel(v.t)} 收盘卖）</span>
      <span>${diff >= 0 ? "跑赢" : "跑输"} <b class="num">${Math.abs(diff).toFixed(2)}</b> 个百分点</span>
    </div>
    ${trades ? `<ul class="pr-trades">${trades}</ul>` : `<p class="muted">这一题没有成交。</p>`}
    ${disciplineHtml(res.discipline, r.score, v.trades, px)}
    <p class="muted">图上的价格已经换回真实价格；练习时看到的是指数（第一根收盘 = 100）。照没照计划、教训，在左栏「交易日志」点开这一笔填。</p>
    <div class="pr-tools"><button type="button" data-act="new">再出一道题</button><button type="button" data-act="journal">去复盘</button></div>`;
  $("center-scroll").scrollTop = 0;
  deps.refreshJournal();
  refreshList();
}

const MARK = { pass: ["✓", "满足"], fail: ["✗", "没做到"], na: ["—", "不评"] };

/** 揭晓后的「照打法」：每一笔四项 ✓ / ✗ / —，哪一根、为什么。价位换回真实价格。 */
function disciplineHtml(list, score, trades, px) {
  if (!list) return "";
  if (!list.length) return `<div class="pr-disc"><p class="muted">照打法：这一题没记计划，不评纪律。</p></div>`;
  const body = list.map((d, i) => {
    const e = trades.find((x) => x.id === d.journalId);
    const head = `第 ${i + 1} 笔${e ? `（${esc(MODE_TEXT[e.practice.order.mode])}）` : ""}`;
    const items = d.checks.map((c) => `<li class="${c.mark}"><span class="mark" aria-label="${MARK[c.mark][1]}">${MARK[c.mark][0]}</span>
      <b>${esc(c.item)}</b><span class="num">${c.t === null ? "" : tLabel(c.t)}</span><span>${esc(c.why.replace(/\d+\.\d{2}/g, (n) => px(Number(n))))}</span></li>`).join("");
    return `<p class="pr-disc-head">${head}</p><ul class="pr-disc-list">${items}</ul>`;
  }).join("");
  return `<div class="pr-disc"><h4>照打法${score ? ` <b class="num">纪律 ${score.passed}/${score.scored}</b>` : "：没有可评的项"}</h4>${body}
    <p class="muted">只看照没照打法，不看盈亏。打法、条件看进场前一根收盘；止损用计划的进场后止损（没有就用自己的），收盘跌破后下一根开盘该走。仓位练习按整笔成交，不评。</p></div>`;
}

// ---------- 启动 ----------

export function initPractice(opts) {
  deps = opts;
  try { speed = SPEEDS.find((x) => String(x) === localStorage.getItem("dma-practice-speed")) ?? DEFAULT_SPEED; } catch { /* 隐私模式 */ }
  $("practice-new").addEventListener("click", start);
  const openItem = (ev) => {
    const li = ev.target.closest(".pr-item");
    if (li && (ev.type === "click" || ev.key === "Enter")) open(li.dataset.id).catch((err) => { $("practice-note").hidden = false; $("practice-note").textContent = err.message; });
  };
  $("practice-list").addEventListener("click", openItem);
  $("practice-list").addEventListener("keydown", openItem);
  $("practice").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b || !cur) return;
    switch (b.dataset.act) {
      case "plan": return planDialog();
      case "step": stop(); return step();
      case "play": return timer ? (stop(), render()) : play();
      case "enter": case "exit": stop(); return step(b.dataset.act);
      case "cancel": return act({ type: "cancel" }).then(() => deps.refreshJournal());
      case "reveal":
        // 点两下才揭晓：揭晓后这一题就结束了
        if (b.dataset.armed !== "1") {
          b.dataset.armed = "1";
          b.textContent = "再点一次揭晓（没成交的计划放弃，持仓按这根收盘平掉）";
          return;
        }
        return act({ type: "reveal" });
      case "analyze": return deps.loadAnalysis(cur.view.label, tLabel(cur.view.t));
      case "new": return start();
      case "journal": return deps.showJournal();
    }
  });
  $("practice").addEventListener("change", (e) => {
    if (e.target.dataset.act !== "speed") return;
    speed = Number(e.target.value);
    try { localStorage.setItem("dma-practice-speed", String(speed)); } catch { /* 忽略 */ }
  });
  document.addEventListener("keydown", (e) => {
    if (!cur || cur.view.phase === "revealed" || e.target.closest?.("input, textarea, select, [contenteditable], dialog")) return;
    if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowRight") { e.preventDefault(); stop(); step(); }
    if (e.key === "ArrowDown") { e.preventDefault(); timer ? (stop(), render()) : play(); }
  });
  return refreshList();
}

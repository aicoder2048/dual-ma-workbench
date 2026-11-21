// 识别题：一张图、一两问，点选项就交卷，当场给答案、依据和规则编号。
// 五步点图题在图上依次点 K 线，点完交卷；推演揭晓题交卷后放出 T0 之后的真实走势对照。
// 题、答案、依据都在服务端（题库），这里只显示和交卷。键盘：1–9 选，Enter 或空格下一题；点图题 Backspace 撤销、Enter 交卷。
import { createDrillChart } from "./drillchart.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const KINDS = [["", "按弱项"], ["chart", "看图"], ["signal", "看信号"], ["dropoff", "看抵扣价"], ["construct", "看构造和 2B"], ["play", "看打法"],
  ["project", "推演揭晓"], ["steps", "五步点图"]];
const KIND_TITLE = {
  "": "错得多的题型出得多：按每种最近 20 题的错误率挑",
  project: "停在 T0 按收平推演，交卷后放出之后的真实走势对照",
  steps: "在图上依次点出一轮转折的破线、拐头、交叉",
};
const POLL_MS = 3000;

let api;
let chart = null;
let kind = "";
/** 现在这一题：{ drill, picks, clicks: [{ time, label }], shownAt, feedback }。 */
let cur = null;
/** 交卷中（别重复交）。 */
let busy = false;
/** 取题的序号：连着换题型时只认最后一次。 */
let seq = 0;
let poll = null;
let tick = null;

function shell() {
  $("pp-drill").innerHTML = `<div class="dr-layout">
      <section class="dr-stage">
        <div class="dr-kinds" role="radiogroup" aria-label="题型">${KINDS.map(([k, name]) =>
          `<button type="button" role="radio" data-kind="${k}" aria-checked="${k === kind}"${KIND_TITLE[k] ? ` title="${KIND_TITLE[k]}"` : ""}>${name}<small data-kind-stat="${k}"></small></button>`).join("")}</div>
        <p class="dr-stats" id="dr-stats" aria-live="polite"></p>
        <p class="dr-readout num" id="dr-readout"></p>
        <div id="dr-chart" class="dr-chart"></div>
      </section>
      <section class="dr-panel" aria-live="polite">
        <div id="dr-question"></div>
        <div id="dr-feedback" class="dr-feedback" hidden></div>
      </section>
    </div>`;
  chart = createDrillChart($("dr-chart"), $("dr-readout"));
}

function setKind(k) {
  kind = k;
  try { localStorage.setItem("dma-drill-kind", k); } catch { /* 隐私模式 */ }
  document.querySelectorAll(".dr-kinds [data-kind]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.kind === k)));
  next();
}

// ---------- 统计：每种题的正确率和答题时间、连对、错得最多的 ----------

const pc = (x) => `${Math.round(x * 100)}%`;
const sec = (ms) => `${(ms / 1000).toFixed(1)} 秒`;
const LABEL = Object.fromEntries(KINDS);

function renderStats(st) {
  for (const k of st.kinds) {
    const el = document.querySelector(`[data-kind-stat="${k.kind}"]`);
    if (el) el.textContent = k.n ? ` ${pc(k.accuracy)} · ${sec(k.medianMs)}` : "";
  }
  const el = $("dr-stats");
  if (!st.total.n) { el.textContent = "还没答过。几秒一题，答多了这里显示每种题的正确率、答题时间中位数和弱项。"; return; }
  const weak = st.weakest.length ? ` · 弱项：${st.weakest.map((k) => LABEL[k]).join("、")}` : "";
  const missed = st.missed[0] ? ` · 错得最多：${LABEL[st.missed[0].kind]}「${esc(st.missed[0].cls.replace(/^[^:]+:/, ""))}」${st.missed[0].misses}/${st.missed[0].n}` : "";
  el.innerHTML = `共 <b class="num">${st.total.n}</b> 题，答对 <b class="num">${pc(st.total.accuracy)}</b> · 连对 <b class="num">${st.streak.current}</b>（最长 ${st.streak.best}）${weak}${missed}`;
}

async function refreshStats() {
  try { renderStats((await api("/api/drills")).stats); } catch { /* 下次答题再刷新 */ }
}

// ---------- 出题 ----------

export async function next() {
  clearTimeout(poll);
  const my = ++seq;
  try {
    const r = await api(`/api/drills/next${kind ? `?kind=${kind}` : ""}`);
    if (my !== seq) return;
    if (!r.drill) return waiting(r);
    cur = { drill: r.drill, picks: r.drill.parts.map(() => null), clicks: [], shownAt: performance.now(), feedback: null };
    chart?.show(r.drill);
    chart?.onPick(r.drill.click ? addClick : null);
    renderQuestion();
  } catch (err) {
    if (my === seq) $("dr-question").innerHTML = `<p class="j-error" role="alert">${esc(err.message)}</p>`;
  }
}

function waiting(r) {
  cur = null;
  $("dr-feedback").hidden = true;
  $("dr-question").innerHTML = r.error && !r.building
    ? `<p class="j-error" role="alert">${esc(r.error)}</p><button type="button" class="dr-next" data-act="retry">再试一次</button>`
    : `<p class="dr-wait">题库准备中……抽几段历史行情、逐根跑 skill 的分析，第一次要半分钟到一分钟。</p>`;
  if (r.building || !r.error) poll = setTimeout(next, POLL_MS);
}

function renderQuestion() {
  const d = cur.drill;
  $("dr-feedback").hidden = true;
  $("dr-feedback").innerHTML = "";
  $("dr-question").classList.remove("answered");
  $("dr-question").dataset.drill = d.id;
  $("dr-question").innerHTML = `
    <p class="dr-head"><span class="dr-kind">${esc(d.label)}</span><span class="dr-timer num" id="dr-timer">0.0 秒</span></p>
    ${d.context ? `<p class="dr-context">${esc(d.context)}</p>` : ""}
    ${d.click ? clickPanel(d.click) : `${d.parts.map((p, i) => `<div class="dr-part" data-part="${i}">
      <p class="dr-prompt">${d.parts.length > 1 ? `<b>${i + 1}.</b> ` : ""}${esc(p.prompt)}</p>
      <div class="dr-choices">${p.choices.map((c, j) => `<button type="button" class="dr-choice" data-part="${i}" data-choice="${j}" aria-pressed="false"><kbd>${j + 1}</kbd>${esc(c)}</button>`).join("")}</div>
    </div>`).join("")}
    <p class="dr-keys">点选项就交卷${d.parts.length > 1 ? "（每问都选了才交）" : ""}；键盘 1–9 选。</p>`}`;
  clearInterval(tick);
  tick = setInterval(() => {
    const el = $("dr-timer");
    if (el && cur && !cur.feedback) el.textContent = `${((performance.now() - cur.shownAt) / 1000).toFixed(1)} 秒`;
  }, 100);
}

// ---------- 点图题：在图上依次点 K 线 ----------

function clickPanel(c) {
  return `<p class="dr-prompt">${esc(c.prompt)}</p>
    <ol class="dr-steps">${c.steps.map((s, i) => `<li data-step="${i}"><span>${esc(s)}</span><b class="num" data-step-at="${i}">—</b></li>`).join("")}</ol>
    <p class="dr-step-acts"><button type="button" class="dr-undo" data-act="undo" disabled>撤销上一步</button>
      <button type="button" class="dr-next" data-act="submit" disabled>交卷</button></p>
    <p class="dr-keys">在图上点 K 线，一下记一步，按上面的顺序；Backspace 撤销，点完按交卷或 Enter。</p>`;
}

function addClick(time, label) {
  if (!cur || cur.feedback || cur.clicks.length >= cur.drill.click.steps.length) return;
  cur.clicks.push({ time, label });
  renderClicks();
}

function undoClick() {
  if (!cur?.drill.click || cur.feedback || !cur.clicks.length) return;
  cur.clicks.pop();
  renderClicks();
}

function renderClicks() {
  const { steps } = cur.drill.click, n = cur.clicks.length;
  steps.forEach((_, i) => {
    const el = document.querySelector(`[data-step-at="${i}"]`);
    if (el) el.textContent = cur.clicks[i]?.label ?? "—";
    document.querySelector(`.dr-steps [data-step="${i}"]`)?.toggleAttribute("aria-current", i === n);
  });
  const undo = document.querySelector('[data-act="undo"]'), go = document.querySelector('[data-act="submit"]');
  if (undo) undo.disabled = n === 0;
  if (go) go.disabled = n < steps.length;
  chart?.setPins(cur.clicks.map((c, i) => ({ time: c.time, text: `${i + 1} ${steps[i]}`, kind: "pick" })));
}

// ---------- 交卷 ----------

async function choose(part, choice) {
  if (!cur || cur.feedback || busy) return;
  cur.picks[part] = choice;
  document.querySelectorAll(`.dr-choice[data-part="${part}"]`).forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.choice) === choice)));
  if (cur.picks.some((p) => p === null)) return;
  submit({ picks: cur.picks });
}

function submitClicks() {
  if (!cur?.drill.click || cur.feedback || cur.clicks.length < cur.drill.click.steps.length) return;
  submit({ clicks: cur.clicks.map((c) => c.time) });
}

async function submit(answer) {
  if (busy) return;
  busy = true;
  try {
    const ms = Math.round(performance.now() - cur.shownAt);
    cur.feedback = await api(`/api/drills/${encodeURIComponent(cur.drill.id)}/answer`, { method: "POST", body: JSON.stringify({ ...answer, ms }) });
    clearInterval(tick);
    renderFeedback();
    renderStats(cur.feedback.stats);
  } catch (err) {
    $("dr-feedback").hidden = false;
    $("dr-feedback").innerHTML = `<p class="j-error" role="alert">${esc(err.message)}</p><button type="button" class="dr-next" data-act="next">下一题</button>`;
  } finally {
    busy = false;
  }
}

function renderFeedback() {
  const f = cur.feedback;
  // 选项上标出对错：自己选的、对的那个
  f.parts.forEach((p, i) => document.querySelectorAll(`.dr-choice[data-part="${i}"]`).forEach((b) => {
    const j = Number(b.dataset.choice);
    b.disabled = true;
    b.classList.toggle("right", j === p.answer);
    b.classList.toggle("wrong", j === p.pick && j !== p.answer);
  }));
  const parts = !f.parts.length ? "" : f.parts.length > 1 ? `<ul class="dr-answers">${f.parts.map((p, i) =>
    `<li class="${p.pick === p.answer ? "ok" : "no"}"><b>${i + 1}.</b> ${p.pick === p.answer ? "✓" : "✗"} 答案：${esc(p.choices[p.answer])}${p.pick === p.answer ? "" : `（你选 ${esc(p.choices[p.pick])}）`}</li>`).join("")}</ul>`
    : f.correct ? "" : `<p class="dr-answer">答案：<b>${esc(f.parts[0].choices[f.parts[0].answer])}</b></p>`;
  // 两问以上的题、点图题答完收起作答区（下面逐问 / 逐步写了答案），依据留在默认视图里
  $("dr-question").classList.toggle("answered", f.parts.length > 1 || Boolean(f.steps));
  if (f.steps) {
    chart?.onPick(null);
    chart?.setPins([...f.steps.map((s) => ({ time: s.answer, text: s.step, kind: "answer" })),
      ...f.steps.map((s, i) => ({ time: s.pick, text: `${i + 1}${s.ok ? "✓" : "✗"}`, kind: s.ok ? "right" : "wrong" }))]);
  }
  if (f.reveal) chart?.reveal(f.reveal);
  const box = $("dr-feedback");
  box.hidden = false;
  box.innerHTML = `
    <p class="dr-verdict ${f.correct ? "ok" : "no"}">${f.correct ? "✓ 答对了" : "✗ 答错了"}<span class="num">${(f.ms / 1000).toFixed(1)} 秒</span>
      <button type="button" class="dr-next" data-act="next" title="Enter / 空格">下一题 ↵</button></p>
    ${parts}
    ${f.steps ? stepsResult(f.steps) : ""}
    ${f.reveal ? revealResult(f.reveal) : ""}
    <p class="dr-rules">${f.rules.map((r) => `<span class="dr-rule"><b>${esc(r.id)}</b>${esc(r.name)}</span>`).join("")}</p>
    ${f.hint ? `<p class="dr-hint">${esc(f.hint)}</p>` : ""}
    <ul class="dr-evidence">${f.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`;
}

/** 图表时间键 → T+n（相对题目那一根）。 */
function tOf(time) {
  const cs = cur.drill.chart.candles;
  const i = cs.findIndex((c) => c.time === time), zero = cs.findIndex((c) => c.time === cur.drill.t0);
  const k = i - zero;
  return i < 0 ? "?" : k === 0 ? "T0" : k > 0 ? `T+${k}` : `T${k}`;
}

/** 点图题：逐步写答案那根、你点的那根、这一步的定义和规则编号。 */
function stepsResult(steps) {
  return `<ol class="dr-stepres">${steps.map((s) => `<li class="${s.ok ? "ok" : "no"}">
      <p>${s.ok ? "✓" : "✗"} <b>${esc(s.step)}</b>：答案 ${tOf(s.answer)}${s.pick === s.answer ? "" : `（你点 ${tOf(s.pick)}）`}</p>
      <p class="dr-def"><span class="dr-rule"><b>${esc(s.rule)}</b></span>${esc(s.meaning)}</p></li>`).join("")}</ol>`;
}

/** 推演揭晓：逐问写推演（评分用）和真实走势，对不上写为什么。 */
function revealResult(r) {
  return `<div class="dr-reveal">
      <p class="dr-reveal-note">放出 T0 之后 ${r.horizon} 根真实走势（图上强调色），虚线是收平价位 ${Number(r.level).toFixed(2)}。评分按推演；真实走势只作对照，不算分。</p>
      <ol>${r.parts.map((p) => `<li class="${p.agree ? "agree" : "differ"}">
        <p>推演（评分）：${esc(p.system)}</p>
        <p>真实走势：${esc(p.real)}${p.agree ? "，和推演一致" : ""}</p>
        ${p.why ? `<p class="dr-why">${esc(p.why)}</p>` : ""}</li>`).join("")}</ol>
    </div>`;
}

// ---------- 启动 ----------

export function initDrills(opts) {
  api = opts.api;
  try { kind = KINDS.some(([k]) => k === localStorage.getItem("dma-drill-kind")) ? localStorage.getItem("dma-drill-kind") : ""; } catch { /* 隐私模式 */ }
  shell();
  $("pp-drill").addEventListener("click", (e) => {
    const k = e.target.closest(".dr-kinds [data-kind]");
    if (k) return setKind(k.dataset.kind);
    const c = e.target.closest(".dr-choice");
    if (c) return choose(Number(c.dataset.part), Number(c.dataset.choice));
    if (e.target.closest('[data-act="undo"]')) return undoClick();
    if (e.target.closest('[data-act="submit"]')) return submitClicks();
    if (e.target.closest('[data-act="next"], [data-act="retry"]')) return next();
  });
  document.addEventListener("keydown", (e) => {
    if ($("pp-drill").hidden || $("practice-page").hidden || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest?.("input, textarea, select, [contenteditable], dialog")) return;
    if (cur?.feedback && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); return next(); }
    if (cur?.drill.click && !cur.feedback) {
      if (e.key === "Backspace") { e.preventDefault(); undoClick(); }
      if (e.key === "Enter") { e.preventDefault(); submitClicks(); }
      return;
    }
    const n = Number(e.key);
    if (!cur || cur.feedback || !(n >= 1 && n <= 9)) return;
    const part = cur.picks.findIndex((p) => p === null);
    const at = part < 0 ? cur.picks.length - 1 : part;
    if (n <= cur.drill.parts[at].choices.length) { e.preventDefault(); choose(at, n - 1); }
  });
}

/** 练习页切到识别题：还没有题就取一题。 */
export function onShow() {
  refreshStats();
  if (!cur) next();
}

// 识别题：一张图、一两问，点选项就交卷，当场给答案、依据和规则编号。
// 题、答案、依据都在服务端（题库），这里只显示和交卷。键盘：1–9 选，Enter 或空格下一题。
import { createDrillChart } from "./drillchart.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const KINDS = [["", "按弱项"], ["chart", "看图"], ["signal", "看信号"], ["dropoff", "看抵扣价"], ["construct", "看构造和 2B"], ["play", "看打法"]];
const POLL_MS = 3000;

let api;
let chart = null;
let kind = "";
/** 现在这一题：{ drill, picks, shownAt, feedback }。 */
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
          `<button type="button" role="radio" data-kind="${k}" aria-checked="${k === kind}">${name}</button>`).join("")}</div>
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

// ---------- 出题 ----------

export async function next() {
  clearTimeout(poll);
  const my = ++seq;
  try {
    const r = await api(`/api/drills/next${kind ? `?kind=${kind}` : ""}`);
    if (my !== seq) return;
    if (!r.drill) return waiting(r);
    cur = { drill: r.drill, picks: r.drill.parts.map(() => null), shownAt: performance.now(), feedback: null };
    chart?.show(r.drill);
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
  $("dr-question").innerHTML = `
    <p class="dr-head"><span class="dr-kind">${esc(d.label)}</span><span class="dr-timer num" id="dr-timer">0.0 秒</span></p>
    ${d.context ? `<p class="dr-context">${esc(d.context)}</p>` : ""}
    ${d.parts.map((p, i) => `<div class="dr-part" data-part="${i}">
      <p class="dr-prompt">${d.parts.length > 1 ? `<b>${i + 1}.</b> ` : ""}${esc(p.prompt)}</p>
      <div class="dr-choices">${p.choices.map((c, j) => `<button type="button" class="dr-choice" data-part="${i}" data-choice="${j}" aria-pressed="false"><kbd>${j + 1}</kbd>${esc(c)}</button>`).join("")}</div>
    </div>`).join("")}
    <p class="dr-keys">点选项就交卷${d.parts.length > 1 ? "（两问都选了才交）" : ""}；键盘 1–9 选。</p>`;
  clearInterval(tick);
  tick = setInterval(() => {
    const el = $("dr-timer");
    if (el && cur && !cur.feedback) el.textContent = `${((performance.now() - cur.shownAt) / 1000).toFixed(1)} 秒`;
  }, 100);
}

// ---------- 交卷 ----------

async function choose(part, choice) {
  if (!cur || cur.feedback || busy) return;
  cur.picks[part] = choice;
  document.querySelectorAll(`.dr-choice[data-part="${part}"]`).forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.choice) === choice)));
  if (cur.picks.some((p) => p === null)) return;
  busy = true;
  try {
    const ms = Math.round(performance.now() - cur.shownAt);
    cur.feedback = await api(`/api/drills/${encodeURIComponent(cur.drill.id)}/answer`, { method: "POST", body: JSON.stringify({ picks: cur.picks, ms }) });
    clearInterval(tick);
    renderFeedback();
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
  const parts = f.parts.length > 1 ? `<ul class="dr-answers">${f.parts.map((p, i) =>
    `<li class="${p.pick === p.answer ? "ok" : "no"}"><b>${i + 1}.</b> ${p.pick === p.answer ? "✓" : "✗"} 答案：${esc(p.choices[p.answer])}${p.pick === p.answer ? "" : `（你选 ${esc(p.choices[p.pick])}）`}</li>`).join("")}</ul>`
    : f.correct ? "" : `<p class="dr-answer">答案：<b>${esc(f.parts[0].choices[f.parts[0].answer])}</b></p>`;
  // 两问的题答完收起选项（下面逐问写了答案），依据留在默认视图里
  $("dr-question").classList.toggle("answered", f.parts.length > 1);
  const box = $("dr-feedback");
  box.hidden = false;
  box.innerHTML = `
    <p class="dr-verdict ${f.correct ? "ok" : "no"}">${f.correct ? "✓ 答对了" : "✗ 答错了"}<span class="num">${(f.ms / 1000).toFixed(1)} 秒</span>
      <button type="button" class="dr-next" data-act="next" title="Enter / 空格">下一题 ↵</button></p>
    ${parts}
    <p class="dr-rules">${f.rules.map((r) => `<span class="dr-rule"><b>${esc(r.id)}</b>${esc(r.name)}</span>`).join("")}</p>
    ${f.hint ? `<p class="dr-hint">${esc(f.hint)}</p>` : ""}
    <ul class="dr-evidence">${f.evidence.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`;
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
    if (e.target.closest('[data-act="next"], [data-act="retry"]')) return next();
  });
  document.addEventListener("keydown", (e) => {
    if ($("pp-drill").hidden || $("practice-page").hidden || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest?.("input, textarea, select, [contenteditable], dialog")) return;
    if (cur?.feedback && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); return next(); }
    const n = Number(e.key);
    if (!cur || cur.feedback || !(n >= 1 && n <= 9)) return;
    const part = cur.picks.findIndex((p) => p === null);
    const at = part < 0 ? cur.picks.length - 1 : part;
    if (n <= cur.drill.parts[at].choices.length) { e.preventDefault(); choose(at, n - 1); }
  });
}

/** 练习页切到识别题：还没有题就取一题。 */
export function onShow() {
  if (!cur) next();
}

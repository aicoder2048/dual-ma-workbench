// 两个 agent 面板（中栏分析师、右栏均线参谋）+ WebSocket 连接。
import { enhance } from "./blocks.js";
import { renderRich } from "./cite.js";
import { currentSettings } from "./settings.js";
import { speak, speakingId, stopSpeaking } from "./speech.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const WHO = { analyst: "分析师", advisor: "均线参谋" };

// ---------- WebSocket ----------
let ws = null;
let handlers = {};
const outbox = [];

export function send(msg) {
  const data = JSON.stringify(msg);
  if (ws?.readyState === WebSocket.OPEN) ws.send(data);
  else outbox.push(data);
}

export function connect(onEvent) {
  handlers.onEvent = onEvent;
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    send({ type: "hello" });
    while (outbox.length) ws.send(outbox.shift());
    document.body.classList.remove("offline");
  };
  ws.onmessage = (e) => handlers.onEvent(JSON.parse(e.data));
  ws.onclose = () => {
    document.body.classList.add("offline");
    setTimeout(() => connect(onEvent), 1500); // 服务重启后自动重连
  };
}

// ---------- 面板 ----------
export class Panel {
  /** opts: { agent, thread, scroller, chips, form, input, sendBtn, resetBtn, empty?, beforeSend? } */
  constructor(opts) {
    this.o = opts;
    this.busy = false;
    this.live = null; // 正在生成的回答 { el, body, tools, text }
    this.connected = false;
    opts.form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.busy ? send({ type: "abort", agent: opts.agent }) : this.submit(opts.input.value);
    });
    opts.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!this.busy) this.submit(opts.input.value);
      }
    });
    opts.input.addEventListener("input", () => this.autosize());
    opts.chips.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (chip && !this.busy) this.submit(chip.dataset.text);
    });
    opts.resetBtn?.addEventListener("click", () => !this.busy && send({ type: "reset", agent: opts.agent }));
    this.enable(false);
  }

  enable(on) {
    this.connected = on;
    this.o.input.disabled = !on;
    this.o.sendBtn.disabled = !on;
  }

  autosize() {
    const t = this.o.input;
    t.style.height = "auto";
    t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
  }

  submit(text) {
    text = String(text ?? "").trim();
    if (!text || this.busy) return;
    const extra = this.o.beforeSend?.() ?? {};
    send({ type: "prompt", agent: this.o.agent, text, ...extra });
    this.o.input.value = "";
    this.autosize();
  }

  setBusy(busy) {
    this.busy = busy;
    this.o.sendBtn.textContent = busy ? "停止" : "发送";
    this.o.sendBtn.classList.toggle("stop", busy);
    this.o.chips.classList.toggle("dim", busy);
  }

  scrollEnd() {
    const s = this.o.scroller;
    s.scrollTop = s.scrollHeight;
  }

  addUser(u) {
    if (this.o.empty) this.o.empty.hidden = true;
    const el = document.createElement("div");
    el.className = "msg user";
    el.innerHTML = `${u.context ? `<div class="ctx">${esc(u.context)}</div>` : ""}<div>${esc(u.text)}</div>`;
    this.o.thread.appendChild(el);
    this.scrollEnd();
  }

  startTurn() {
    const el = document.createElement("div");
    el.className = "msg assistant streaming";
    el.innerHTML = `<div class="who">${WHO[this.o.agent]}</div><div class="tools"></div><div class="body"><span class="typing">思考中…</span></div>`;
    this.o.thread.appendChild(el);
    this.live = { el, body: el.querySelector(".body"), tools: el.querySelector(".tools"), text: "", toolEls: {} };
    this.scrollEnd();
  }

  delta(d) {
    if (!this.live) this.startTurn();
    this.live.text += d;
    // 流式阶段先按 Markdown 渲染，引用暂时显示成灰色占位；结束时再按校验结果渲染
    renderRich(this.live.body, this.live.text, null);
    this.live.body.querySelectorAll(".cite.bad").forEach((b) => b.classList.replace("bad", "pending"));
    this.scrollEnd();
  }

  tool(e) {
    if (!this.live) this.startTurn();
    let row = this.live.toolEls[e.label];
    if (!row) {
      row = document.createElement("div");
      row.className = "tool";
      this.live.tools.appendChild(row);
      this.live.toolEls[e.label] = row;
    }
    row.textContent = `${e.phase === "start" ? "⋯" : e.ok ? "✓" : "✗"} ${e.label}`;
    row.classList.toggle("failed", e.phase === "end" && !e.ok);
  }

  /** 回答结束：用最终文字和数据字段重新渲染，引用按校验结果显示。replay = 回放历史记录，不自动朗读。 */
  endTurn(entry, replay = false) {
    if (!this.live) this.startTurn();
    const { el, body } = this.live;
    el.classList.remove("streaming");
    renderAssistant(el, body, entry, this.o.agent);
    this.live = null;
    this.scrollEnd();
    if (!replay && entry.text && !entry.aborted && currentSettings()?.autoSpeak) el.querySelector(".speak")?.click();
  }

  error(message) {
    const el = document.createElement("div");
    el.className = "msg assistant error";
    el.textContent = message;
    this.o.thread.appendChild(el);
    this.scrollEnd();
  }

  history(entries) {
    this.o.thread.innerHTML = "";
    this.live = null;
    if (this.o.empty) this.o.empty.hidden = entries.length > 0;
    for (const e of entries) {
      if (e.role === "user") { this.addUser(e); continue; }
      this.startTurn();
      for (const t of e.tools) this.tool({ label: t.label, phase: "end", ok: t.ok });
      this.endTurn(e, true);
    }
  }

  suggestions(items, source) {
    const c = this.o.chips;
    c.innerHTML = "";
    c.dataset.source = source;
    for (const it of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.dataset.text = it.text;
      b.innerHTML = `<span class="kind">${esc(it.intent)}</span>${esc(it.text)}`;
      c.appendChild(b);
    }
    if (items.length) {
      const tag = document.createElement("span");
      tag.className = "chips-src";
      tag.textContent = source === "ai" ? "AI 生成" : "规则生成，AI 版生成中…";
      c.appendChild(tag);
    }
  }
}

let speakSeq = 0;

/** 每条回答右上角的「朗读」开关。声音按 agent 取设置里的选择。 */
function speakButton(agent, text) {
  const id = `say-${++speakSeq}`;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "speak";
  const paint = (on) => {
    btn.setAttribute("aria-pressed", String(on));
    btn.textContent = on ? "■ 停止" : "▶ 朗读";
    btn.title = on ? "停止朗读" : "朗读这条回答（微软 Edge 在线语音）";
  };
  paint(false);
  btn.addEventListener("click", () => {
    if (speakingId() === id) return stopSpeaking();
    const s = currentSettings();
    speak(id, text, agent === "analyst" ? s?.voiceAnalyst : s?.voiceAdvisor, paint);
  });
  return btn;
}

function renderAssistant(el, body, entry, agent) {
  const who = el.querySelector(".who");
  if (who && entry.model) who.textContent = `${who.textContent.split(" · ")[0]} · ${entry.model.split("/").pop()}`;
  if (!entry.text) {
    body.innerHTML = `<span class="caption">${entry.aborted ? "已中断。" : "（没有文字回答）"}</span>`;
    return;
  }
  el.querySelector(".who")?.appendChild(speakButton(agent, entry.text));
  renderRich(body, entry.text, entry.book);
  enhance(body); // 表格由 Markdown 直接渲染；流程图、迷你 K 线、底扣价小图异步画出
  const bad = entry.checks.filter((c) => !c.ok).length;
  const total = entry.checks.length;
  const foot = document.createElement("div");
  foot.className = `cite-foot${bad ? " has-bad" : ""}`;
  foot.textContent = total
    ? `${total} 处引用，${bad ? `${bad} 处找不到出处（红色）` : "全部核对通过"}${entry.aborted ? " · 已中断" : ""}`
    : "这条回答没有引用出处，请谨慎参考";
  if (!total) foot.classList.add("has-bad");
  el.appendChild(foot);
}

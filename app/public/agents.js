// 两个 agent 面板（中栏长风、右栏鸿雁）+ WebSocket 连接。
import { installAttachments } from "./attach.js";
import { enhance } from "./blocks.js";
import { renderRich } from "./cite.js";
import { currentSettings } from "./settings.js";
import { pauseSpeaking, resumeSpeaking, speak, speakingId, speechState, stopSpeaking } from "./speech.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const WHO = { analyst: "长风", advisor: "鸿雁" };

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
    this.attachments = installAttachments({ form: opts.form, input: opts.input });
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
    if ((!text && !this.attachments.has()) || this.busy) return;
    const extra = this.o.beforeSend?.() ?? {};
    const attachments = this.attachments.take();
    send({ type: "prompt", agent: this.o.agent, text, ...extra, ...(attachments.length ? { attachments } : {}) });
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
    const atts = (u.attachments ?? []).map((n) => `<span class="att-name">📎 ${esc(n)}</span>`).join("");
    el.innerHTML = `${u.context ? `<div class="ctx">${esc(u.context)}</div>` : ""}${atts ? `<div class="atts">${atts}</div>` : ""}${u.text ? `<div>${esc(u.text)}</div>` : ""}`;
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

/** 每条回答右上角的朗读控件：朗读 → 暂停 ⇄ 继续，旁边「停止」。声音按 agent 取设置里的选择。 */
function speakButton(agent, text) {
  const id = `say-${++speakSeq}`;
  const wrap = document.createElement("span");
  wrap.className = "speak-ctl";
  // 「停止」放在左边：主按钮（朗读 → 暂停 → 继续）一直在原位，在同一个地方再点一下就是暂停，不会误点到停止
  wrap.innerHTML = `<button type="button" class="speak-stop" title="停止朗读" hidden>■ 停止</button><button type="button" class="speak"></button>`;
  const [stop, main] = wrap.querySelectorAll("button");
  const LOOK = { idle: ["▶ 朗读", "朗读这条回答（微软 Edge 在线语音）"], playing: ["⏸ 暂停", "暂停朗读"], paused: ["▶ 继续", "从暂停的地方接着读"] };
  const paint = (state, error = null) => {
    const [label, title] = LOOK[state];
    main.textContent = error ? "⚠ 朗读失败" : label;
    main.title = error ?? title;
    main.setAttribute("aria-pressed", String(state !== "idle"));
    main.classList.toggle("failed", Boolean(error));
    stop.hidden = state === "idle";
  };
  paint("idle");
  main.addEventListener("click", () => {
    if (speakingId() === id) return speechState() === "playing" ? pauseSpeaking() : resumeSpeaking();
    const s = currentSettings();
    speak(id, text, agent === "analyst" ? s?.voiceAnalyst : s?.voiceAdvisor, paint);
  });
  stop.addEventListener("click", () => speakingId() === id && stopSpeaking());
  return wrap;
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
  enhance(body); // 表格由 Markdown 直接渲染；流程图、迷你 K 线、抵扣价小图异步画出
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

// 把含 [[S:编号]] / [[D:字段]] 的 Markdown 渲染成 HTML，引用变成可点开的标签。
const DOC_SHORT = {
  article: "文章", skill: "流程", concepts: "概念", cases: "案例",
  dropoff: "底扣价笔记", ta01: "TA01", ta15: "TA15", memo: "看片笔记",
};

let sourceIndex = new Map(); // id → { id, doc, heading }

export async function loadSourceIndex() {
  const list = await (await fetch("/api/sources")).json();
  sourceIndex = new Map(list.map((s) => [s.id, s]));
}

const CITE = /\[\[(S|D):([^\]\n]+?)\]\]/g;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** facts：当前上下文的数据字段 { 键: {label, value} }；可以为空。 */
export function renderRich(el, text, facts = null) {
  const withSlots = String(text).replace(CITE, (_, kind, ref) =>
    `<span class="cite-slot" data-kind="${kind}" data-ref="${esc(ref.trim())}"></span>`);
  const html = window.marked ? window.marked.parse(withSlots, { breaks: true }) : esc(withSlots);
  el.innerHTML = window.DOMPurify ? window.DOMPurify.sanitize(html) : html;
  el.querySelectorAll(".cite-slot").forEach((slot) => slot.replaceWith(citeButton(slot.dataset.kind, slot.dataset.ref, facts)));
}

/** 只渲染行内（不包 <p>），用于报告要点。 */
export function renderInline(el, text, facts = null) {
  renderRich(el, text, facts);
  const only = el.children.length === 1 && el.firstElementChild.tagName === "P" ? el.firstElementChild : null;
  if (only) only.replaceWith(...only.childNodes);
}

function citeButton(kind, ref, facts) {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.kind = kind;
  b.dataset.ref = ref;
  if (kind === "S") {
    const s = sourceIndex.get(ref);
    const [doc, sec] = ref.split("#");
    b.className = s ? "cite src" : "cite bad";
    b.textContent = `${DOC_SHORT[doc] ?? doc} ${sec ?? ""}`.trim();
    b.title = s ? `${s.doc} · ${s.heading}` : `引用库里没有 ${ref}`;
  } else {
    const f = facts?.[ref];
    b.className = f ? "cite data" : "cite bad";
    // 正文里已经写了数字，标签只放字段名；数值在悬停提示和弹窗里
    b.textContent = ref;
    b.title = f ? `${f.label}：${f.value}` : `当前分析结果里没有字段 ${ref}`;
    if (f) b.dataset.value = f.value, b.dataset.label = f.label;
  }
  return b;
}

// ---------- 弹窗 ----------
const pop = () => document.getElementById("popover");

export function closePopover() {
  pop().hidden = true;
}

function placeNear(anchor) {
  const p = pop();
  p.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = p.offsetWidth, h = p.offsetHeight;
  const left = Math.min(Math.max(16, r.left), innerWidth - w - 16);
  const top = r.bottom + 8 + h > innerHeight ? Math.max(16, r.top - h - 8) : r.bottom + 8;
  p.style.left = `${left}px`;
  p.style.top = `${top}px`;
}

async function openSource(btn) {
  const p = pop();
  p.innerHTML = `<p class="caption">读取原文……</p>`;
  placeNear(btn);
  const res = await fetch(`/api/source?id=${encodeURIComponent(btn.dataset.ref)}`);
  if (!res.ok) { p.innerHTML = `<p>引用库里没有 <code>${esc(btn.dataset.ref)}</code>。</p>`; return; }
  const c = await res.json();
  p.innerHTML = `<div class="pop-head"><b>${esc(c.docTitle)} · ${esc(c.heading)}</b><button class="close" aria-label="关闭">×</button></div>
    <div class="pop-path">${esc(c.path)}:${c.line} · [[S:${esc(c.id)}]]</div><div class="pop-body"></div>`;
  const body = p.querySelector(".pop-body");
  body.innerHTML = window.DOMPurify.sanitize(window.marked.parse(c.body));
  placeNear(btn);
}

function openData(btn, meta) {
  const p = pop();
  p.innerHTML = `<div class="pop-head"><b>${esc(btn.dataset.label)}</b><button class="close" aria-label="关闭">×</button></div>
    <p class="num" style="font-size:18px;margin:6px 0">${esc(btn.dataset.value)}</p>
    <div class="pop-path">[[D:${esc(btn.dataset.ref)}]] · 来自 dma_analyze.py 的计算${meta ? ` · ${esc(meta)}` : ""}</div>`;
  placeNear(btn);
}

/** 全局委托：点引用标签开弹窗；点外面或按 Esc 关。dataMeta() 返回当前数据的说明（日期、来源）。 */
export function installCitationHandlers(dataMeta = () => "") {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".cite");
    if (btn && !btn.classList.contains("bad")) {
      e.preventDefault();
      btn.dataset.kind === "S" ? openSource(btn) : openData(btn, btn.closest("[data-meta]")?.dataset.meta ?? dataMeta());
      return;
    }
    if (e.target.closest(".close") || !e.target.closest("#popover")) closePopover();
  });
  document.addEventListener("keydown", (e) => e.key === "Escape" && closePopover());
}

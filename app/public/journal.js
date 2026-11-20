// 交易日志：结论卡片上「记入日志」记下当时的计划；左栏「交易日志」列出每一笔和汇总；点开一笔填进场、离场、复盘。
// 快照由服务端按票、日期、处境重新取，这里只发这三样和自己填的仓位、理由。
import { parseCost, situationOf } from "./viz.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const f2 = (x) => Number(x).toFixed(2);
const pct = (x, d = 1) => `${x >= 0 ? "+" : ""}${Number(x).toFixed(d)}%`;

const STATE_LABEL = { planned: "计划", open: "已进场", closed: "已离场", cancelled: "放弃" };
const SITUATION_LABEL = { flat: "空仓", holding: "持仓", profit: "持仓 · 浮盈", loss: "持仓 · 浮亏" };

let view = { entries: [], summary: null, smallSample: 10 };
let api;
let current;

/** 左栏的两个标签：自选股、交易日志。选哪个记在本机。 */
function selectTab(name) {
  for (const [tab, pane] of [["tab-watch", "watch-pane"], ["tab-journal", "journal-pane"]]) {
    const on = tab === `tab-${name}`;
    $(tab).setAttribute("aria-selected", String(on));
    $(pane).hidden = !on;
  }
  try { localStorage.setItem("dma-left-tab", name); } catch { /* 隐私模式 */ }
}

// ---------- 汇总 ----------
function groupRow(name, g) {
  if (!g.n) return `<tr><th>${name}</th><td class="num">0</td><td colspan="4" class="muted">—</td></tr>`;
  return `<tr><th>${name}</th><td class="num">${g.n}</td><td class="num">${Math.round(g.winRate * 100)}%</td>
    <td class="num ${g.mean >= 0 ? "bullish" : "bearish"}">${pct(g.mean)}</td><td class="num">${pct(g.median)}</td><td class="num">${g.avgDays.toFixed(0)}</td></tr>`;
}

function summaryHtml(s) {
  const counts = Object.entries(STATE_LABEL).map(([k, label]) => `<span>${label} <b class="num">${s.counts[k]}</b></span>`).join("");
  const c = s.closed;
  const small = !c.all.n ? `<p class="j-small">还没有已离场的。离场、复盘后，这里按照没照计划分开算。</p>`
    : c.all.small ? `<p class="j-small">已离场 ${c.all.n} 笔，少于 ${view.smallSample} 笔：数字只当参考，别据此下结论。</p>` : "";
  return `<div class="j-counts">${counts}</div>${small}
    <table class="j-stats"><thead><tr><th></th><th>笔</th><th>胜率</th><th>均值</th><th>中位</th><th>天</th></tr></thead>
      <tbody>${groupRow("照计划", c.followed)}${groupRow("没照", c.deviated)}${groupRow("全部", c.all)}</tbody></table>
    ${c.unreviewed ? `<p class="j-small">${c.unreviewed} 笔已离场还没复盘，不算进照没照计划。</p>` : ""}`;
}

function itemHtml(e) {
  const s = e.snapshot;
  let line = esc(s.action);
  if (e.state === "closed") {
    const o = e.outcome;
    const followed = e.review ? (e.review.followed ? "照计划" : "没照计划") : "待复盘";
    line = `<b class="num ${o.pnl >= 0 ? "bullish" : "bearish"}">${pct(o.pnl)}</b> · ${o.days} 天 · ${followed}`;
  } else if (e.state === "open") {
    line = `进场 ${esc(e.entry.date)} @ <span class="num">${f2(e.entry.price)}</span>`;
  }
  return `<li class="j-item" data-id="${esc(e.id)}" tabindex="0">
      <span class="sym">${esc(s.ticker)}</span><span class="j-state ${e.state}">${STATE_LABEL[e.state]}</span>
      <span class="j-date">${esc(s.date)} · ${SITUATION_LABEL[s.situation]}</span>
      <span class="j-line">${line}</span></li>`;
}

function paint() {
  $("journal-count").textContent = view.entries.length ? String(view.entries.length) : "";
  if (view.error) {
    $("journal-summary").innerHTML = `<p class="j-error" role="alert">${esc(view.error)}</p>`;
    $("journal-list").innerHTML = "";
    return;
  }
  $("journal-summary").innerHTML = summaryHtml(view.summary);
  $("journal-list").innerHTML = view.entries.length ? view.entries.map(itemHtml).join("")
    : `<li class="j-empty">还没有记录。在中栏结论卡片上点「记入日志」，记下当时的计划。</li>`;
}

async function refresh() {
  try {
    view = await api("/api/journal");
  } catch (err) {
    view = { entries: [], summary: null, smallSample: 10, error: err.message };
  }
  paint();
}

// ---------- 对话框：记入、看一笔 ----------
const dialog = () => $("journal-dialog");

function openDialog(html) {
  const d = dialog();
  d.innerHTML = html;
  if (!d.open) d.showModal();
}

function levelChip(key, lv, cls) {
  return lv ? `<span class="pchip ${cls}"><span class="ck">${key}</span>${esc(lv.label)} <b class="num">${f2(lv.price)}</b></span>` : "";
}

function planHtml(s) {
  const flat = s.situation === "flat";
  return `<b class="j-action">${esc(s.action)}</b>
    <div class="chips-row">${levelChip(flat ? "触发 / 先看" : "盯住", s.trigger, "trigger")}${levelChip(flat ? "进场后止损" : "止损", s.stop, "stop")}${
      s.risk === null ? "" : `<span class="pchip risk"><span class="ck">到止损</span><b class="num">${s.risk.toFixed(1)}%</b></span>`}</div>
    <ul class="j-items">${s.items.map((i) => `<li><span class="pl">${esc(i.label)}</span>${esc(i.text)}</li>`).join("")}</ul>`;
}

/** 记入前预览：处境可以在空仓 / 持仓之间换，预览跟着换。 */
function recordDialog(situation) {
  const { data, asof, pos } = current();
  const a = data.analysis;
  const r = data.report;
  const cost = situation === "profit" || situation === "loss" ? parseCost(pos.cost) : null;
  const plan = r.plans[situation];
  const fill = (t) => t.replaceAll("{cost}", cost === null ? "成本" : f2(cost));
  const seg = ["flat", "holding"].map((k) =>
    `<button type="button" data-situation="${k}" aria-pressed="${(situation === "flat") === (k === "flat")}">${k === "flat" ? "空仓" : "持仓"}</button>`).join("");
  openDialog(`<form method="dialog" class="j-dialog" id="journal-new">
      <header><h2>记入日志：${esc(a.label)} ${esc(a.date)}</h2><button type="button" class="j-close" aria-label="关闭">×</button></header>
      <p class="j-note">记下的是此刻的计划（${esc(r.trend.type)} · 按「${esc(r.playKey)}」的打法）。记入后计划不能再改，只能填进场、离场和复盘。${asof ? "这是回放的那一天。" : ""}</p>
      <div class="j-row"><span class="pl">处境</span><div class="pos-seg" role="group" aria-label="记哪种处境的计划">${seg}</div>
        ${situation === "profit" || situation === "loss" ? `<span class="muted">${SITUATION_LABEL[situation]}（成本 ${f2(cost)}）</span>` : ""}</div>
      <section class="j-plan">${planHtml({ ...plan, situation, action: fill(plan.action), items: plan.items.map((i) => ({ ...i, text: fill(i.text) })) })}</section>
      <label class="j-field"><span>打算用多大仓位</span><input name="size" maxlength="200" placeholder="例如 1/3 仓、100 股"></label>
      <label class="j-field"><span>自己的理由</span><textarea name="reason" rows="3" maxlength="2000" placeholder="为什么这样做；看到了什么"></textarea></label>
      <p class="j-error" role="alert" hidden></p>
      <footer><button type="button" class="ghost j-close">取消</button><button type="submit" id="journal-save">记入</button></footer>
    </form>`);
  const form = $("journal-new");
  form.querySelectorAll("[data-situation]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.situation === "flat" ? "flat" : situationOf({ pos: "holding", cost: pos.cost }, a.close);
    const keep = { size: form.size.value, reason: form.reason.value };
    recordDialog(k);
    $("journal-new").size.value = keep.size;
    $("journal-new").reason.value = keep.reason;
  }));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = { id: crypto.randomUUID(), ticker: a.label, asof, situation, cost, size: form.size.value, reason: form.reason.value };
    await submit(form, () => api("/api/journal", { method: "POST", body: JSON.stringify(body) }), () => {
      dialog().close();
      selectTab("journal");
      $("journal-list").querySelector(`[data-id="${body.id}"]`)?.focus();
    });
  });
}

/** 发请求：成功就刷新左栏，失败把原因写在对话框里，不关。 */
async function submit(form, request, done) {
  const err = form.querySelector(".j-error");
  err.hidden = true;
  const btns = form.querySelectorAll("button[type=submit]");
  btns.forEach((b) => (b.disabled = true));
  try {
    view = await request();
    paint();
    done();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}

const fillForm = (name, title, fields, button) =>
  `<form class="j-act" data-act="${name}"><h3>${title}</h3><div class="j-fields">${fields}</div><button type="submit">${button}</button></form>`;
const dateField = (label, v) => `<label class="j-field"><span>${label}</span><input name="date" type="date" required min="1990-01-01" max="2100-12-31" value="${esc(v ?? "")}"></label>`;
const priceField = (label, v, hint) =>
  `<label class="j-field"><span>${label}</span><input name="price" inputmode="decimal" required value="${v ?? ""}" placeholder="${esc(hint ?? "")}"></label>`;

function executionHtml(e) {
  const s = e.snapshot;
  const parts = [];
  if (e.state === "planned" || e.state === "open" || e.state === "closed") {
    parts.push(fillForm("enter", e.state === "planned" ? "进场" : "进场（填错了可以改）",
      dateField("日期", e.entry?.date) + priceField("成交价", e.entry?.price, s.trigger ? `计划 ${f2(s.trigger.price)}` : ""), e.state === "planned" ? "记进场" : "改进场"));
  }
  if (e.state === "open" || e.state === "closed") {
    parts.push(fillForm("exit", e.state === "open" ? "离场" : "离场（填错了可以改）",
      dateField("日期", e.exit?.date) + priceField("成交价", e.exit?.price, s.stop ? `止损 ${f2(s.stop.price)}` : "")
        + `<label class="j-field wide"><span>为什么走</span><input name="reason" maxlength="500" value="${esc(e.exit?.reason)}" placeholder="例如 碰到止损、跌破 EMA20、主动止盈"></label>`,
      e.state === "open" ? "记离场" : "改离场"));
  }
  if (e.state === "planned") {
    parts.push(fillForm("cancel", "放弃这个计划", `<label class="j-field wide"><span>为什么放弃</span><input name="note" maxlength="2000" placeholder="例如 条件一直没齐"></label>`, "放弃"));
  }
  if (e.state === "cancelled") parts.push(`<p class="j-note">已放弃${e.note ? `：${esc(e.note)}` : "。"}</p>`);
  return parts.join("");
}

function reviewHtml(e) {
  if (e.state !== "closed") return "";
  const o = e.outcome;
  const rv = e.review;
  const yes = rv?.followed === true ? "checked" : "";
  const no = rv?.followed === false ? "checked" : "";
  return `<section class="j-outcome"><span class="pl">结果</span>收益 <b class="num ${o.pnl >= 0 ? "bullish" : "bearish"}">${pct(o.pnl, 2)}</b>，持有 <b class="num">${o.days}</b> 天（自然日）</section>
    ${fillForm("review", "复盘", `<fieldset class="j-yn"><legend>照计划做了吗</legend>
        <label><input type="radio" name="followed" value="yes" required ${yes}> 照计划</label>
        <label><input type="radio" name="followed" value="no" ${no}> 没照计划</label></fieldset>
      <label class="j-field wide"><span>哪里没照计划</span><input name="deviation" maxlength="2000" value="${esc(rv?.deviation)}" placeholder="例如 没到触发价就买了、止损没走"></label>
      <label class="j-field wide"><span>教训</span><textarea name="lesson" rows="2" maxlength="2000">${esc(rv?.lesson)}</textarea></label>`, "保存复盘")}`;
}

function detailDialog(id) {
  const e = view.entries.find((x) => x.id === id);
  if (!e) return;
  const s = e.snapshot;
  const rules = s.rules.map((r) => `<li><span class="rs ${r.status === "满足" ? "met" : r.status === "需看图" ? "chart" : "unmet"}">${esc(r.status)}</span> ${esc(r.id)} ${esc(r.name)}</li>`).join("");
  openDialog(`<div class="j-dialog" id="journal-detail" data-id="${esc(e.id)}">
      <header><h2>${esc(s.ticker)} ${esc(s.date)} <span class="j-state ${e.state}">${STATE_LABEL[e.state]}</span></h2><button type="button" class="j-close" aria-label="关闭">×</button></header>
      <section class="j-plan"><h3>当时的计划 <span class="muted">记入后不能改</span></h3>
        <p class="j-meta">${esc(s.trend)} · 按「${esc(s.playKey)}」的打法 · ${SITUATION_LABEL[s.situation]}${s.cost ? `（成本 ${f2(s.cost)}）` : ""} · 收盘 <span class="num">${f2(s.close)}</span>${s.asof ? " · 回放" : ""}</p>
        ${planHtml(s)}
        <details><summary>当时的规则状态（${s.rules.length} 条）、数据来源、回测记录</summary>
          <ul class="j-rules">${rules}</ul><p class="j-meta">数据：${esc(s.source)}</p><p class="j-meta">${esc(s.record)}</p></details>
        <p class="j-meta">仓位：${esc(e.size || "没填")} · 理由：${esc(e.reason || "没填")} · 记于 ${esc(new Date(e.createdAt).toLocaleString("zh-CN", { hour12: false }))}</p>
      </section>
      ${reviewHtml(e)}
      ${executionHtml(e)}
      <p class="j-error" role="alert" hidden></p>
    </div>`);
  const box = $("journal-detail");
  box.querySelectorAll("form.j-act").forEach((f) => f.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const v = Object.fromEntries(new FormData(f));
    const act = f.dataset.act;
    const body = act === "enter" || act === "exit" ? { type: act, date: v.date, price: parseCost(v.price), ...(act === "exit" ? { reason: v.reason } : {}) }
      : act === "cancel" ? { type: act, note: v.note }
      : { type: act, followed: v.followed === "yes", deviation: v.deviation, lesson: v.lesson };
    await submit(box, () => api(`/api/journal/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify(body) }), () => detailDialog(id));
  }));
}

export async function initJournal(opts) {
  api = opts.api;
  current = opts.current;
  let tab = "watch";
  try { tab = localStorage.getItem("dma-left-tab") === "journal" ? "journal" : "watch"; } catch { /* 隐私模式 */ }
  selectTab(tab);
  $("tab-watch").addEventListener("click", () => selectTab("watch"));
  $("tab-journal").addEventListener("click", () => selectTab("journal"));
  const open = (ev) => {
    const li = ev.target.closest(".j-item");
    if (li && (ev.type === "click" || ev.key === "Enter")) detailDialog(li.dataset.id);
  };
  $("journal-list").addEventListener("click", open);
  $("journal-list").addEventListener("keydown", open);
  // 结论卡片会随换票重画，按钮的点击在外层接
  $("verdict").addEventListener("click", (ev) => {
    if (!ev.target.closest("#journal-add") || !current().data) return;
    const { data, pos } = current();
    recordDialog(situationOf(pos, data.analysis.close));
  });
  dialog().addEventListener("click", (ev) => {
    if (ev.target.closest(".j-close") || ev.target === dialog()) dialog().close();
  });
  await refresh();
}

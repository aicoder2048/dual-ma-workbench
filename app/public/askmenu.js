// 卡片右上角「问鸿雁」：按当前数据生成和这张卡相关的问题，点一下带上下文发给鸿雁。
// cardQuestions 是纯函数（bun test 直接测）；initAskMenu 在浏览器里接上菜单。

export const CARD_NAMES = {
  chart: "日线图",
  big_picture: "1. 看大局",
  strategy: "2. 定策略",
  direction: "3. 看方向",
};

const shortTrend = (t) => String(t).replace("（排列或方向不一致）", "");
const fmt = (x, d = 1) => `${x >= 0 ? "+" : ""}${Number(x).toFixed(d)}`;

/** analysis：脚本结果；visual：report.visual。返回 [{ text }]，最多 5 条，按和这只股票的相关程度排。 */
export function cardQuestions(card, analysis, visual) {
  const a = analysis, v = visual;
  const qs = [];
  const add = (cond, text) => cond && qs.push({ text });
  const pctl = Math.round(a.bias_pctl * 100);
  const extremeBias = a.bias_pctl <= 0.05 || a.bias_pctl >= 0.95;
  const mixedCross = v.crosses.find((c) => c.verdict === "不一致");
  const doubleCross = v.crosses.find((c) => c.verdict.startsWith("双"));
  const p = v.projection;

  if (card === "chart") {
    add(true, "图上的三个小黄点分别是什么意思？");
    add(a.volume?.spikes.length > 0, `最近 20 天有 ${a.volume?.spikes.length} 根黄色量柱，说明什么？`);
    add(extremeBias, `价格离 20 线 ${fmt(a.bias20)}%，在图上怎么看出来？`);
    add(a.arr_ma === "混乱", "MA 排列混乱，在图上怎么看出来？");
    add(true, "实线 MA 和虚线 EMA 为什么要一起看？");
  } else if (card === "big_picture") {
    add(Boolean(mixedCross), mixedCross && `${mixedCross.pair}：MA ${mixedCross.ma.kind}、EMA ${mixedCross.ema.kind}，为什么不算确认？`);
    add(Boolean(doubleCross), doubleCross && `${doubleCross.pair} ${doubleCross.verdict}说明什么？`);
    add(extremeBias, `乖离率排在历史 ${pctl}% 分位，意味着什么？`);
    add(a.arr_ma !== a.arr_ema, `MA ${a.arr_ma}、EMA ${a.arr_ema}，两种排列为什么不一样？`);
    add(true, `"${a.lines[0].clock}"这种钟表读法怎么用？`);
    add(true, "价位梯子怎么读？间距大小说明什么？");
  } else if (card === "strategy") {
    const t = shortTrend(a.trend);
    add(true, `为什么「${t}」要这样做？`);
    add(true, `出现什么变化，才会从「${t}」变成别的类型？`);
    add(t === "过渡态", "过渡态和横盘震荡有什么区别？");
    add(true, "仓位为什么要以心态稳得住为准？");
  } else if (card === "direction") {
    const worst = [...a.drops].sort((x, y) => x.ma_flat_change_pct - y.ma_flat_change_pct)[0];
    const kind = worst.below === 0 ? "都扣高值" : worst.below === worst.count ? "都扣低值" : `扣低 ${worst.below} 天`;
    add(true, `MA${worst.period} 未来 ${worst.count} 天${kind}，意味着什么？`);
    add(p.arrNow.ma !== p.arrAfter.ma, `价格不变 ${p.days} 天，MA 排列为什么会从${p.arrNow.ma}变成${p.arrAfter.ma}？`);
    add(p.arrNow.ma === p.arrAfter.ma, `价格不变 ${p.days} 天，MA 排列为什么还是${p.arrAfter.ma}？`);
    add(true, "棒棒糖图怎么读？在现价上方和下方有什么区别？");
    add(true, "EMA 没有抵扣价，推演公式是什么？");
  }
  return qs.slice(0, 5);
}

/** 卡片的上下文说明，随问题发给鸿雁。 */
export function cardContext(card, analysis) {
  return { kind: "view", what: CARD_NAMES[card] ?? card, detail: `${analysis.label} ${analysis.date}${analysis.warning ? "（盘中）" : ""}` };
}

/** 鸿雁输入框上方的上下文标签。三种来源：划选文字、点图表、卡片菜单（view）。 */
export function selectionLabel(sel) {
  if (sel.kind === "text") return `${sel.where ? `「${sel.where}」` : ""}${sel.text}`;
  if (sel.kind === "view") return `「${sel.what}」${sel.detail ? ` · ${sel.detail}` : ""}`;
  return `图表 ${sel.time}${sel.drops?.length ? ` · MA${sel.drops.join("/MA")} 的抵扣价` : ""}${sel.candle ? ` · 收 ${sel.candle.close.toFixed(2)}` : ""}`;
}

// ---------- 浏览器 ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * getState() → { analysis, visual, aiSuggestions: [{text}] }
 * ask(question, selection) → 发给鸿雁
 */
export function initAskMenu({ getState, ask }) {
  const menu = document.getElementById("ask-menu");
  let opener = null;

  const close = () => {
    menu.hidden = true;
    opener?.setAttribute("aria-expanded", "false");
    opener = null;
  };

  const open = (btn) => {
    const s = getState();
    if (!s?.analysis) return;
    const card = btn.dataset.askCard;
    const qs = cardQuestions(card, s.analysis, s.visual);
    const ai = (s.aiSuggestions ?? []).filter((x) => !qs.some((q) => q.text === x.text)).slice(0, 2);
    menu.innerHTML = `<div class="am-head"><b>问鸿雁</b> · 关于「${esc(CARD_NAMES[card])}」（${esc(s.analysis.label)}）</div>
      ${qs.map((q) => `<button type="button" class="q" role="menuitem">${esc(q.text)}</button>`).join("")}
      ${ai.map((q) => `<button type="button" class="q" role="menuitem">${esc(q.text)}<span class="src">AI 生成</span></button>`).join("")}
      <form class="am-free"><input placeholder="或者自己问这张卡……" aria-label="自己输入问题"><button type="submit">问</button></form>`;
    menu.hidden = false;
    const r = btn.getBoundingClientRect();
    const w = menu.offsetWidth;
    menu.style.left = `${Math.max(16, Math.min(r.right - w, innerWidth - w - 16))}px`;
    menu.style.top = `${Math.min(r.bottom + 6, innerHeight - menu.offsetHeight - 16)}px`;
    opener = btn;
    btn.setAttribute("aria-expanded", "true");
    menu.querySelector("button.q")?.focus();

    const send = (text) => {
      if (!text.trim()) return;
      ask(text.trim(), cardContext(card, s.analysis));
      close();
    };
    menu.querySelectorAll("button.q").forEach((b) => b.addEventListener("click", () => send(b.firstChild.textContent)));
    menu.querySelector(".am-free").addEventListener("submit", (e) => {
      e.preventDefault();
      send(e.target.querySelector("input").value);
    });
  };

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-ask-card]");
    if (btn) {
      e.stopPropagation();
      opener === btn ? close() : open(btn);
      return;
    }
    if (!menu.hidden && !e.target.closest("#ask-menu")) close();
  });
  document.addEventListener("keydown", (e) => e.key === "Escape" && close());
}

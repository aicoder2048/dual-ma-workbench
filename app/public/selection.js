// 划选中栏文字 / 点图表 → 浮动"问鸿雁"按钮 → 右栏上下文条 + 默认问题。
const $ = (id) => document.getElementById(id);

/**
 * opts:
 *   chart        createChart 返回的对象（可为 null）
 *   onAttach(sel, question)   用户点了"问鸿雁"
 */
export function initSelection({ chart, onAttach }) {
  const btn = $("ask-advisor");
  let pending = null; // { sel, question }

  const hide = () => { btn.hidden = true; pending = null; };
  const showAt = (x, y, label, sel, question) => {
    pending = { sel, question };
    btn.textContent = label;
    btn.hidden = false;
    const w = btn.offsetWidth;
    btn.style.left = `${Math.min(Math.max(8, x - w / 2), innerWidth - w - 8)}px`;
    btn.style.top = `${Math.max(8, y - 38)}px`;
  };

  // 文字：只认中栏里的内容（报告、结论条、长风对话）
  document.addEventListener("mouseup", (e) => {
    if (e.target.closest("#ask-advisor, .cite, button, input, textarea")) return;
    setTimeout(() => {
      const s = getSelection();
      const text = s?.toString().trim() ?? "";
      if (!text || text.length < 2 || !s.rangeCount) return;
      const node = s.getRangeAt(0).commonAncestorContainer;
      const el = node.nodeType === 1 ? node : node.parentElement;
      const scope = el?.closest("#steps, #verdict, #analyst-thread");
      if (!scope) return;
      const where =
        el.closest(".step")?.querySelector("h2")?.firstChild?.textContent.trim() ??
        (el.closest("#verdict") ? "结论" : el.closest("#analyst-thread") ? "分析师·长风的回答" : "");
      const r = s.getRangeAt(0).getBoundingClientRect();
      showAt(r.left + r.width / 2, r.top, "问鸿雁", { kind: "text", text: text.slice(0, 1200), where }, "解读一下这段话");
    }, 0);
  });

  // 图表：点某一天
  chart?.onPick((p) => {
    if (!p.point) return;
    const box = $("chart").getBoundingClientRect();
    const sel = { kind: "chart", time: p.time, candle: p.candle, lines: p.lines, drops: p.drops };
    const q = p.drops.length ? `${p.time} 这个小黄点是什么意思？` : `${p.time} 这一天在图上说明了什么？`;
    showAt(box.left + p.point.x, box.top + p.point.y, `问鸿雁：${p.time}`, sel, q);
  });

  btn.addEventListener("click", () => {
    if (!pending) return;
    onAttach(pending.sel, pending.question);
    getSelection()?.removeAllRanges();
    hide();
  });
  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest("#ask-advisor, #chart")) hide();
  });
  document.addEventListener("keydown", (e) => e.key === "Escape" && hide());
  $("center-scroll").addEventListener("scroll", hide, { passive: true });
}

// 抽屉：中栏的五块（总结、K 线图、三步）滚出视野后，中栏顶部的提示条上出现这一块的按钮；
// 点一下把那一块拉到抽屉里看，收起放回原处。
// 抽屉里放的是原来那个元素本身（图表的范围、画的线、空仓/持仓的选择都保持），原处留一个同样高的占位，滚动位置不变。
const $ = (id) => document.getElementById(id);

/** 抽屉分区：按页面上的先后顺序。el() 每次现取，因为三步卡片换股票时会重新生成。 */
const SECTIONS = [
  { key: "verdict", label: "总结", el: () => $("verdict") },
  { key: "chart", label: "K 线图", el: () => document.querySelector(".chart-card") },
  { key: "big_picture", label: "看大局", el: () => document.querySelector('#steps [data-step="big_picture"]') },
  { key: "strategy", label: "定策略", el: () => document.querySelector('#steps [data-step="strategy"]') },
  { key: "direction", label: "看方向", el: () => document.querySelector('#steps [data-step="direction"]') },
];

let closeDrawer = () => {};
/** 收起抽屉（页面要重新渲染分析之前调用，免得抽屉里留着过期的元素）。 */
export const collapseDrawer = () => closeDrawer();

export function initDrawer() {
  const scroller = $("center-scroll");
  const peek = $("peek");
  const drawer = $("drawer");
  const body = drawer.querySelector(".drawer-body");
  peek.querySelector(".peek-btns").innerHTML = SECTIONS.map((s) =>
    `<button type="button" data-peek="${s.key}" aria-pressed="false" hidden>${s.label}</button>`).join("");
  const btn = (key) => peek.querySelector(`[data-peek="${key}"]`);
  let open = null; // { key, el, placeholder }

  /** 这一块的开头已经滚出视野了吗（读到它的后半段、或整块滚走）。最后一块在对话为空时滚不走，也能出现。 */
  const gone = (el) => el && scroller.contains(el) && el.offsetHeight > 0
    && el.getBoundingClientRect().top < scroller.getBoundingClientRect().top - 1;

  const update = () => {
    let any = false;
    for (const s of SECTIONS) {
      const show = open?.key === s.key || gone(s.el());
      btn(s.key).hidden = !show;
      any ||= show;
    }
    peek.hidden = !any;
  };

  const close = () => {
    if (!open) return;
    if (open.placeholder.isConnected) open.placeholder.replaceWith(open.el);
    else open.el.remove(); // 原处已经重新渲染：抽屉里这份过期了，丢掉
    body.innerHTML = "";
    drawer.hidden = true;
    btn(open.key).setAttribute("aria-pressed", "false");
    open = null;
    update();
  };
  closeDrawer = close;

  const show = (key) => {
    if (open?.key === key) return close();
    close();
    const el = SECTIONS.find((s) => s.key === key).el();
    if (!el) return;
    const placeholder = document.createElement("div");
    placeholder.style.height = `${el.getBoundingClientRect().height}px`; // 带小数，收起后滚动位置一点不差
    el.replaceWith(placeholder);
    body.appendChild(el);
    drawer.style.maxHeight = `${scroller.clientHeight - drawer.offsetTop - 8}px`; // 不盖住下面的输入区
    drawer.hidden = false;
    btn(key).setAttribute("aria-pressed", "true");
    open = { key, el, placeholder };
  };

  peek.addEventListener("click", (e) => {
    const b = e.target.closest("[data-peek]");
    if (b) show(b.dataset.peek);
  });
  drawer.querySelector(".drawer-close").addEventListener("click", close);
  document.addEventListener("keydown", (e) => e.key === "Escape" && close());

  // 滚动时每帧最多算一次
  let queued = false;
  scroller.addEventListener("scroll", () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; update(); });
  });
}

/** 提示条上的一句话：代码、收盘、模糊判断、趋势类型。 */
export function updatePeek(a, leanText, trend) {
  $("peek-text").innerHTML = `<b>${a.label}</b> ${a.close.toFixed(2)} · <b>${leanText}</b> · ${trend}`;
}

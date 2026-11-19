// 抽屉：总结卡片和 K 线图滚出视野后，中栏顶部出现提示条；点一下把那一块拉到抽屉里看，收起放回原处。
// 抽屉里放的是原来那个元素本身（图表的范围、画的线都保持），原处留一个同样高的占位，滚动位置不变。
const $ = (id) => document.getElementById(id);

export function initDrawer() {
  const scroller = $("center-scroll");
  const peek = $("peek");
  const drawer = $("drawer");
  const body = drawer.querySelector(".drawer-body");
  const targets = { verdict: () => $("verdict"), chart: () => document.querySelector(".chart-card") };
  let open = null; // { key, el, placeholder }

  const close = () => {
    if (!open) return;
    open.placeholder.replaceWith(open.el);
    drawer.hidden = true;
    peek.querySelectorAll("[data-peek]").forEach((b) => b.setAttribute("aria-pressed", "false"));
    open = null;
    update();
  };
  const show = (key) => {
    if (open?.key === key) return close();
    close();
    const el = targets[key]();
    const placeholder = document.createElement("div");
    placeholder.style.height = `${el.getBoundingClientRect().height}px`; // 带小数，收起后滚动位置一点不差
    el.replaceWith(placeholder);
    body.appendChild(el);
    drawer.style.maxHeight = `${scroller.clientHeight - drawer.offsetTop - 8}px`; // 不盖住下面的输入区
    drawer.hidden = false;
    peek.querySelector(`[data-peek="${key}"]`).setAttribute("aria-pressed", "true");
    open = { key, el, placeholder };
  };

  peek.addEventListener("click", (e) => {
    const b = e.target.closest("[data-peek]");
    if (b) show(b.dataset.peek);
  });
  drawer.querySelector(".drawer-close").addEventListener("click", close);
  document.addEventListener("keydown", (e) => e.key === "Escape" && close());

  // 总结（第一块）一滚出视野就显示提示条；K 线图还露着也一样，用户随时能把两块拉回来。滚动时每帧最多算一次。
  let queued = false;
  const update = () => {
    queued = false;
    const v = targets.verdict();
    const gone = scroller.contains(v) && v.offsetHeight > 0
      && v.getBoundingClientRect().bottom <= scroller.getBoundingClientRect().top + 1;
    peek.hidden = !open && !gone;
  };
  scroller.addEventListener("scroll", () => {
    if (!queued) { queued = true; requestAnimationFrame(update); }
  });
}

/** 提示条上的一句话：代码、收盘、模糊判断、趋势类型。 */
export function updatePeek(a, leanText, trend) {
  $("peek-text").innerHTML = `<b>${a.label}</b> ${a.close.toFixed(2)} · <b>${leanText}</b> · ${trend}`;
}

// 「图层 ▾」菜单：上面一行预设，下面每个图层一行开关。只管 DOM 和键盘；
// 哪行开着、能不能用、现在是哪个预设，都由 layers.js 的表算好，经 render 传进来。
import { LAYERS, PRESETS } from "./layers.js";

/**
 * wrap：工具栏里放菜单的那个空 span。onPreset(预设的 key)、onToggle(图层的 key)：用户点了什么。
 * 返回 render(rows, preset)：rows 是 layers.js 的 layerRows，preset 是 presetOf（null = 自定）。
 */
export function createLayerMenu(wrap, { onPreset, onToggle }) {
  wrap.innerHTML = `<button type="button" class="layers-toggle" aria-expanded="false" aria-haspopup="true">图层 ▾</button>`
    + `<div class="layers-menu" role="group" aria-label="图层：图上画什么" hidden>`
    + `<div class="layers-presets" role="group" aria-label="预设"><span class="lm-cap">预设</span>`
    + PRESETS.map((p) => `<button type="button" data-preset="${p.key}" aria-pressed="false" title="${p.title}">${p.label}</button>`).join("")
    + `<span class="layers-custom" title="手动改过，和三个预设都不一样；点一个预设就换回去" hidden>自定</span></div>`
    + LAYERS.map((l) => `<button type="button" class="layer-item" data-layer="${l.key}" aria-pressed="false">`
      + `<span class="li-check" aria-hidden="true"></span><span class="li-label">${l.label}</span>`
      + `<span class="li-hint"><span class="li-lead"></span><span class="li-text"></span></span></button>`
      + `<p class="layer-note" data-note="${l.key}" hidden></p>`).join("")
    + `</div>`;
  const btn = wrap.querySelector(".layers-toggle");
  const menu = wrap.querySelector(".layers-menu");
  const custom = wrap.querySelector(".layers-custom");

  /** 菜单所在的那个能滚的栏（中栏）。 */
  const scroller = () => {
    for (let el = wrap.parentElement; el; el = el.parentElement) if (/auto|scroll/.test(getComputedStyle(el).overflowY)) return el;
    return null;
  };
  let moved = null; // 打开时为了露出整个菜单把栏滚了多少：{ el, from, to }
  /**
   * back：关上时把打开时滚走的那一段滚回去（用户自己又滚过就不动）。Esc、再点一次「图层」关的滚回去，
   * 图上面的东西（练习的按钮）不会留在视野外面；点菜单外面关的不滚，鼠标正按着别的东西，页面一动就点偏了。
   */
  const setOpen = (open, back = false) => {
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    if (open) {
      const el = scroller();
      const from = el?.scrollTop;
      menu.scrollIntoView({ block: "nearest" }); // 按钮贴着中栏底边时，菜单也整个露出来
      moved = el && el.scrollTop !== from ? { el, from, to: el.scrollTop } : null;
    } else {
      if (back && moved && moved.el.scrollTop === moved.to) moved.el.scrollTop = moved.from;
      moved = null;
    }
  };
  btn.addEventListener("click", () => setOpen(menu.hidden, true));
  menu.addEventListener("click", (e) => {
    const preset = e.target.closest("[data-preset]");
    const layer = e.target.closest("[data-layer]");
    if (preset) onPreset(preset.dataset.preset);
    else if (layer && !layer.disabled) onToggle(layer.dataset.layer);
  });
  // Esc 只关菜单（抢在图表的 Esc 前面：不顺带退出测量、取消聚焦），焦点回到按钮；上下键在能点的项之间走
  document.addEventListener("keydown", (e) => {
    if (menu.hidden) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false, true);
      btn.focus();
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && wrap.contains(document.activeElement)) {
      e.preventDefault();
      const items = [...menu.querySelectorAll("button:not(:disabled)")];
      const at = items.indexOf(document.activeElement);
      const next = e.key === "ArrowDown" ? at + 1 : at < 0 ? items.length - 1 : at - 1;
      items[(next + items.length) % items.length].focus();
    }
  }, true);
  document.addEventListener("mousedown", (e) => { if (!wrap.contains(e.target)) setOpen(false); });

  return {
    render(rows, preset) {
      for (const r of rows) {
        const item = menu.querySelector(`[data-layer="${r.key}"]`);
        item.disabled = Boolean(r.why);
        item.classList.toggle("sub", r.sub);
        item.setAttribute("aria-pressed", String(r.shown));
        item.title = r.why ?? r.title;
        item.querySelector(".li-lead").textContent = r.why ? "" : r.lead ?? "";
        item.querySelector(".li-text").textContent = r.why ?? r.hint; // 不能用时这一行直接写原因
        const note = menu.querySelector(`[data-note="${r.key}"]`);
        note.hidden = !r.note;
        note.textContent = r.note ?? "";
      }
      for (const b of menu.querySelectorAll("[data-preset]")) b.setAttribute("aria-pressed", String(b.dataset.preset === preset));
      custom.hidden = preset !== null;
      btn.title = `图上画什么。现在是「${PRESETS.find((p) => p.key === preset)?.label ?? "自定"}」`;
    },
  };
}

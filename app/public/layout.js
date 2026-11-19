// 页面框架交互：拖拽调整左右栏宽度、回放日期输入框。
const $ = (id) => document.getElementById(id);

const DEFAULTS = { left: 236, right: 384 };
const LIMITS = { left: [180, 420], right: [300, 720] };
const CENTER_MIN = 420;
const KEY = "dma-cols";

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { left: Number(v.left) || DEFAULTS.left, right: Number(v.right) || DEFAULTS.right };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(w) {
  try { localStorage.setItem(KEY, JSON.stringify(w)); } catch { /* 隐私模式 */ }
}

/** 拖拽、方向键、双击复位。宽度存在 localStorage。 */
export function initSplitters() {
  const shell = document.querySelector(".shell");
  const widths = load();

  // 中栏至少留 CENTER_MIN 宽
  const clamp = (side, w) => {
    const [lo, hi] = LIMITS[side];
    const cs = getComputedStyle(shell);
    const gap = parseFloat(cs.getPropertyValue("--gap")) || 16;
    const inner = shell.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2 * gap;
    const other = side === "left" ? widths.right : widths.left;
    return Math.round(Math.max(lo, Math.min(hi, w, inner - other - CENTER_MIN)));
  };
  const apply = () => {
    shell.style.setProperty("--left-w", `${widths.left}px`);
    shell.style.setProperty("--right-w", `${widths.right}px`);
    $("split-left").setAttribute("aria-valuenow", String(widths.left));
    $("split-right").setAttribute("aria-valuenow", String(widths.right));
  };
  const set = (side, w) => {
    widths[side] = clamp(side, w);
    apply();
  };

  for (const [id, side, dir] of [["split-left", "left", 1], ["split-right", "right", -1]]) {
    const el = $(id);
    el.setAttribute("aria-valuemin", String(LIMITS[side][0]));
    el.setAttribute("aria-valuemax", String(LIMITS[side][1]));
    el.title = "拖动调整宽度；双击复位";

    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const startX = e.clientX, startW = widths[side];
      el.classList.add("dragging");
      document.body.classList.add("resizing");
      const move = (ev) => set(side, startW + dir * (ev.clientX - startX));
      const up = () => {
        el.releasePointerCapture(e.pointerId);
        el.classList.remove("dragging");
        document.body.classList.remove("resizing");
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
        save(widths);
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    });
    el.addEventListener("dblclick", () => { set(side, DEFAULTS[side]); save(widths); });
    el.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 48 : 16;
      const delta = e.key === "ArrowRight" ? step : e.key === "ArrowLeft" ? -step : 0;
      if (!delta) return;
      e.preventDefault();
      set(side, widths[side] + dir * delta);
      save(widths);
    });
  }
  apply();
  // 窗口变窄时重新夹一下，避免中栏被挤没
  addEventListener("resize", () => { set("left", widths.left); set("right", widths.right); });
}

/** 回放日期：空的时候显示"最新行情"，聚焦时换成原生日期选择器；选定日期立即回放，× 回到最新。 */
export function initAsofInput({ onChange }) {
  const input = $("load-asof");
  const clear = $("asof-clear");
  const sync = () => { clear.hidden = !input.value; };
  input.addEventListener("focus", () => {
    input.type = "date";
    input.max = new Date().toISOString().slice(0, 10);
  });
  input.addEventListener("blur", () => {
    if (!input.value) input.type = "text";
    sync();
  });
  input.addEventListener("change", () => {
    sync();
    if (/^\d{4}-\d{2}-\d{2}$/.test(input.value)) onChange(input.value);
  });
  clear.addEventListener("click", () => {
    input.value = "";
    input.type = "text";
    sync();
    onChange(null);
  });
  return { sync };
}

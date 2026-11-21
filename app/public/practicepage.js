// 练习页：顶栏「练习」打开，盖住整个工作台。关掉就回到工作台，工作台的票、图、对话都没动过。
// 两种练习：识别题（几秒一题）、综合题（整笔盲测，在工作台里做）。选哪种记在本机。

const $ = (id) => document.getElementById(id);
const MODES = ["drill", "combo"];
let onMode = () => {};
let beforeOpen = () => {};
let returnFocus = null;

export const isOpen = () => !$("practice-page").hidden;

function selectMode(name) {
  for (const m of MODES) {
    const tab = $(`pp-tab-${m}`);
    if (!tab) continue;
    tab.setAttribute("aria-selected", String(m === name));
    $(`pp-${m}`).hidden = m !== name;
  }
  try { localStorage.setItem("dma-practice-mode", name); } catch { /* 隐私模式 */ }
  onMode(name);
}

export function openPage(mode) {
  const page = $("practice-page");
  if (page.hidden) {
    beforeOpen();
    returnFocus = document.activeElement;
  }
  page.hidden = false;
  $("practice-btn").setAttribute("aria-expanded", "true");
  let m = mode;
  if (!m) try { m = localStorage.getItem("dma-practice-mode"); } catch { /* 隐私模式 */ }
  selectMode(MODES.includes(m) && $(`pp-tab-${m}`) ? m : MODES.find((x) => $(`pp-tab-${x}`)));
}

export function closePage() {
  const page = $("practice-page");
  if (page.hidden) return;
  page.hidden = true;
  $("practice-btn").setAttribute("aria-expanded", "false");
  returnFocus?.focus?.();
}

/** opts.onMode(mode)：切到某种练习时调（识别题第一次打开时取题）；opts.beforeOpen()：打开前关掉别的整页（回测）。 */
export function initPracticePage(opts = {}) {
  onMode = opts.onMode ?? onMode;
  beforeOpen = opts.beforeOpen ?? beforeOpen;
  $("practice-btn").setAttribute("aria-expanded", "false");
  $("practice-btn").addEventListener("click", () => (isOpen() ? closePage() : openPage()));
  $("practice-close").addEventListener("click", closePage);
  for (const m of MODES) $(`pp-tab-${m}`)?.addEventListener("click", () => selectMode(m));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen() && !document.querySelector("dialog[open]")) closePage();
  });
}

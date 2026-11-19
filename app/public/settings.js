// 设置面板：大模型、市场数据、语音播报。改了立刻保存到服务端（data/settings.json）。
import { speak, speakingId, stopSpeaking } from "./speech.js";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let view = null; // { settings, models, dataSources, voices }

/** 当前设置（语音模块按 agent 取声音用）。 */
export const currentSettings = () => view?.settings ?? null;

const PREVIEW = {
  voiceAnalyst: "我是分析师。现在六条均线都向下，明显偏空。收盘站上 EMA20，才是第一个转折信号。",
  voiceAdvisor: "我是鸿雁。抵扣价就是均线明天要扣掉的那天收盘价。收盘价高于它，均线就往上走。",
};

export const shortModel = (id) => String(id ?? "").split("/").pop();

/** 把当前模型显示在两个面板的标题里。 */
export function paintModelBadges(settings) {
  const m = view?.models.find((x) => x.id === settings.model);
  document.querySelectorAll("[data-model-badge]").forEach((el) => {
    el.textContent = shortModel(settings.model);
    el.classList.toggle("metered", m?.billing === "按量计费");
    el.title = m ? `${m.label} · ${m.billing}` : settings.model;
  });
}

function render() {
  const panel = $("settings-panel");
  const { settings, models, dataSources } = view;
  panel.innerHTML = `
    <div class="sp-head"><b>设置</b><button type="button" class="close" aria-label="关闭">×</button></div>
    <fieldset><legend>大模型 <span>分析师、鸿雁、动态问法共用</span></legend>
      ${models.map((m) => `
        <label class="opt ${m.ready ? "" : "disabled"}">
          <input type="radio" name="model" value="${esc(m.id)}" ${m.id === settings.model ? "checked" : ""} ${m.ready ? "" : "disabled"}>
          <span class="opt-main"><b>${esc(m.label)}</b>
            <span class="bill ${m.billing === "按量计费" ? "metered" : "sub"}">${esc(m.billing)}</span>
            ${m.id === models[0].id ? '<span class="dflt">默认</span>' : ""}</span>
          <span class="opt-note">${esc(m.note)}${m.ready ? "" : `<br><b class="bad">${esc(m.authHint)}</b>`}</span>
        </label>`).join("")}
    </fieldset>
    <fieldset><legend>市场数据 <span>图表、报告、分析师取数共用</span></legend>
      ${dataSources.map((d, i) => `
        <label class="opt">
          <input type="radio" name="dataSource" value="${esc(d.id)}" ${d.id === settings.dataSource ? "checked" : ""}>
          <span class="opt-main"><b>${esc(d.label)}</b>${i === 0 ? '<span class="dflt">默认</span>' : ""}</span>
          <span class="opt-note">${esc(d.note)}</span>
        </label>`).join("")}
    </fieldset>
    <fieldset><legend>语音播报 <span>微软 Edge 在线语音，回答的文字会发到微软的服务</span></legend>
      ${!view.voices ? `<p class="bad">服务端还是旧版本，没有语音选项：请重启服务（just wildgoose）后刷新页面。</p>` : `
      ${[["voiceAnalyst", "分析师"], ["voiceAdvisor", "鸿雁"]].map(([key, who]) => `
        <div class="voice-row">
          <label for="sp-${key}">${who}</label>
          <select id="sp-${key}" name="${key}">
            ${["男", "女"].map((g) => `<optgroup label="${g}声">${view.voices.filter((v) => v.gender === g).map((v) => `
              <option value="${esc(v.id)}" ${v.id === settings[key] ? "selected" : ""}>${esc(v.label)} · ${esc(v.note)}</option>`).join("")}</optgroup>`).join("")}
          </select>
          <button type="button" class="ghost preview" data-preview="${key}">试听</button>
        </div>`).join("")}
      <label class="opt check"><input type="checkbox" name="autoSpeak" ${settings.autoSpeak ? "checked" : ""}>
        <span class="opt-main"><b>回答完自动朗读</b></span>
        <span class="opt-note">关掉时，点每条回答旁的「▶ 朗读」。</span></label>`}
    </fieldset>
    <p class="sp-status" id="sp-status" aria-live="polite"></p>`;
}

/** onDataSourceChange：数据源变了以后重新取数。 */
let openPanel = () => {};
/** 顶栏状态胶囊点了也打开设置。 */
export const openSettings = () => openPanel();

export async function initSettings({ onDataSourceChange }) {
  const btn = $("settings-btn");
  const panel = $("settings-panel");
  view = await (await fetch("/api/settings")).json();
  paintModelBadges(view.settings);

  const open = () => { render(); panel.hidden = false; btn.setAttribute("aria-expanded", "true"); };
  const close = () => { panel.hidden = true; btn.setAttribute("aria-expanded", "false"); };
  openPanel = open;
  btn.addEventListener("click", () => (panel.hidden ? open() : close()));
  document.addEventListener("keydown", (e) => e.key === "Escape" && close());
  document.addEventListener("mousedown", (e) => {
    if (!panel.hidden && !e.target.closest("#settings-panel, #settings-btn, [data-open-settings]")) close();
  });
  panel.addEventListener("click", (e) => {
    if (e.target.closest(".close")) return close();
    const btn = e.target.closest("[data-preview]");
    if (!btn) return;
    const id = `preview-${btn.dataset.preview}`;
    if (speakingId() === id) return stopSpeaking();
    speak(id, PREVIEW[btn.dataset.preview], view.settings[btn.dataset.preview], (state, error) => {
      btn.textContent = state !== "idle" ? "停止" : error ? "试听失败" : "试听";
      if (error) $("sp-status").textContent = error;
    });
  });

  panel.addEventListener("change", async (e) => {
    const input = e.target.closest("input[type=radio], input[type=checkbox], select");
    if (!input) return;
    const value = input.type === "checkbox" ? input.checked : input.value;
    const status = $("sp-status");
    const before = view.settings;
    status.textContent = "保存中…";
    const res = await fetch("/api/settings", { method: "PUT", body: JSON.stringify({ [input.name]: value }) });
    const body = await res.json();
    if (!res.ok) {
      status.textContent = body.error;
      status.className = "sp-status bad";
      render();
      return;
    }
    view = body;
    render();
    $("sp-status").textContent =
      input.name === "model" ? `已切换到 ${shortModel(view.settings.model)}。下一次提问生效，对话上下文保留。` :
      input.name === "dataSource" ? "已切换数据源，正在重新取数…" : "已保存。";
    paintModelBadges(view.settings);
    if (input.name === "dataSource" && before.dataSource !== view.settings.dataSource) onDataSourceChange();
  });
}

/** 其他页面改了设置（WebSocket 推过来）。 */
export function applyRemoteSettings(settings, { onDataSourceChange }) {
  const changedSource = view && view.settings.dataSource !== settings.dataSource;
  if (view) view.settings = settings;
  paintModelBadges(settings);
  if (changedSource) onDataSourceChange();
}

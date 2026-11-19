// 设置面板：大模型、市场数据、语音播报。改了立刻保存到服务端（data/settings.json）。
import { speak, speakingId, stopSpeaking } from "./speech.js";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let view = null; // { settings, models, thinkingLevels, effective, dataSources, voices }

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
    el.classList.toggle("metered", Boolean(m) && m.billing !== "订阅");
    el.title = m ? `${m.id} · ${m.billing}` : `${settings.model}（没在 pi 里登录）`;
  });
}

const THINK_LABEL = { off: "关", minimal: "最少", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高" };

/** 当前模型的说明：计费、验证过没有、能不能看图。 */
function modelNote(m) {
  if (!m) return `<b class="bad">当前模型 ${esc(view.settings.model)} 不可用：它的 provider 没在 pi 里登录。在终端运行 pi，输入 /login 登录后刷新，或在上面换一个。</b>`;
  return [
    m.billing === "订阅" ? "订阅登录，不额外花钱。" : m.billing === "按量计费" ? "按量计费：在 Pi 里走 API，按 token 收费。" : "计费方式未知：Pi 没标明它是订阅。",
    m.verified ? "已验证：引用格式、工具调用实测过。" : "未验证：引用格式、工具调用没实测过，回答里可能有标红的引用。",
    m.image ? "" : "不能看图：附件里的截图它看不到。",
  ].filter(Boolean).join("");
}

function modelSection() {
  const { settings, models } = view;
  // 旧服务端（pull 了新页面、旧进程还在跑）：没有动态清单和思考程度，别按新格式硬画
  if (!view.thinkingLevels) {
    return `<fieldset><legend>大模型</legend><p class="bad">服务端还是旧版本，没有模型清单和思考程度：请重启服务（just wildgoose）后刷新页面。当前模型 ${esc(settings.model)}。</p></fieldset>`;
  }
  const groups = [...new Set(models.map((m) => m.provider))];
  const current = models.find((m) => m.id === settings.model);
  return `<fieldset><legend>大模型 <span>分析师、鸿雁、动态问法共用；列的是你在 pi 里登录过的</span></legend>
      <select id="sp-model" name="model" aria-label="大模型">
        ${current ? "" : `<option value="" selected disabled>${esc(settings.model)}（不可用）</option>`}
        ${groups.map((p) => {
          const ms = models.filter((m) => m.provider === p);
          return `<optgroup label="${esc(p)} · ${esc(ms[0].billing)}">${ms.map((m) => `
            <option value="${esc(m.id)}" ${m.id === settings.model ? "selected" : ""}>${esc(m.id.split("/").pop())}${m.verified ? " · 已验证" : ""}</option>`).join("")}</optgroup>`;
        }).join("")}
      </select>
      <p class="opt-note">${modelNote(current)}</p>
      <div class="sp-confirm" id="sp-confirm" hidden></div>
    </fieldset>
    <fieldset><legend>思考程度 <span>越高越慢；按量计费时也越贵</span></legend>
      ${[["thinkingAnalyst", "分析师", "analyst"], ["thinkingAdvisor", "鸿雁", "advisor"]].map(([key, who, role]) => {
        const eff = view.effective?.[role];
        const want = settings[key];
        return `<div class="voice-row">
          <label for="sp-${key}">${who}</label>
          <select id="sp-${key}" name="${key}">${view.thinkingLevels.map((l) => `
            <option value="${l}" ${l === want ? "selected" : ""}>${THINK_LABEL[l] ?? l} · ${l}</option>`).join("")}</select>
          ${eff && eff !== want ? `<span class="opt-note">${esc(shortModel(settings.model))} 没有 ${want}，实际用 ${eff}</span>` : ""}
        </div>`;
      }).join("")}
    </fieldset>`;
}

function render() {
  const panel = $("settings-panel");
  const { settings, dataSources } = view;
  panel.innerHTML = `
    <div class="sp-head"><b>设置</b><button type="button" class="close" aria-label="关闭">×</button></div>
    ${modelSection()}
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
  // 面板开着时整页压在暗幕下（app.css body::after），点哪儿都落在 body 上 → 关；
  // 下面排除设置按钮和状态胶囊，只对面板关着时有意义（让它们的 click 去打开）
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

  /** 保存一项设置；name 决定成功后说什么。 */
  async function save(name, value) {
    const status = $("sp-status");
    const before = view.settings;
    status.textContent = "保存中…";
    const res = await fetch("/api/settings", { method: "PUT", body: JSON.stringify({ [name]: value }) });
    const body = await res.json();
    if (!res.ok) {
      render();
      $("sp-status").textContent = body.error;
      $("sp-status").className = "sp-status bad";
      return;
    }
    view = body;
    render();
    $("sp-status").textContent =
      name === "model" ? `已切换到 ${shortModel(view.settings.model)}。下一次提问生效，对话上下文保留。` :
      name === "dataSource" ? "已切换数据源，正在重新取数…" : "已保存。下一次提问生效。";
    paintModelBadges(view.settings);
    if (name === "dataSource" && before.dataSource !== view.settings.dataSource) onDataSourceChange();
  }

  panel.addEventListener("change", async (e) => {
    const input = e.target.closest("input[type=radio], input[type=checkbox], select");
    if (!input) return;
    const value = input.type === "checkbox" ? input.checked : input.value;
    // 不是订阅的模型：先确认再切（按量计费每次提问都花钱）
    const m = input.name === "model" && view.models.find((x) => x.id === value);
    if (m && m.billing !== "订阅") {
      const box = $("sp-confirm");
      box.innerHTML = `<p><b>${esc(m.id)}</b> ${m.billing === "按量计费" ? "按量计费（在 Pi 里走 API）" : "计费方式未知"}：每次提问都可能花钱。</p>
        <button type="button" id="sp-confirm-yes">确认切换</button> <button type="button" class="ghost" id="sp-confirm-no">取消</button>`;
      box.hidden = false;
      $("sp-confirm-yes").onclick = () => save("model", value);
      $("sp-confirm-no").onclick = () => render();
      return;
    }
    await save(input.name, value);
  });
}

/** 其他页面改了设置（WebSocket 推过来）。 */
export function applyRemoteSettings(settings, { onDataSourceChange }) {
  const changedSource = view && view.settings.dataSource !== settings.dataSource;
  if (view) view.settings = settings;
  paintModelBadges(settings);
  if (changedSource) onDataSourceChange();
  // 实际用的思考程度、清单也可能变了：重新取一遍。面板开着就重画，但确认框开着时不动它；
  // 自己保存后的回声也会走到这里，重画时保留状态行（"已切换到 …"）
  fetch("/api/settings").then((r) => r.json()).then((v) => {
    if (!v.settings) return;
    view = v;
    paintModelBadges(view.settings);
    if ($("settings-panel").hidden || $("sp-confirm")?.hidden === false) return;
    const { textContent, className } = $("sp-status");
    render();
    Object.assign($("sp-status"), { textContent, className });
  }).catch(() => {});
}

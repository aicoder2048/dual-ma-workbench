// K 线 + 6 条均线 + 抵扣价小黄点 + 成交量（TradingView lightweight-charts 4.2.0）。
import { DEFAULT_SPEED, OFF, SPEEDS, appendDelta, earliestIndex, indexOnOrBefore, randomIndex, sliceAt, speedMs, step } from "./replay.js";

const SPECS = [];
[20, 60, 120].forEach((n) => ["MA", "EMA"].forEach((k) =>
  SPECS.push({ key: k + n, token: `--${k.toLowerCase()}${n}`, dashed: k === "EMA", width: k === "MA" ? 2 : 1 })));
// MA200 朴素规则的对照线：默认不画，在图例里点开
SPECS.push({ key: "MA200", token: "--ma200", dashed: false, width: 1, off: true });

/** 图表库传来的时间（"2026-10-22"、{year,month,day} 或 UTC 秒）→ "2026-10-22"。 */
function isoDate(t) {
  if (typeof t === "string") return t;
  if (typeof t === "number") return new Date(t * 1000).toISOString().slice(0, 10);
  return `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
}

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// 破线拐头着色：tone 由 Python 算好（见 html_report.bar_tones），这里只查颜色
const TONE_TOKENS = { bull: "--bar-bull", bear: "--bar-bear", mixed: "--bar-mixed" };
const TONE_TITLE = [
  "破线拐头信号着色：按 20 线有没有破线拐头给 K 线上色（点击开 / 关）",
  "绿：收盘在 MA20 上方，且高于 20 日抵扣价（MA20 向上）",
  "黑：两样都不满足（MA20 向下）。第一根黑柱就是破线拐头信号",
  "灰：只满足一样，过渡状态",
].join("&#10;");

export function createChart(box, legendEl) {
  if (!window.LightweightCharts) {
    box.innerHTML = '<p class="caption">图表库没能从 CDN 加载，请检查网络。</p>';
    return null;
  }
  box.innerHTML = "";
  // 盲测练习：时间键是挪过的日期，显示时换成 T+n（setTimeLabel）；平时原样
  let timeLabel = null;
  const showTime = (t) => (timeLabel ? timeLabel(isoDate(t)) ?? isoDate(t) : isoDate(t));
  const chart = LightweightCharts.createChart(box, {
    autoSize: true,
    rightPriceScale: { scaleMargins: { top: 0.06, bottom: 0.24 } },
    // 练习时坐标轴的刻度也写 T+n；返回 null 用默认刻度
    timeScale: { rightOffset: 4, tickMarkFormatter: (t) => (timeLabel ? showTime(t) : null) },
    // 十字线底部的日期统一写成 2026-10-22（默认按浏览器语言写成 "22 10月 '26"，不好读）
    localization: { timeFormatter: showTime },
    crosshair: { mode: 0 },
    // 滚轮只滚页面，不缩放图表（误触太多）；缩放用 ⌘/Ctrl + 滚轮（见下方 wheel 处理），按住拖动平移
    handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true },
  });
  const candles = chart.addCandlestickSeries({ priceLineVisible: false });
  const vol = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  const series = {};
  for (const s of SPECS) {
    series[s.key] = chart.addLineSeries({ lineWidth: s.width, lineStyle: s.dashed ? 2 : 0, visible: !s.off,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  }

  legendEl.innerHTML = "";
  for (const s of SPECS) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-pressed", String(!s.off));
    b.dataset.line = s.key;
    if (s.off) b.title = "MA200 朴素规则的对照线（收盘在上方持有，否则空仓），默认不画";
    b.innerHTML = `<i class="${s.dashed ? "dash" : ""}" style="--c: var(${s.token})"></i>${s.key}`;
    b.addEventListener("click", () => {
      const on = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", String(on));
      series[s.key].applyOptions({ visible: on });
      showReadout(null);
    });
    legendEl.appendChild(b);
  }

  // 对数坐标：等比涨幅等高，钟表方向才可比（文章 2.4）。默认开，记在本机。
  let logScale = true;
  try { logScale = localStorage.getItem("dma-log") !== "0"; } catch { /* 隐私模式 */ }
  const logBtn = document.createElement("button");
  logBtn.type = "button";
  logBtn.className = "scale-toggle";
  logBtn.title = "对数坐标下，同样的涨跌幅画出来一样高，均线的角度才能比较";
  const applyScale = () => {
    chart.priceScale("right").applyOptions({ mode: logScale ? 1 : 0 });
    logBtn.setAttribute("aria-pressed", String(logScale));
    logBtn.textContent = logScale ? "对数坐标" : "普通坐标";
  };
  logBtn.addEventListener("click", () => {
    logScale = !logScale;
    try { localStorage.setItem("dma-log", logScale ? "1" : "0"); } catch { /* 忽略 */ }
    applyScale();
  });
  legendEl.appendChild(logBtn);
  applyScale();

  // ---------- 读数条：鼠标停在哪天显示哪天，移开显示最新一天 ----------
  const readout = document.createElement("div");
  readout.id = "chart-readout";
  readout.className = "chart-readout";
  box.before(readout);
  const f2 = (x) => (x == null ? "—" : x.toFixed(2));
  const showReadout = (time) => {
    if (!view?.candles.length) { readout.textContent = ""; return; }
    const c = view.candles.find((x) => x.time === time) ?? view.candles.at(-1);
    const at = (k) => (view.lines[k] || []).find((p) => p.time === c.time)?.value;
    readout.innerHTML = `<b>${showTime(c.time)}</b><span>收 <b>${f2(c.close)}</b></span>`
      + SPECS.filter((sp) => series[sp.key].options().visible).map((sp) => `<span><i class="${sp.dashed ? "dash" : ""}" style="--c: var(${sp.token})"></i>${sp.key} ${f2(at(sp.key))}</span>`).join("");
  };
  chart.subscribeCrosshairMove((param) => showReadout(param.time));

  // ---------- 范围按钮：固定时长看斜率（文章 2.4：短期看 1 年） ----------
  // [键, 按钮, 往回看几天]
  const RANGES = [["1w", "1 周", 7], ["1m", "1 月", 31], ["6m", "半年", 183], ["1y", "1 年", 365], ["all", "全部", null]];
  let rangeKey = "1y";
  const tools = document.createElement("div");
  tools.className = "chart-tools";
  tools.innerHTML = RANGES.map(([k, label]) => `<button type="button" class="range-btn" data-range="${k}">${label}</button>`).join("")
    + `<button type="button" class="range-btn" data-range="reset" title="回到当前范围的默认视图">复位</button>`
    + `<button type="button" class="replay-toggle" aria-pressed="false" title="从过去某一天开始，一根一根往后放 K 线">回放</button>`
    + `<button type="button" class="draw-toggle" aria-pressed="false" title="点这里，再点图上任意一处，就在那个价位画一条横线">画线</button>`
    + `<button type="button" class="draw-clear" title="删掉这只股票上自己画的线">清除</button>`
    + `<button type="button" class="tone-toggle" title="${TONE_TITLE}">`
    + `${Object.values(TONE_TOKENS).map((t) => `<i style="--c: var(${t})"></i>`).join("")}着色</button>`
    + `<button type="button" class="levels-toggle" aria-pressed="true" title="把结论里的触发价、止损和推翻判断的价位画成虚线">价位线</button>`
    + `<button type="button" class="chart-help-toggle" aria-expanded="false">怎么用</button>`;
  legendEl.after(tools);

  // 破线拐头信号着色：默认开，记在本机
  let toneOn = true;
  try { toneOn = localStorage.getItem("dma-tone") !== "0"; } catch { /* 隐私模式 */ }
  const toneBtn = tools.querySelector(".tone-toggle");
  toneBtn.setAttribute("aria-pressed", String(toneOn));
  toneBtn.addEventListener("click", () => {
    toneOn = !toneOn;
    toneBtn.setAttribute("aria-pressed", String(toneOn));
    try { localStorage.setItem("dma-tone", toneOn ? "1" : "0"); } catch { /* 忽略 */ }
    paint();
  });
  const applyRange = () => {
    tools.querySelectorAll(".range-btn").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.range === rangeKey)));
    if (!view?.candles.length) return;
    const days = RANGES.find(([k]) => k === rangeKey)[2];
    const last = view.candles.at(-1).time; // 回放时以回放到的那天为准
    if (!days) { chart.timeScale().fitContent(); return; }
    const from = new Date(last);
    from.setDate(from.getDate() - days);
    const first = view.candles.find((c) => c.time >= from.toISOString().slice(0, 10))?.time ?? view.candles[0].time;
    chart.timeScale().setVisibleRange({ from: first, to: last });
  };
  tools.addEventListener("click", (e) => {
    const b = e.target.closest(".range-btn");
    if (!b) return;
    if (b.dataset.range !== "reset") rangeKey = b.dataset.range;
    applyRange();
  });

  // ---------- ⌘ / Ctrl + 滚轮缩放（触控板捏合也会带 ctrlKey）；只滚轮就让页面滚 ----------
  box.addEventListener("wheel", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const ts = chart.timeScale();
    const r = ts.getVisibleLogicalRange();
    if (!r) return;
    const span = r.to - r.from;
    const next = Math.min(Math.max(span * Math.exp(e.deltaY / 300), 5), (data?.candles.length ?? 500) + 10);
    ts.setVisibleLogicalRange({ from: r.to - next, to: r.to }); // 以最右边（最新一天）为锚
  }, { passive: false });

  // ---------- 价位线：结论里的触发价、止损，和做推演里推翻判断的价位 ----------
  const LEVEL_COLOR = { trigger: "--up", stop: "--down", invalid: "--neutral" };
  let levels = [];
  let levelLines = [];
  let levelsOn = true;
  const levelsShown = () => levelsOn && rs.mode !== "replay"; // 价位线属于最新一天，回放时收起
  const paintLevels = () => {
    levelLines.forEach((l) => candles.removePriceLine(l));
    levelLines = levelsShown() ? levels.map((lv) => candles.createPriceLine({
      price: lv.price, color: css(LEVEL_COLOR[lv.kind]), lineWidth: 1, lineStyle: 2,
      axisLabelVisible: true, title: lv.title,
    })) : [];
  };
  const levelsBtn = tools.querySelector(".levels-toggle");
  levelsBtn.addEventListener("click", () => {
    levelsOn = !levelsOn;
    levelsBtn.setAttribute("aria-pressed", String(levelsOn));
    paintLevels();
  });

  // ---------- 怎么用：四种常见用法，在这套方法里看什么 ----------
  const help = document.createElement("div");
  help.className = "chart-help";
  help.hidden = true;
  help.innerHTML = `
    <p><b>悬停读数</b>：鼠标停在某天，上方显示那天的收盘和 6 条线。用来看"那次回调碰到了哪条线、守没守住"。</p>
    <p><b>缩放</b>：按住 ⌘（或 Ctrl）滚轮，或触控板双指捏合，以最新一天为准放大缩小；按住拖动可以左右平移。只滚轮时滚动的是页面。</p>
    <p><b>固定范围</b>（1 周 / 1 月 / 半年 / 1 年 / 全部）：均线的斜率（几点钟方向）只有在同样长的时间里比才不失真，所以要固定时长、用对数坐标。
      <b>1 年</b>（默认）判断现在是几点钟、属于哪种趋势；<b>全部</b>看大周期和横盘有多长（"横有多长，竖有多高"）；<b>半年</b>看最近的细节，比如这次回调比上次深还是浅；<b>1 周、1 月</b>看最近几根 K 线怎么走。</p>
    <p><b>画线</b>：点「画线」，再点图上一处，就在那个价位画一条横线，刷新后还在。常画的是前高、前低、自己的成本价、"跌破就重新看"的价位。
      图上的<b>虚线价位线</b>是自动画的：绿色是结论里的触发价（不买的打法是"先看"），红色是止损，黄色是推翻判断的价位。</p>
    <p><b>着色</b>：绿 = 收盘在 MA20 上方且高于 20 日抵扣价（MA20 向上）；黑 = 两样都不满足（MA20 向下）；灰 = 只满足一样。
      第一根黑柱就是 20 线破线拐头；连续黑柱、收不回去，才说明拐头确认了。点工具栏里的「着色」可以关掉。</p>
    <p><b>看量</b>：底部的量柱，黄色是超过 50 日均量 2 倍的大量。看两种情况：横盘末期突然放量，是要变盘的信号；
      急涨或急跌的末端连续放量，说明多空分歧在化解，行情往往快要转向，并不代表强势。看到放量先提高警惕，动手还是要等均线拐头。</p>
    <p><b>回放</b>：点「回放」，再点图上的一天（或在「选起点」里选日期、最早一天、随机一天），图上就只剩那天及以前的 K 线，
      并立刻开始一根一根往后放（默认一秒一根，「回放」按钮下方的控制条可以暂停、前进一根、调速度），像当时身在其中那样练判断：先想好"这里该怎么做"，再放下一根看结果。快捷键 <b>Shift+↓</b> 播放 / 暂停，<b>Shift+→</b> 前进一根，<b>Shift+←</b> 回退一根（回退会停下播放）。
      想看那天的完整分析，点「按这一天分析」。点「回到最新」或 × 退出。</p>`;
  tools.after(help);
  const helpBtn = tools.querySelector(".chart-help-toggle");
  helpBtn.addEventListener("click", () => {
    help.hidden = !help.hidden;
    helpBtn.setAttribute("aria-expanded", String(!help.hidden));
  });

  // ---------- 自己画的水平线：按股票记在本机浏览器里 ----------
  let drawKey = null; // 当前股票
  let drawn = []; // 价格
  let drawnLines = [];
  let drawing = false;
  const storeKey = () => `dma-lines:${drawKey}`;
  const loadDrawn = () => {
    try { drawn = JSON.parse(localStorage.getItem(storeKey()) ?? "[]").filter(Number.isFinite); } catch { drawn = []; }
  };
  const saveDrawn = () => {
    try { localStorage.setItem(storeKey(), JSON.stringify(drawn)); } catch { /* 隐私模式：只在本页有效 */ }
  };
  const paintDrawn = () => {
    drawnLines.forEach((l) => candles.removePriceLine(l));
    drawnLines = drawn.map((price) => candles.createPriceLine({
      price, color: css("--accent"), lineWidth: 1, lineStyle: 0, axisLabelVisible: true, title: "我的线",
    }));
  };
  const drawBtn = tools.querySelector(".draw-toggle");
  const setDrawing = (on) => {
    drawing = on;
    drawBtn.setAttribute("aria-pressed", String(on));
    drawBtn.textContent = on ? "点图上的价位…" : "画线";
    box.classList.toggle("drawing", on);
  };
  drawBtn.addEventListener("click", () => setDrawing(!drawing));
  tools.querySelector(".draw-clear").addEventListener("click", () => {
    drawn = [];
    saveDrawn();
    paintDrawn();
  });
  chart.subscribeClick((param) => {
    if (!drawing || rs.mode === "select" || !param.point) return;
    const price = candles.coordinateToPrice(param.point.y);
    if (price == null) return;
    drawn.push(Math.round(price * 100) / 100);
    saveDrawn();
    paintDrawn();
    setTimeout(() => setDrawing(false)); // 同一次点击的其他处理（问鸿雁）还要看到"正在画线"
  });

  let data = null; // 完整数据
  let view = null; // 图上画着的：平时就是 data，回放时是截到那天的
  let toneColors = {}; // tone → 颜色，换主题时在 paint 里重取

  /** 一根 K 线 → 图表库的数据点（新对象：图表库会把 time 就地改成 {year, month, day}）。阳线空心、阴线实心。 */
  function candleBar(c) {
    const bar = { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close };
    const color = toneOn && toneColors[c.tone];
    if (!color) return bar;
    return { ...bar, color: c.close >= c.open ? "rgba(0,0,0,0)" : color, borderColor: color, wickColor: color };
  }

  function paint() {
    if (!view) return;
    const muted = css("--muted");
    chart.applyOptions({
      layout: { background: { type: "solid", color: css("--card") }, textColor: muted, fontFamily: css("--mono") },
      grid: { vertLines: { color: css("--grid") }, horzLines: { color: css("--grid") } },
      rightPriceScale: { borderColor: css("--line") }, timeScale: { borderColor: css("--line") },
    });
    candles.applyOptions({ upColor: "rgba(0,0,0,0)", downColor: muted, borderUpColor: muted, borderDownColor: muted, wickUpColor: muted, wickDownColor: muted });
    toneColors = Object.fromEntries(Object.entries(TONE_TOKENS).map(([k, t]) => [k, css(t)]));
    candles.setData(view.candles.map(candleBar));
    vol.setData(view.volume.map(volBar));
    for (const s of SPECS) series[s.key].applyOptions({ color: css(s.token) });
    paintLevels();
    paintMarkers();
  }
  const volBar = (v) => ({ time: v.time, value: v.value, color: css(v.spike ? "--drop" : "--line") });
  function paintMarkers() {
    const drop = css("--drop");
    candles.setMarkers(view.drops.slice().sort((a, b) => (a.time < b.time ? -1 : 1)).map((d) => ({
      time: d.time, position: "belowBar", color: drop, shape: "circle", text: `${d.period}扣`,
    })));
  }
  /** 把一份图表数据（完整的，或回放截到某天的）画到图上。 */
  function show(v) {
    view = v;
    for (const s of SPECS) series[s.key].setData(v.lines[s.key] || []);
    paint();
    showReadout(null);
  }

  // ---------- 回放：从过去某一天开始，一根一根往后放（状态机在 replay.js） ----------
  let rs = OFF;
  let timer = null;
  let analyzeDate = null;
  let speed = DEFAULT_SPEED;
  try { speed = SPEEDS.find((x) => String(x) === localStorage.getItem("dma-replay-speed")) ?? DEFAULT_SPEED; } catch { /* 隐私模式 */ }

  const replayBtn = tools.querySelector(".replay-toggle");
  const badge = document.createElement("span");
  badge.className = "replay-badge";
  badge.textContent = "回放中";
  badge.hidden = true;
  box.closest(".chart-card")?.querySelector(".card-head h2")?.append(badge);

  // 选起点时的竖线 + 右边变暗 + 日期（盖在图上，不挡鼠标）
  const overlay = document.createElement("div");
  overlay.className = "replay-overlay";
  overlay.hidden = true;
  overlay.innerHTML = '<div class="replay-dim"></div><div class="replay-line"></div><div class="replay-date"></div>';
  box.append(overlay);
  const [dimEl, lineEl, dateEl] = overlay.children;

  const bar = document.createElement("div");
  bar.className = "replay-bar";
  bar.hidden = true;
  bar.innerHTML = `
    <span class="replay-start-wrap">
      <button type="button" class="replay-start" aria-expanded="false">选起点 ▾</button>
      <span class="replay-menu" hidden>
        <button type="button" data-start="click">点图选择</button>
        <label>选日期 <input type="date"></label>
        <button type="button" data-start="earliest" title="图上 6 条线都有值的第一天">最早一天</button>
        <button type="button" data-start="random">随机一天</button>
      </span>
    </span>
    <button type="button" class="replay-play" aria-pressed="false" title="播放 / 暂停（Shift+↓）">▶ 播放</button>
    <button type="button" class="replay-back" title="回退一根（Shift+←）">回退一根</button>
    <button type="button" class="replay-forward" title="前进一根（Shift+→）">前进一根</button>
    <select class="replay-speed" title="播放速度：1x = 一秒一根">${SPEEDS.map((x) => `<option value="${x}">${x}x</option>`).join("")}</select>
    <button type="button" class="replay-realtime">回到最新</button>
    <span class="replay-label" aria-live="polite"></span>
    <button type="button" class="replay-analyze" title="退出回放，载入只用这一天及以前数据的完整分析">按这一天分析</button>
    <button type="button" class="replay-exit" aria-label="退出回放" title="退出回放">×</button>`;
  tools.after(bar); // 紧挨着「回放」按钮，在图上方：图下方会被长风输入框挡住
  const $r = (sel) => bar.querySelector(sel);
  const menu = $r(".replay-menu");
  const speedSel = $r(".replay-speed");
  speedSel.value = String(speed);

  const setMenu = (open) => {
    menu.hidden = !open;
    $r(".replay-start").setAttribute("aria-expanded", String(open));
  };

  /** 状态机走一步，再把图和按钮对上。定时器每次都先清掉，只有在播放才重新挂。 */
  function dispatch(action) {
    if (!data) return;
    const prev = rs;
    rs = step(rs, action, data.candles.length);
    if (rs !== prev) renderReplay(prev);
    arm();
  }
  function arm() {
    clearTimeout(timer);
    timer = rs.mode === "replay" && rs.playing ? setTimeout(() => dispatch({ type: "forward" }), speedMs(speed)) : null;
  }

  function renderReplay(prev) {
    if (rs.mode !== "replay") {
      if (view !== data) {
        // 回放中重选起点：视图留在原处（逻辑序号前后一致），退出回放才回到默认范围
        const r = rs.mode === "select" ? chart.timeScale().getVisibleLogicalRange() : null;
        show(data);
        if (r) chart.timeScale().setVisibleLogicalRange(r); else applyRange();
      }
    } else if (prev.mode === "replay" && rs.index === prev.index + 1) {
      appendBar(rs.index);
    } else if (prev.mode !== "replay" || rs.index !== prev.index) {
      const r = chart.timeScale().getVisibleLogicalRange();
      show(sliceAt(data, rs.index));
      // 回退一根时，用户把图拖到别处看（回放那根不在视图里）：视图留在原处，和前进一样不拉回来
      const away = prev.mode === "replay" && rs.index === prev.index - 1 && r && r.to < prev.index;
      if (away) chart.timeScale().setVisibleLogicalRange(r);
      else windowAt(rs.index, r ? r.to - r.from : 120);
    }
    if ((prev.mode === "replay") !== (rs.mode === "replay")) paintLevels();
    syncReplay();
  }

  /** 往后放一根：只追加，不重画，视图不跳。 */
  function appendBar(i) {
    view = sliceAt(data, i);
    const t = data.candles[i].time;
    candles.update(candleBar(data.candles[i]));
    const v = view.volume.at(-1);
    if (v?.time === t) vol.update(volBar(v));
    for (const s of SPECS) {
      const p = view.lines[s.key]?.at(-1);
      if (p?.time === t) series[s.key].update({ ...p });
    }
    paintMarkers();
    showReadout(null);
  }

  /** 选好起点：保持现在看的跨度，右边留出空位给新的 K 线。 */
  function windowAt(i, span) {
    chart.timeScale().setVisibleLogicalRange({ from: i + 8 - span, to: i + 8 });
  }

  /** 按钮、提示、徽标、十字线、选起点的覆盖层跟着状态走。 */
  let shownMode = "off";
  function syncReplay() {
    const on = rs.mode !== "off";
    const selecting = rs.mode === "select";
    replayBtn.setAttribute("aria-pressed", String(on));
    replayBtn.textContent = selecting ? "取消选起点" : rs.mode === "replay" ? "退出回放" : "回放";
    bar.hidden = !on;
    badge.hidden = rs.mode !== "replay";
    box.classList.toggle("replay-selecting", selecting);
    chart.applyOptions({ crosshair: { vertLine: { visible: !selecting, labelVisible: !selecting } } });
    if (!selecting) overlay.hidden = true;
    if (rs.mode !== shownMode) { setMenu(false); shownMode = rs.mode; } // 只在换状态时收菜单：播放中每走一根不收
    const last = (data?.candles.length ?? 0) - 1;
    const atEnd = rs.mode === "replay" && rs.index >= last;
    $r(".replay-play").textContent = rs.playing ? "⏸ 暂停" : "▶ 播放";
    $r(".replay-play").setAttribute("aria-pressed", String(Boolean(rs.playing)));
    $r(".replay-label").setAttribute("aria-live", rs.playing ? "off" : "polite"); // 播放中不每秒播报
    levelsBtn.disabled = rs.mode === "replay"; // 价位线属于最新一天，回放时收起，按钮也不能点
    $r(".replay-play").disabled = rs.mode !== "replay" || atEnd;
    $r(".replay-forward").disabled = rs.mode !== "replay" || atEnd;
    $r(".replay-back").disabled = rs.mode !== "replay" || rs.index <= 0;
    $r(".replay-analyze").disabled = rs.mode !== "replay";
    $r(".replay-label").textContent = selecting ? "点图上的一天作为回放起点"
      : rs.mode === "replay" ? `回放 ${data.candles[rs.index].time} · 第 ${rs.index + 1}/${last + 1} 根${atEnd ? " · 已到最新一根" : ""}` : "";
  }

  replayBtn.addEventListener("click", () => {
    if (rs.mode === "off") { setDrawing(false); dispatch({ type: "enter" }); } else dispatch({ type: "exit" });
  });
  $r(".replay-start").addEventListener("click", () => setMenu(menu.hidden));
  menu.addEventListener("click", (e) => {
    const how = e.target.closest("[data-start]")?.dataset.start;
    if (!how || !data) return;
    if (how === "click") { dispatch({ type: "enter" }); return; }
    dispatch({ type: "pick", index: how === "earliest" ? earliestIndex(data) : randomIndex(data) });
  });
  menu.querySelector("input").addEventListener("change", (e) => {
    const i = data ? indexOnOrBefore(data.candles, e.target.value) : -1;
    if (i >= 0) dispatch({ type: "pick", index: i });
  });
  $r(".replay-play").addEventListener("click", () => dispatch({ type: "toggle" }));
  $r(".replay-back").addEventListener("click", () => dispatch({ type: "back" }));
  $r(".replay-forward").addEventListener("click", () => dispatch({ type: "forward" }));
  $r(".replay-realtime").addEventListener("click", () => dispatch({ type: "realtime" }));
  $r(".replay-exit").addEventListener("click", () => dispatch({ type: "exit" }));
  $r(".replay-analyze").addEventListener("click", () => {
    if (rs.mode !== "replay") return;
    const date = data.candles[rs.index].time;
    dispatch({ type: "exit" });
    analyzeDate?.(date);
  });
  speedSel.addEventListener("change", () => {
    speed = Number(speedSel.value);
    try { localStorage.setItem("dma-replay-speed", String(speed)); } catch { /* 忽略 */ }
    arm(); // 正在放的话，换速度立刻生效
  });

  // 选起点：竖线跟着鼠标，右边变暗，时间轴上写出日期
  chart.subscribeCrosshairMove((param) => {
    if (rs.mode !== "select" || !param.point || !param.time) { overlay.hidden = true; return; }
    const x = chart.timeScale().timeToCoordinate(param.time) ?? param.point.x;
    const w = chart.timeScale().width();
    const axis = chart.timeScale().height();
    overlay.hidden = false;
    overlay.style.bottom = `${axis}px`;
    overlay.style.width = `${w}px`;
    lineEl.style.left = dimEl.style.left = `${x}px`;
    dimEl.style.width = `${Math.max(0, w - x)}px`;
    dateEl.style.left = `${x}px`;
    dateEl.textContent = `回放起点 ${isoDate(param.time)}`;
  });
  chart.subscribeClick((param) => {
    if (rs.mode !== "select" || !param.time) return;
    const i = data.candles.findIndex((c) => c.time === isoDate(param.time));
    setTimeout(() => dispatch({ type: "pick", index: i })); // 同一次点击的问鸿雁还要看到"正在选起点"
  });

  // 快捷键：Shift+↓ 播放 / 暂停，Shift+→ 前进一根；Esc 取消选起点。焦点在输入框里时不管。
  document.addEventListener("keydown", (e) => {
    if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    if (e.key === "Escape" && rs.mode === "select") { dispatch({ type: "exit" }); return; }
    if (rs.mode !== "replay" || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    const action = { ArrowDown: "toggle", ArrowRight: "forward", ArrowLeft: "back" }[e.key];
    if (!action) return;
    e.preventDefault();
    dispatch({ type: action });
  });
  document.addEventListener("mousedown", (e) => { if (!e.target.closest(".replay-start-wrap")) setMenu(false); });

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paint);
  new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  return {
    chart,
    /** key：股票代码（自己画的线按它分开存）。 */
    setData(d, key = null) {
      // 同一只票重新载入（长风调了取数、换了数据源）：停在原来回放到的那天，免得露出后面的 K 线；换票才退出回放
      const sameTicker = key === drawKey;
      const at = sameTicker && rs.mode === "replay" ? data.candles[rs.index].time : null;
      const r = at ? chart.timeScale().getVisibleLogicalRange() : null;
      data = d;
      const index = at ? indexOnOrBefore(d.candles, at) : -1;
      rs = index >= 0 ? { mode: "replay", index, playing: false } : OFF;
      arm();
      if (!sameTicker) { drawKey = key; loadDrawn(); }
      paintDrawn();
      if (rs.mode === "replay") {
        show(sliceAt(d, index));
        if (r) chart.timeScale().setVisibleLogicalRange(r);
      } else {
        show(d);
        applyRange();
      }
      paintLevels();
      syncReplay();
    },
    /** 盲测练习：往后多了一根（服务端只发到现在那根）。只追加，视图不跳。 */
    extend(delta) {
      if (!data) return;
      data = appendDelta(data, delta);
      view = data;
      candles.update(candleBar(delta.candle));
      for (const v of delta.volume) vol.update(volBar(v));
      for (const s of SPECS) for (const p of delta.lines[s.key] ?? []) series[s.key].update({ ...p });
      paintMarkers();
      showReadout(null);
      // 最新一根跑出右边时跟上
      const r = chart.timeScale().getVisibleLogicalRange();
      const last = data.candles.length - 1;
      if (r && last > r.to - 2) chart.timeScale().setVisibleLogicalRange({ from: r.from + 1, to: r.to + 1 });
    },
    /** 时间键 → 显示的文字（练习里是 T+n）；null 恢复原样。 */
    setTimeLabel(fn) {
      timeLabel = fn;
      chart.applyOptions({ timeScale: { tickMarkFormatter: (t) => (timeLabel ? showTime(t) : null) } });
      showReadout(null);
    },
    /** 练习时收起「回放」：数据本来就只到现在那根，自己的回放会和练习的推进混在一起。 */
    setPractice(on) {
      if (on) dispatch({ type: "exit" });
      replayBtn.hidden = on;
    },
    /** 停止回放、回到完整数据（取数失败、中栏收起图表时用）。 */
    stopReplay() { dispatch({ type: "exit" }); },
    /** 价位线：[{ kind: trigger | stop | invalid, price, title }]，来自 viz.js 的 chartLevels。 */
    setLevels(list) {
      levels = list;
      paintLevels();
    },
    /** 当前画在图上的价位线（测试和问鸿雁用）。 */
    levels: () => (levelsShown() ? levels.map(({ kind, title, price }) => ({ kind, title, price })) : []),
    /** 自己画的线（价格列表）。 */
    drawn: () => [...drawn],
    /** 回放状态（测试用）：mode / index / playing，加上速度、回放到的日期、图上几根 K 线。 */
    replay: () => ({ ...rs, speed, date: rs.mode === "replay" ? data.candles[rs.index].time : null, bars: view?.candles.length ?? 0 }),
    /** 回放里点「按这一天分析」时回调那天的日期。 */
    onAnalyzeDate(cb) { analyzeDate = cb; },
    /** 点图表时回调 { time, candle, lines, drops, point }，给"问鸿雁"用。画线、选回放起点时不回调；回放时按回放到的数据。 */
    onPick(cb) {
      chart.subscribeClick((param) => {
        if (drawing || rs.mode === "select" || !param.time || !view) return;
        const candle = view.candles.find((c) => c.time === param.time);
        if (!candle) return; // 回放时右边空白处
        const lines = Object.fromEntries(SPECS.map((s) => [s.key, (view.lines[s.key] || []).find((p) => p.time === param.time)?.value]));
        const drops = view.drops.filter((d) => d.time === param.time).map((d) => d.period);
        cb({ time: showTime(param.time), candle, lines, drops, point: param.point });
      });
    },
  };
}

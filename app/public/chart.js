// K 线 + 6 条均线 + 抵扣价小黄点 + 成交量（TradingView lightweight-charts 4.2.0）。
import { baseCandleStyle, candleBar as styledBar } from "./candles.js";
import { CHART_HELP, toneHelp } from "./charthelp.js";
import { createOverlay } from "./chartoverlay.js";
import { earningsMarks, logicalOf } from "./earnings.js";
import { createLayerMenu } from "./layermenu.js";
import { LAYERS_KEY, layerRows, parseLayers, presetOf, presetState, shownLayers, toggleLayer } from "./layers.js";
import { measure, measureLines } from "./measure.js";
import { BAND_ALPHA, CANDLE_ALPHA, GROUPS, SPECS, alpha, bandPoints, lineStyle, nextFocus } from "./lines.js";
import { gapBands, pickGaps, structureScene } from "./overlays.js";
import { createProfileLayer } from "./profilelayer.js";
import { ohlcRow, weekLabel } from "./readout.js";
import { DEFAULT_SPEED, OFF, SPEEDS, appendDelta, earliestIndex, indexOnOrBefore, randomIndex, sliceAt, speedMs, step } from "./replay.js";
import { toneInfo, toneTurns } from "./tones.js";
import { visibleProfile } from "./volprofile.js";

/** 图表库传来的时间（"2026-10-22"、{year,month,day} 或 UTC 秒）→ "2026-10-22"。 */
function isoDate(t) {
  if (typeof t === "string") return t;
  if (typeof t === "number") return new Date(t * 1000).toISOString().slice(0, 10);
  return `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
}

/** 最新一根右边留几根的空位（下一次财报的 E 标在这里）。 */
const RIGHT_ROOM = 4;
/** 下一次财报在这么多根之内，右边的空位留到能看见它（覆盖 10 个交易日的财报提醒）。 */
const NEXT_EARNINGS_ROOM = 15;

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// 着色：每根 K 线的 tone 由 Python 算好（skill 的 tones.py 的 bar_tones：自带规则或本机的着色插件），这里只查颜色
const TONE_TOKENS = { bull: "--bar-bull", bear: "--bar-bear", mixed: "--bar-mixed" };
/** 点结论卡片上的价位，图上那条线亮多久（毫秒）。 */
const FLASH_MS = 4000;

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
    timeScale: { rightOffset: RIGHT_ROOM, tickMarkFormatter: (t) => (timeLabel ? showTime(t) : null) },
    // 十字线底部的日期统一写成 2026-10-22（默认按浏览器语言写成 "22 10月 '26"，不好读）
    localization: { timeFormatter: showTime },
    crosshair: { mode: 0 },
    // 滚轮只滚页面，不缩放图表（误触太多）；缩放用 ⌘/Ctrl + 滚轮（见下方 wheel 处理），按住拖动平移
    handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true },
  });
  let flash = null; // 正在亮着的那条价位线，见下面的 flashLevel
  const candles = chart.addCandlestickSeries({
    priceLineVisible: false,
    // 亮着的价位在图的价格范围外面时，把范围撑到它，不然点了看不见
    autoscaleInfoProvider: (base) => {
      const info = base();
      if (!info?.priceRange || !flash) return info;
      const { minValue, maxValue } = info.priceRange;
      return { ...info, priceRange: { minValue: Math.min(minValue, flash.price), maxValue: Math.max(maxValue, flash.price) } };
    },
  });
  const vol = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  const series = {};
  for (const s of SPECS) {
    series[s.key] = chart.addLineSeries({ visible: !s.off, priceLineVisible: false, crosshairMarkerVisible: false });
  }

  // 图例：每组一个「20 线组」按钮（点它聚焦这一组），后面是这组两条线的开关（点它显示 / 隐藏这条线）
  legendEl.innerHTML = GROUPS.map((n) => `<span class="legend-group" data-group="${n}">`
    + `<button type="button" class="group-focus" data-group="${n}" aria-pressed="false" style="--c: var(--ma${n})"`
    + ` title="聚焦 ${n} 线组：MA${n} 和 EMA${n} 之间填上色带，另外两组变淡；再点一次或按 Esc 取消">${n} 线组</button></span>`).join("");
  for (const s of SPECS) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-pressed", String(!s.off));
    b.dataset.line = s.key;
    b.title = s.off ? "MA200 朴素规则的对照线（收盘在上方持有，否则空仓），默认不画" : `显示 / 隐藏 ${s.key}`;
    b.innerHTML = `<i class="${s.kind.toLowerCase()}" style="--c: var(${s.token})"></i>${s.key}`;
    b.addEventListener("click", () => {
      b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
      paintLines();
      showReadout(null);
    });
    (legendEl.querySelector(`.legend-group[data-group="${s.group}"]`) ?? legendEl).appendChild(b);
  }
  legendEl.addEventListener("click", (e) => {
    const g = e.target.closest(".group-focus");
    if (g) setFocus(nextFocus(shownFocus(), { type: "click", group: Number(g.dataset.group) }));
  });

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
    const prev = view.candles[view.candles.indexOf(c) - 1];
    const at = (k) => (view.lines[k] || []).find((p) => p.time === c.time)?.value;
    // 照 TradingView：第一行日期 + 开高低收 + 比前一根涨跌 + 量和量比，第二行各条均线的值
    const label = frame === "week" ? weekLabel(showTime(c.time), view.partial && c === view.candles.at(-1)) : showTime(c.time);
    const lines = SPECS.filter((sp) => series[sp.key].options().visible && (frame === "day" || !sp.off))
      .map((sp) => `<span><i class="${sp.kind.toLowerCase()}" style="--c: var(${sp.token})"></i>${sp.key} ${f2(at(sp.key))}</span>`).join("");
    const turn = turnsNow.find((t) => t.time === c.time)?.to ?? null;
    readout.innerHTML = `<div class="ro-ohlc">${ohlcRow(label, c, prev, view.volume.find((v) => v.time === c.time), turn)}</div><div class="ro-lines">${lines}</div>`;
    // 窄栏（默认视口）放不下时一步步收：先收涨跌额，还放不下（多了「转绿」「转黑」）再收量比后面的「均量」两个字
    const row = readout.firstChild;
    for (const cls of ["tight", "tighter"]) {
      if (row.scrollWidth <= row.clientWidth) break;
      row.classList.add(cls);
    }
  };
  chart.subscribeCrosshairMove((param) => showReadout(param.time));

  // ---------- 范围按钮：固定时长看斜率（文章 2.4：短期看 1 年） ----------
  // [键, 按钮, 往回看几天]
  const RANGES = [["1w", "1 周", 7], ["1m", "1 月", 31], ["6m", "半年", 183], ["1y", "1 年", 365], ["all", "全部", null]];
  // 日线默认近 1 年；周线默认全部（5 年），1 周、1 月在周线上没有意义
  const rangeKeys = { day: "1y", week: "all" };
  const WEEK_OFF = new Set(["1w", "1m"]);
  const tools = document.createElement("div");
  tools.className = "chart-tools";
  // 一行放得下（默认视口）：互斥的选项连成一段；图上画什么都收在「图层 ▾」里
  // 「图层」排最右、挨着「?」（ADR 0019）：菜单从右边缘往下展开
  tools.innerHTML = `<span class="seg frame-toggle" role="group" aria-label="日线 / 周线">`
    + `<button type="button" data-frame="day" aria-pressed="true" title="日 K 线（分析用的就是日线）">日</button>`
    + `<button type="button" data-frame="week" aria-pressed="false">周</button></span>`
    + `<span class="seg" role="group" aria-label="看多长一段">`
    + RANGES.map(([k, label]) => `<button type="button" class="range-btn" data-range="${k}">${label}</button>`).join("")
    + `<button type="button" class="range-btn" data-range="reset" title="回到当前范围的默认视图">复位</button></span>`
    + `<span class="seg" role="group" aria-label="图上的工具">`
    + `<button type="button" class="replay-toggle" aria-pressed="false" title="从过去某一天开始，一根一根往后放 K 线">回放</button>`
    + `<button type="button" class="measure-toggle" aria-pressed="false" title="点这里，再在图上按住从一点拖到另一点：量涨跌多少、隔几根 K 线、几个 ATR（看止损离得远不远）。Esc 清掉">测量</button>`
    + `<button type="button" class="draw-toggle" aria-pressed="false" title="点这里，再点图上任意一处，就在那个价位画一条横线">画线</button>`
    + `<button type="button" class="draw-clear" title="删掉这只股票上自己画的线">清除</button></span>`
    + `<span class="layers-wrap"></span>`
    + `<button type="button" class="chart-help-toggle" aria-expanded="false" aria-label="怎么用" title="怎么用：每个工具、每个图层在这套方法里看什么">?</button>`;
  legendEl.after(tools);

  // ---------- 图层：图上画什么。表在 layers.js，菜单在 layermenu.js；开关记在本机 ----------
  let layers = parseLayers(null);
  try { layers = parseLayers(localStorage.getItem(LAYERS_KEY)); } catch { /* 隐私模式 */ }
  /** 图表现在的情况，决定哪些图层能用（layers.js 的 ctx）。 */
  const layerCtx = () => {
    const { all, picked } = gapSets();
    const whole = data ? frameData(data) : null; // 这一档（日线或周线）的完整数据：回放截短了的图也按它说颜色
    return { frame, replay: rs.mode === "replay", practice: practicing, structure: Boolean(structure?.available),
      gaps: gaps ? gaps.list.length : null, moreGaps: all.length - picked.length, volume: Boolean(view?.volume?.length),
      tone: toneInfo(whole?.tone_source), tones: Boolean(whole?.candles.some((c) => c.tone)) };
  };
  /** 图上现在画哪些图层：开着而且能用。 */
  const shown = () => shownLayers(layers, layerCtx());
  const layerRow = (key) => layerRows(layers, layerCtx()).find((r) => r.key === key);
  const layerMenu = createLayerMenu(tools.querySelector(".layers-wrap"), {
    onPreset: (name) => setLayers(presetState(name)),
    onToggle: (key) => setLayers(toggleLayer(layers, key)),
  });
  /** 菜单和「怎么用」里讲着色的那段，都照图表现在的情况写。 */
  const syncLayers = () => {
    const ctx = layerCtx();
    layerMenu.render(layerRows(layers, ctx), presetOf(layers));
    help.querySelector('[data-help="tone"]').innerHTML = toneHelp(ctx.tone);
  };
  function setLayers(next) {
    layers = next;
    try { localStorage.setItem(LAYERS_KEY, JSON.stringify(layers)); } catch { /* 忽略 */ }
    if (!view) { syncLayers(); return; } // 还没有数据：只把菜单对上
    paint();
    showReadout(null); // 均线关了，读数条第二行也跟着空
  }
  const applyRange = () => {
    tools.querySelectorAll(".range-btn").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.range === rangeKeys[frame]));
      b.disabled = frame === "week" && WEEK_OFF.has(b.dataset.range);
    });
    if (!view?.candles.length) return;
    const days = RANGES.find(([k]) => k === rangeKeys[frame])[2];
    const last = view.candles.length - 1; // 回放时以回放到的那天为准
    const from = new Date(view.candles[last].time);
    from.setDate(from.getDate() - (days ?? Infinity));
    const first = days ? Math.max(0, view.candles.findIndex((c) => c.time >= from.toISOString().slice(0, 10))) : 0;
    // 右边留几根的空位；下一次财报在三周内就留到能看见它的 E
    const next = frame === "day" && earningsMarks(earnings, view.candles[last].time).find((m) => m.next);
    const ahead = next ? logicalOf(next.date, view.candles) - last : 0;
    const room = ahead > 0 && ahead <= NEXT_EARNINGS_ROOM ? Math.max(RIGHT_ROOM, ahead + 1) : RIGHT_ROOM;
    chart.timeScale().setVisibleLogicalRange({ from: first, to: last + room });
  };
  tools.addEventListener("click", (e) => {
    const b = e.target.closest(".range-btn");
    if (!b) return;
    if (b.dataset.range !== "reset") rangeKeys[frame] = b.dataset.range;
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
    const next = Math.min(Math.max(span * Math.exp(e.deltaY / 300), 5), (view?.candles.length ?? 500) + 10);
    ts.setVisibleLogicalRange({ from: r.to - next, to: r.to }); // 以最右边（最新一天）为锚
  }, { passive: false });

  // ---------- 价位线：结论里的触发价、止损、目标位，和做推演里推翻判断的价位 ----------
  const LEVEL_COLOR = { trigger: "--up", stop: "--down", target: "--accent", invalid: "--neutral" };
  let levels = [];
  let levelLines = [];
  const levelsShown = () => shown().levels; // 价位线属于最新一天，回放时收起
  const paintLevels = () => {
    levelLines.forEach((l) => candles.removePriceLine(l));
    levelLines = levelsShown() ? levels.map((lv) => candles.createPriceLine({
      price: lv.price, color: css(LEVEL_COLOR[lv.kind]), lineWidth: 1, lineStyle: 2,
      axisLabelVisible: true, title: lv.title,
    })) : [];
    syncGuides();
  };
  /** 图上的小字（缺口、颈线……）避开价位线和自己画的线。 */
  const guidePrices = () => [...(levelsShown() ? levels.map((lv) => lv.price) : []), ...drawn];
  const syncGuides = () => structLayer.setGuides(guidePrices());

  // ---------- 点结论卡片上的价位：那条线在图上亮几秒（价位线图层关着、回放中也照样亮）。lv：{ kind, price, title } ----------
  function flashLevel(lv) {
    clearFlash();
    const line = candles.createPriceLine({ price: lv.price, color: css(LEVEL_COLOR[lv.kind]), lineWidth: 3, lineStyle: 0, axisLabelVisible: true, title: lv.title });
    flash = { kind: lv.kind, price: lv.price, title: lv.title, line, timer: setTimeout(clearFlash, FLASH_MS) };
  }
  function clearFlash() {
    if (!flash) return;
    clearTimeout(flash.timer);
    candles.removePriceLine(flash.line);
    flash = null;
  }

  // ---------- 结构标注：波段、最近的顶部 / 底部构造、M 顶 / W 底 / 2B（skill 的 structure.py 算好的，这里只画） ----------
  const structLayer = createOverlay(chart, candles, box);
  let structure = null;
  const overlayColors = () => ({ swing: css("--muted"), neck: css("--neutral"), up: css("--up"), down: css("--down"),
    gap: css("--neutral"), target: css("--accent"), bg: css("--card"), font: css("--mono") });
  // 缺口：没补的向下缺口画成色带（和交易计划找目标位同一个定义，tradeplan.unfilled_gaps）；被用作目标位的标出来
  let gaps = null; // { list, targets }
  /** 图上这段 K 线里没补的缺口：all 是全部，picked 是要紧的（目标位 + 离现价最近的上下各一个），默认只画 picked。 */
  const gapSets = () => {
    const bars = view?.candles ?? [];
    const all = gaps && bars.length ? gaps.list.filter((g) => g.date <= bars.at(-1).time) : [];
    return { all, picked: pickGaps(all, gaps?.targets, bars.at(-1)?.close) };
  };
  /** 结构和缺口。图层能不能用变了（换数据、日 / 周、进出回放）都会走到这里，所以菜单也在这里对上。 */
  function paintOverlay() {
    syncLayers();
    const on = shown();
    const bars = view?.candles ?? [];
    const { all, picked } = gapSets();
    const scene = {
      ...structureScene(structure, bars, on),
      bands: on.gaps ? gapBands(on.gapsAll ? all : picked, gaps?.targets, bars) : [],
    };
    structLayer.set(scene, overlayColors(), bars);
    paintTurns();
  }
  // 变色提示：颜色变了的那几根上方标小三角（规则在 tones.js，只看颜色序列）。跟着图上的 K 线走：回放只标已经放出来的
  let turnsNow = [];
  function paintTurns() {
    const bars = view?.candles ?? [];
    turnsNow = shown().toneTurns ? toneTurns(bars).map((t) => ({ ...t, high: bars[t.i].high })) : [];
    structLayer.setTurns(turnsNow, { bull: css("--bar-bull"), bear: css("--bar-bear") });
  }

  // ---------- 筹码分布（视频 O）：按图上看得见的那段 K 线在浏览器里算（volprofile.js），缩放、平移、回放都重算 ----------
  const profileLayer = createProfileLayer(chart, candles);
  let profileRef = null; // 交易计划记下的上方最近的筹码山 { foot, top }：参考带（P38，只作参考，不是目标）；练习里没有
  let profileNow = null; // 现在画着的那份（测试和问鸿雁用）
  function paintProfile() {
    const p = shown().profile ? visibleProfile(view, chart.timeScale().getVisibleLogicalRange()) : null;
    profileNow = p && { ...p, fromLabel: showTime(p.from), toLabel: showTime(p.to) };
    profileLayer.set({
      profile: profileNow,
      ref: rs.mode === "replay" ? null : profileRef, // 参考带属于最新一天的计划：回放时收起
      close: view?.candles.at(-1)?.close ?? null,
      guides: guidePrices(),
      colors: { bin: css("--muted"), mountain: css("--neutral"), ref: css("--accent"), muted: css("--muted"), bg: css("--card"), font: css("--mono") },
    });
  }

  // ---------- 怎么用：每个工具、每个图层在这套方法里看什么（文字在 charthelp.js） ----------
  const help = document.createElement("div");
  help.className = "chart-help";
  help.hidden = true;
  help.innerHTML = CHART_HELP;
  tools.after(help);
  const helpBtn = tools.querySelector(".chart-help-toggle");
  helpBtn.addEventListener("click", () => {
    help.hidden = !help.hidden;
    helpBtn.setAttribute("aria-expanded", String(!help.hidden));
  });

  let tool = "none"; // 图上的交互模式，见下面的 setTool

  // ---------- 自己画的水平线：按股票记在本机浏览器里 ----------
  let drawKey = null; // 当前股票
  let drawn = []; // 价格
  let drawnLines = [];
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
    syncGuides();
  };
  const drawBtn = tools.querySelector(".draw-toggle");
  drawBtn.addEventListener("click", () => setTool(tool === "draw" ? "none" : "draw"));
  tools.querySelector(".draw-clear").addEventListener("click", () => {
    drawn = [];
    saveDrawn();
    paintDrawn();
  });
  chart.subscribeClick((param) => {
    if (tool !== "draw" || !param.point) return;
    const price = candles.coordinateToPrice(param.point.y);
    if (price == null) return;
    drawn.push(Math.round(price * 100) / 100);
    saveDrawn();
    paintDrawn();
    setTimeout(() => setTool("none")); // 同一次点击的其他处理（问鸿雁）还要看到"正在画线"
  });

  let data = null; // 完整数据
  let view = null; // 图上画着的：平时就是 data，回放时是截到那天的
  let toneColors = {}; // tone → 颜色，换主题时在 paint 里重取

  const candleBar = (c, tone = shown().tone) => styledBar(c, tone, toneColors);

  function paint() {
    if (!view) return;
    const muted = css("--muted");
    chart.applyOptions({
      layout: { background: { type: "solid", color: css("--card") }, textColor: muted, fontFamily: css("--mono") },
      grid: { vertLines: { color: css("--grid") }, horzLines: { color: css("--grid") } },
      rightPriceScale: { borderColor: css("--line") }, timeScale: { borderColor: css("--line") },
    });
    // K 线淡一点（着色时也一样），均线浮在上面
    const faded = (token) => alpha(css(token), CANDLE_ALPHA);
    candles.applyOptions(baseCandleStyle({ up: faded("--up"), down: faded("--down") }));
    toneColors = Object.fromEntries(Object.entries(TONE_TOKENS).map(([k, t]) => [k, faded(t)]));
    const tone = shown().tone;
    candles.setData(view.candles.map((c) => candleBar(c, tone)));
    vol.setData(view.volume.map(volBar));
    paintLines();
    paintLevels();
    paintMarkers();
    paintOverlay();
    paintProfile();
  }
  // ---------- 聚焦一组：这组的 MA、EMA 照常、中间填色带，另外两组变淡；记在本机 ----------
  let focus = null;
  try { focus = nextFocus(null, { type: "click", group: Number(localStorage.getItem("dma-focus")) }); } catch { /* 隐私模式 */ }
  let practicing = false;
  const shownFocus = () => (practicing ? null : focus); // 练习时图例收起了，没法取消聚焦：不聚焦
  function setFocus(next) {
    focus = next;
    try { localStorage.setItem("dma-focus", focus ? String(focus) : ""); } catch { /* 忽略 */ }
    paintLines();
  }
  /** 一条线画不画：均线图层开着，图例里这条线也点着。图层关着时图例整行不能点（MA200 在周线上本来就没有）。 */
  function paintLines() {
    const f = shownFocus();
    const on = shown().ma;
    const colors = Object.fromEntries(SPECS.map((s) => [s.token, css(s.token)]));
    for (const s of SPECS) {
      const b = legendEl.querySelector(`[data-line="${s.key}"]`);
      b.disabled = !on || (s.off && frame === "week");
      series[s.key].applyOptions({ ...lineStyle(s, colors, f), visible: on && b.getAttribute("aria-pressed") === "true" });
    }
    if (f) legendEl.dataset.focus = String(f); else delete legendEl.dataset.focus;
    legendEl.title = on ? "" : "均线图层关着：在「图层」里打开";
    legendEl.querySelectorAll(".group-focus").forEach((b) => {
      b.disabled = !on;
      b.setAttribute("aria-pressed", String(Number(b.dataset.group) === f));
    });
    paintRibbon();
  }
  /** 色带跟着图上的数据走（回放截到哪天就画到哪天）；这组有一条线被隐藏了就不画。 */
  function paintRibbon() {
    const f = shownFocus();
    const both = f && series[`MA${f}`].options().visible && series[`EMA${f}`].options().visible;
    structLayer.setRibbon(both ? bandPoints(view, f) : [], f ? alpha(css(`--ma${f}`), BAND_ALPHA) : "");
  }

  const volBar = (v) => ({ time: v.time, value: v.value, color: css(v.spike ? "--drop" : "--line") });
  function paintMarkers() {
    const drop = css("--drop");
    const drops = shown().drops ? view.drops.slice().sort((a, b) => (a.time < b.time ? -1 : 1)) : [];
    candles.setMarkers(drops.map((d) => ({
      time: d.time, position: "belowBar", color: drop, shape: "circle", text: `${d.period}${frame === "week" ? "周" : ""}扣`,
    })));
    paintEarnings();
    paintRuler();
  }

  // ---------- 财报日：时间轴上方的小 E（照 TradingView）；之后的第一次在右边留白里也标 ----------
  let earnings = null;
  const eLayer = document.createElement("div");
  eLayer.className = "earnings-layer";
  box.append(eLayer);
  function paintEarnings() {
    const ts = chart.timeScale();
    const width = ts.width();
    eLayer.style.bottom = `${ts.height()}px`;
    eLayer.style.width = `${width}px`;
    // 周线上财报标在那一周；下一次在右边留白里，按天数排的位置在周线上不对，不标
    const marks = view?.candles.length ? earningsMarks(earnings, view.candles.at(-1).time).filter((m) => frame === "day" || !m.next) : [];
    eLayer.innerHTML = marks.map(({ date, next }) => {
      const i = logicalOf(date, view.candles);
      const x = i === null ? null : ts.logicalToCoordinate(i);
      if (x === null || x < 0 || x > width) return "";
      const what = next ? `下次财报 ${date}：财报后常跳空，止损可能按不到原价` : `财报 ${date}`;
      return `<span class="e-mark${next ? " next" : ""}" style="left:${x}px" data-date="${date}" title="${what}">E</span>`;
    }).join("");
  }
  chart.timeScale().subscribeVisibleLogicalRangeChange(() => { paintEarnings(); paintRuler(); paintProfile(); });
  chart.timeScale().subscribeSizeChange(() => { paintEarnings(); paintRuler(); });
  /** 把一份图表数据（完整的，或回放截到某天的）画到图上。 */
  function show(v) {
    view = v;
    for (const s of SPECS) series[s.key].setData(v.lines[s.key] || []);
    paint();
    showReadout(null);
  }

  // ---------- 日 / 周：周线是分析 JSON 里 chart.weekly（5 年周 K 线和周线均线）；回放、测量只在日线上 ----------
  let frame = "day";
  const frameData = (d) => (frame === "week" ? d.weekly : d);
  const weekBtn = tools.querySelector('[data-frame="week"]');
  function setFrame(next) {
    if (next === frame || (next === "week" && !data?.weekly)) return;
    if (next === "week") {
      leaveReplay();
      if (tool === "measure") setTool("none");
    }
    frame = next;
    show(frameData(data));
    applyRange();
    syncTool();
  }
  tools.querySelector(".frame-toggle").addEventListener("click", (e) => {
    const f = e.target.closest("[data-frame]")?.dataset.frame;
    if (f) setFrame(f);
  });
  /** 日 / 周按钮和只在日线上能用的按钮（回放、测量）。 */
  function syncFrame() {
    const week = frame === "week";
    tools.querySelectorAll("[data-frame]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.frame === frame)));
    const head = box.closest(".chart-card")?.querySelector(".chart-frame");
    if (head) head.textContent = week ? "周线" : "日线";
    weekBtn.disabled = !data?.weekly;
    weekBtn.title = data?.weekly ? "周 K 线和周线的 MA / EMA 20、60、120（5 年）" : "这份数据没有周线（练习里只看日线，周线会用到之后的 K 线）";
    replayBtn.disabled = week;
    replayBtn.title = week ? "回放只在日线上：切回日线" : REPLAY_TITLE;
    measureBtn.disabled = week;
    measureBtn.title = week ? "测量按日线的 ATR(14) 算止损远近：切回日线再量" : MEASURE_TITLE;
  }

  // ---------- 回放：从过去某一天开始，一根一根往后放（状态机在 replay.js） ----------
  let rs = OFF;
  let timer = null;
  let analyzeDate = null;
  let speed = DEFAULT_SPEED;
  try { speed = SPEEDS.find((x) => String(x) === localStorage.getItem("dma-replay-speed")) ?? DEFAULT_SPEED; } catch { /* 隐私模式 */ }

  const replayBtn = tools.querySelector(".replay-toggle");
  const REPLAY_TITLE = replayBtn.title;
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
        const r = tool === "pick-start" ? chart.timeScale().getVisibleLogicalRange() : null;
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
    if ((prev.mode === "replay") !== (rs.mode === "replay")) { paintLevels(); paintOverlay(); paintProfile(); }
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
    paintRibbon();
    paintMarkers();
    paintTurns();
    paintProfile();
    showReadout(null);
  }

  /** 选好起点：保持现在看的跨度，右边留出空位给新的 K 线。 */
  function windowAt(i, span) {
    chart.timeScale().setVisibleLogicalRange({ from: i + 8 - span, to: i + 8 });
  }

  /** 按钮、提示、徽标、十字线、选起点的覆盖层跟着状态走。 */
  let shownMode = "off";
  function syncReplay() {
    const selecting = tool === "pick-start";
    const on = rs.mode === "replay" || selecting;
    replayBtn.setAttribute("aria-pressed", String(on));
    replayBtn.textContent = selecting ? "取消选起点" : rs.mode === "replay" ? "退出回放" : "回放";
    bar.hidden = !on;
    badge.hidden = rs.mode !== "replay";
    box.classList.toggle("replay-selecting", selecting);
    chart.applyOptions({ crosshair: { vertLine: { visible: !selecting, labelVisible: !selecting } } });
    if (!selecting) overlay.hidden = true;
    const shown = selecting ? "select" : rs.mode;
    if (shown !== shownMode) { setMenu(false); shownMode = shown; } // 只在换状态时收菜单：播放中每走一根不收
    const last = (data?.candles.length ?? 0) - 1;
    const atEnd = rs.mode === "replay" && rs.index >= last;
    $r(".replay-play").textContent = rs.playing ? "⏸ 暂停" : "▶ 播放";
    $r(".replay-play").setAttribute("aria-pressed", String(Boolean(rs.playing)));
    $r(".replay-label").setAttribute("aria-live", rs.playing ? "off" : "polite"); // 播放中不每秒播报
    $r(".replay-play").disabled = rs.mode !== "replay" || atEnd;
    $r(".replay-forward").disabled = rs.mode !== "replay" || atEnd;
    $r(".replay-back").disabled = rs.mode !== "replay" || rs.index <= 0;
    $r(".replay-analyze").disabled = rs.mode !== "replay";
    $r(".replay-label").textContent = selecting ? "点图上的一天作为回放起点"
      : rs.mode === "replay" ? `回放 ${data.candles[rs.index].time} · 第 ${rs.index + 1}/${last + 1} 根${atEnd ? " · 已到最新一根" : ""}` : "";
  }

  replayBtn.addEventListener("click", () => {
    if (tool === "pick-start") setTool("none");
    else if (rs.mode === "replay") dispatch({ type: "exit" });
    else setTool("pick-start");
  });
  /** 选好回放起点：退出选起点，从那天开始放。 */
  const pickAt = (index) => {
    setTool("none");
    dispatch({ type: "pick", index });
  };
  /** 退出回放和选起点（练习、取数失败、收起图表时）。 */
  const leaveReplay = () => {
    if (tool === "pick-start") setTool("none");
    dispatch({ type: "exit" });
  };
  $r(".replay-start").addEventListener("click", () => setMenu(menu.hidden));
  menu.addEventListener("click", (e) => {
    const how = e.target.closest("[data-start]")?.dataset.start;
    if (!how || !data) return;
    if (how === "click") { setTool("pick-start"); return; }
    pickAt(how === "earliest" ? earliestIndex(data) : randomIndex(data));
  });
  menu.querySelector("input").addEventListener("change", (e) => {
    const i = data ? indexOnOrBefore(data.candles, e.target.value) : -1;
    if (i >= 0) pickAt(i);
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
    if (tool !== "pick-start" || !param.point || !param.time) { overlay.hidden = true; return; }
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
    if (tool !== "pick-start" || !param.time) return;
    const i = data.candles.findIndex((c) => c.time === isoDate(param.time));
    setTimeout(() => pickAt(i)); // 同一次点击的问鸿雁还要看到"正在选起点"
  });

  // ---------- 图上的交互模式：无 / 画线 / 测量 / 选回放起点，同一时刻只有一种 ----------
  // 点图做什么由 tool 决定；换模式只走 setTool，按钮、光标、提示都从它同步
  function setTool(next) {
    if (next === tool) return;
    tool = next;
    if (tool === "pick-start" && rs.mode === "replay") dispatch({ type: "exit" }); // 回放中重选起点：先回到完整数据，视图留在原处
    syncTool();
  }
  function syncTool() {
    syncFrame();
    drawBtn.setAttribute("aria-pressed", String(tool === "draw"));
    drawBtn.textContent = tool === "draw" ? "点图上的价位…" : "画线";
    box.classList.toggle("drawing", tool === "draw");
    measureBtn.setAttribute("aria-pressed", String(tool === "measure"));
    box.classList.toggle("measuring", tool === "measure");
    chart.applyOptions({ handleScroll: { pressedMouseMove: tool !== "measure" } }); // 测量时按住拖动是量，不是平移
    if (tool !== "measure") { ruler = null; dragging = false; paintRuler(); }
    syncReplay();
  }

  // ---------- 测量：按住从 A 拖到 B，量涨跌、根数、自然日、几个 ATR（照 TradingView 的标尺）；回放时一样能用 ----------
  const measureBtn = tools.querySelector(".measure-toggle");
  const MEASURE_TITLE = measureBtn.title;
  measureBtn.addEventListener("click", () => setTool(tool === "measure" ? "none" : "measure"));
  const mLayer = document.createElement("div");
  mLayer.className = "measure-layer";
  mLayer.hidden = true;
  mLayer.innerHTML = '<div class="measure-rect"></div><div class="measure-label"></div>';
  box.append(mLayer);
  const [mRect, mLabel] = mLayer.children;
  let ruler = null; // { a, b }：两点都落在 K 线上，{ index（图上第几根）, price }
  let dragging = false;

  /** 鼠标位置 → 落在第几根 K 线、什么价位；不在绘图区（时间轴、价格轴上）返回 null。 */
  function pointAt(e) {
    if (!view?.candles.length) return null;
    const r = box.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const ts = chart.timeScale();
    if (x < 0 || x > ts.width() || y < 0 || y > r.height - ts.height()) return null;
    const logical = ts.coordinateToLogical(x);
    const price = candles.coordinateToPrice(y);
    if (logical === null || price === null) return null;
    return { index: Math.min(Math.max(Math.round(logical), 0), view.candles.length - 1), price };
  }

  function paintRuler() {
    // 回放退回到量的那几根之前：那两点已经不在图上，清掉
    if (ruler && view && Math.max(ruler.a.index, ruler.b.index) >= view.candles.length) ruler = null;
    const ts = chart.timeScale();
    const xs = ruler ? [ts.logicalToCoordinate(ruler.a.index), ts.logicalToCoordinate(ruler.b.index)] : [];
    const ys = ruler ? [candles.priceToCoordinate(ruler.a.price), candles.priceToCoordinate(ruler.b.price)] : [];
    mLayer.hidden = !ruler || [...xs, ...ys].some((v) => v === null);
    if (mLayer.hidden) return;
    const m = measure(ruler.a, ruler.b, view.candles);
    const [left, top] = [Math.min(...xs), Math.min(...ys)];
    mLayer.classList.toggle("down", m.change < 0);
    Object.assign(mRect.style, { left: `${left}px`, top: `${top}px`, width: `${Math.max(...xs) - left}px`, height: `${Math.max(...ys) - top}px` });
    mLabel.innerHTML = measureLines(m).map((t) => `<div>${t}</div>`).join("");
    // 标签放在终点那头（往上量在框上方，往下量在框下方），水平居中；靠边时收回图里
    const paneH = box.clientHeight - ts.height();
    const w = mLabel.offsetWidth, h = mLabel.offsetHeight;
    const y = m.change >= 0 ? top - h - 6 : Math.max(...ys) + 6;
    mLabel.style.left = `${Math.min(Math.max((xs[0] + xs[1]) / 2 - w / 2, 0), ts.width() - w)}px`;
    mLabel.style.top = `${Math.min(Math.max(y, 0), paneH - h)}px`;
  }

  box.addEventListener("mousedown", (e) => {
    if (tool !== "measure" || e.button !== 0) return;
    const p = pointAt(e);
    if (!p) return;
    e.preventDefault();
    ruler = { a: p, b: p };
    dragging = true;
    paintRuler();
  }, true);
  document.addEventListener("mousemove", (e) => {
    const p = dragging ? pointAt(e) : null;
    if (!p) return;
    ruler = { ...ruler, b: p };
    paintRuler();
  });
  document.addEventListener("mouseup", () => { dragging = false; });

  // 快捷键：Shift+↓ 播放 / 暂停，Shift+→ 前进一根；Esc 退出画线、测量、选起点，再按一次取消聚焦。焦点在输入框里时不管。
  document.addEventListener("keydown", (e) => {
    if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    if (e.key === "Escape" && tool !== "none") { setTool("none"); return; }
    if (e.key === "Escape" && shownFocus()) { setFocus(null); return; }
    if (rs.mode !== "replay" || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    const action = { ArrowDown: "toggle", ArrowRight: "forward", ArrowLeft: "back" }[e.key];
    if (!action) return;
    e.preventDefault();
    dispatch({ type: action });
  });
  document.addEventListener("mousedown", (e) => { if (!e.target.closest(".replay-start-wrap")) setMenu(false); });

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paint);
  new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  syncLayers();

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
      if (rs.mode === "replay" || !d.weekly) frame = "day"; // 回放只在日线上；没有周线（练习）就回日线
      if (tool === "pick-start") tool = "none"; // 换了数据：选到一半的起点作废
      ruler = null; // 量的两点属于旧数据
      clearFlash(); // 亮着的价位也是
      arm();
      if (!sameTicker) { drawKey = key; loadDrawn(); }
      structure = gaps = null; // 结构、缺口属于上一份分析；app 随后用 setStructure 给这份的（练习、揭晓时不给）
      paintDrawn();
      if (rs.mode === "replay") {
        show(sliceAt(d, index));
        if (r) chart.timeScale().setVisibleLogicalRange(r);
      } else {
        show(frameData(d));
        applyRange();
      }
      paintLevels();
      syncTool();
    },
    /** 盲测练习：往后多了一根（服务端只发到现在那根）。只追加，视图不跳。 */
    extend(delta) {
      if (!data) return;
      data = appendDelta(data, delta);
      view = data;
      candles.update(candleBar(delta.candle));
      for (const v of delta.volume) vol.update(volBar(v));
      for (const s of SPECS) for (const p of delta.lines[s.key] ?? []) series[s.key].update({ ...p });
      paintRibbon();
      paintMarkers();
      paintProfile();
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
      if (on) leaveReplay();
      replayBtn.hidden = on;
      practicing = on;
      paintLines();
      paintOverlay(); // 练习里用不了的图层（变色提示）跟着变
    },
    /** 停止回放、回到完整数据（取数失败、中栏收起图表时用）。 */
    stopReplay() { leaveReplay(); },
    /** 财报日（分析 JSON 的 earnings）：图上标 E；练习里没有，传 null 清掉。 */
    setEarnings(e) {
      earnings = e ?? null;
      if (rs.mode === "replay") paintEarnings(); // 回放中重新载入：视图留在原处
      else applyRange(); // 右边的空位要不要放宽到下一次财报
    },
    /** 结构标注：分析 JSON 的 structure；练习、揭晓时传 null，不画。 */
    setStructure(s) {
      structure = s ?? null;
      paintOverlay();
    },
    /** 缺口：分析 JSON 的 gaps 和交易计划的目标位（被用作目标的缺口标出来）；练习、揭晓时传 null，不画。 */
    setGaps(list, targets = []) {
      gaps = list ? { list, targets } : null;
      paintOverlay();
    },
    /** 筹码分布的参考带：交易计划记下的上方最近的筹码山（P38，trade_plan 的 mountain） { foot（山脚）, top（山顶） }；没有或练习里传 null。 */
    setProfileRef(m) {
      profileRef = m ? { foot: m.foot, top: m.top } : null;
      paintProfile();
    },
    /** 筹码分布（测试和问鸿雁用）：开没开、不能用的原因、用了哪段 K 线、筹码山、参考带、画在哪。 */
    profile: () => ({
      on: layerRow("profile").shown, why: layerRow("profile").why,
      from: profileNow?.from ?? null, to: profileNow?.to ?? null, bars: profileNow?.bars ?? 0,
      mountains: profileNow?.mountains ?? [], ref: rs.mode === "replay" ? null : profileRef, drawn: profileLayer.drawn(),
    }),
    /** 现在画着的结构标注和缺口（测试用）：{ segments, levels, marks, bands }，见 overlays.js。 */
    structure: () => structLayer.scene(),
    /** 图上的小字摆在哪（测试用）：[{ text, left, top, width, height, hidden }] 和价位线的 y。 */
    labels: () => ({ labels: structLayer.labels(), guides: guidePrices().map((p) => candles.priceToCoordinate(p)) }),
    /** 价位线：[{ kind: trigger | stop | target | invalid, price, title }]，来自 viz.js 的 chartLevels。 */
    setLevels(list) {
      levels = list;
      paintLevels();
    },
    /** 各条线现在的样式（测试用）：{ MA20: { color, lineWidth, lineStyle, visible, lastValueVisible, title }, … }。 */
    lineStyles: () => Object.fromEntries(SPECS.map((s) => {
      const { color, lineWidth, lineStyle: style, visible, lastValueVisible, title } = series[s.key].options();
      return [s.key, { color, lineWidth, lineStyle: style, visible, lastValueVisible, title }];
    })),
    /** 聚焦的线组（20 / 60 / 120）和色带（测试用）：{ group, band: [{ i, ma, ema }] }。 */
    focus: () => ({ group: shownFocus(), band: structLayer.ribbon().points }),
    /** 当前画在图上的价位线（测试和问鸿雁用）。 */
    levels: () => (levelsShown() ? levels.map(({ kind, title, price }) => ({ kind, title, price })) : []),
    /** 点了结论卡片上的一个价位：{ kind, price, title } 那条线在图上亮几秒，价位线图层关着也亮。 */
    flashLevel,
    /** 正在亮着的价位（测试用）：{ kind, price, title, y（在图上的纵坐标） }，没有是 null。 */
    flashing: () => (flash ? { kind: flash.kind, price: flash.price, title: flash.title, y: candles.priceToCoordinate(flash.price) } : null),
    /** 图层（测试用）：现在是哪个预设（null = 自定），每个图层开没开、画没画、不能用的原因。 */
    layers: () => ({ preset: presetOf(layers), rows: layerRows(layers, layerCtx()).map(({ key, on, shown: drawn, why }) => ({ key, on, shown: drawn, why })) }),
    /** 图上的变色提示（测试用）：上一次画的小三角 [{ time, to: "bull" | "bear", left, top, width, height }]。 */
    turns: () => structLayer.turns(),
    /** 图上的抵扣价小黄点（测试用）：["20扣", …]。 */
    drops: () => candles.markers().map((m) => m.text),
    /** 有几根 K 线着了色（测试用）。 */
    toned: () => candles.data().filter((b) => b.borderColor).length,
    /** 自己画的线（价格列表）。 */
    drawn: () => [...drawn],
    /** 回放状态（测试用）：mode / index / playing，加上速度、回放到的日期、图上几根 K 线。 */
    /** 日线还是周线（测试用）：day | week。 */
    frame: () => frame,
    /** 图上的交互模式（测试用）：none | draw | measure | pick-start。 */
    tool: () => tool,
    /** 测量的结果（测试用）：没有在量时为 null。 */
    measured: () => (ruler && !mLayer.hidden ? { a: { ...ruler.a }, b: { ...ruler.b }, ...measure(ruler.a, ruler.b, view.candles) } : null),
    replay: () => ({ ...rs, speed, date: rs.mode === "replay" ? data.candles[rs.index].time : null, bars: view?.candles.length ?? 0 }),
    /** 回放里点「按这一天分析」时回调那天的日期。 */
    onAnalyzeDate(cb) { analyzeDate = cb; },
    /** 点图表时回调 { time, candle, lines, drops, point }，给"问鸿雁"用。画线、测量、选回放起点时不回调；回放时按回放到的数据。 */
    onPick(cb) {
      chart.subscribeClick((param) => {
        if (tool !== "none" || !param.time || !view) return;
        const candle = view.candles.find((c) => c.time === param.time);
        if (!candle) return; // 回放时右边空白处
        const lines = Object.fromEntries(SPECS.map((s) => [s.key, (view.lines[s.key] || []).find((p) => p.time === param.time)?.value]));
        const drops = view.drops.filter((d) => d.time === param.time).map((d) => d.period);
        cb({ time: showTime(param.time), candle, lines, drops, point: param.point });
      });
    },
  };
}

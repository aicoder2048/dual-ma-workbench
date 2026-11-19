// K 线 + 6 条均线 + 抵扣价小黄点 + 成交量（TradingView lightweight-charts 4.2.0）。
const SPECS = [];
[20, 60, 120].forEach((n) => ["MA", "EMA"].forEach((k) =>
  SPECS.push({ key: k + n, token: `--${k.toLowerCase()}${n}`, dashed: k === "EMA", width: k === "MA" ? 2 : 1 })));

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export function createChart(box, legendEl) {
  if (!window.LightweightCharts) {
    box.innerHTML = '<p class="caption">图表库没能从 CDN 加载，请检查网络。</p>';
    return null;
  }
  box.innerHTML = "";
  const chart = LightweightCharts.createChart(box, {
    autoSize: true,
    rightPriceScale: { scaleMargins: { top: 0.06, bottom: 0.24 } },
    timeScale: { rightOffset: 4 },
    crosshair: { mode: 0 },
    // 滚轮只滚页面，不缩放图表（误触太多）；按住拖动平移、拖价格轴缩放、触控板双指捏合仍可用
    handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true },
  });
  const candles = chart.addCandlestickSeries({ priceLineVisible: false });
  const vol = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  const series = {};
  for (const s of SPECS) {
    series[s.key] = chart.addLineSeries({ lineWidth: s.width, lineStyle: s.dashed ? 2 : 0,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  }

  legendEl.innerHTML = "";
  for (const s of SPECS) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-pressed", "true");
    b.innerHTML = `<i class="${s.dashed ? "dash" : ""}" style="--c: var(${s.token})"></i>${s.key}`;
    b.addEventListener("click", () => {
      const on = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", String(on));
      series[s.key].applyOptions({ visible: on });
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
    if (!data?.candles.length) { readout.textContent = ""; return; }
    const c = data.candles.find((x) => x.time === time) ?? data.candles.at(-1);
    const at = (k) => (data.lines[k] || []).find((p) => p.time === c.time)?.value;
    readout.innerHTML = `<b>${c.time}</b><span>收 <b>${f2(c.close)}</b></span>`
      + SPECS.map((sp) => `<span><i class="${sp.dashed ? "dash" : ""}" style="--c: var(${sp.token})"></i>${sp.key} ${f2(at(sp.key))}</span>`).join("");
  };
  chart.subscribeCrosshairMove((param) => showReadout(param.time));

  // ---------- 范围按钮：固定时长看斜率（文章 2.4：短期看 1 年） ----------
  const RANGES = [["6m", "半年", 6], ["1y", "1 年", 12], ["all", "全部", null]];
  let rangeKey = "1y";
  const tools = document.createElement("div");
  tools.className = "chart-tools";
  tools.innerHTML = RANGES.map(([k, label]) => `<button type="button" class="range-btn" data-range="${k}">${label}</button>`).join("")
    + `<button type="button" class="range-btn" data-range="reset" title="回到当前范围的默认视图">复位</button>`
    + `<button type="button" class="draw-toggle" aria-pressed="false" title="点这里，再点图上任意一处，就在那个价位画一条横线">画线</button>`
    + `<button type="button" class="draw-clear" title="删掉这只股票上自己画的线">清除</button>`
    + `<button type="button" class="levels-toggle" aria-pressed="true" title="把「什么会改变判断」的价位画成虚线">门槛线</button>`
    + `<button type="button" class="chart-help-toggle" aria-expanded="false">怎么用</button>`;
  legendEl.after(tools);
  const applyRange = () => {
    tools.querySelectorAll(".range-btn").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.range === rangeKey)));
    if (!data?.candles.length) return;
    const months = RANGES.find(([k]) => k === rangeKey)[2];
    const last = data.candles.at(-1).time;
    if (!months) { chart.timeScale().fitContent(); return; }
    const from = new Date(last);
    from.setMonth(from.getMonth() - months);
    const first = data.candles.find((c) => c.time >= from.toISOString().slice(0, 10))?.time ?? data.candles[0].time;
    chart.timeScale().setVisibleRange({ from: first, to: last });
  };
  tools.addEventListener("click", (e) => {
    const b = e.target.closest(".range-btn");
    if (!b) return;
    if (b.dataset.range !== "reset") rangeKey = b.dataset.range;
    applyRange();
  });

  // ---------- 门槛线：模糊判断里"什么会改变判断"的价位 ----------
  let levels = [];
  let levelLines = [];
  let levelsOn = true;
  const paintLevels = () => {
    levelLines.forEach((l) => candles.removePriceLine(l));
    levelLines = levelsOn ? levels.map((lv) => candles.createPriceLine({
      price: lv.price, color: css(lv.line.endsWith("20") ? "--ma20" : "--ma60"), lineWidth: 1, lineStyle: 2,
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
    <p><b>固定范围</b>（半年 / 1 年 / 全部）：均线的斜率（几点钟方向）只有在同样长的时间里比才不失真，所以要固定时长、用对数坐标。
      <b>1 年</b>（默认）判断现在是几点钟、属于哪种趋势；<b>全部</b>看大周期和横盘有多长（"横有多长，竖有多高"）；<b>半年</b>看最近的细节，比如这次回调比上次深还是浅。</p>
    <p><b>画线</b>：点「画线」，再点图上一处，就在那个价位画一条横线，刷新后还在。常画的是前高、前低、自己的成本价、"跌破就重新看"的价位。
      图上的<b>虚线门槛线</b>是自动画的：价格过了它，20 线组才会拐头（先 EMA20，后 MA20），判断才值得改。</p>
    <p><b>看量</b>：底部的量柱，黄色是超过 50 日均量 2 倍的大量。看两种情况：横盘末期突然放量，是要变盘的信号；
      急涨或急跌的末端连续放量，说明多空分歧在化解，行情往往快要转向，并不代表强势。看到放量先提高警惕，动手还是要等均线拐头。</p>`;
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
    if (!drawing || !param.point) return;
    const price = candles.coordinateToPrice(param.point.y);
    if (price == null) return;
    drawn.push(Math.round(price * 100) / 100);
    saveDrawn();
    paintDrawn();
    setTimeout(() => setDrawing(false)); // 同一次点击的其他处理（问鸿雁）还要看到"正在画线"
  });

  let data = null;

  function paint() {
    if (!data) return;
    const muted = css("--muted");
    chart.applyOptions({
      layout: { background: { type: "solid", color: css("--card") }, textColor: muted, fontFamily: css("--mono") },
      grid: { vertLines: { color: css("--grid") }, horzLines: { color: css("--grid") } },
      rightPriceScale: { borderColor: css("--line") }, timeScale: { borderColor: css("--line") },
    });
    candles.applyOptions({ upColor: "rgba(0,0,0,0)", downColor: muted, borderUpColor: muted, borderDownColor: muted, wickUpColor: muted, wickDownColor: muted });
    vol.setData(data.volume.map((v) => ({ time: v.time, value: v.value, color: v.spike ? css("--drop") : css("--line") })));
    for (const s of SPECS) series[s.key].applyOptions({ color: css(s.token) });
    const drop = css("--drop");
    paintLevels();
    candles.setMarkers(data.drops.slice().sort((a, b) => (a.time < b.time ? -1 : 1)).map((d) => ({
      time: d.time, position: "belowBar", color: drop, shape: "circle", text: `${d.period}扣`,
    })));
  }

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paint);
  new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  return {
    chart,
    /** key：股票代码（自己画的线按它分开存）。 */
    setData(d, key = null) {
      data = d;
      if (key !== drawKey) { drawKey = key; loadDrawn(); }
      paintDrawn();
      candles.setData(d.candles);
      for (const s of SPECS) series[s.key].setData(d.lines[s.key] || []);
      paint();
      applyRange();
      showReadout(null);
    },
    /**
     * 门槛线：lean.flips 里 20 线组还没越过的价位（第 1 个动作 EMA20、第 2 个动作 MA20 抵扣价）。
     * 偏空时是"站上"，偏多时是"跌破"。60 线组的价位留在模糊判断卡片里，图上不画，免得挤。
     */
    setLevels(lean) {
      const verb = lean.score < 0 ? "站上" : "跌破";
      levels = lean.flips.filter((f) => !f.crossed && f.line.endsWith("20") && !f.line.endsWith("120"))
        .map((f) => ({ line: f.line, price: f.price, title: `${verb} ${f.line.startsWith("EMA") ? f.line : `${f.line} 抵扣价`}` }));
      paintLevels();
    },
    /** 当前画在图上的门槛线（测试和问鸿雁用）。 */
    levels: () => (levelsOn ? levels.map(({ title, price }) => ({ title, price })) : []),
    /** 自己画的线（价格列表）。 */
    drawn: () => [...drawn],
    /** 点图表时回调 { time, candle, lines, drops, point }，给"问鸿雁"用。画线模式下不回调。 */
    onPick(cb) {
      chart.subscribeClick((param) => {
        if (drawing || !param.time || !data) return;
        const candle = data.candles.find((c) => c.time === param.time);
        const lines = Object.fromEntries(SPECS.map((s) => [s.key, (data.lines[s.key] || []).find((p) => p.time === param.time)?.value]));
        const drops = data.drops.filter((d) => d.time === param.time).map((d) => d.period);
        cb({ time: param.time, candle, lines, drops, point: param.point });
      });
    },
  };
}

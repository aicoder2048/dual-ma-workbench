// 识别题的图：K 线，按题目要求加 6 条均线、量、明天的抵扣价小点、标出的 K 线。时间一律写成 T+n（题目那根是 T0）。
// 只画服务端给的（到题目那一根为止），没有缩放以外的工具，看完就答。
// 点图题：点 K 线记一根（onPick），点过的和交卷后的答案画成标记（setPins）。
// 推演揭晓题交卷后 reveal 把 T0 之后的真实 K 线、均线接上，另画收平价位和真实发生的交叉。

const LINES = [20, 60, 120].flatMap((n) => ["MA", "EMA"].map((k) => ({ key: k + n, token: `--${k.toLowerCase()}${n}`, dashed: k === "EMA", width: k === "MA" ? 2 : 1 })));
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const tLabel = (k) => (k === 0 ? "T0" : k > 0 ? `T+${k}` : `T${k}`);
const isoDate = (t) => (typeof t === "string" ? t : `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`);
const f2 = (x) => Number(x).toFixed(2);

/** box：图的容器；readout：显示鼠标所在那根的开高低收。返回 { show(drill), onPick(fn), setPins(pins), reveal(r) }。 */
export function createDrillChart(box, readout) {
  if (!window.LightweightCharts) {
    box.innerHTML = '<p class="caption">图表库没能从 CDN 加载，请检查网络。</p>';
    return null;
  }
  const L = window.LightweightCharts;
  let label = () => "";
  let drill = null;
  /** 图上现在的 K 线：题目那段，揭晓后接上之后的。 */
  let bars = [];
  /** 揭晓：{ future: Set<time>, marks, volume }。 */
  let shown = null;
  /** 点图题点过的、交卷后的答案：{ time, text, kind: "pick" | "right" | "wrong" | "answer" }。 */
  let pins = [];
  let pickFn = null;
  let levelLine = null;
  const chart = L.createChart(box, {
    autoSize: true,
    rightPriceScale: { scaleMargins: { top: 0.06, bottom: 0.2 } },
    timeScale: { rightOffset: 3, tickMarkFormatter: (t) => label(isoDate(t)) },
    localization: { timeFormatter: (t) => label(isoDate(t)) },
    crosshair: { mode: 0 },
    handleScroll: { mouseWheel: false, pressedMouseMove: true },
    handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true },
  });
  const candles = chart.addCandlestickSeries({ priceLineVisible: false, lastValueVisible: false });
  const vol = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
  const series = Object.fromEntries(LINES.map((s) => [s.key, chart.addLineSeries({
    lineWidth: s.width, lineStyle: s.dashed ? 2 : 0, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
  })]));

  function paint() {
    if (!drill) return;
    const muted = css("--muted"), accent = css("--accent"), drop = css("--drop");
    chart.applyOptions({
      layout: { background: { type: "solid", color: css("--card") }, textColor: muted, fontFamily: css("--mono") },
      grid: { vertLines: { color: css("--grid") }, horzLines: { color: css("--grid") } },
      rightPriceScale: { borderColor: css("--line") }, timeScale: { borderColor: css("--line") },
    });
    candles.applyOptions({ upColor: "rgba(0,0,0,0)", downColor: muted, borderUpColor: muted, borderDownColor: muted, wickUpColor: muted, wickDownColor: muted });
    // 揭晓出来的 K 线用强调色，和作答时看到的分开
    candles.setData(bars.map((c) => (shown?.future.has(c.time)
      ? { ...c, color: c.close >= c.open ? "rgba(0,0,0,0)" : accent, borderColor: accent, wickColor: accent } : c)));
    for (const s of LINES) series[s.key].applyOptions({ color: css(s.token) });
    vol.setData([...drill.chart.volume, ...(shown?.volume ?? [])].map((v) => ({ time: v.time, value: v.value, color: css(v.spike ? "--drop" : "--line") })));
    levelLine?.applyOptions({ color: accent });
    const pinColor = { pick: accent, right: css("--up"), wrong: css("--down"), answer: css("--up") };
    const markers = [
      ...drill.chart.drops.map((d) => ({ time: d.time, position: "belowBar", color: drop, shape: "circle", text: `${d.period}扣` })),
      ...drill.marks.map((m) => ({ time: m.time, position: "aboveBar", color: accent, shape: "arrowDown", text: m.text })),
      ...pins.map((p) => ({ time: p.time, position: p.kind === "answer" ? "belowBar" : "aboveBar", color: pinColor[p.kind], shape: p.kind === "answer" ? "arrowUp" : "arrowDown", text: p.text })),
      ...(shown ? [{ time: drill.t0, position: "aboveBar", color: muted, shape: "square", text: "T0 作答" },
        ...shown.marks.map((m) => ({ time: m.time, position: "belowBar", color: accent, shape: "arrowUp", text: m.text }))] : []),
    ];
    candles.setMarkers(markers.sort((a, b) => (a.time < b.time ? -1 : 1)));
  }

  function showReadout(time) {
    const i = time ? bars.findIndex((c) => c.time === time) : bars.length - 1;
    const c = bars[i];
    readout.textContent = c ? `${label(c.time)}　开 ${f2(c.open)}　高 ${f2(c.high)}　低 ${f2(c.low)}　收 ${f2(c.close)}` : "";
  }

  function relabel() {
    const at = new Map(bars.map((c, i) => [c.time, i]));
    const zero = at.get(drill.t0);
    label = (t) => (at.has(t) ? tLabel(at.get(t) - zero) : "");
  }

  chart.subscribeCrosshairMove((p) => drill && showReadout(p.time ? isoDate(p.time) : null));
  // 点图题自己听按下、抬起：图表库的单击回调在上一下之后半秒内不报（算双击），连着点两根、同一根点两下都会丢。
  // 按下到抬起挪了几个像素以上是在拖图，不算点。
  let down = null;
  box.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY }; });
  box.addEventListener("pointerup", (e) => {
    const was = down;
    down = null;
    if (!drill || !pickFn || !was || Math.hypot(e.clientX - was.x, e.clientY - was.y) > 4) return;
    const x = e.clientX - box.getBoundingClientRect().left;
    if (x > chart.timeScale().width()) return; // 价格轴上
    const t = chart.timeScale().coordinateToTime(x);
    const time = t && isoDate(t);
    if (time && bars.some((c) => c.time === time)) pickFn(time, label(time));
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paint);
  new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  return {
    show(d) {
      drill = d;
      shown = null;
      pins = [];
      pickFn = null;
      if (levelLine) { candles.removePriceLine(levelLine); levelLine = null; }
      bars = d.chart.candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close }));
      relabel();
      for (const s of LINES) series[s.key].setData(d.chart.lines[s.key] ?? []);
      paint();
      chart.timeScale().fitContent();
      showReadout(null);
    },
    /** 点图题：fn(time, label) 在点到一根 K 线时调；null 关掉。 */
    onPick(fn) { pickFn = fn; },
    /** 点过的和答案的标记，整组换掉。 */
    setPins(next) { pins = next; paint(); },
    /** 推演揭晓：接上 T0 之后的真实 K 线和均线，画收平价位、真实的交叉。 */
    reveal(r) {
      if (!drill) return;
      bars = [...bars, ...r.chart.candles];
      shown = { future: new Set(r.chart.candles.map((c) => c.time)), marks: r.marks, volume: r.chart.volume };
      relabel();
      for (const s of LINES) series[s.key].setData([...(drill.chart.lines[s.key] ?? []), ...(r.chart.lines[s.key] ?? [])]);
      levelLine = candles.createPriceLine({ price: r.level, color: css("--accent"), lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "收平" });
      paint();
      chart.timeScale().fitContent();
      showReadout(null);
    },
  };
}

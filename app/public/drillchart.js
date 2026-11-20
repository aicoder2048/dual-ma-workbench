// 识别题的图：K 线，按题目要求加 6 条均线、量、明天的抵扣价小点、标出的 K 线。时间一律写成 T+n（题目那根是 T0）。
// 只画服务端给的（到题目那一根为止），没有缩放以外的工具，看完就答。

const LINES = [20, 60, 120].flatMap((n) => ["MA", "EMA"].map((k) => ({ key: k + n, token: `--${k.toLowerCase()}${n}`, dashed: k === "EMA", width: k === "MA" ? 2 : 1 })));
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const tLabel = (k) => (k === 0 ? "T0" : k > 0 ? `T+${k}` : `T${k}`);
const isoDate = (t) => (typeof t === "string" ? t : `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`);
const f2 = (x) => Number(x).toFixed(2);

/** box：图的容器；readout：显示鼠标所在那根的开高低收。返回 { show(drill) }。 */
export function createDrillChart(box, readout) {
  if (!window.LightweightCharts) {
    box.innerHTML = '<p class="caption">图表库没能从 CDN 加载，请检查网络。</p>';
    return null;
  }
  const L = window.LightweightCharts;
  let label = () => "";
  let drill = null;
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
    const muted = css("--muted");
    chart.applyOptions({
      layout: { background: { type: "solid", color: css("--card") }, textColor: muted, fontFamily: css("--mono") },
      grid: { vertLines: { color: css("--grid") }, horzLines: { color: css("--grid") } },
      rightPriceScale: { borderColor: css("--line") }, timeScale: { borderColor: css("--line") },
    });
    candles.applyOptions({ upColor: "rgba(0,0,0,0)", downColor: muted, borderUpColor: muted, borderDownColor: muted, wickUpColor: muted, wickDownColor: muted });
    for (const s of LINES) series[s.key].applyOptions({ color: css(s.token) });
    vol.setData(drill.chart.volume.map((v) => ({ time: v.time, value: v.value, color: css(v.spike ? "--drop" : "--line") })));
    const drop = css("--drop"), accent = css("--accent");
    const markers = [
      ...drill.chart.drops.map((d) => ({ time: d.time, position: "belowBar", color: drop, shape: "circle", text: `${d.period}扣` })),
      ...drill.marks.map((m) => ({ time: m.time, position: "aboveBar", color: accent, shape: "arrowDown", text: m.text })),
    ];
    candles.setMarkers(markers.sort((a, b) => (a.time < b.time ? -1 : 1)));
  }

  function showReadout(time) {
    const i = time ? drill.chart.candles.findIndex((c) => c.time === time) : drill.chart.candles.length - 1;
    const c = drill.chart.candles[i];
    readout.textContent = c ? `${label(c.time)}　开 ${f2(c.open)}　高 ${f2(c.high)}　低 ${f2(c.low)}　收 ${f2(c.close)}` : "";
  }
  chart.subscribeCrosshairMove((p) => drill && showReadout(p.time ? isoDate(p.time) : null));
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paint);
  new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  return {
    show(d) {
      drill = d;
      const at = new Map(d.chart.candles.map((c, i) => [c.time, i]));
      const zero = at.get(d.t0);
      label = (t) => (at.has(t) ? tLabel(at.get(t) - zero) : "");
      candles.setData(d.chart.candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
      for (const s of LINES) series[s.key].setData(d.chart.lines[s.key] ?? []);
      paint();
      chart.timeScale().fitContent();
      showReadout(null);
    },
  };
}

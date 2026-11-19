// K 线 + 6 条均线 + 底扣价小黄点 + 成交量（TradingView lightweight-charts 4.2.0）。
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
    candles.setMarkers(data.drops.slice().sort((a, b) => (a.time < b.time ? -1 : 1)).map((d) => ({
      time: d.time, position: "belowBar", color: drop, shape: "circle", text: `${d.period}扣`,
    })));
  }

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paint);
  new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  return {
    chart,
    setData(d) {
      data = d;
      candles.setData(d.candles);
      for (const s of SPECS) series[s.key].setData(d.lines[s.key] || []);
      paint();
      chart.timeScale().fitContent();
    },
    /** 点图表时回调 { time, candle, lines, drops, point }，给"问参谋"用。 */
    onPick(cb) {
      chart.subscribeClick((param) => {
        if (!param.time || !data) return;
        const candle = data.candles.find((c) => c.time === param.time);
        const lines = Object.fromEntries(SPECS.map((s) => [s.key, (data.lines[s.key] || []).find((p) => p.time === param.time)?.value]));
        const drops = data.drops.filter((d) => d.time === param.time).map((d) => d.period);
        cb({ time: param.time, candle, lines, drops, point: param.point });
      });
    },
  };
}

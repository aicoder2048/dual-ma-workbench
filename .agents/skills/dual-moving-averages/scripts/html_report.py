"""把 dma_analyze.analyze() 的结果渲染成单文件网页报告。

图表用 TradingView 开源的 lightweight-charts（jsDelivr CDN），其余 CSS/JS 全部内联。
页面跟随浏览器亮/暗主题，可以直接本地打开，也可以发布成 claude.ai Artifact。

点评 JSON（全部字段可选；文本里可以用 **加粗**）：
{
  "headline": "下跌趋势，正在进入极度超卖",        # 一句话结论
  "stance": "bearish",                              # bullish | bearish | neutral，决定结论颜色
  "summary": "不抄底，不抢反弹；反弹到 20 日线附近减仓。",
  "big_picture": ["..."],                           # 第 1 步的点评要点
  "strategy": ["..."],                              # 第 2 步
  "direction": ["..."],                             # 第 3 步
  "risks": ["..."]                                  # 什么情况会推翻判断
}
"""
from __future__ import annotations

import html
import json
import re
from datetime import datetime
from pathlib import Path

import pandas as pd

CHART_BARS = 260  # 图上显示最近多少根日 K 线
CHART_LIB = "https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js"
LIST_FIELDS = ("big_picture", "strategy", "direction", "risks")


def load_commentary(path: str) -> dict:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("点评 JSON 顶层必须是对象")
    for key in LIST_FIELDS:
        if key in data and not isinstance(data[key], list):
            raise ValueError(f"点评 JSON 的 {key} 必须是字符串数组")
    if data.get("stance") not in (None, "bullish", "bearish", "neutral"):
        raise ValueError("stance 只能是 bullish / bearish / neutral")
    return data


def _t(text: str) -> str:
    """转义后支持 **加粗**。"""
    return re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", html.escape(str(text)))


def _bullets(items: list[str] | None, cls: str = "notes") -> str:
    if not items:
        return ""
    return f'<ul class="{cls}">' + "".join(f"<li>{_t(i)}</li>" for i in items) + "</ul>"


def chart_data(df: pd.DataFrame, a: dict) -> dict:
    view = df.tail(CHART_BARS)
    dates = [d.strftime("%Y-%m-%d") for d in view.index]

    def line(col: str) -> list[dict]:
        return [{"time": t, "value": round(float(v), 4)} for t, v in zip(dates, view[col]) if pd.notna(v)]

    candles = [{"time": t, "open": float(r.get("Open", r["Close"])), "high": float(r.get("High", r["Close"])),
                "low": float(r.get("Low", r["Close"])), "close": float(r["Close"])}
               for t, (_, r) in zip(dates, view.iterrows())]
    volume = []
    if "Volume" in view.columns:
        ratio = view["Volume"] / df["Volume"].rolling(50).mean().reindex(view.index)
        volume = [{"time": t, "value": float(v), "spike": bool(r > 2)}
                  for t, v, r in zip(dates, view["Volume"], ratio) if pd.notna(v)]
    # 明天要扣的那根 K 线 = 倒数第 N 根（见 drop_off）
    drops = [{"time": df.index[-n].strftime("%Y-%m-%d"), "period": n}
             for n in (ln["period"] for ln in a["lines"]) if len(df) >= n and df.index[-n] >= view.index[0]]
    lines = {f"{k}{ln['period']}": line(f"{k}{ln['period']}") for ln in a["lines"] for k in ("MA", "EMA")}
    return {"candles": candles, "volume": volume, "lines": lines, "drops": drops}


def render_html(a: dict, df: pd.DataFrame, commentary: dict | None = None) -> str:
    c = commentary or {}
    lean = a["lean"]
    lean_stance = "bullish" if lean["score"] >= 0.25 else "bearish" if lean["score"] <= -0.25 else "neutral"
    stance = c.get("stance") or lean_stance
    lean_name = lean["label"] + ("·" + lean["conflict"] if lean["conflict"] else "")
    headline = c.get("headline") or f"{lean_name}（{a['trend']}）"
    summary = c.get("summary") or lean["play"]
    flip = next((f["text"] for f in lean["flips"] if not f["crossed"]), "暂无：方向不明，等均线理顺")
    chg_cls = "up" if a["change_pct"] >= 0 else "down"
    chart_json = json.dumps(chart_data(df, a), ensure_ascii=False).replace("</", "<\\/")

    line_rows = "".join(
        f"<tr><th>{ln['period']}</th><td>{ln['ma']:.2f}</td><td>{ln['ema']:.2f}</td>"
        f"<td class=\"{'up' if ln['above'] else 'down'}\">{'上方' if ln['above'] else '下方'}</td>"
        f"<td>{html.escape(ln['clock'])}<span class=\"sub\">{ln['slope']:+.2f}%/日</span></td></tr>"
        for ln in a["lines"])
    cross_rows = "".join(
        f"<li><b>{x['pair']}</b> MA {html.escape(x['ma'])}；EMA {html.escape(x['ema'])}</li>" for x in a["crosses"])
    vol = a["volume"]
    vol_text = (f"今日 {vol['ratio']:.1f}× 50 日均量；近 20 日放量 {len(vol['spikes'])} 天" if vol else "无成交量数据")
    drop_rows = "".join(
        f"<tr><th>MA{d['period']}</th><td>{d['tomorrow']:.2f}</td>"
        f"<td class=\"{'up' if d['direction'] == '上' else 'down' if d['direction'] == '下' else ''}\">{d['direction']}</td>"
        f"<td>{d['below']}/{d['count']}</td>"
        f"<td class=\"{'up' if d['ma_flat_change_pct'] >= 0 else 'down'}\">{d['ma_flat_change_pct']:+.2f}%</td>"
        f"<td>{'第 ' + str(d['first_low']) + ' 天' if d['first_low'] else str(d['period']) + ' 天内不会'}</td></tr>"
        for d in a["drops"])
    warning = (f'<div class="warn" role="note"><b>注意</b> {html.escape(a["warning"])}</div>'
               if a["warning"] else "")
    risks = _bullets(c.get("risks"), "risks")
    risks_block = f'<section class="block"><h2>什么情况会推翻这个判断</h2>{risks}</section>' if risks else ""
    ai_note = "点评由 Claude 根据下面的数据撰写" if commentary else "没有 AI 点评，结论来自规则初判"
    generated = datetime.now().strftime("%Y-%m-%d %H:%M")

    return f"""<title>{html.escape(a['label'])} 双均线报告</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Noto+Sans+SC:wght@400;500;700&display=swap">
<style>
/* 布局：研报式单栏。顶部结论 → 图表 → 三步分析三列（窄屏堆叠）→ 风险 */
:root {{
  --bg: #f4f6f9; --card: #ffffff; --fg: #18202c; --muted: #5a6577; --line: #dde2ea; --grid: #eef1f5;
  --up: #17855a; --down: #c2372c; --neutral: #a8700f; --drop: #e0a100;
  --ma20: #1c2430; --ema20: #8a94a6; --ma60: #d62828; --ema60: #f08a8a; --ma120: #1f5fbf; --ema120: #86aee8;
  --warn-bg: #fff4d6; --warn-fg: #6b4a00;
  --sans: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
}}
@media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{
  --bg: #0e131a; --card: #151c26; --fg: #e5e9f0; --muted: #94a0b4; --line: #263142; --grid: #1c2532;
  --up: #3cc48a; --down: #ff6b5e; --neutral: #e3a93b; --drop: #ffc531;
  --ma20: #e5e9f0; --ema20: #7d889b; --ma60: #ff5a5a; --ema60: #ff9f9f; --ma120: #5b9bff; --ema120: #a9c6ff;
  --warn-bg: #3a2e10; --warn-fg: #ffd98a; color-scheme: dark; }} }}
:root[data-theme="dark"] {{
  --bg: #0e131a; --card: #151c26; --fg: #e5e9f0; --muted: #94a0b4; --line: #263142; --grid: #1c2532;
  --up: #3cc48a; --down: #ff6b5e; --neutral: #e3a93b; --drop: #ffc531;
  --ma20: #e5e9f0; --ema20: #7d889b; --ma60: #ff5a5a; --ema60: #ff9f9f; --ma120: #5b9bff; --ema120: #a9c6ff;
  --warn-bg: #3a2e10; --warn-fg: #ffd98a; color-scheme: dark; }}
body {{ background: var(--bg); color: var(--fg); font-family: var(--sans); font-size: 15px; line-height: 1.65; }}
.wrap {{ max-width: 1120px; margin: 0 auto; padding-block: 28px 48px;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px));
  display: grid; gap: 20px; }}
.num, td, .price {{ font-family: var(--mono); font-variant-numeric: tabular-nums; }}
header {{ display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 8px 24px; }}
.eyebrow {{ font-size: 12px; letter-spacing: .08em; color: var(--muted); }}
h1 {{ margin: 2px 0 0; font-size: 34px; line-height: 1.1; display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }}
h1 .price {{ font-size: 22px; font-weight: 600; }}
h1 .chg {{ font-size: 15px; font-family: var(--mono); }}
.meta {{ font-size: 13px; color: var(--muted); text-align: right; min-width: 0; }}
.up {{ color: var(--up); }} .down {{ color: var(--down); }}
.warn {{ background: var(--warn-bg); color: var(--warn-fg); border-radius: 8px; padding: 10px 14px; font-size: 14px; }}
.verdict {{ background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px 22px;
  border-left: 5px solid var(--stance); display: grid; gap: 6px; }}
.verdict[data-stance="bullish"] {{ --stance: var(--up); }}
.verdict[data-stance="bearish"] {{ --stance: var(--down); }}
.verdict[data-stance="neutral"] {{ --stance: var(--neutral); }}
.verdict h2 {{ margin: 0; font-size: 24px; line-height: 1.3; text-wrap: balance; color: var(--stance); }}
.verdict p {{ margin: 0; font-size: 16px; max-width: 70ch; }}
.chips {{ display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }}
.chip {{ font-size: 12px; border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; color: var(--muted); }}
.chip b {{ color: var(--fg); font-weight: 500; }}
.card {{ background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; min-width: 0; }}
.legend {{ display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }}
.legend button {{ font: 12px var(--mono); color: var(--fg); background: transparent; border: 1px solid var(--line);
  border-radius: 6px; padding: 3px 9px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }}
.legend button[aria-pressed="false"] {{ opacity: .4; }}
.legend button:focus-visible {{ outline: 2px solid var(--ma120); outline-offset: 2px; }}
.legend i {{ width: 14px; height: 3px; border-radius: 2px; background: var(--c); display: inline-block; }}
.legend i.dash {{ background: repeating-linear-gradient(90deg, var(--c) 0 4px, transparent 4px 7px); }}
#chart {{ height: 440px; width: 100%; }}
.caption {{ font-size: 13px; color: var(--muted); margin: 10px 0 0; }}
.dot {{ display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--drop); vertical-align: middle; }}
.steps {{ display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }}
.step h2, .block h2 {{ margin: 0 0 10px; font-size: 17px; display: flex; gap: 8px; align-items: baseline; }}
.step h2 span {{ font-family: var(--mono); font-size: 13px; color: var(--muted); font-weight: 400; }}
.tbl {{ overflow-x: auto; }}
table {{ width: 100%; border-collapse: collapse; font-size: 13px; }}
th, td {{ text-align: right; padding: 5px 6px; border-bottom: 1px solid var(--grid); white-space: nowrap; }}
th:first-child {{ text-align: left; }}
thead th {{ color: var(--muted); font-weight: 500; font-family: var(--sans); font-size: 12px; }}
tbody th {{ font-family: var(--mono); font-weight: 600; }}
.sub {{ display: block; font-size: 11px; color: var(--muted); }}
.facts {{ list-style: none; padding: 0; margin: 12px 0 0; display: grid; gap: 4px; font-size: 13px; }}
.facts li b {{ font-family: var(--mono); margin-right: 4px; }}
.rule {{ font-size: 14px; background: var(--bg); border-radius: 8px; padding: 10px 12px; margin: 0; }}
.notes, .risks {{ margin: 12px 0 0; padding-left: 1.2em; display: grid; gap: 6px; font-size: 14px; }}
.notes {{ border-top: 1px dashed var(--line); padding-top: 12px; }}
.label {{ font-size: 12px; color: var(--muted); letter-spacing: .04em; margin: 12px 0 0; }}
.block {{ background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px 20px; }}
footer {{ font-size: 12px; color: var(--muted); display: grid; gap: 4px; }}
@media (max-width: 900px) {{ .steps {{ grid-template-columns: minmax(0, 1fr); }} }}
@media (max-width: 520px) {{ h1 {{ font-size: 28px; }} #chart {{ height: 320px; }} .meta {{ text-align: left; }} }}
</style>

<div class="wrap">
  <header>
    <div>
      <div class="eyebrow">双均线报告 · 日线 · MA + EMA 20/60/120</div>
      <h1>{html.escape(a['label'])}<span class="price">{a['close']:.2f}</span>
        <span class="chg {chg_cls}">{a['change_pct']:+.2f}%</span></h1>
    </div>
    <div class="meta">收盘日 {a['date']}<br>{html.escape(a['source'])}</div>
  </header>
  {warning}
  <section class="verdict" data-stance="{stance}">
    <div class="eyebrow">结论</div>
    <h2>{_t(headline)}</h2>
    <p>{_t(summary)}</p>
    <div class="chips">
      <span class="chip">模糊判断 <b>{html.escape(lean_name)}</b>（6 条线 {lean['up']} 上 / {lean['down']} 下）</span>
      <span class="chip">价不变 {lean['after']['days']} 天后 <b>{html.escape(lean['after']['label'])}</b></span>
      <span class="chip">改变判断 <b>{html.escape(flip)}</b></span>
      <span class="chip">规则初判 <b>{html.escape(a['trend'])}</b></span>
      <span class="chip">排列 MA <b>{a['arr_ma']}</b> · EMA <b>{a['arr_ema']}</b></span>
      <span class="chip">20 线乖离 <b class="num">{a['bias20']:+.1f}%</b>（历史 {a['bias_pctl']:.0%} 分位）</span>
    </div>
  </section>

  <section class="card" aria-label="K 线与均线">
    <div class="legend" id="legend"></div>
    <div id="chart"><p class="caption">图表加载中……如果一直不出现，说明图表库没能从 CDN 加载。</p></div>
    <p class="caption"><span class="dot"></span> 小黄点 = 明天各条 MA 要扣掉的那根 K 线（抵扣价）。今天收盘高于它，那条 MA 明天上升；低于它就下降。实线为 MA，虚线为 EMA。</p>
  </section>

  <div class="steps">
    <section class="card step">
      <h2>看大局 <span>现在是什么趋势</span></h2>
      <div class="tbl"><table>
        <thead><tr><th>周期</th><th>MA</th><th>EMA</th><th>价格在</th><th>MA 方向</th></tr></thead>
        <tbody>{line_rows}</tbody></table></div>
      <ul class="facts">
        {cross_rows}
        <li><b>间距</b> 三条 MA 相差 {a['spread_pct']:.1f}%（&lt; 4% 视为缠绕）</li>
        <li><b>成交量</b> {vol_text}</li>
      </ul>
      {_bullets(c.get('big_picture'))}
    </section>
    <section class="card step">
      <h2>定策略 <span>该怎么做</span></h2>
      <p class="label">按「{html.escape(a['trend'])}」查表</p>
      <p class="rule">{html.escape(a['strategy'])}</p>
      {_bullets(c.get('strategy'))}
    </section>
    <section class="card step">
      <h2>看方向 <span>抵扣价推演</span></h2>
      <div class="tbl"><table>
        <thead><tr><th></th><th>明天扣</th><th>明天</th><th>扣低值</th><th>价不变时</th><th>首次扣低</th></tr></thead>
        <tbody>{drop_rows}</tbody></table></div>
      <p class="caption">「扣低值」= 未来 10 天要扣的价格里低于现价的天数；「价不变时」= 收盘价停在现价不动，10 天后 MA 的涨跌。</p>
      {_bullets(c.get('direction'))}
    </section>
  </div>

  {risks_block}

  <footer>
    <div>{ai_note}。趋势类型初判是规则算的（阈值见 dma_analyze.py），需要结合图形确认。方法来自双均线教学视频：均线的方向就是价格的最小阻力方向。</div>
    <div>只用于学习和复盘，不是投资建议。生成于 {generated}。</div>
  </footer>
</div>

<script src="{CHART_LIB}"></script>
<script>
(function () {{
  const DATA = {chart_json};
  const box = document.getElementById("chart");
  if (!window.LightweightCharts) return;
  box.innerHTML = "";
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const chart = LightweightCharts.createChart(box, {{ autoSize: true,
    rightPriceScale: {{ scaleMargins: {{ top: 0.06, bottom: 0.24 }} }},
    timeScale: {{ rightOffset: 4 }}, crosshair: {{ mode: 0 }} }});
  const candles = chart.addCandlestickSeries({{ priceLineVisible: false }});
  candles.setData(DATA.candles);
  const vol = chart.addHistogramSeries({{ priceScaleId: "vol", priceFormat: {{ type: "volume" }}, lastValueVisible: false, priceLineVisible: false }});
  chart.priceScale("vol").applyOptions({{ scaleMargins: {{ top: 0.8, bottom: 0 }} }});
  const SPECS = [];
  [20, 60, 120].forEach((n) => ["MA", "EMA"].forEach((k) => SPECS.push({{ key: k + n, token: "--" + k.toLowerCase() + n, dashed: k === "EMA", width: k === "MA" ? 2 : 1 }})));
  const series = {{}};
  SPECS.forEach((s) => {{
    series[s.key] = chart.addLineSeries({{ lineWidth: s.width, lineStyle: s.dashed ? 2 : 0,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }});
    series[s.key].setData(DATA.lines[s.key] || []);
  }});
  const legend = document.getElementById("legend");
  SPECS.forEach((s) => {{
    const b = document.createElement("button");
    b.type = "button"; b.id = "toggle-" + s.key; b.setAttribute("aria-pressed", "true");
    b.innerHTML = '<i class="' + (s.dashed ? "dash" : "") + '" style="--c: var(' + s.token + ')"></i>' + s.key;
    b.addEventListener("click", () => {{
      const on = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", String(on));
      series[s.key].applyOptions({{ visible: on }});
    }});
    legend.appendChild(b);
  }});
  function paint() {{
    const up = css("--up"), down = css("--down"), muted = css("--muted");
    chart.applyOptions({{ layout: {{ background: {{ type: "solid", color: css("--card") }}, textColor: muted,
        fontFamily: css("--mono") }},
      grid: {{ vertLines: {{ color: css("--grid") }}, horzLines: {{ color: css("--grid") }} }},
      rightPriceScale: {{ borderColor: css("--line") }}, timeScale: {{ borderColor: css("--line") }} }});
    candles.applyOptions({{ upColor: "rgba(0,0,0,0)", downColor: muted, borderUpColor: muted, borderDownColor: muted,
      wickUpColor: muted, wickDownColor: muted }});
    vol.setData(DATA.volume.map((v) => ({{ time: v.time, value: v.value, color: v.spike ? css("--drop") : css("--line") }})));
    SPECS.forEach((s) => series[s.key].applyOptions({{ color: css(s.token) }}));
    const drop = css("--drop");
    candles.setMarkers(DATA.drops.slice().sort((a, b) => a.time < b.time ? -1 : 1).map((d) => ({{
      time: d.time, position: "belowBar", color: drop, shape: "circle", text: d.period + "扣" }})));
  }}
  paint();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paint);
  new MutationObserver(paint).observe(document.documentElement, {{ attributes: true, attributeFilter: ["data-theme"] }});
}})();
</script>
"""

// 三步报告的可视化：表格 + 小图。数据来自服务端 report.visual。
// 规则（dataviz）：细线、≥8px 点、文字用文字色、颜色不单独表意（都配文字）、每个标记可悬停看数值。
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const f2 = (x) => Number(x).toFixed(2);
const pct = (x, d = 1) => `${x >= 0 ? "+" : ""}${Number(x).toFixed(d)}%`;
const tip = (t) => `data-tip="${esc(t)}"`;

// ---------- 钟表方向图标 ----------
/** "2 点钟（上行）" → 箭头角度：3 点 = 水平，每差 1 点转 30°。 */
export function clockGlyph(clock) {
  const h = Number(String(clock).match(/^(\d)/)?.[1] ?? 3);
  const deg = (3 - h) * 30; // 正数 = 向上
  return `<svg class="clock" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.5"/>
    <g transform="rotate(${-deg} 10 10)"><path d="M4 10h11"/><path d="M12 7l3 3-3 3"/></g></svg>`;
}

// ---------- 1. 看大局 ----------
export function maTable(v) {
  const rows = v.lines.map((l) => `<tr>
      <th><i class="sw" style="--c: var(--ma${l.period})"></i>${l.period} 日</th>
      <td class="num">${f2(l.ma)}</td><td class="num">${f2(l.ema)}</td>
      <td><span class="dir">${clockGlyph(l.clock)}${esc(l.clock)}</span></td>
      <td class="num">${pct(l.slope, 2)}/日</td>
      <td>${l.above ? '<span class="bullish">上方</span>' : '<span class="bearish">下方</span>'}</td></tr>`).join("");
  return `<table class="vt"><thead><tr><th>周期</th><th>MA</th><th>EMA</th><th>MA 方向</th><th>斜率</th><th>价格在</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** 价位梯子：一条价格轴上标出收盘价、3 条 MA（实心点）、3 条 EMA（空心圈）。看次序和间距。 */
export function ladder(v) {
  const W = 640, H = 92, padX = 28, axisY = 46;
  const pts = [
    ...v.lines.map((l) => ({ key: `MA${l.period}`, value: l.ma, color: `var(--ma${l.period})`, solid: true, row: -1 })),
    ...v.lines.map((l) => ({ key: `EMA${l.period}`, value: l.ema, color: `var(--ema${l.period})`, solid: false, row: 1 })),
  ];
  const all = [...pts.map((p) => p.value), v.close];
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = (hi - lo || 1) * 0.08;
  lo -= pad; hi += pad;
  const x = (val) => padX + ((val - lo) / (hi - lo)) * (W - 2 * padX);
  // 标签分层，避免重叠
  const placed = { "-1": [], "1": [] };
  const labelY = (p) => {
    const xs = placed[p.row];
    let lvl = 0;
    while (xs.some((o) => o.lvl === lvl && Math.abs(o.x - x(p.value)) < 52)) lvl++;
    xs.push({ x: x(p.value), lvl });
    return axisY + p.row * (16 + lvl * 13);
  };
  const marks = pts.sort((a, b) => a.value - b.value).map((p) => {
    const cx = x(p.value), ly = labelY(p);
    return `<g class="mk" ${tip(`${p.key} ${f2(p.value)}`)}>
      <circle cx="${cx}" cy="${axisY}" r="${p.solid ? 5 : 4.5}" style="${p.solid ? `fill:${p.color}` : `fill:var(--card);stroke:${p.color};stroke-width:2`}" class="ring"/>
      <text x="${cx}" y="${ly}" text-anchor="middle" class="lbl">${p.key}</text>
      <circle cx="${cx}" cy="${axisY}" r="11" class="hit"/></g>`;
  }).join("");
  const cx = x(v.close);
  return `<figure class="viz"><svg viewBox="0 0 ${W} ${H}" class="ladder" role="img" aria-label="价位梯子：收盘价与 6 条均线的位置">
      <line x1="${padX}" x2="${W - padX}" y1="${axisY}" y2="${axisY}" class="axis"/>
      <text x="${padX}" y="${H - 4}" class="tick">${f2(lo)}</text><text x="${W - padX}" y="${H - 4}" text-anchor="end" class="tick">${f2(hi)}</text>
      <g ${tip(`收盘 ${f2(v.close)}`)}><line x1="${cx}" x2="${cx}" y1="${axisY - 20}" y2="${axisY + 20}" class="close"/>
      <text x="${cx}" y="${axisY - 24}" text-anchor="middle" class="lbl strong">收盘 ${f2(v.close)}</text></g>
      ${marks}</svg>
    <figcaption>价位梯子：实心点是 MA，空心圈是 EMA，竖线是收盘价。左低右高。</figcaption></figure>`;
}

/** 乖离分位条：0–100%，两端 5% 是"大幅乖离"区。 */
export function biasMeter(v) {
  const p = Math.max(0, Math.min(1, v.bias.pctl));
  return `<figure class="viz meter" ${tip(`离 20 线 ${pct(v.bias.value)}，历史 ${Math.round(p * 100)}% 分位`)}>
      <div class="meter-track"><span class="zone lo"></span><span class="zone hi"></span>
        <span class="needle" style="left:${(p * 100).toFixed(1)}%"><b>${Math.round(p * 100)}%</b></span></div>
      <div class="meter-axis"><span>0% 最负</span><span>大幅乖离区：两端各 5%</span><span>100% 最正</span></div>
    <figcaption>离 20 线 ${pct(v.bias.value)}：在自身历史里排 ${Math.round(p * 100)}% 分位。</figcaption></figure>`;
}

export function crossTable(v) {
  const cell = (c) => (c.kind ? `<span class="${c.kind === "金叉" ? "bullish" : "bearish"}">${c.kind}</span> <span class="num muted">${c.date}（${c.barsAgo} 根前）</span>` : "无");
  const rows = v.crosses.map((c) => `<tr><th>${c.pair}</th><td>${cell(c.ma)}</td><td>${cell(c.ema)}</td>
      <td><span class="verdict-tag ${c.verdict.startsWith("双") ? (c.verdict.includes("金") ? "bullish" : "bearish") : "neutral"}">${c.verdict.startsWith("双") ? "✓ " : "△ "}${c.verdict}</span></td></tr>`).join("");
  return `<table class="vt"><thead><tr><th>交叉</th><th>MA 最近</th><th>EMA 最近</th><th>判定</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ---------- 2. 定策略 ----------
export function trendTable(v) {
  const rows = v.trendTable.map((r) => `<tr class="${r.current ? "cur" : ""}">
      <th>${r.current ? "▶ " : ""}${esc(r.type)}</th><td>${esc(r.look)}</td><td>${esc(r.play)}</td></tr>`).join("");
  return `<table class="vt trend"><thead><tr><th>趋势类型</th><th>均线长什么样</th><th>打法</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ---------- 3. 看方向 ----------
/**
 * 底扣价小多图：每条 MA 一张，横轴是未来第 1–10 天，纵轴价格（三张共用）。
 * 中线 = 现价；棒棒糖从现价伸到当天要扣的价格：在上方 = 扣高值（MA 往下拉），在下方 = 扣低值（MA 往上抬）。
 */
export function dropMultiples(v, opts = {}) {
  const drops = opts.periods ? v.drops.filter((d) => opts.periods.includes(d.period)) : v.drops;
  const all = [v.close, ...drops.flatMap((d) => d.path.map((p) => p.close))];
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = (hi - lo || 1) * 0.12;
  lo -= pad; hi += pad;
  const W = 230, H = 150, L = 8, R = 8, T = 10, B = 22;
  const y = (val) => T + (1 - (val - lo) / (hi - lo)) * (H - T - B);
  const charts = drops.map((d) => {
    const n = d.path.length;
    const x = (i) => L + 10 + (i * (W - L - R - 20)) / Math.max(1, n - 1);
    const cy = y(v.close);
    const sticks = d.path.map((p, i) => {
      const highSide = p.close > v.close;
      const cls = highSide ? "hi" : "lo";
      return `<g class="mk" ${tip(`第 ${i + 1} 天扣 ${p.date} 的 ${f2(p.close)}（${highSide ? "扣高值" : "扣低值"}）`)}>
        <line x1="${x(i)}" x2="${x(i)}" y1="${cy}" y2="${y(p.close)}" class="stick ${cls}"/>
        <circle cx="${x(i)}" cy="${y(p.close)}" r="4" class="dot ${cls}"/>
        <rect x="${x(i) - 9}" y="${T}" width="18" height="${H - T - B}" class="hit"/></g>`;
    }).join("");
    const high = n - d.below;
    return `<figure class="viz drop">
      <div class="drop-head"><b><i class="sw" style="--c: var(--ma${d.period})"></i>MA${d.period}</b>
        <span>扣高 <b class="bearish">${high}</b> · 扣低 <b class="bullish">${d.below}</b></span></div>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="MA${d.period} 未来 ${n} 天的底扣价">
        <line x1="${L}" x2="${W - R}" y1="${cy}" y2="${cy}" class="mid"/>
        <text x="${L}" y="${d.below * 2 >= n ? cy - 4 : cy + 11}" class="tick">现价 ${f2(v.close)}</text>
        ${sticks}
        <text x="${x(0)}" y="${H - 6}" text-anchor="middle" class="tick">第1天</text>
        <text x="${x(n - 1)}" y="${H - 6}" text-anchor="middle" class="tick">第${n}天</text>
      </svg>
      <figcaption>价不变 ${n} 天：MA${d.period} ${pct(d.ma_flat_change_pct, 2)}</figcaption></figure>`;
  }).join("");
  return `<div class="drops">${charts}</div>
    <p class="legend-note"><span class="key hi"></span>在现价上方 = 扣高值，MA 往下拉　<span class="key lo"></span>在下方 = 扣低值，MA 往上抬　三张图纵轴相同</p>`;
}

/** 推演链：价格不变 N 天 → 每条均线怎么动 → 排列变成什么。 */
export function projectionFlow(v) {
  const p = v.projection;
  const arrow = (a, b) => (Math.abs(b - a) / a < 0.001 ? "→" : b > a ? "↗" : "↘");
  const rows = (obj) => Object.entries(obj).map(([k, x]) =>
    `<li ${tip(`${k}：${f2(x.now)} → ${f2(x.after)}`)}><span class="k">${k}</span><span class="num">${f2(x.now)}</span><span class="ar ${x.after >= x.now ? "bullish" : "bearish"}">${arrow(x.now, x.after)}</span><span class="num">${f2(x.after)}</span></li>`).join("");
  const arr = (a, b) => `<span class="arr">${a}</span> → <span class="arr ${b === "多头" ? "bullish" : b === "空头" ? "bearish" : "neutral"}">${b}</span>`;
  return `<div class="flow">
      <div class="node"><div class="nk">① 假设</div><div class="nv">价格停在 <b class="num">${f2(v.close)}</b><br>${p.days} 个交易日</div></div>
      <div class="edge">→</div>
      <div class="node"><div class="nk">② 底扣价决定方向</div><ul class="proj">${rows(p.ma)}</ul><ul class="proj ema">${rows(p.ema)}</ul></div>
      <div class="edge">→</div>
      <div class="node"><div class="nk">③ 排列</div><div class="nv">MA：${arr(p.arrNow.ma, p.arrAfter.ma)}<br>EMA：${arr(p.arrNow.ema, p.arrAfter.ema)}</div></div>
    </div>`;
}

// ---------- 悬停提示 ----------
export function installTips() {
  const box = document.getElementById("viz-tip");
  document.addEventListener("pointerover", (e) => {
    const el = e.target.closest("[data-tip]");
    if (!el) return;
    box.textContent = el.dataset.tip;
    box.hidden = false;
  });
  document.addEventListener("pointermove", (e) => {
    if (box.hidden) return;
    box.style.left = `${Math.min(e.clientX + 12, innerWidth - box.offsetWidth - 8)}px`;
    box.style.top = `${e.clientY + 14}px`;
  });
  document.addEventListener("pointerout", (e) => {
    if (e.target.closest("[data-tip]") && !e.relatedTarget?.closest?.("[data-tip]")) box.hidden = true;
  });
}

/** 每一步要放哪些图。 */
export function stepVisuals(key, v) {
  if (key === "big_picture") return maTable(v) + ladder(v) + `<div class="two">${biasMeter(v)}${crossTable(v)}</div>`;
  if (key === "strategy") return trendTable(v);
  if (key === "direction") return dropMultiples(v) + projectionFlow(v);
  return "";
}

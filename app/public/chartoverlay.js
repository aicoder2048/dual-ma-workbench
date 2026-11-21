// 把 overlays.js 换算好的结构标注画到 K 线图上：线和色带画在图表的画布里（series primitive，跟着缩放、平移、坐标轴走），
// 标记是盖在图上的小按钮（点开看规则原文，和正文里的规则编号同一个弹窗）。
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** 标记离 K 线最高（最低）价多远、叠放时每层多高（像素）。 */
const MARK_GAP = 8;
const MARK_STEP = 18;

/**
 * chart、series：lightweight-charts 的图和 K 线；box：图的容器。
 * 返回 set(scene, colors)：scene 是 { segments, levels, marks, bands }（见 overlays.js），colors 是颜色键 → 颜色。
 */
export function createOverlay(chart, series, box) {
  let scene = { segments: [], levels: [], marks: [], bands: [] };
  let colors = {};
  let candles = [];
  let ribbon = { points: [], color: "" };
  let request = null;

  const layer = document.createElement("div");
  layer.className = "struct-layer";
  box.append(layer);

  const x = (i) => chart.timeScale().logicalToCoordinate(i);
  const y = (price) => series.priceToCoordinate(price);
  const ok = (...vs) => vs.every((v) => v !== null && Number.isFinite(v));

  function line(g, a, b, color, dash, width = 1) {
    const xa = x(a.i), xb = x(b.i), ya = y(a.price), yb = y(b.price);
    if (!ok(xa, xb, ya, yb)) return null;
    g.strokeStyle = color;
    g.lineWidth = width;
    g.setLineDash(dash);
    g.beginPath();
    g.moveTo(xa, ya);
    g.lineTo(xb, yb);
    g.stroke();
    return { xa, ya, xb, yb };
  }

  /** 线上方的小字；right：右对齐到 px（短虚线的字从线的右端往左写，不伸到价格轴上）。 */
  function label(g, text, px, py, color, right = false) {
    g.font = `11px ${colors.font}`;
    const w = g.measureText(text).width;
    const left = right ? px - 3 - w : px + 3;
    g.globalAlpha = 0.85; // 字底下垫一层底色：压在 K 线上也看得清
    g.fillStyle = colors.bg;
    g.fillRect(left - 2, py - 15, w + 4, 13);
    g.globalAlpha = 1;
    g.fillStyle = color;
    g.textBaseline = "bottom";
    g.fillText(text, left, py - 2);
  }

  /** 聚焦那组 MA 和 EMA 之间的色带：沿 MA 画过去、沿 EMA 画回来，围成一块填色。 */
  const drawRibbon = (g) => {
    const pts = ribbon.points.map((p) => ({ x: x(p.i), ma: y(p.ma), ema: y(p.ema) })).filter((p) => ok(p.x, p.ma, p.ema));
    if (pts.length < 2) return;
    g.fillStyle = ribbon.color;
    g.beginPath();
    pts.forEach((p, k) => (k ? g.lineTo(p.x, p.ma) : g.moveTo(p.x, p.ma)));
    for (let k = pts.length - 1; k >= 0; k--) g.lineTo(pts[k].x, pts[k].ema);
    g.closePath();
    g.fill();
  };

  const drawBands = (g) => {
    drawRibbon(g);
    for (const b of scene.bands) {
      const xa = x(b.from - 0.5), xb = x(b.to + 0.5), yt = y(b.top), yb = y(b.bottom);
      if (!ok(xa, xb, yt, yb)) continue;
      const color = b.target ? colors.target : colors.gap;
      g.globalAlpha = b.target ? 0.16 : 0.1;
      g.fillStyle = color;
      g.fillRect(xa, yt, xb - xa, yb - yt);
      g.globalAlpha = 0.55;
      g.fillRect(xa, yt, xb - xa, 1);
      g.fillRect(xa, yb - 1, xb - xa, 1);
      g.globalAlpha = 1;
      label(g, b.label, Math.max(xa, 0), yt, color);
    }
  };

  const drawLines = (g) => {
    for (const s of scene.segments) {
      const color = s.kind === "neck" ? colors.neck : colors.swing;
      const at = line(g, s.a, s.b, color, s.kind === "swing" ? [] : [4, 3], s.kind === "swing" ? 1.5 : 1);
      if (at && s.label) label(g, s.label, at.xa, at.ya, color);
      if (at && s.kind === "swing") for (const [px, py] of [[at.xa, at.ya], [at.xb, at.yb]]) {
        g.fillStyle = color;
        g.beginPath();
        g.arc(px, py, 2.5, 0, Math.PI * 2);
        g.fill();
      }
    }
    for (const lv of scene.levels) {
      const color = lv.side === "top" ? colors.down : colors.up;
      const at = line(g, lv.a, lv.b, color, [2, 3]);
      if (at) label(g, lv.text, at.xb, at.yb, color, true);
    }
    g.setLineDash([]);
  };

  const view = (draw, zOrder) => ({
    zOrder: () => zOrder,
    renderer: () => ({ draw: (target) => target.useMediaCoordinateSpace(({ context }) => draw(context)) }),
  });
  const views = [view(drawBands, "bottom"), view(drawLines, "top")];

  /** 标记跟着图走：每次重画之前算一遍位置（缩放、平移、价格轴拖动都会重画）。 */
  function placeMarks() {
    const width = chart.timeScale().width();
    const paneH = box.clientHeight - chart.timeScale().height();
    for (const el of layer.children) {
      const m = scene.marks[Number(el.dataset.n)];
      const c = candles[m.i];
      const px = x(m.i);
      const py = c ? y(m.side === "top" ? c.high : c.low) : null;
      const show = ok(px, py) && px >= 0 && px <= width;
      el.hidden = !show;
      if (!show) continue;
      const off = MARK_GAP + m.stack * MARK_STEP;
      const top = m.side === "top" ? py - off - el.offsetHeight : py + off;
      el.style.left = `${px}px`;
      el.style.top = `${Math.min(Math.max(top, 0), paneH - el.offsetHeight)}px`;
    }
  }

  series.attachPrimitive({
    attached: ({ requestUpdate }) => { request = requestUpdate; },
    detached: () => { request = null; },
    updateAllViews: placeMarks,
    paneViews: () => views,
  });

  return {
    /** bars：图上的 K 线（标记放在哪根的最高、最低价旁边）。 */
    set(next, nextColors, bars) {
      scene = { segments: [], levels: [], marks: [], bands: [], ...next };
      colors = nextColors;
      candles = bars;
      layer.innerHTML = scene.marks.map((m, n) =>
        `<button type="button" class="cite src struct-mark ${m.tone}" data-n="${n}" data-kind="S" data-ref="rules#${esc(m.rule)}"
          data-lead="${esc(m.lead)}" title="${esc(m.lead)}（点开看 rules.md ${esc(m.rule)}）">${esc(m.text)}</button>`).join("");
      placeMarks();
      request?.();
    },
    /** 聚焦那组的色带：points 是 lines.js 的 bandPoints，空数组不画。 */
    setRibbon(points, color) {
      ribbon = { points, color };
      request?.();
    },
    /** 现在画着的东西（测试和问鸿雁用）。 */
    scene: () => scene,
    ribbon: () => ribbon,
  };
}

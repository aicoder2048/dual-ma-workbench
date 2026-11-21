// 筹码分布画在 K 线图里：贴着价格轴（绘图区右边）横过来的直方图，筹码山描框、标山脚山顶，交易计划记下的上方最近那座（P38，只作参考）高亮成参考带。
// 画在图表画布里（series primitive，跟着缩放、平移、价格轴走），在 K 线下面一层；数是 volprofile.js 按可见范围算好的。
import { layoutLabels } from "./labels.js";
import { labeledMountains } from "./volprofile.js";

/** 直方图最宽占绘图区的几成、最多几像素：只占右边一条，不盖住中间的 K 线。 */
const WIDTH_SHARE = 0.2;
const MAX_WIDTH = 160;
/** 山的框比直方图往左多出几像素；山脚、山顶、参考带的小字写在这一条里面，不伸进 K 线和结构标注。 */
const FRAME_PAD = 4;
const LABEL_H = 13;

/**
 * 返回 set({ profile, ref, close, guides, colors }) 和测试用的读数。profile 为 null 时不画。
 * ref：交易计划的参考带 { foot, top }（P38，带的读法是 J47；不是目标）或 null；close：最新一根收盘（决定标哪几座山）；
 * guides：价位线的价格，小字不压在上面。
 */
export function createProfileLayer(chart, series) {
  let state = { profile: null, ref: null, close: null, guides: [], colors: {} };
  let drawn = null; // 上一次画在哪（测试用）：{ left, right, labels }
  let request = null;

  const y = (price) => series.priceToCoordinate(price);
  const ok = (...vs) => vs.every((v) => v !== null && Number.isFinite(v));

  /** 一条小字：从 left 往右写，top 是上沿（摆放时可能上下挪）。 */
  function label(g, text, left, top, color, priority) {
    g.font = `11px ${state.colors.font}`;
    return { text, color, priority, left, top, width: g.measureText(text).width + 4, height: LABEL_H };
  }

  function draw(g, size) {
    const { profile: p, ref, close, colors } = state;
    drawn = null;
    if (!p) return;
    const paneW = size.width;
    const maxW = Math.min(paneW * WIDTH_SHARE, MAX_WIDTH);
    const peak = Math.max(...p.volumes);
    const inMountain = (j) => p.mountains.some((m) => m.foot <= p.edges[j] && p.edges[j + 1] <= m.top);
    for (let j = 0; j < p.volumes.length; j++) {
      const top = y(p.edges[j + 1]), bottom = y(p.edges[j]);
      if (!ok(top, bottom) || !(peak > 0)) continue;
      const w = maxW * p.volumes[j] / peak;
      g.globalAlpha = inMountain(j) ? 0.42 : 0.2;
      g.fillStyle = inMountain(j) ? colors.mountain : colors.bin;
      g.fillRect(paneW - w, top + 0.5, w, Math.max(bottom - top - 1, 1));
    }
    g.globalAlpha = 1;
    const left = paneW - maxW - FRAME_PAD;
    const labels = [];
    if (ref && ok(y(ref.top), y(ref.foot))) {
      const top = y(ref.top), bottom = y(ref.foot);
      g.globalAlpha = 0.16;
      g.fillStyle = colors.ref;
      g.fillRect(left, top, paneW - left, bottom - top);
      g.globalAlpha = 0.8;
      g.fillRect(left, top, paneW - left, 1);
      g.fillRect(left, bottom - 1, paneW - left, 1);
      g.globalAlpha = 1;
      labels.push(label(g, "参考带（P38）", left + 2, top + 1, colors.ref, 0));
    }
    g.strokeStyle = colors.mountain;
    g.lineWidth = 1;
    g.setLineDash([3, 2]);
    for (const m of p.mountains) {
      const top = y(m.top), bottom = y(m.foot);
      if (ok(top, bottom)) g.strokeRect(left + 0.5, top + 0.5, paneW - left - 1, bottom - top - 1);
    }
    g.setLineDash([]);
    for (const m of close == null ? [] : labeledMountains(p.mountains, close)) {
      if (ref && Math.abs(m.foot - ref.foot) < 1e-9 && Math.abs(m.top - ref.top) < 1e-9) continue; // 参考带已经写了
      if (ok(y(m.top))) labels.push(label(g, `山顶 ${m.top.toFixed(2)}`, left + 2, y(m.top) + 1, colors.mountain, 1));
      if (ok(y(m.foot))) labels.push(label(g, `山脚 ${m.foot.toFixed(2)}`, left + 2, y(m.foot) - LABEL_H - 1, colors.mountain, 1));
    }
    const caption = label(g, `筹码 ${p.fromLabel} ~ ${p.toLabel} · ${p.bars} 根`, 0, 2, colors.muted, -1);
    caption.left = paneW - caption.width - 2;
    const laid = layoutLabels([caption, ...labels], state.guides.map(y).filter((v) => ok(v)), size.height);
    g.font = `11px ${colors.font}`;
    g.textBaseline = "bottom";
    for (const l of laid) {
      if (l.hidden) continue;
      g.globalAlpha = 0.85;
      g.fillStyle = colors.bg;
      g.fillRect(l.left, l.top, l.width, l.height);
      g.globalAlpha = 1;
      g.fillStyle = l.color;
      g.fillText(l.text, l.left + 2, l.top + l.height);
    }
    drawn = { left, right: paneW, labels: laid.map(({ text, left: x, top, width, height, hidden }) => ({ text, left: x, top, width, height, hidden })) };
  }

  const view = {
    zOrder: () => "bottom",
    renderer: () => ({ draw: (target) => target.useMediaCoordinateSpace(({ context, mediaSize }) => draw(context, mediaSize)) }),
  };
  series.attachPrimitive({
    attached: ({ requestUpdate }) => { request = requestUpdate; },
    detached: () => { request = null; },
    paneViews: () => [view],
  });

  return {
    set(next) {
      state = next;
      request?.();
    },
    /** 上一次画在哪（测试用）：直方图和山框的左右边（绘图区坐标）和小字；没画时为 null。 */
    drawn: () => drawn,
  };
}

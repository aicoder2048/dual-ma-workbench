// 图上小字（缺口、颈线、构造"下一根怎样"）的摆放：互相不压、不压在价位线上；
// 结构标记和小字避开价格轴上的标签（价位、最新价、均线值和价位线的名字）。纯函数，单元测试直接用。

/** 放不下时最多往上、往下各挪几行；再挪就离它标的东西太远，不如不写。 */
const MAX_SHIFT = 2;

const hit = (a, b) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

/**
 * labels：[{ left, top, width, height, priority }]（像素，top 是想放的位置）；priority 小的先放、先占位置。
 * guides：价位线的 y（整条横线，字不压在上面）；paneHeight：绘图区高度。
 * obstacles：已经占着、不能压的框（价格轴标签，见 axisLabelBoxes）。
 * 按原来的顺序返回 { ...label, top, hidden }：先试原位，再上下各挪一行、两行，都不行就藏起来（hidden）。
 */
export function layoutLabels(labels, guides, paneHeight, obstacles = []) {
  const placed = [...obstacles];
  const out = labels.map((l) => ({ ...l, hidden: true }));
  const order = out.map((_, k) => k).sort((a, b) => out[a].priority - out[b].priority || a - b);
  for (const k of order) {
    const l = out[k];
    const shifts = [0];
    for (let n = 1; n <= MAX_SHIFT; n++) shifts.push(-n, n);
    for (const n of shifts) {
      const box = { ...l, top: l.top + n * l.height };
      const inside = box.top >= 0 && box.top + box.height <= paneHeight;
      const clear = !placed.some((p) => hit(p, box)) && !guides.some((y) => y > box.top && y < box.top + box.height);
      if (inside && clear) {
        Object.assign(l, { top: box.top, hidden: false });
        placed.push(l);
        break;
      }
    }
  }
  return out;
}

// 价格轴标签的尺寸，照图表库（lightweight-charts 4.2.0，默认字号 12）的画法：
// 高 = 字号 12 + 上下各 2.5；价位线的名字画在绘图区里、紧贴价格轴，宽 = 字宽 + 左右各 5 + 1 像素边。
export const AXIS_LABEL_H = 17;
const TITLE_PAD = 11;

/** 往外推开一串标签（图表库的 recalculateOverlapping）：ys 从中线往外排好，dir 1 往上、-1 往下。 */
function pushApart(ys, dir, height) {
  if (!ys.length) return;
  const h = AXIS_LABEL_H, center = height / 2;
  let groupStart = 0;
  let room = Math.max(0, dir === 1 ? center - (ys[0] - h / 2) : ys[0] - h / 2 - center);
  for (let i = 1; i < ys.length; i++) {
    const prev = ys[i - 1];
    if (dir === 1 ? ys[i] > prev - h : ys[i] < prev + h) {
      ys[i] = prev - h * dir;
      const edge = ys[i] - (dir * h) / 2;
      if ((dir === 1 ? edge < 0 : edge > height) && room > 0) {
        const shift = Math.min(dir === 1 ? -1 - edge : edge - height, room);
        for (let k = groupStart; k < ys.length; k++) ys[k] += dir * shift;
        room -= shift;
      }
    } else {
      groupStart = i;
      room = dir === 1 ? prev - h - ys[i] : ys[i] - (prev + h);
    }
  }
}

/**
 * 价格轴上的标签各占哪一块（像素，和图的容器同一个坐标）。图表库不告诉我们，照它的规则算：
 * 标签挤在一起时，中线以上的往上推、以下的往下推，贴边的收进来（lightweight-charts 4.2.0 的 _fixLabelOverlap）。
 * items：[{ y, titleWidth }]，y 是价格的纵坐标，titleWidth 是价位线名字的字宽（没有名字是 0）。
 * pane：{ width, height, axisWidth } 绘图区的宽高和价格轴的宽。
 * 返回和 items 同序的 [{ left, top, width, height }]：从名字的左边（没有名字就是价格轴的左边）到价格轴的右边，上下各多留 1 像素。
 */
export function axisLabelBoxes(items, pane) {
  const h = AXIS_LABEL_H, half = Math.floor(h / 2);
  const fixed = items.map(({ y }) => (y > -half && y < half ? half : y > pane.height - half && y < pane.height + half ? pane.height - half : y));
  const center = pane.height / 2;
  const side = (up) => items.map((_, k) => k).filter((k) => (items[k].y <= center) === up)
    .sort((a, b) => (up ? items[b].y - items[a].y : items[a].y - items[b].y));
  for (const [order, dir] of [[side(true), 1], [side(false), -1]]) {
    const ys = order.map((k) => fixed[k]);
    pushApart(ys, dir, pane.height);
    order.forEach((k, n) => { fixed[k] = ys[n]; });
  }
  return items.map(({ titleWidth }, k) => {
    const left = pane.width - (titleWidth ? Math.ceil(titleWidth) + TITLE_PAD : 0);
    return { left, top: fixed[k] - h / 2 - 1, width: pane.width + pane.axisWidth - left, height: h + 2 };
  });
}

/** 标记和价格轴标签之间至少空几像素。 */
const DODGE_GAP = 2;

/**
 * 一个框（结构标记、小字）往左让，让到不压别的框（价格轴标签、先摆好的标记）：右边离 maxRight（绘图区的右边）至少 DODGE_GAP，不伸进价格轴，
 * 压着谁就让到谁的左边，留 DODGE_GAP。只左右挪、不上下挪，标记还在它标的那根 K 线的高度上；让到绘图区左边为止。返回新的 left。
 */
export function dodgeLeft(box, obstacles, maxRight) {
  let left = Math.max(0, Math.min(box.left, maxRight - DODGE_GAP - box.width));
  for (let o; left > 0 && (o = obstacles.find((b) => hit(b, { ...box, left })));) left = Math.max(0, o.left - DODGE_GAP - box.width);
  return left;
}

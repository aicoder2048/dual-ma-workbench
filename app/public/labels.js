// 图上小字（缺口、颈线、构造"下一根怎样"）的摆放：互相不压、不压在价位线上。纯函数，单元测试直接用。

/** 放不下时最多往上、往下各挪几行；再挪就离它标的东西太远，不如不写。 */
const MAX_SHIFT = 2;

const hit = (a, b) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

/**
 * labels：[{ left, top, width, height, priority }]（像素，top 是想放的位置）；priority 小的先放、先占位置。
 * guides：价位线的 y（整条横线，字不压在上面）；paneHeight：绘图区高度。
 * 按原来的顺序返回 { ...label, top, hidden }：先试原位，再上下各挪一行、两行，都不行就藏起来（hidden）。
 */
export function layoutLabels(labels, guides, paneHeight) {
  const placed = [];
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

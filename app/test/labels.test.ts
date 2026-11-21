import { describe, expect, test } from "bun:test";
import { AXIS_LABEL_H, axisLabelBoxes, dodgeLeft, layoutLabels as layoutJs } from "../public/labels.js";

type Box = { left: number; top: number; width: number; height: number };
const box = (top: number, priority = 0, left = 0, width = 100) => ({ left, top, width, height: 13, priority });
type Placed = Box & { hidden: boolean };
const layoutLabels = (labels: object[], guides: number[], paneHeight: number, obstacles: Box[] = []) => layoutJs(labels, guides, paneHeight, obstacles) as Placed[];
const overlaps = (a: Box, b: Box) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

describe("图上小字的摆放", () => {
  test("不挤的时候都在原位", () => {
    const out = layoutLabels([box(10), box(40), box(70, 0, 300)], [], 400);
    expect(out.map((l) => [l.top, l.hidden])).toEqual([[10, false], [40, false], [70, false]]);
  });

  test("两条压在一起：先放的留在原位，后放的挪开一行（往上挪还压着，就往下）", () => {
    const out = layoutLabels([box(100, 0), box(105, 1)], [], 400);
    expect(out.map((l) => l.top)).toEqual([100, 105 + 13]);
    expect(overlaps(out[0], out[1])).toBe(false);
  });

  test("priority 小的先占位：后面的字不论在列表哪里都让开", () => {
    const out = layoutLabels([box(105, 3), box(100, 0)], [], 400);
    expect(out[1].top).toBe(100);
    expect(out[0].hidden).toBe(false);
    expect(overlaps(out[0], out[1])).toBe(false);
  });

  test("压在价位线上的字挪开，不让线从字中间穿过", () => {
    const [l] = layoutLabels([box(100)], [106], 400);
    expect(l.top > 106 || l.top + l.height < 106).toBe(true);
  });

  test("一堆挤在同一处：放得下的都不重叠，挪两行还放不下的藏起来", () => {
    const out = layoutLabels(Array.from({ length: 8 }, (_, k) => box(200, k)), [], 400);
    const shown = out.filter((l) => !l.hidden);
    expect(shown).toHaveLength(5); // 原位 + 上下各两行
    for (const a of shown) for (const b of shown) if (a !== b) expect(overlaps(a, b)).toBe(false);
  });

  test("不挪出绘图区：靠顶的字往下挪", () => {
    const out = layoutLabels([box(0, 0), box(2, 1)], [], 400);
    expect(out[1].top).toBe(15);
  });

  test("横向不相交的字不互相让", () => {
    const out = layoutLabels([box(100, 0, 0, 100), box(100, 1, 200, 100)], [], 400);
    expect(out.map((l) => l.top)).toEqual([100, 100]);
  });
});

describe("价格轴标签占的地方", () => {
  const pane = { width: 460, height: 400, axisWidth: 60 };
  const mid = (b: Box) => b.top + b.height / 2;

  test("单独一个：以价格为中线，从价格轴左边到右边；价位线的名字画在绘图区里，框从名字左边起", () => {
    const [plain, titled] = axisLabelBoxes([{ y: 100, titleWidth: 0 }, { y: 300, titleWidth: 24.3 }], pane);
    expect(plain).toEqual({ left: 460, top: 100 - AXIS_LABEL_H / 2 - 1, width: 60, height: AXIS_LABEL_H + 2 });
    expect(titled.left).toBe(460 - 25 - 11);
    expect(titled.left + titled.width).toBe(520);
    expect(mid(titled)).toBe(300);
  });

  test("挤在一起：中线以上的往上推、以下的往下推，离中线近的留在原位", () => {
    const [a, b, c, d] = axisLabelBoxes([{ y: 100, titleWidth: 0 }, { y: 105, titleWidth: 0 }, { y: 300, titleWidth: 0 }, { y: 305, titleWidth: 0 }], pane);
    expect([mid(a), mid(b), mid(c), mid(d)]).toEqual([105 - AXIS_LABEL_H, 105, 300, 300 + AXIS_LABEL_H]);
  });

  test("贴着上边的收进来；推出上边的整组往回挪，都不出界、不重叠", () => {
    const [edge] = axisLabelBoxes([{ y: 3, titleWidth: 0 }], pane);
    expect(mid(edge)).toBe(Math.floor(AXIS_LABEL_H / 2));
    // 12 留原位、10 推到 -5 出了上边，整组往下挪回来（图表库挪到上边沿只出界 1 像素为止）
    const out = axisLabelBoxes([{ y: 10, titleWidth: 0 }, { y: 12, titleWidth: 0 }], pane);
    expect(out.map(mid)).toEqual([7.5, 24.5]);
    expect(overlaps({ ...out[0], top: out[0].top + 1, height: AXIS_LABEL_H }, { ...out[1], top: out[1].top + 1, height: AXIS_LABEL_H })).toBe(false);
  });
});

describe("标记让开价格轴标签", () => {
  const label = { left: 400, top: 90, width: 120, height: 19 };

  test("没有标签挡着：只是不伸进价格轴", () => {
    expect(dodgeLeft({ left: 440, top: 200, width: 40, height: 16 }, [], 460)).toBe(418);
    expect(dodgeLeft({ left: 100, top: 200, width: 40, height: 16 }, [], 460)).toBe(100);
  });

  test("同一高度有标签：往左让到它左边，留 2 像素", () => {
    const left = dodgeLeft({ left: 420, top: 95, width: 40, height: 16 }, [label], 460);
    expect(left).toBe(400 - 2 - 40);
    expect(overlaps({ left, top: 95, width: 40, height: 16 }, label)).toBe(false);
  });

  test("标签在别的高度：不用让；让到最左也不出绘图区左边", () => {
    expect(dodgeLeft({ left: 380, top: 200, width: 40, height: 16 }, [label], 460)).toBe(380);
    expect(dodgeLeft({ left: 10, top: 95, width: 40, height: 16 }, [{ ...label, left: 20 }], 460)).toBe(0);
  });

  test("别的框在同一高度但不挨着：不用让；让开一个又压着下一个（先摆好的标记）：接着让", () => {
    expect(dodgeLeft({ left: 300, top: 95, width: 40, height: 16 }, [label, { left: 200, top: 95, width: 50, height: 16 }], 460)).toBe(300);
    const mark = { left: 330, top: 92, width: 50, height: 16 };
    expect(dodgeLeft({ left: 420, top: 95, width: 40, height: 16 }, [label, mark], 460)).toBe(330 - 2 - 40);
  });

  test("图上小字也不压在价格轴标签上：挪开一行", () => {
    const [l] = layoutLabels([box(95, 0, 380, 60)], [], 400, [label]);
    expect(l.hidden).toBe(false);
    expect(overlaps(l, label)).toBe(false);
  });
});

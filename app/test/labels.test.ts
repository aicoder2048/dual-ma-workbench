import { describe, expect, test } from "bun:test";
import { layoutLabels as layoutJs } from "../public/labels.js";

type Box = { left: number; top: number; width: number; height: number };
const box = (top: number, priority = 0, left = 0, width = 100) => ({ left, top, width, height: 13, priority });
type Placed = Box & { hidden: boolean };
const layoutLabels = (labels: object[], guides: number[], paneHeight: number) => layoutJs(labels, guides, paneHeight) as Placed[];
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

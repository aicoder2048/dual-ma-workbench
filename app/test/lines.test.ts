import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FADED_ALPHA, GROUPS, SPECS, alpha, bandPoints, contrastRatio, lineStyle, nextFocus } from "../public/lines.js";
import { sliceAt } from "../public/replay.js";

/** app.css 里每个主题的颜色 token：light（:root）、dark、ink。 */
const THEMES = (() => {
  const css = readFileSync(resolve(import.meta.dir, "../public/app.css"), "utf8");
  const block = (sel: string) => {
    const body = css.slice(css.indexOf(sel)).match(/\{([^}]*)\}/)![1];
    return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  };
  return { light: block(":root {"), dark: block(':root[data-theme="dark"]'), ink: block(':root[data-theme="ink"]'),
    "dark（跟系统）": block(":root:not([data-theme]) {") };
})();

/** 色相（度）和饱和度（0 ~ 1）：看两条线是不是同一个色系。 */
const hueSat = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
  const h = d === 0 ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { hue: h * 60, sat: d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)) };
};
const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

const spec = (key: string) => SPECS.find((s) => s.key === key)!;

describe("均线样式", () => {
  test("6 条线和 MA200 全是实线", () => {
    for (const s of SPECS) expect({ key: s.key, style: lineStyle(s, THEMES.light).lineStyle }).toEqual({ key: s.key, style: 0 });
  });

  test("同一周期：MA 粗、EMA 细，颜色各用自己主题里的 token", () => {
    for (const n of [20, 60, 120]) {
      const ma = lineStyle(spec(`MA${n}`), THEMES.dark), ema = lineStyle(spec(`EMA${n}`), THEMES.dark);
      expect(ma.lineWidth).toBeGreaterThan(ema.lineWidth);
      expect([ma.color, ema.color]).toEqual([THEMES.dark[`--ma${n}`], THEMES.dark[`--ema${n}`]]);
    }
  });

  test("右端价格轴：MA 用线的颜色写值，EMA 不写；都不在绘图区写名字（会压在筹码分布上）", () => {
    expect(lineStyle(spec("MA60"), THEMES.light)).toMatchObject({ lastValueVisible: true, title: "" });
    expect(lineStyle(spec("EMA60"), THEMES.light)).toMatchObject({ lastValueVisible: false, title: "" });
  });

  test("对比度照 WCAG 算：白底黑字 21，同色 1，和参数顺序无关", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#d62828", "#d62828")).toBe(1);
    expect(contrastRatio("#ffffff", "#767676")).toBeCloseTo(contrastRatio("#767676", "#ffffff"), 10);
    expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
  });

  test("每个主题：每条线（含 MA200）在图表底色上对比度 ≥ 3（WCAG 非文字图形）", () => {
    for (const [theme, t] of Object.entries(THEMES)) {
      for (const s of SPECS) {
        const ratio = contrastRatio(t[s.token], t["--card"]);
        expect({ theme, line: s.key, ok: ratio >= 3, ratio: +ratio.toFixed(2) }).toMatchObject({ theme, line: s.key, ok: true });
      }
    }
  });

  test("每个主题：同组 MA 和 EMA 是一家（同色系）但看得出不同；三组之间分得开", () => {
    for (const [theme, t] of Object.entries(THEMES)) {
      const hs = (n: number, kind: string) => hueSat(t[`--${kind}${n}`]);
      for (const n of GROUPS) {
        const ma = hs(n, "ma"), ema = hs(n, "ema");
        // 20 组是墨 / 灰（几乎没有颜色），60、120 组同一个色相
        const family = n === 20 ? ma.sat < 0.3 && ema.sat < 0.3 : hueGap(ma.hue, ema.hue) <= 15;
        const distinct = Math.abs(contrastRatio(t[`--ma${n}`], t["--card"]) - contrastRatio(t[`--ema${n}`], t["--card"])) > 1.5;
        expect({ theme, n, family, distinct }).toEqual({ theme, n, family: true, distinct: true });
      }
      // 60 组（红）和 120 组（蓝）色相差得远，而且都比 20 组（灰）有颜色
      expect({ theme, apart: hueGap(hs(60, "ma").hue, hs(120, "ma").hue) >= 90 && hs(60, "ma").sat > 0.4 && hs(120, "ma").sat > 0.4 }).toEqual({ theme, apart: true });
    }
  });
});

describe("聚焦一组", () => {
  test("聚焦 60：60 组照常、写出 EMA60 的值；20、120 组和 MA200 淡下去，不写标签", () => {
    const t = THEMES.light;
    expect(lineStyle(spec("EMA60"), t, 60)).toMatchObject({ color: t["--ema60"], lastValueVisible: true, title: "" });
    expect(lineStyle(spec("MA60"), t, 60)).toMatchObject({ color: t["--ma60"], title: "" });
    for (const key of ["MA20", "EMA20", "MA120", "EMA120", "MA200"]) {
      expect(lineStyle(spec(key), t, 60)).toMatchObject({ color: alpha(t[spec(key).token], FADED_ALPHA), lastValueVisible: false, title: "" });
    }
  });

  test("点一组聚焦，再点同一组取消，点另一组换过去；Esc（clear）取消", () => {
    expect(nextFocus(null, { type: "click", group: 20 })).toBe(20);
    expect(nextFocus(20, { type: "click", group: 20 })).toBe(null);
    expect(nextFocus(20, { type: "click", group: 120 })).toBe(120);
    expect(nextFocus(60, { type: "clear" })).toBe(null);
  });

  test("本机存的值坏了（不是 20 / 60 / 120）当作不聚焦", () => {
    for (const bad of [0, Number.NaN, 200, 59]) expect(nextFocus(null, { type: "click", group: bad })).toBe(null);
  });
});

describe("色带", () => {
  const days = ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"];
  const pts = (vals: (number | null)[]) => days.flatMap((time, i) => (vals[i] == null ? [] : [{ time, value: vals[i]! }]));
  const data = {
    candles: days.map((time) => ({ time, open: 1, high: 1, low: 1, close: 1 })),
    volume: days.map((time) => ({ time, value: 1 })),
    lines: { MA20: pts([null, 10, 11, 12, 13]), EMA20: pts([9, 9.5, 10.5, 12.5, 14]), MA60: pts([null, null, null, null, 20]) },
    drops: [],
  };

  test("MA 和 EMA 都有值的那几根，按图上第几根排", () => {
    expect(bandPoints(data, 20)).toEqual([
      { i: 1, ma: 10, ema: 9.5 }, { i: 2, ma: 11, ema: 10.5 }, { i: 3, ma: 12, ema: 12.5 }, { i: 4, ma: 13, ema: 14 },
    ]);
  });

  test("回放截到第 3 根：色带也只到第 3 根，不露出之后的线", () => {
    expect(bandPoints(sliceAt(data, 2), 20).map((p: { i: number }) => p.i)).toEqual([1, 2]);
  });

  test("这组少一条线（EMA60 没有）或没有聚焦：没有色带", () => {
    expect(bandPoints(data, 60)).toEqual([]);
    expect(bandPoints(data, null)).toEqual([]);
  });
});

describe("alpha", () => {
  test("十六进制颜色加透明度；其他写法原样返回", () => {
    expect(alpha("#1f5fbf", 0.5)).toBe("rgba(31,95,191,0.5)");
    expect(alpha("#0a0", 0.2)).toBe("rgba(0,170,0,0.2)");
    expect(alpha("rgb(1,2,3)", 0.2)).toBe("rgb(1,2,3)");
  });
});

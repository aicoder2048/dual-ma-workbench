import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FADED_ALPHA, SPECS, alpha, bandPoints, lineStyle, nextFocus } from "../public/lines.js";
import { sliceAt } from "../public/replay.js";

/** app.css 里每个主题的颜色 token：light（:root）、dark、ink。 */
const THEMES = (() => {
  const css = readFileSync(resolve(import.meta.dir, "../public/app.css"), "utf8");
  const block = (sel: string) => {
    const body = css.slice(css.indexOf(sel)).match(/\{([^}]*)\}/)![1];
    return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  };
  return { light: block(":root {"), dark: block(':root[data-theme="dark"]'), ink: block(':root[data-theme="ink"]') };
})();

/** WCAG 对比度。 */
const contrast = (a: string, b: string) => {
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

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

  test("右端价格轴：MA 写名字和值，EMA 不写（6 个标签挤在一起反而难读）", () => {
    expect(lineStyle(spec("MA60"), THEMES.light)).toMatchObject({ lastValueVisible: true, title: "MA60" });
    expect(lineStyle(spec("EMA60"), THEMES.light)).toMatchObject({ lastValueVisible: false, title: "" });
  });

  test("每个主题：MA 在卡片底色上清楚（对比度 ≥ 4），EMA 浅一档但看得见（≥ 2.2），同组 MA 比 EMA 显眼", () => {
    for (const [theme, t] of Object.entries(THEMES)) {
      for (const n of [20, 60, 120]) {
        const ma = contrast(t[`--ma${n}`], t["--card"]), ema = contrast(t[`--ema${n}`], t["--card"]);
        expect({ theme, n, ma: ma >= 4, ema: ema >= 2.2 }).toEqual({ theme, n, ma: true, ema: true });
        // 深色主题里 60 / 120 组的浅色调反而更亮：只要求两条线看得出不同
        expect({ theme, n, distinct: Math.abs(ma - ema) > 1.5 }).toEqual({ theme, n, distinct: true });
      }
    }
  });
});

describe("聚焦一组", () => {
  test("聚焦 60：60 组照常、写出 EMA60 的标签；20、120 组和 MA200 淡下去，不写标签", () => {
    const t = THEMES.light;
    expect(lineStyle(spec("EMA60"), t, 60)).toMatchObject({ color: t["--ema60"], lastValueVisible: true, title: "EMA60" });
    expect(lineStyle(spec("MA60"), t, 60)).toMatchObject({ color: t["--ma60"], title: "MA60" });
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

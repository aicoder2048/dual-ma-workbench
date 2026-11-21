import { describe, expect, test } from "bun:test";
import { fmtVolume, linesRow, ohlcRow, volumeCell, weekLabel } from "../public/readout.js";

describe("读数条的成交量", () => {
  test("缩写照 TradingView：三位有效数字，K / M / B", () => {
    expect(fmtVolume(980)).toBe("980");
    expect(fmtVolume(45_600)).toBe("45.6K");
    expect(fmtVolume(5_214_000)).toBe("5.21M");
    expect(fmtVolume(33_812_345)).toBe("33.8M");
    expect(fmtVolume(123_400_000)).toBe("123M");
    expect(fmtVolume(1_234_000_000)).toBe("1.23B");
  });

  test("量和量比：1.2× 均量；大量标黄", () => {
    const normal = volumeCell({ time: "2026-11-20", value: 33.8e6, spike: false, ratio: 1.24 });
    expect(normal).toContain("量<b>33.8M</b>");
    expect(normal).toContain('1.2×<span class="ro-unit"> 均量</span>');
    expect(normal).not.toContain("spike");
    const big = volumeCell({ time: "2026-11-20", value: 81.1e6, spike: true, ratio: 2.4 });
    expect(big).toContain('class="ro-ratio spike"');
    expect(big).toContain('2.4×<span class="ro-unit"> 均量</span>');
  });

  test("不到 50 根没有量比：只写量；没有量：整格不写", () => {
    expect(volumeCell({ time: "2026-11-20", value: 1e6, spike: false })).toBe('<span class="ro-vol">量<b>1.00M</b></span>');
    expect(volumeCell(undefined)).toBe("");
  });
});

describe("读数条第一行：开高低收和涨跌", () => {
  const week = (time: string, open: number, high: number, low: number, close: number) => ({ time, open, high, low, close });

  test("周线：写那一周，涨跌比上一周的收盘", () => {
    const prev = week("2026-11-13", 400, 420, 380, 400);
    const cur = week("2026-11-20", 401, 410, 340, 345.82);
    const row = ohlcRow(weekLabel("2026-11-20", false), cur, prev, { time: "2026-11-20", value: 512e6, spike: false });
    expect(row).toContain("<b>周 2026-11-20</b>");
    expect(row).toContain('收<b class="down">345.82</b>');
    expect(row).toContain("−54.18（</span>−13.55%"); // (345.82 − 400) / 400
    expect(row).toContain("量<b>512M</b>");
    expect(row).not.toContain("均量"); // 周线不给量比
  });

  test("最新一周没走完：注明本周未完", () => {
    expect(weekLabel("2026-11-18", true)).toBe("周 2026-11-18（本周未完）");
  });

  test("第一根没有前一根：不写涨跌，数字不着色", () => {
    const row = ohlcRow("2026-01-02", week("2026-01-02", 1, 2, 0.5, 1.5), undefined, undefined);
    expect(row).not.toContain("ro-chg");
    expect(row).toContain('收<b class="">1.50</b>');
  });

  test("这根变了色（变色提示开着）：日期后面写「转绿」或「转黑」；没变色不写", () => {
    const cur = week("2026-11-20", 401, 410, 340, 345.82);
    expect(ohlcRow("2026-11-20", cur, undefined, undefined, "bull")).toStartWith('<b>2026-11-20</b><span class="ro-turn bull">转绿</span>');
    expect(ohlcRow("2026-11-20", cur, undefined, undefined, "bear")).toContain('<span class="ro-turn bear">转黑</span>');
    expect(ohlcRow("2026-11-20", cur, undefined, undefined, null)).not.toContain("ro-turn");
    expect(ohlcRow("2026-11-20", cur, undefined, undefined)).not.toContain("ro-turn");
  });
});

describe("读数条第二行：均线的值", () => {
  const cell = (key: string, group: number | null, value: number | null) => ({ key, kind: key.startsWith("EMA") ? "EMA" : "MA", token: `--${key.toLowerCase()}`, group, value });
  const groupsOf = (html: string) => [...html.matchAll(/<span class="ro-group">(.*?)<\/span><\/span>(?=<span class="ro-group">|$)/g)]
    .map((m) => [...m[0].matchAll(/<\/i>([^<]+)<\/span>/g)].map((x) => x[1]));

  test("同一组的 MA、EMA 包成一块（窄栏整组折行），MA200 单独一块；没有值写 —", () => {
    const html = linesRow([cell("MA20", 20, 158), cell("EMA20", 20, 157.5), cell("MA60", 60, 163), cell("EMA60", 60, null),
      cell("MA120", 120, 168), cell("EMA120", 120, 167), cell("MA200", null, 170)]);
    expect(groupsOf(html)).toEqual([["MA20 158.00", "EMA20 157.50"], ["MA60 163.00", "EMA60 —"], ["MA120 168.00", "EMA120 167.00"], ["MA200 170.00"]]);
  });

  test("关掉一条线：那一组只剩另一条，不和别的组并在一起", () => {
    expect(groupsOf(linesRow([cell("MA20", 20, 1), cell("EMA60", 60, 2), cell("MA120", 120, 3)]))).toEqual([["MA20 1.00"], ["EMA60 2.00"], ["MA120 3.00"]]);
  });
});

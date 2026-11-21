import { describe, expect, test } from "bun:test";
import { fmtVolume, ohlcRow, volumeCell, weekLabel } from "../public/readout.js";

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
    expect(normal).toContain("1.2× 均量");
    expect(normal).not.toContain("spike");
    const big = volumeCell({ time: "2026-11-20", value: 81.1e6, spike: true, ratio: 2.4 });
    expect(big).toContain('class="ro-ratio spike"');
    expect(big).toContain("2.4× 均量");
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
});

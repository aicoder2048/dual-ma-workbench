import { describe, expect, test } from "bun:test";
import { fmtVolume, volumeCell } from "../public/readout.js";

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

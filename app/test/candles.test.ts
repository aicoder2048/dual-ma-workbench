import { describe, expect, test } from "bun:test";
import { baseCandleStyle, candleBar } from "../public/candles.js";

const COLORS = { up: "#0a0", down: "#c00", bull: "#0b0", bear: "#000", mixed: "#888" };
const up = { time: "2026-01-02", open: 10, high: 12, low: 9, close: 11, tone: "bear" };
const down = { time: "2026-01-05", open: 11, high: 11.5, low: 9.5, close: 10, tone: "bull" };

describe("K 线颜色", () => {
  test("不着色时照常：涨绿跌红、实心，和 TradingView 一样", () => {
    expect(baseCandleStyle(COLORS)).toEqual({
      upColor: "#0a0", downColor: "#c00", borderUpColor: "#0a0", borderDownColor: "#c00", wickUpColor: "#0a0", wickDownColor: "#c00",
    });
    // 不着色时不给单根 K 线另配颜色，用上面的涨跌色
    expect(candleBar(up, false, COLORS)).toEqual({ time: up.time, open: 10, high: 12, low: 9, close: 11 });
  });

  test("着色时按破线拐头信号上色：阳线空心、阴线实心，颜色看信号不看涨跌", () => {
    expect(candleBar(up, true, COLORS)).toMatchObject({ color: "rgba(0,0,0,0)", borderColor: "#000", wickColor: "#000" });
    expect(candleBar(down, true, COLORS)).toMatchObject({ color: "#0b0", borderColor: "#0b0", wickColor: "#0b0" });
  });
});

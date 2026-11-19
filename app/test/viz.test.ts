import { describe, expect, test } from "bun:test";
import { parseCost, pnlText, situationOf } from "../public/viz.js";

describe("成本价：浏览器端解析和处境", () => {
  test("逗号、全角数字、空格都能认", () => {
    expect(parseCost("1,200")).toBe(1200);
    expect(parseCost("２００．５")).toBe(200.5);
    expect(parseCost(" 133 ")).toBe(133);
  });
  test("看不懂的、0、负数：不算填了成本", () => {
    for (const s of ["abc", "0", "-5", ""]) expect(parseCost(s)).toBeNull();
  });
  test("逗号只当千分位：133,5 这种看不懂（不悄悄变成 1335）；十六进制、科学计数也不认", () => {
    for (const s of ["133,5", "1,33", "0x10", "1e2", "1.2.3"]) expect(parseCost(s)).toBeNull();
    expect(parseCost("1,234,567.5")).toBe(1234567.5);
  });
  test("处境：价格不低于成本算浮盈，低于算浮亏，没填算持仓", () => {
    expect(situationOf({ pos: "holding", cost: "133" }, 150)).toBe("profit");
    expect(situationOf({ pos: "holding", cost: "150.01" }, 150)).toBe("loss");
    expect(situationOf({ pos: "holding", cost: "200" }, 150)).toBe("loss");
    expect(situationOf({ pos: "holding", cost: "" }, 150)).toBe("holding");
    expect(situationOf({ pos: "flat", cost: "133" }, 150)).toBe("flat");
  });
  test("持平（显示出来一样）：按没填成本给计划，不说「还有浮盈」", () => {
    expect(situationOf({ pos: "holding", cost: "150" }, 150)).toBe("holding");
    expect(situationOf({ pos: "holding", cost: "133.004" }, 133)).toBe("holding");
    expect(pnlText("133.004", 133)).toContain("持平");
  });
  test("提示：持平、看不懂", () => {
    expect(pnlText("150", 150)).toContain("持平");
    expect(pnlText("abc", 150)).toContain("看不懂");
  });
});

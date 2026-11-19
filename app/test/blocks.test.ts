import { describe, expect, test } from "bun:test";
// 前端模块里的纯函数（不碰 DOM）
import { parseBlockSpec } from "../public/blocks.js";

describe("可视化代码块解析", () => {
  test("mermaid 只接受 flowchart", () => {
    expect(parseBlockSpec("mermaid", "flowchart LR\n A-->B").ok).toBe(true);
    expect(parseBlockSpec("mermaid", "sequenceDiagram\n A->>B: hi").ok).toBe(false);
  });
  test("dma-chart：代码大写、过滤非法均线名和日期", () => {
    const r = parseBlockSpec("dma-chart", JSON.stringify({
      ticker: "nvda", from: "2026-09-01", lines: ["MA20", "MA999"], marks: [{ time: "2026-10-22", text: "20扣" }, { time: "bad" }],
    }));
    expect(r.ok).toBe(true);
    expect(r.spec).toEqual({ ticker: "NVDA", asof: null, from: "2026-09-01", to: null, lines: ["MA20"], marks: [{ time: "2026-10-22", text: "20扣" }] });
  });
  test("dma-chart：日期格式错误要报出来", () => {
    expect(parseBlockSpec("dma-chart", '{"ticker":"NVDA","from":"9/1"}').ok).toBe(false);
  });
  test("dma-drops：默认三条，过滤非法周期", () => {
    expect(parseBlockSpec("dma-drops", '{"ticker":"TSLA"}').spec?.periods).toEqual([20, 60, 120]);
    expect(parseBlockSpec("dma-drops", '{"ticker":"TSLA","periods":[20,5]}').spec?.periods).toEqual([20]);
    expect(parseBlockSpec("dma-drops", '{"ticker":"TSLA","periods":[5]}').ok).toBe(false);
  });
  test("坏 JSON 和非法代码", () => {
    expect(parseBlockSpec("dma-drops", "{ticker:").ok).toBe(false);
    expect(parseBlockSpec("dma-drops", '{"ticker":"BAD ONE"}').ok).toBe(false);
  });
});

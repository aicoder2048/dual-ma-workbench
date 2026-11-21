import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Analysis } from "../src/citations.ts";
import { captureSnapshot, Journal, journalView, parseAction, parseCreate, summarize, transition, type CreateInput } from "../src/journal.ts";
import { buildReport } from "../src/report.ts";
import spyJson from "./fixtures/spy-2024-04-19-analysis.json";

const spy = spyJson as Analysis; // 稳定上涨·回撤中
const T0 = "2024-04-19T21:00:00.000Z";
const T1 = "2024-04-22T21:00:00.000Z";

const fileIn = () => join(mkdtempSync(join(tmpdir(), "dma-journal-")), "data", "journal.json");
const input = (over: Partial<CreateInput> = {}): CreateInput =>
  ({ id: "entry-0001", ticker: "SPY", asof: "2024-04-19", situation: "flat", cost: null, size: "1/3 仓", reason: "回撤到 60 线组", ...over });
const snap = (i = input()) => captureSnapshot(spy, buildReport(spy), i);

function record(j: Journal, over: Partial<CreateInput> = {}) {
  const i = input(over);
  return j.create(i, snap(i), T0);
}

describe("快照：记入时从当时的分析里取", () => {
  test("空仓：类型 × 阶段、打法、计划、价位、规则状态、数据来源、回测记录", () => {
    const r = buildReport(spy);
    const s = snap();
    expect(s).toMatchObject({ ticker: "SPY", asof: "2024-04-19", date: "2024-04-19", close: 495.16, trend: "稳定上涨·回撤中",
      playKey: "稳定上涨", situation: "flat", cost: null, source: "Polygon/Massive（日线，只按拆股复权）" });
    expect(s.action).toBe(r.plans.flat.action);
    expect(s.trigger).toEqual(r.plans.flat.trigger);
    expect(s.stop).toEqual(r.plans.flat.stop);
    expect(s.risk).toBe(r.plans.flat.risk);
    expect(s.record).toBe(r.record.text);
    expect(s.rules.find((x) => x.id === "P10")).toEqual({ id: "P10", name: expect.any(String), status: "满足" });
    expect(s.rules.find((x) => x.id === "P12")?.status).toBe("不满足");
  });

  test("持仓浮亏：计划文字里的成本填成数字", () => {
    const s = snap(input({ situation: "loss", cost: 520 }));
    expect(s.cost).toBe(520);
    expect(JSON.stringify(s)).not.toContain("{cost}");
  });

  test("浮盈 / 浮亏没给成本：拒绝", () => {
    expect(() => parseCreate(input({ situation: "profit", cost: null }))).toThrow("成本价");
  });

  test("请求里夹带快照字段：拒绝（快照只能由服务端取）", () => {
    expect(() => parseCreate({ ...input(), snapshot: { action: "事后改的" } })).toThrow("不合法");
  });
});

describe("新增和读取", () => {
  test("没有文件时是空的；记一笔后读回来一样，状态是计划", () => {
    const j = new Journal(fileIn());
    expect(j.list()).toEqual([]);
    const e = record(j);
    expect(e.state).toBe("planned");
    expect(new Journal(j.file).list()).toEqual([e]);
  });

  test("同一个编号记两次：只有一笔，内容是第一次的", () => {
    const j = new Journal(fileIn());
    const first = record(j);
    const again = record(j, { reason: "第二次点" });
    expect(again).toEqual(first);
    expect(j.list()).toHaveLength(1);
  });
});

describe("状态转移", () => {
  const planned = () => { const j = new Journal(fileIn()); return { j, id: record(j).id }; };

  test("计划 → 已进场 → 已离场 → 复盘", () => {
    const { j, id } = planned();
    expect(j.apply(id, { type: "enter", date: "2024-04-22", price: 499 }, T1).state).toBe("open");
    const closed = j.apply(id, { type: "exit", date: "2024-05-10", price: 520, reason: "跌破 EMA20" }, T1);
    expect(closed).toMatchObject({ state: "closed", exit: { price: 520 }, review: null });
    const reviewed = j.apply(id, { type: "review", followed: true, deviation: "", lesson: "按计划走" }, T1);
    expect(reviewed).toMatchObject({ state: "closed", review: { followed: true, lesson: "按计划走" } });
  });

  test("计划 → 放弃", () => {
    const { j, id } = planned();
    expect(j.apply(id, { type: "cancel", note: "条件没齐" }, T1)).toMatchObject({ state: "cancelled", note: "条件没齐" });
  });

  test("不合法的转移被拒绝（409），文件不变", () => {
    const { j, id } = planned();
    const before = readFileSync(j.file, "utf8");
    expect(() => j.apply(id, { type: "exit", date: "2024-05-10", price: 520, reason: "" })).toThrow("还没进场");
    expect(() => j.apply(id, { type: "review", followed: true, deviation: "", lesson: "" })).toThrow("离场以后");
    expect(readFileSync(j.file, "utf8")).toBe(before);

    j.apply(id, { type: "enter", date: "2024-04-22", price: 499 });
    expect(() => j.apply(id, { type: "cancel", note: "" })).toThrow("已经进场");

    const { j: j2, id: id2 } = planned();
    j2.apply(id2, { type: "cancel", note: "" });
    expect(() => j2.apply(id2, { type: "enter", date: "2024-04-22", price: 499 })).toThrow(
      expect.objectContaining({ status: 409, message: expect.stringContaining("放弃") }));
  });

  test("离场日期早于进场、日期不存在、价格 ≤ 0：拒绝", () => {
    const { j, id } = planned();
    j.apply(id, { type: "enter", date: "2024-04-22", price: 499 });
    expect(() => j.apply(id, { type: "exit", date: "2024-04-01", price: 520, reason: "" })).toThrow("早于进场");
    expect(() => j.apply(id, { type: "exit", date: "2024-02-30", price: 520, reason: "" })).toThrow("日期不合法");
    expect(() => parseAction({ type: "enter", date: "2024-04-22", price: 0 })).toThrow("价格要填大于 0 的数字");
    expect(() => parseAction({ type: "enter", date: "42220-02-04", price: 1 })).toThrow("日期要写成 2024-04-22 这样");
    expect(() => j.apply("nope-0000", { type: "cancel", note: "" })).toThrow("没有这笔");
  });

  test("填错了可以改进场、离场；复盘保留", () => {
    const { j, id } = planned();
    j.apply(id, { type: "enter", date: "2024-04-22", price: 499 });
    j.apply(id, { type: "exit", date: "2024-05-10", price: 520, reason: "" });
    j.apply(id, { type: "review", followed: false, deviation: "提前走了", lesson: "" });
    const fixed = j.apply(id, { type: "enter", date: "2024-04-22", price: 498 });
    expect(fixed).toMatchObject({ state: "closed", entry: { price: 498 }, review: { followed: false } });
  });

  test("同一个操作做两次：结果一样，更新时间不变", () => {
    const { j, id } = planned();
    const a = j.apply(id, { type: "enter", date: "2024-04-22", price: 499 }, T1);
    const b = j.apply(id, { type: "enter", date: "2024-04-22", price: 499 }, "2030-01-01T00:00:00.000Z");
    expect(b).toEqual(a);
  });

  test("快照不随任何操作改变；操作里夹带快照字段被拒绝", () => {
    const { j, id } = planned();
    const s0 = structuredClone(j.list()[0].snapshot);
    j.apply(id, { type: "enter", date: "2024-04-22", price: 499 });
    j.apply(id, { type: "exit", date: "2024-05-10", price: 520, reason: "" });
    j.apply(id, { type: "review", followed: true, deviation: "", lesson: "" });
    j.apply(id, { type: "enter", date: "2024-04-23", price: 501 });
    expect(j.list()[0].snapshot).toEqual(s0);
    expect(() => parseAction({ type: "review", followed: true, deviation: "", lesson: "", snapshot: { stop: null } })).toThrow("不合法");
  });

  test("transition 是纯函数：不改传进来的那笔", () => {
    const { j } = planned();
    const e = j.list()[0];
    const copy = structuredClone(e);
    transition(e, { type: "enter", date: "2024-04-22", price: 499 }, T1);
    expect(e).toEqual(copy);
  });
});

describe("汇总", () => {
  /** 已离场的一笔：进场 100，离场 price，持有 days 天，followed 照没照计划（undefined = 没复盘）。 */
  function closed(j: Journal, n: number, price: number, days: number, followed?: boolean) {
    const id = `trade-${String(n).padStart(4, "0")}`;
    record(j, { id });
    j.apply(id, { type: "enter", date: "2024-01-01", price: 100 });
    const exit = new Date(Date.UTC(2024, 0, 1 + days)).toISOString().slice(0, 10);
    j.apply(id, { type: "exit", date: exit, price, reason: "" });
    if (followed !== undefined) j.apply(id, { type: "review", followed, deviation: "", lesson: "" });
  }

  test("按状态计数；照计划 / 没照计划分开算胜率、均值、中位数、平均持有天数", () => {
    const j = new Journal(fileIn());
    closed(j, 1, 110, 10, true); // +10%
    closed(j, 2, 95, 4, true); //  -5%
    closed(j, 3, 104, 6, true); //  +4%
    closed(j, 4, 90, 2, false); // -10%
    closed(j, 5, 101, 3, false); // +1%
    closed(j, 6, 120, 30); // 没复盘：+20%
    record(j, { id: "plan-0001" });
    record(j, { id: "plan-0002" });
    j.apply("plan-0002", { type: "cancel", note: "" });
    record(j, { id: "open-0001" });
    j.apply("open-0001", { type: "enter", date: "2024-04-22", price: 499 });

    const s = summarize(j.list());
    expect(s.counts).toEqual({ planned: 1, open: 1, closed: 6, cancelled: 1 });
    expect(s.closed.unreviewed).toBe(1);
    const f = s.closed.followed;
    expect(f.n).toBe(3);
    expect(f.winRate).toBeCloseTo(2 / 3);
    expect(f.mean).toBeCloseTo((10 - 5 + 4) / 3);
    expect(f.median).toBeCloseTo(4);
    expect(f.avgDays).toBeCloseTo((10 + 4 + 6) / 3);
    const d = s.closed.deviated;
    expect(d).toMatchObject({ n: 2, winRate: 0.5, small: true });
    expect(d.mean).toBeCloseTo(-4.5);
    expect(d.median).toBeCloseTo(-4.5); // 偶数笔：中间两笔的平均
    expect(s.closed.all.n).toBe(6);
    expect(s.closed.all.mean).toBeCloseTo((10 - 5 + 4 - 10 + 1 + 20) / 6);
  });

  test("没有已离场的：各项是空，标为样本少", () => {
    expect(summarize([]).closed.followed).toEqual({ n: 0, winRate: null, mean: null, median: null, avgDays: null, small: true });
  });

  test("给页面的：最新的在前，已离场的带收益和天数", () => {
    const j = new Journal(fileIn());
    closed(j, 1, 110, 10, true);
    record(j, { id: "plan-0001" });
    const v = journalView(j.list());
    expect(v.entries.map((e) => e.id)).toEqual(["plan-0001", "trade-0001"]);
    expect(v.entries[1].outcome).toEqual({ pnl: expect.closeTo(10, 6), days: 10 });
    expect(v.entries[0].outcome).toBeNull();
  });
});

describe("文件", () => {
  test("文件坏了（不是 JSON）：报错，写明文件；不覆盖", () => {
    const file = fileIn();
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "{ 坏了");
    const j = new Journal(file);
    expect(() => j.list()).toThrow("交易日志文件读不了");
    expect(() => record(j)).toThrow("交易日志文件读不了");
    expect(readFileSync(file, "utf8")).toBe("{ 坏了");
  });

  test("结构不对（缺字段、状态写错、编号重复）：报错，不悄悄丢掉那一笔", () => {
    const j = new Journal(fileIn());
    const e = record(j);
    const write = (entries: unknown[]) => writeFileSync(j.file, JSON.stringify({ version: 1, entries }));
    write([{ ...e, state: "done" }]);
    expect(() => j.list()).toThrow("读不了");
    write([{ ...e, snapshot: undefined }]);
    expect(() => j.list()).toThrow("读不了");
    write([e, e]);
    expect(() => j.list()).toThrow("重复");
  });

  test("先写临时文件再改名：写失败时原文件完好，也不留半截内容", () => {
    const j = new Journal(fileIn());
    record(j);
    const before = readFileSync(j.file, "utf8");
    expect(existsSync(`${j.file}.tmp`)).toBe(false);
    mkdirSync(`${j.file}.tmp`); // 临时文件的位置被占：写入失败
    expect(() => record(j, { id: "entry-0002" })).toThrow();
    expect(readFileSync(j.file, "utf8")).toBe(before);
    expect(j.list()).toHaveLength(1);
  });
});

import { describe, expect, test } from "bun:test";
import { PROFILE_BINS, PROFILE_EDGE, distribute, findMountains, labeledMountains, visibleProfile } from "../public/volprofile.js";
import fixture from "./fixtures/volprofile-crosscheck.json";

// 夹具是 skill 的 volprofile.py 生成的（tests/test_volprofile.py 守着它和 Python 一致）：同样的 K 线，JS 要算出逐位相同的结果
describe("和 Python 的 volprofile.py 逐位一致", () => {
  test("分档数、出山的阈值和 Python 一样", () => {
    expect([PROFILE_BINS, PROFILE_EDGE]).toEqual([fixture.bins, fixture.edge]);
  });
  for (const c of fixture.cases) {
    test(c.name, () => {
      const { edges, volumes } = distribute(c.bars);
      expect(edges).toEqual(c.edges);
      expect(volumes).toEqual(c.volumes);
      expect(findMountains(edges, volumes)).toEqual(c.mountains);
    });
  }
});

describe("按可见范围取 K 线", () => {
  const view = {
    candles: ["2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07"].map((time, i) => ({ time, high: 12 + i, low: 10 + i, close: 11 + i })),
    volume: [{ time: "2026-01-02", value: 100 }, { time: "2026-01-05", value: 50 }, { time: "2026-01-07", value: 40 }],
  };

  test("只算看得见的那几根：逻辑范围取整到 K 线上，右边的空位不算", () => {
    const p = visibleProfile(view, { from: 0.6, to: 6 })!;
    expect([p.from, p.to, p.bars]).toEqual(["2026-01-05", "2026-01-07", 2]); // 第 3 根没有量，不算
  });

  test("没有 K 线或范围时算不了", () => {
    expect(visibleProfile({ candles: [], volume: [] }, { from: 0, to: 3 })).toBeNull();
    expect(visibleProfile(view, null)).toBeNull();
  });
});

test("图上只标价格所在的、上方和下方最近的山", () => {
  const m = (foot: number, top: number) => ({ foot, top, volume: 1, share: 0.1 });
  const all = [m(90, 95), m(100, 105), m(110, 120), m(130, 140), m(150, 160)];
  expect(labeledMountains(all, 115)).toEqual([m(100, 105), m(110, 120), m(130, 140)]);
  expect(labeledMountains(all, 125)).toEqual([m(110, 120), m(130, 140)]);
});

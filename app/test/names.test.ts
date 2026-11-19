import { describe, expect, test } from "bun:test";
import { resolveTicker } from "../public/names.js";

describe("resolveTicker：搜索框输入 → 代码", () => {
  test("代码照常，统一大写", () => expect(resolveTicker(" nvda ")).toEqual({ ticker: "NVDA" }));
  test("常用中文名换成代码（简繁都行）", () => {
    expect(resolveTicker("台积电")).toEqual({ ticker: "TSM", name: "台积电" });
    expect(resolveTicker("台積電")).toEqual({ ticker: "TSM", name: "台积电" });
    expect(resolveTicker("英伟达")).toEqual({ ticker: "NVDA", name: "英伟达" });
  });
  test("英文名不分大小写", () => expect(resolveTicker("tsmc")).toEqual({ ticker: "TSM", name: "台积电" }));
  test("认不出的名字给出能照做的提示", () => {
    const r = resolveTicker("某某科技");
    expect(r.ticker).toBeUndefined();
    expect(r.error).toContain("「某某科技」");
    expect(r.error).toContain("代码");
  });
  test("空输入什么也不做", () => expect(resolveTicker("  ")).toEqual({}));
});

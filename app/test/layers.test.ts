import { describe, expect, test } from "bun:test";
import { DEFAULT_PRESET, LAYERS, PRESETS, layerRows, parseLayers, presetOf, presetState, shownLayers, toggleLayer } from "../public/layers.js";

/** 一眼看得出是假的颜色来源。 */
const FAKE_TONE = { name: "假规则：按日期单双", legend: ["单号绿、双号黑（测试用）", "第二行"], warning: null };
/** 日线、不在回放、不在练习、结构和缺口都有、有成交量、有颜色：什么都能画。 */
const DAY = { frame: "day", replay: false, practice: false, structure: true, gaps: 8, moreGaps: 6, volume: true, tone: FAKE_TONE, tones: true };
const onKeys = (state: Record<string, boolean>) => Object.keys(state).filter((k) => state[k]);
const why = (state: Record<string, boolean>, ctx: object) => Object.fromEntries(layerRows(state, ctx).map((r) => [r.key, r.why]));

describe("图层表", () => {
  test("菜单里的分组和顺序：均线、价位线、抵扣价、着色（带「变色提示」）、顶底构造、形态、波段、缺口（带「全部」）、筹码", () => {
    expect(LAYERS.map((l) => [l.group, l.label])).toEqual([
      ["均线", "均线"], ["价位线", "价位线"], ["抵扣价", "抵扣价"], ["着色", "着色"], ["着色", "变色提示"], ["顶底构造", "顶底构造"],
      ["形态", "形态"], ["波段", "波段"], ["缺口", "缺口"], ["缺口", "全部"], ["筹码", "筹码"],
    ]);
  });

  test("形态那一行写明是 M 顶、W 底、2B 和颈线", () => {
    const row = layerRows(presetState("all"), DAY).find((r) => r.key === "patterns")!;
    expect(row.hint).toBe("M 顶、W 底、2B 和颈线");
  });
});

describe("「着色」那一行的说明跟着颜色的来源走", () => {
  const tone = (ctx: object) => layerRows(presetState("all"), ctx).find((r) => r.key === "tone")!;

  test("写来源的名字，小字是说明的第一行，悬停看整段", () => {
    const row = tone(DAY);
    expect([row.label, row.lead, row.hint]).toEqual(["着色", "假规则：按日期单双", "单号绿、双号黑（测试用）"]);
    expect(row.title).toBe("假规则：按日期单双\n单号绿、双号黑（测试用）\n第二行");
    expect(row.note).toBeNull();
  });

  test("换了来源（切到周线、换了数据）说明跟着换", () => {
    const row = tone({ ...DAY, tone: { name: "假规则：周线版", legend: ["周线的说明"], warning: null } });
    expect([row.lead, row.hint, row.title]).toEqual(["假规则：周线版", "周线的说明", "假规则：周线版\n周线的说明"]);
  });

  test("插件没用上：原因写在这一行下面", () => {
    expect(tone({ ...DAY, tone: { ...FAKE_TONE, warning: "着色插件 fake.py 没用上，退回自带规则：文件不存在" } }).note)
      .toBe("着色插件 fake.py 没用上，退回自带规则：文件不存在");
  });

  test("没有来源：不写名字，小字是那一行兜底说明", () => {
    const row = tone({ ...DAY, tone: { name: null, legend: ["兜底说明"], warning: null } });
    expect([row.lead, row.hint, row.title, row.note]).toEqual([null, "兜底说明", "兜底说明", null]);
  });

  test("插件只给了名字、没给说明：小字空着，不报错", () => {
    const row = tone({ ...DAY, tone: { name: "假规则：没写说明", legend: [], warning: null } });
    expect([row.lead, row.hint, row.title]).toEqual(["假规则：没写说明", "", "假规则：没写说明"]);
  });

  test("别的行没有来源名字和下面那句", () => {
    for (const r of layerRows(presetState("all"), DAY).filter((x) => x.key !== "tone")) expect([r.key, r.lead, r.note]).toEqual([r.key, null, null]);
  });
});

describe("预设", () => {
  test("三个：简洁、结构、全部；默认是简洁", () => {
    expect(PRESETS.map((p) => p.label)).toEqual(["简洁", "结构", "全部"]);
    expect(PRESETS.find((p) => p.key === DEFAULT_PRESET)!.label).toBe("简洁");
  });

  test("简洁：只画均线、价位线、抵扣价", () => {
    expect(onKeys(presetState("simple"))).toEqual(["ma", "levels", "drops"]);
  });

  test("结构：简洁之上加顶底构造、形态、波段、缺口；不着色、不画全部缺口和筹码", () => {
    expect(onKeys(presetState("structure"))).toEqual(["ma", "levels", "drops", "constructs", "patterns", "swings", "gaps"]);
  });

  test("全部：每个图层都开", () => {
    expect(onKeys(presetState("all"))).toEqual(LAYERS.map((l) => l.key));
  });

  test("状态和某个预设一模一样才算那个预设；手动改过一项就不是任何预设，改回来又是", () => {
    for (const p of PRESETS) expect(presetOf(presetState(p.key))).toBe(p.key);
    const custom = toggleLayer(presetState("simple"), "gaps");
    expect(custom.gaps).toBe(true);
    expect(presetOf(custom)).toBeNull();
    expect(presetOf(toggleLayer(custom, "gaps"))).toBe("simple");
  });

  test("开关一个图层不动原来的状态对象", () => {
    const before = presetState("simple");
    toggleLayer(before, "tone");
    expect(before.tone).toBe(false);
  });
});

describe("能不能用", () => {
  test("日线、有数据：全都能用", () => {
    expect(Object.values(why(presetState("all"), DAY)).every((w) => w === null)).toBe(true);
  });

  test("周线：构造、形态、波段、缺口、筹码按日线算，写明切回日线；均线、价位线、抵扣价、着色照常", () => {
    const w = why(presetState("all"), { ...DAY, frame: "week" });
    for (const k of ["constructs", "patterns", "swings"]) expect(w[k]).toBe("结构按日线算：切回日线看");
    expect(w.gaps).toBe("缺口按日线算：切回日线看");
    expect(w.profile).toBe("筹码按日线算：切回日线看");
    expect([w.ma, w.levels, w.drops, w.tone]).toEqual([null, null, null, null]);
  });

  test("回放：结构、缺口、价位线收起并写明原因；筹码照样能用", () => {
    const w = why(presetState("all"), { ...DAY, replay: true });
    for (const k of ["constructs", "patterns", "swings"]) expect(w[k]).toContain("回放时收起：结构是按最新一天算的");
    expect(w.gaps).toContain("回放时收起：缺口补没补要看之后的 K 线");
    expect(w.levels).toContain("回放时收起");
    expect(w.profile).toBeNull();
  });

  test("练习（没有结构、没有缺口数据）：写明练习里不画", () => {
    const w = why(presetState("all"), { ...DAY, structure: false, gaps: null, moreGaps: 0 });
    for (const k of ["constructs", "patterns", "swings", "gaps"]) expect(w[k]).toContain("练习里不画");
  });

  test("一个没补的缺口都没有：缺口那行写明", () => {
    expect(why(presetState("all"), { ...DAY, gaps: 0, moreGaps: 0 }).gaps).toBe("上方没有没补的缺口");
  });

  test("没有成交量：筹码算不了", () => {
    expect(why(presetState("all"), { ...DAY, volume: false }).profile).toContain("没有成交量");
  });

  test("「全部」是缺口的子项：缺口关着要先打开，缺口不能用时原因和缺口一样，没有更多可画时写明", () => {
    expect(why(presetState("simple"), DAY).gapsAll).toBe("先打开「缺口」");
    expect(why(presetState("all"), { ...DAY, frame: "week" }).gapsAll).toBe("缺口按日线算：切回日线看");
    expect(why(presetState("all"), { ...DAY, moreGaps: 0 }).gapsAll).toContain("没有更多");
    const row = layerRows(presetState("structure"), DAY).find((r) => r.key === "gapsAll")!;
    expect([row.sub, row.why, row.hint]).toEqual([true, null, "离得远、不是阻力位的那 6 个也画"]);
  });

  test("「变色提示」是着色的子项：着色关着要先打开；练习里不标；没有颜色数据标不了", () => {
    const row = (state: Record<string, boolean>, ctx: object) => layerRows(state, ctx).find((r) => r.key === "toneTurns")!;
    expect([row(presetState("all"), DAY).sub, row(presetState("all"), DAY).why]).toEqual([true, null]);
    expect(row(toggleLayer(presetState("simple"), "toneTurns"), DAY).why).toBe("先打开「着色」");
    expect(row(presetState("all"), { ...DAY, practice: true }).why).toBe("练习里不标：这是题目要你自己看的");
    expect(row(presetState("all"), { ...DAY, practice: true }).shown).toBe(false);
    expect(row(presetState("all"), { ...DAY, tones: false }).why).toContain("没有颜色");
  });

  test("「变色提示」只属于「全部」；周线、回放时照常能用", () => {
    expect(PRESETS.map((p) => presetState(p.key).toneTurns)).toEqual([false, false, true]);
    expect(why(presetState("all"), { ...DAY, frame: "week" }).toneTurns).toBeNull();
    expect(why(presetState("all"), { ...DAY, replay: true }).toneTurns).toBeNull();
  });

  test("图上画不画 = 开着而且能用", () => {
    const all = presetState("all");
    expect(Object.values(shownLayers(all, DAY)).every(Boolean)).toBe(true);
    const week = shownLayers(all, { ...DAY, frame: "week" });
    expect(onKeys(week)).toEqual(["ma", "levels", "drops", "tone", "toneTurns"]);
    expect(onKeys(shownLayers(presetState("simple"), DAY))).toEqual(["ma", "levels", "drops"]);
  });
});

describe("记在本机", () => {
  test("没存过、存坏了：简洁", () => {
    for (const text of [null, "", "{", "[]", "3", "null"]) expect(parseLayers(text)).toEqual(presetState("simple"));
  });

  test("存过的照原样读回来", () => {
    const saved = toggleLayer(presetState("structure"), "profile");
    expect(parseLayers(JSON.stringify(saved))).toEqual(saved);
  });

  test("少了的图层、不是真假值的、不认识的键：按简洁补上，多的丢掉", () => {
    expect(parseLayers(JSON.stringify({ tone: true, gaps: "yes", nope: true }))).toEqual({ ...presetState("simple"), tone: true });
  });
});

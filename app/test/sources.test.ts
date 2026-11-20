import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chunkMarkdown, FALLBACK, PROJECT_ROOT, queryTerms, sectionKey, SOURCE_DOCS, SourceLibrary, type SourceDoc } from "../src/sources.ts";

const DOC: SourceDoc = { code: "t", title: "测试文档", path: "t.md", skip: ["跳过"] };

describe("sectionKey", () => {
  test("带点的章节号", () => expect(sectionKey("2.3 抵扣价")).toBe("2.3"));
  test("一级章节号", () => expect(sectionKey("1. 双均线是干什么的")).toBe("1"));
  test("年份不是章节号", () => expect(sectionKey("2020 年的例子：一个死叉")).toBe("2020年的例子"));
  test("取冒号前、去括号", () => expect(sectionKey("第 1 步：看大局（现在是什么趋势）")).toBe("第1步"));
  test("括号里的时间戳冒号不切", () => expect(sectionKey("AAPL（日线）（16:11–17:15）")).toBe("AAPL"));
});

describe("chunkMarkdown", () => {
  const md = ["---", "title: x", "---", "导语", "# 一", "正文一", "## 跳过这节", "不要", "## 空节", "## 二", "正文二"].join("\n");
  const chunks = chunkMarkdown(DOC, md);

  test("去掉 frontmatter，标题前的文字归到文档名片段", () => {
    expect(chunks[0].heading).toBe("测试文档");
    expect(chunks[0].body).toBe("导语");
  });
  test("跳过配置里的章节和空章节", () => {
    expect(chunks.map((c) => c.heading)).toEqual(["测试文档", "一", "二"]);
  });
  test("记录标题所在行号", () => expect(chunks.find((c) => c.heading === "二")!.line).toBe(10));
  test("重名章节加后缀，编号不重复", () => {
    const dup = chunkMarkdown(DOC, "## 同名\na\n## 同名\nb");
    expect(dup.map((c) => c.id)).toEqual(["t#同名", "t#同名-2"]);
  });
});

describe("SourceLibrary.search", () => {
  test("长段落反复出现同一个词，排不过标题对题的短段落", () => {
    const lib = new SourceLibrary(chunkMarkdown(DOC, [
      "## 案例复盘", "抵扣价".repeat(20),
      "## 定义与公式", "MA 每天的变化 = (今天收盘价 − 抵扣价) / N，抵扣价是 N 天前的收盘价。",
    ].join("\n")));
    expect(lib.search("抵扣价的公式")[0].chunk.heading).toBe("定义与公式");
  });
});

const HAS_PRIVATE = existsSync(resolve(PROJECT_ROOT, "chat/1118_what-I-want.md"));

describe.skipIf(!HAS_PRIVATE)("SourceLibrary（本地完整资料，公开仓库里没有）", () => {
  const lib = SourceLibrary.load();

  test("关键片段存在", () => {
    for (const id of ["article#2.3", "article#4", "skill#原则", "skill#第3步", "dropoff#定义与公式", "cases#TSLA2021"]) {
      expect(lib.has(id)).toBe(true);
    }
  });
  test("不收录 skill 的操作说明章节", () => {
    expect(lib.chunks.some((c) => c.doc === "skill" && c.heading.includes("网页报告"))).toBe(false);
  });
  test("搜索抵扣价公式能命中定义片段", () => {
    const ids = lib.search("抵扣价的公式").map((r) => r.chunk.id);
    expect(ids).toContain("dropoff#定义与公式");
  });
  test("搜索双交叉命中讲两组算法的片段", () => {
    const ids = lib.search("双交叉").map((r) => r.chunk.id);
    expect(ids).toContain("article#2.2");
  });
});

test("queryTerms：英文按词，中文按二字组", () => {
  expect(queryTerms("MA20 抵扣价")).toEqual(["ma20", "抵扣", "扣价"]);
});

describe("公开版：转载内容不在仓库里", () => {
  // 只用 skill 自带的文档，模拟从 GitHub clone 下来的情况
  const publicLib = SourceLibrary.load(undefined, SOURCE_DOCS.filter((d) => d.path.startsWith(".agents/")));

  test("缺文件不报错：load 跳过不存在的文档", () => {
    const docs: SourceDoc[] = [...SOURCE_DOCS, { code: "nope", title: "不存在", path: "no/such/file.md" }];
    expect(() => SourceLibrary.load(undefined, docs)).not.toThrow();
  });
  test("报告里写死的外部引用都能落到 skill 自带的片段", () => {
    for (const id of Object.keys(FALLBACK)) {
      const c = publicLib.get(id);
      expect(c, id).toBeDefined();
      expect(c!.doc === "skill" || c!.doc === "concepts" || c!.doc === "playbook").toBe(true);
    }
  });
  test("替代只在原文缺失时生效", () => {
    const full = SourceLibrary.load();
    if (full.chunks.some((c) => c.doc === "article")) expect(full.get("article#2.3")!.doc).toBe("article");
    expect(publicLib.get("article#2.3")!.id).toBe("concepts#抵扣价");
  });
  test("目录里列出替代条目，前端不会把它标红", () => {
    expect(publicLib.index().some((e) => e.id === "article#2.3" && e.aliasOf === "concepts#抵扣价")).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import { chunkMarkdown, queryTerms, sectionKey, SourceLibrary, type SourceDoc } from "../src/sources.ts";

const DOC: SourceDoc = { code: "t", title: "测试文档", path: "t.md", skip: ["跳过"] };

describe("sectionKey", () => {
  test("带点的章节号", () => expect(sectionKey("2.3 底扣价")).toBe("2.3"));
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

describe("SourceLibrary（真实项目资料）", () => {
  const lib = SourceLibrary.load();

  test("关键片段存在", () => {
    for (const id of ["article#2.3", "article#4", "skill#原则", "skill#第3步", "dropoff#定义与公式", "cases#TSLA2021"]) {
      expect(lib.has(id)).toBe(true);
    }
  });
  test("不收录 skill 的操作说明章节", () => {
    expect(lib.chunks.some((c) => c.doc === "skill" && c.heading.includes("网页报告"))).toBe(false);
  });
  test("搜索底扣价公式能命中定义片段", () => {
    const ids = lib.search("底扣价的公式").map((r) => r.chunk.id);
    expect(ids).toContain("dropoff#定义与公式");
  });
  test("搜索双交叉命中讲两组算法的片段", () => {
    const ids = lib.search("双交叉").map((r) => r.chunk.id);
    expect(ids).toContain("article#2.2");
  });
});

test("queryTerms：英文按词，中文按二字组", () => {
  expect(queryTerms("MA20 底扣价")).toEqual(["ma20", "底扣", "扣价"]);
});

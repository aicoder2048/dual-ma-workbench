import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeFingerprint } from "../src/build.ts";

describe("codeFingerprint：服务端启动后代码有没有变", () => {
  const dir = mkdtempSync(join(tmpdir(), "dma-build-"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "a.ts"), "1");
  writeFileSync(join(dir, "sub", "b.js"), "2");

  test("没改就相同", () => expect(codeFingerprint([dir])).toBe(codeFingerprint([dir])));
  test("改了任一文件内容就不同", () => {
    const before = codeFingerprint([dir]);
    writeFileSync(join(dir, "sub", "b.js"), "3");
    expect(codeFingerprint([dir])).not.toBe(before);
  });
  test("新增文件也算", () => {
    const before = codeFingerprint([dir]);
    writeFileSync(join(dir, "c.css"), "x");
    expect(codeFingerprint([dir])).not.toBe(before);
  });
});

describe("codeFingerprint：也认启动时读进来的单个文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "dma-build2-"));
  const md = join(dir, "SKILL.md");
  writeFileSync(md, "原则 1");
  test("改了单个 Markdown 文件，指纹就变", () => {
    const before = codeFingerprint([md]);
    writeFileSync(md, "原则 2");
    expect(codeFingerprint([md])).not.toBe(before);
  });
  test("不存在的文件跳过，不报错（公开仓库没有转载的笔记）", () => {
    expect(() => codeFingerprint([join(dir, "没有这个文件.md")])).not.toThrow();
  });
});

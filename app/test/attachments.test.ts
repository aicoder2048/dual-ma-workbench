import { describe, expect, test } from "bun:test";
import { MAX_ATTACHMENTS, MAX_IMAGE_BYTES, parseAttachments, withAttachments } from "../src/attachments.ts";

const PNG = Buffer.from("89504e470d0a1a0a", "hex").toString("base64"); // PNG 文件头就够了，不解码
const png = (name = "截图.png") => ({ kind: "image", name, mimeType: "image/png", data: PNG });

describe("parseAttachments：浏览器传来的附件，在边界上校验", () => {
  test("没有附件", () => {
    expect(parseAttachments(undefined)).toEqual([]);
    expect(parseAttachments([])).toEqual([]);
  });
  test("图片和文本文件都收", () => {
    const got = parseAttachments([png(), { kind: "text", name: "持仓.csv", text: "代码,股数\nNVDA,10" }]);
    expect(got.map((a) => a.kind)).toEqual(["image", "text"]);
  });
  test("拒绝：太多、不认识的图片格式、太大的图片、坏的 base64、PDF", () => {
    expect(() => parseAttachments(Array(MAX_ATTACHMENTS + 1).fill(png()))).toThrow(/最多/);
    expect(() => parseAttachments([{ ...png(), mimeType: "image/tiff" }])).toThrow(/不合法/);
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64");
    expect(() => parseAttachments([{ ...png(), data: big }])).toThrow(/太大/);
    expect(() => parseAttachments([{ ...png(), data: "不是base64!!" }])).toThrow(/不合法/);
    expect(() => parseAttachments([{ kind: "pdf", name: "研报.pdf" }])).toThrow(/截图/);
  });
});

describe("withAttachments：拼成发给模型的内容", () => {
  test("文本附件拼进问题，图片单独给模型，界面只记名字", () => {
    const r = withAttachments("帮我看看", parseAttachments([png("图.png"), { kind: "text", name: "a.csv", text: "x,y" }]));
    expect(r.prompt).toContain("帮我看看");
    expect(r.prompt).toContain("附件「a.csv」");
    expect(r.prompt).toContain("x,y");
    expect(r.prompt).toContain("1 张图片");
    expect(r.images).toEqual([{ type: "image", mimeType: "image/png", data: PNG }]);
    expect(r.names).toEqual(["图.png", "a.csv"]);
  });
  test("只有附件、没写问题时，补一句默认问题", () => {
    expect(withAttachments("", parseAttachments([png()])).prompt).toContain("请看附件");
  });
  test("没有附件时原样返回", () => {
    expect(withAttachments("问题", [])).toEqual({ prompt: "问题", images: [], names: [] });
  });
});

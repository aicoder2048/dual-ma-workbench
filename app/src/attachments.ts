/**
 * 对话框附件：导入的文件、粘贴的截图。浏览器经 WebSocket 发来，这里在边界上校验一次，之后只用解析好的类型。
 *
 * - 图片：按 Pi 的图片输入交给模型（两个可选模型都支持看图）。
 * - 文本文件（csv、md、txt、json……）：内容拼进问题里。
 * - 其他（PDF、Word……）：拒绝，提示用截图。
 */
export const MAX_ATTACHMENTS = 4;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_TEXT_CHARS = 60_000;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type ImageMime = (typeof IMAGE_TYPES)[number];
export type Attachment =
  | { kind: "image"; name: string; mimeType: ImageMime; data: string }
  | { kind: "text"; name: string; text: string };

const bad = (why: string) => new Error(`附件不合法：${why}`);
const nameOf = (raw: unknown) => String(raw ?? "附件").replace(/[\r\n]/g, " ").slice(0, 120) || "附件";

export function parseAttachments(raw: unknown): Attachment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw bad("应为列表");
  if (raw.length > MAX_ATTACHMENTS) throw new Error(`附件最多 ${MAX_ATTACHMENTS} 个`);
  let textChars = 0;
  return raw.map((r: any): Attachment => {
    const name = nameOf(r?.name);
    if (r?.kind === "image") {
      if (!IMAGE_TYPES.includes(r.mimeType)) throw bad(`「${name}」的图片格式 ${String(r.mimeType)}，只支持 png、jpeg、webp、gif`);
      if (typeof r.data !== "string" || !BASE64.test(r.data)) throw bad(`「${name}」的图片数据坏了`);
      if ((r.data.length * 3) / 4 > MAX_IMAGE_BYTES) throw new Error(`图片「${name}」太大：单张不超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB`);
      return { kind: "image", name, mimeType: r.mimeType, data: r.data };
    }
    if (r?.kind === "text") {
      if (typeof r.text !== "string") throw bad(`「${name}」没有文字`);
      textChars += r.text.length;
      if (textChars > MAX_TEXT_CHARS) throw new Error(`文本附件太长：合计不超过 ${MAX_TEXT_CHARS} 字`);
      return { kind: "text", name, text: r.text };
    }
    throw bad(`「${name}」只支持图片和文本文件。PDF 等请截图后粘贴`);
  });
}

/** 拼成发给模型的内容：文本附件进 prompt，图片单独给；names 给界面显示。 */
export function withAttachments(question: string, atts: Attachment[]) {
  if (!atts.length) return { prompt: question, images: [], names: [] };
  const images = atts.flatMap((a) => (a.kind === "image" ? [{ type: "image" as const, mimeType: a.mimeType, data: a.data }] : []));
  const texts = atts.flatMap((a) => (a.kind === "text" ? [`附件「${a.name}」：\n\`\`\`\n${a.text}\n\`\`\``] : []));
  const parts = [question.trim() || "请看附件，结合当前股票用双均线方法解读。"];
  if (images.length) parts.push(`（用户附了 ${images.length} 张图片：${atts.filter((a) => a.kind === "image").map((a) => a.name).join("、")}）`);
  parts.push(...texts);
  return { prompt: parts.join("\n\n"), images, names: atts.map((a) => a.name) };
}

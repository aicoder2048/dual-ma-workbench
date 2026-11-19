/**
 * 引用库：把项目里的方法论资料切成带稳定编号的片段，供两个 agent 搜索、读取和引用。
 *
 * 片段编号 = `<文档代号>#<章节号或压缩标题>`，例如 `article#2.3`、`skill#原则`。
 * 回答里用 `[[S:article#2.3]]` 引用；citations.ts 负责校验。
 *
 * 命令行：`bun src/sources.ts` 列出全部片段编号（检查切片结果用）。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const PROJECT_ROOT = resolve(import.meta.dir, "../..");
const SKILL = ".agents/skills/dual-moving-averages";

export interface SourceDoc {
  /** 文档代号，出现在片段编号里，不能改（改了旧引用就失效）。 */
  code: string;
  /** 给人看的文档名。 */
  title: string;
  /** 相对项目根目录的路径。 */
  path: string;
  /** 不收录的章节（标题包含这些文字就跳过）。 */
  skip?: string[];
}

export const SOURCE_DOCS: SourceDoc[] = [
  { code: "article", title: "学习文章：双均线分析", path: "chat/1118_what-I-want.md" },
  {
    code: "skill", title: "Skill：双均线分析流程", path: `${SKILL}/SKILL.md`,
    skip: ["拿数据", "回答格式", "网页报告", "工作台"],
  },
  { code: "concepts", title: "概念速查", path: `${SKILL}/references/concepts.md` },
  { code: "cases", title: "视频案例", path: `${SKILL}/references/cases.md` },
  { code: "dropoff", title: "底扣价学习笔记", path: "study-notes/261118-ma-drop-off-price.md" },
  { code: "ta01", title: "TA01 均线实战要点", path: "docs/moving-averages/TA01-MA-Practical-Essentials.md" },
  { code: "ta15", title: "TA15 用均线判断趋势与震荡", path: "docs/moving-averages/TA15-Trend-Summary-from-MA.md" },
  { code: "memo", title: "用户看片笔记", path: "memo/模糊正确.md" },
];

export interface Chunk {
  id: string;
  doc: string;
  docTitle: string;
  /** 章节标题（不含 # 号）。 */
  heading: string;
  path: string;
  /** 章节标题所在行，从 1 开始。 */
  line: number;
  body: string;
}

const HEADING = /^(#{1,3})\s+(.+?)\s*$/;
// "2.3 底扣价" 或 "1. 双均线是干什么的"；不匹配 "2020 年的例子"
const SECTION_NO = /^(\d+\.\d+(?:\.\d+)*|\d+)\.?\s+(?=\D)/;
const DOTTED_OR_DOT = /^(\d+\.\d+(?:\.\d+)*\s|\d+\.\s)/;

function stripFrontmatter(lines: string[]): number {
  if (lines[0]?.trim() !== "---") return 0;
  const end = lines.indexOf("---", 1);
  return end === -1 ? 0 : end + 1;
}

/**
 * 章节号优先（"2.3"、"1."）；没有就取冒号前的部分，去掉括号内容、空白和标点，最多 12 个字。
 * 例："第 1 步：看大局（现在是什么趋势）" → "第1步"；"TSLA（日线，2021 年下跌）" → "TSLA"。
 */
export function sectionKey(heading: string): string {
  if (DOTTED_OR_DOT.test(heading)) return heading.match(SECTION_NO)![1];
  // 先去括号（里面可能有 "16:11" 这样的时间戳），再按冒号切
  const head = heading.replace(/[（(][^）)]*[）)]/g, "").split(/[：:]/)[0];
  return head.replace(/[\s\p{P}\p{S}]+/gu, "").slice(0, 12) || "section";
}

export function chunkMarkdown(doc: SourceDoc, text: string): Chunk[] {
  const lines = text.split(/\r?\n/);
  const start = stripFrontmatter(lines);
  const chunks: Chunk[] = [];
  const used = new Set<string>();
  let cur: { heading: string; line: number; body: string[] } | null = null;

  const flush = () => {
    if (!cur) return;
    const body = cur.body.join("\n").trim();
    const skipped = doc.skip?.some((s) => cur!.heading.includes(s));
    if (body && !skipped) {
      let key = sectionKey(cur.heading);
      for (let i = 2; used.has(key); i++) key = `${sectionKey(cur.heading)}-${i}`;
      used.add(key);
      chunks.push({
        id: `${doc.code}#${key}`, doc: doc.code, docTitle: doc.title, heading: cur.heading,
        path: doc.path, line: cur.line, body,
      });
    }
  };

  for (let i = start; i < lines.length; i++) {
    const m = lines[i].match(HEADING);
    if (m) {
      flush();
      cur = { heading: m[2], line: i + 1, body: [] };
    } else {
      // 第一个标题之前的文字（或整篇没有标题）归到以文档名命名的片段
      cur ??= { heading: doc.title, line: i + 1, body: [] };
      cur.body.push(lines[i]);
    }
  }
  flush();
  return chunks;
}

export class SourceLibrary {
  readonly chunks: Chunk[];
  private byId: Map<string, Chunk>;

  constructor(chunks: Chunk[]) {
    this.chunks = chunks;
    this.byId = new Map(chunks.map((c) => [c.id, c]));
    if (this.byId.size !== chunks.length) throw new Error("引用库里有重复的片段编号");
  }

  static load(root = PROJECT_ROOT, docs = SOURCE_DOCS): SourceLibrary {
    const chunks = docs.flatMap((d) => chunkMarkdown(d, readFileSync(resolve(root, d.path), "utf8")));
    return new SourceLibrary(chunks);
  }

  get(id: string): Chunk | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** 关键词检索：英文按词、中文按二字组，标题命中权重更高。 */
  search(query: string, limit = 6): { chunk: Chunk; score: number }[] {
    const terms = queryTerms(query);
    if (!terms.length) return [];
    return this.chunks
      .map((chunk) => {
        const head = chunk.heading.toLowerCase();
        const body = chunk.body.toLowerCase();
        const score = terms.reduce((s, t) => s + (head.includes(t) ? 3 : 0) + countOf(body, t), 0);
        return { chunk, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

export function queryTerms(query: string): string[] {
  const q = query.toLowerCase();
  const words = q.match(/[a-z0-9]+/g) ?? [];
  const cjk = q.match(/[\p{Script=Han}]+/gu) ?? [];
  const grams = cjk.flatMap((run) =>
    run.length === 1 ? [run] : Array.from({ length: run.length - 1 }, (_, i) => run.slice(i, i + 2)),
  );
  return [...new Set([...words.filter((w) => w.length > 1), ...grams])];
}

function countOf(text: string, term: string): number {
  let n = 0;
  for (let i = text.indexOf(term); i !== -1; i = text.indexOf(term, i + term.length)) n++;
  return n;
}

if (import.meta.main) {
  const lib = SourceLibrary.load();
  for (const c of lib.chunks) console.log(`${c.id.padEnd(28)} ${c.path}:${c.line}  ${c.heading}`);
  console.log(`\n共 ${lib.chunks.length} 个片段`);
}

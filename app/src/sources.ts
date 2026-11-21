/**
 * 引用库：把项目里的方法论资料切成带稳定编号的片段，供两个 agent 搜索、读取和引用。
 *
 * 片段编号 = `<文档代号>#<章节号或压缩标题>`，例如 `article#2.3`、`skill#原则`。
 * rules.md 每条规则单独一个片段，编号就是规则编号，例如 `rules#P17`。
 * 回答里用 `[[S:article#2.3]]` 引用；citations.ts 负责校验。
 *
 * 命令行：`bun src/sources.ts` 列出全部片段编号（检查切片结果用）。
 */
import { existsSync, readFileSync } from "node:fs";
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
  /** 规则表：每一行规则（`| P17 | 动作 | IF | THEN | 来源 | 计算 |`）单独成片段，编号 `<代号>#P17`。 */
  ruleRows?: boolean;
}

export const SOURCE_DOCS: SourceDoc[] = [
  { code: "article", title: "学习文章：双均线分析", path: "chat/1118_what-I-want.md" },
  {
    code: "skill", title: "Skill：双均线分析流程", path: `${SKILL}/SKILL.md`,
    skip: ["拿数据", "回答格式", "网页报告", "工作台"],
  },
  { code: "concepts", title: "概念速查", path: `${SKILL}/references/concepts.md` },
  { code: "cases", title: "视频案例", path: `${SKILL}/references/cases.md` },
  { code: "playbook", title: "打法（类型 × 仓位）", path: `${SKILL}/references/playbooks.md` },
  { code: "rules", title: "规则", path: `${SKILL}/references/rules.md`, ruleRows: true },
  { code: "dropoff", title: "抵扣价学习笔记", path: "study-notes/261118-ma-drop-off-price.md" },
  { code: "ta01", title: "TA01 均线实战要点", path: "docs/moving-averages/TA01-MA-Practical-Essentials.md" },
  { code: "ta15", title: "TA15 用均线判断趋势与震荡", path: "docs/moving-averages/TA15-Trend-Summary-from-MA.md" },
  { code: "memo", title: "看片笔记：模糊正确、推演与系统精髓", path: "memo/模糊正确.md" },
];

/**
 * 公开仓库不含转载内容（学习文章、抵扣价笔记、TA 笔记、看片笔记）。
 * 这些文件不在时，报告和提示词里写死的引用改指 skill 自带的同主题片段。原文在时不生效。
 */
export const FALLBACK: Record<string, string> = {
  "article#1": "concepts#底层逻辑",
  "article#2.2": "concepts#两种均线",
  "article#2.3": "concepts#抵扣价",
  "article#2.7": "concepts#标志性动作与构造",
  "article#3.2": "concepts#趋势生命周期",
  "article#4": "concepts#五种趋势类型",
  "article#7.3": "playbook#仓位",
  "dropoff#定义与公式": "concepts#抵扣价",
  "dropoff#示例": "concepts#抵扣价",
};

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

const BODY_HITS_CAP = 3;
const HEADING = /^(#{1,3})\s+(.+?)\s*$/;
// "2.3 抵扣价" 或 "1. 双均线是干什么的"；不匹配 "2020 年的例子"
const SECTION_NO = /^(\d+\.\d+(?:\.\d+)*|\d+)\.?\s+(?=\D)/;
const DOTTED_OR_DOT = /^(\d+\.\d+(?:\.\d+)*\s|\d+\.\s)/;
const RULE_ROW = /^\| ([AJPX]\d+) \| (公理|判定|动作) \|/;
const RULE_HEAD = /^\| 编号 \||^\|---/;
const HEADING_PART_CHARS = 16;
const clip = (t: string) => (t.length > HEADING_PART_CHARS ? `${t.slice(0, HEADING_PART_CHARS)}…` : t);

/** 规则表的一行 → 片段。单元格里的 `\|` 是转义的竖线。 */
function ruleChunk(doc: SourceDoc, line: string, lineNo: number): Chunk {
  const [id, kind, cond, then, source, compute] = line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim().replaceAll("\\|", "|"));
  return {
    id: `${doc.code}#${id}`, doc: doc.code, docTitle: doc.title, heading: `${id}（${kind}）${clip(cond)} → ${clip(then)}`,
    path: doc.path, line: lineNo, body: `**IF** ${cond}\n\n**THEN** ${then}\n\n来源：${source}\n\n由哪个计算判断：${compute}`,
  };
}

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
    if (doc.ruleRows && RULE_ROW.test(lines[i])) {
      chunks.push(ruleChunk(doc, lines[i], i + 1));
      continue;
    }
    if (doc.ruleRows && RULE_HEAD.test(lines[i]) && (lines[i].startsWith("| 编号") || lines[i - 1]?.startsWith("| 编号"))) continue;
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

  /** 不存在的文档跳过（公开仓库里没有转载内容）。 */
  static load(root = PROJECT_ROOT, docs = SOURCE_DOCS): SourceLibrary {
    const present = docs.filter((d) => existsSync(resolve(root, d.path)));
    const chunks = present.flatMap((d) => chunkMarkdown(d, readFileSync(resolve(root, d.path), "utf8")));
    return new SourceLibrary(chunks);
  }

  /** 先找原文；原文缺失时按 FALLBACK 找替代片段。 */
  get(id: string): Chunk | undefined {
    return this.byId.get(id) ?? (FALLBACK[id] ? this.byId.get(FALLBACK[id]) : undefined);
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  /** 前端用的目录：真实片段 + 生效中的替代条目。 */
  index(): { id: string; doc: string; heading: string; aliasOf?: string }[] {
    const real = this.chunks.map((c) => ({ id: c.id, doc: c.docTitle, heading: c.heading }));
    const aliases = Object.entries(FALLBACK)
      .filter(([from, to]) => !this.byId.has(from) && this.byId.has(to))
      .map(([from, to]) => {
        const c = this.byId.get(to)!;
        return { id: from, doc: c.docTitle, heading: `${c.heading}（公开版替代）`, aliasOf: to };
      });
    return [...real, ...aliases];
  }

  /**
   * 关键词检索：英文按词、中文按二字组。先比命中了几个不同的词，再比分数（标题命中权重更高，
   * 每个词在正文里最多算 3 次）。只靠分数时，标题里有半个问题的片段会压过整个问题都答到的片段。
   */
  search(query: string, limit = 6): { chunk: Chunk; score: number }[] {
    const terms = queryTerms(query);
    if (!terms.length) return [];
    return this.chunks
      .map((chunk) => {
        const head = chunk.heading.toLowerCase();
        const body = chunk.body.toLowerCase();
        const hits = terms.map((t) => (head.includes(t) ? 3 : 0) + Math.min(countOf(body, t), BODY_HITS_CAP));
        return { chunk, score: hits.reduce((s, h) => s + h, 0), covered: hits.filter((h) => h > 0).length };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.covered - a.covered || b.score - a.score)
      .slice(0, limit)
      .map(({ chunk, score }) => ({ chunk, score }));
  }
}

/**
 * 「的」是词和词之间的连接，二字组跨过它就是噪声：「抵扣价的公式」里的「价的」「的公」
 * 会命中「EMA 的公式」这类无关句子，让命中词数虚高。所以中文先在「的」处断开再切二字组。
 */
export function queryTerms(query: string): string[] {
  const q = query.toLowerCase();
  const words = q.match(/[a-z0-9]+/g) ?? [];
  const cjk = (q.match(/[\p{Script=Han}]+/gu) ?? []).flatMap((run) => run.split("的")).filter(Boolean);
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

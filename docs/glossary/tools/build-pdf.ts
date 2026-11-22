/**
 * 把 docs/glossary/双均线概念图解.md 用 techdoc-pdf 技能（pandoc → XeLaTeX）排成打印版 PDF。
 * .md 本身保持干净（GitHub 上也能读）；排版用的东西在临时副本里加：
 *   - 每个部分（#）、每个术语（##）另起一页；
 *   - ### 以下的小节不进目录（techdoc.py 把 toc-depth 写死成 3），目录只列部分和术语；
 *   - 图片路径改成绝对路径。
 * 用法（仓库根目录）：bun docs/glossary/tools/build-pdf.ts
 * 依赖：pandoc、xelatex；~/.claude/skills/techdoc-pdf/techdoc.py。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const G = resolve(import.meta.dir, "..");
const SRC = join(G, "双均线概念图解.md");
const OUT = join(G, "双均线概念图解.pdf");
const TECHDOC = join(homedir(), ".claude/skills/techdoc-pdf/techdoc.py");
const DATE = new Date().toLocaleDateString("sv-SE");

const BREAK = "```{=latex}\n\\newpage\n```\n\n";
let md = readFileSync(SRC, "utf8")
  .replace(/^<!--.*?-->\n/s, "")
  .replace(/^[\s\S]*?(?=^# )/m, "") // 开头那段导语封面副标题已经说了，PDF 里从第一部分开始
  .replace(/^(#{3,4} .*)$/gm, "$1 {.unlisted .unnumbered}")
  .replace(/\]\(figures\//g, `](${join(G, "figures")}/`);
// 每个部分、每个术语另起一页；部分标题页只放标题，术语紧跟着另起一页会留大片空白，所以部分标题和它的第一个术语放同一页
md = md.replace(/\n(#{1,2} )/g, (m, h, off) => {
  const prev = md.slice(Math.max(0, off - 200), off);
  return /(^|\n)# [^\n]*\n\s*$/.test(prev) ? m : `\n${BREAK}${h}`;
});
// 图和紧跟的图注包进一个 minipage，不让图注一个人掉到下一页顶上
md = md.replace(/^(!\[\]\([^)]+\))\n\n(图 \d+　[^\n]*)$/gm,
  "```{=latex}\n\\par\\noindent\\begin{minipage}{\\linewidth}\n```\n\n$1\n\n$2\n\n```{=latex}\n\\end{minipage}\\par\\medskip\n```");
// 中西文交界的自动间距（xCJKecglue）会在「（P25）」「0.74，」里多出空格；源文本该有的空格已经写了，这里关掉。
// techdoc 说关它会和代码高亮冲突，这份文档没有代码块。
md = "```{=latex}\n\\xeCJKsetup{CJKecglue={\\hskip 0pt}}\n```\n\n" + md;
// 第一部分也另起一页，别挂在目录页底下
md = BREAK + md;
const dir = mkdtempSync(join(tmpdir(), "glossary-pdf-"));
const tmp = join(dir, "glossary.md");
writeFileSync(tmp, md);
const r = spawnSync("python3", [TECHDOC, OUT, tmp, "--title", "双均线概念图解", "--subtitle", "归雁工作台 · 16 个术语的示意图、判断方法和出处",
  "--meta", `${DATE} 版 · 图都是示意，不是真实行情`, "--toc", "--paper", "letter"], { encoding: "utf8" });
process.stdout.write(r.stdout); process.stderr.write(r.stderr);
rmSync(dir, { recursive: true, force: true });
if (r.status !== 0) throw new Error("techdoc.py 失败");

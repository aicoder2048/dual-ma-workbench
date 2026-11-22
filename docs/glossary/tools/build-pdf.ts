/**
 * 概念图解的打印版：用 techdoc-pdf 技能（pandoc → XeLaTeX）排版。
 * 1. 浏览器打开每一页，把每张示意图（inline SVG）的样式算好、内联，单独存成矢量 PDF；
 * 2. 按页面结构把文字转成 markdown（对照卡 → 小标题 + 一段，表格 → 管道表，图 → 图片）；
 * 3. 交给 ~/.claude/skills/techdoc-pdf/techdoc.py 排成 US Letter，带封面和目录。
 * 用法（仓库根目录）：bun docs/glossary/tools/build-pdf.ts
 * 依赖：app/node_modules 里的 playwright（本机 Chrome）；pandoc、xelatex；techdoc-pdf 技能。
 */
import { chromium } from "../../../app/node_modules/playwright/index.mjs";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const G = resolve(import.meta.dir, "..");
const OUT = join(G, "双均线概念图解.pdf");
const TMP = join(G, "tools", ".build");
const TECHDOC = join(homedir(), ".claude/skills/techdoc-pdf/techdoc.py");
const DATE = new Date().toLocaleDateString("sv-SE");

const index = readFileSync(join(G, "index.html"), "utf8");
const groups = [...index.matchAll(/<section><h2>(.*?)<\/h2><ul>([\s\S]*?)<\/ul><\/section>/g)].map(([, name, ul]) => ({
  name,
  items: [...ul.matchAll(/<a href="([\w-]+)\.html">(.*?)<span>(.*?)<\/span><\/a>/g)].map(([, slug, title, desc]) => ({ slug, title, desc })),
}));

rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, "fig"), { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
await page.emulateMedia({ colorScheme: "light" });
const figPage = await browser.newPage();

const mdFiles: string[] = [];
let chapter = 0;
for (const g of groups) for (const it of g.items) {
  await page.goto(`file://${join(G, it.slug + ".html")}`);
  await page.evaluate(() => document.fonts.ready);
  // 页面里：每张图内联算好的样式后序列化；文字按结构转 markdown，图的位置留 ⟦FIG n⟧
  const { md, svgs } = await page.evaluate(() => {
    const PROPS = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "stroke-opacity", "stroke-linecap",
      "stroke-linejoin", "opacity", "font-family", "font-size", "font-weight", "text-anchor", "dominant-baseline", "letter-spacing"];
    const svgs: { svg: string; w: number; h: number }[] = [];
    const exportSvg = (svg: SVGSVGElement) => {
      const r = svg.getBoundingClientRect();
      const clone = svg.cloneNode(true) as SVGSVGElement;
      const src = [svg, ...svg.querySelectorAll("*")], dst = [clone, ...clone.querySelectorAll("*")];
      src.forEach((el, i) => {
        const cs = getComputedStyle(el), d = dst[i] as SVGElement;
        d.setAttribute("style", PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";"));
        d.removeAttribute("class");
      });
      clone.setAttribute("width", String(Math.round(r.width)));
      clone.setAttribute("height", String(Math.round(r.height)));
      clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      svgs.push({ svg: clone.outerHTML, w: Math.round(r.width), h: Math.round(r.height) });
      return `\n\n⟦FIG ${svgs.length - 1}⟧\n\n`;
    };
    const esc = (t: string) => t.replace(/\\/g, "\\\\").replace(/([*_`#|<>\[\]])/g, "\\$1").replace(/\$/g, "\\$");
    const inline = (n: Node): string => {
      if (n.nodeType === 3) return esc((n.textContent ?? "").replace(/\s+/g, " "));
      if (!(n instanceof Element)) return "";
      const kids = () => [...n.childNodes].map(inline).join("");
      const tag = n.tagName.toLowerCase();
      if (tag === "svg") return "";
      if (tag === "br") return " ";
      if (n.classList.contains("tag")) return `**${n.textContent!.trim()}**`;
      if (n.classList.contains("verdict")) return `（${n.textContent!.trim()}）`;
      if (n.classList.contains("n") || n.classList.contains("badge")) return `${"①②③④⑤⑥⑦⑧⑨"[Number(n.textContent) - 1] ?? n.textContent} `;
      if (tag === "b" || tag === "strong") { const t = kids().trim(); return t ? `**${t}**` : ""; }
      if (tag === "code") return `\`${n.textContent}\``;
      return kids();
    };
    const table = (t: HTMLTableElement) => {
      const rows = [...t.rows].map((r) => [...r.cells].map((c) => inline(c).trim().replace(/\|/g, "\\|") || " "));
      if (!rows.length) return "";
      const head = t.tHead?.rows.length ? rows.shift()! : rows[0].map(() => " ");
      const n = Math.max(head.length, ...rows.map((r) => r.length));
      const line = (r: string[]) => `| ${[...r, ...Array(n - r.length).fill(" ")].join(" | ")} |`;
      return `\n\n${line(head)}\n|${Array(n).fill("---").join("|")}|\n${rows.map(line).join("\n")}\n\n`;
    };
    const block = (n: Element): string => {
      const tag = n.tagName.toLowerCase();
      if (n.matches("nav.crumb, script, style")) return "";
      if (tag === "svg") return exportSvg(n as SVGSVGElement);
      if (tag === "h1") return `# ${inline(n).trim()}\n\n`;
      if (tag === "h2") return `\n## ${inline(n).trim()}\n\n`;
      if (tag === "h3") return `\n### ${inline(n).trim()}\n\n`;
      if (tag === "table") return table(n as HTMLTableElement);
      if (tag === "ul" || tag === "ol") return "\n" + [...n.children].map((li, i) => `${tag === "ol" ? `${i + 1}.` : "-"} ${[...li.childNodes].map((c) => c instanceof Element && /^(ul|ol|table|svg)$/i.test(c.tagName) ? "" : inline(c)).join("").trim()}`).join("\n") + "\n\n";
      if (n.classList.contains("legend")) return `图例：${[...n.children].map((c) => inline(c).trim()).filter(Boolean).join("；")}\n\n`;
      if (tag === "footer") return `\n---\n\n${[...n.children].map((c) => inline(c).trim()).join("\n\n")}\n\n`;
      const hasBlock = [...n.children].some((c) => /^(div|section|article|header|figure|p|h[1-6]|ul|ol|table|svg|footer|nav)$/i.test(c.tagName));
      if (!hasBlock) { const t = inline(n).trim(); return t ? `${t}\n\n` : ""; }
      // 混排：文字节点和块各自处理
      let out = "", buf = "";
      for (const c of n.childNodes) {
        if (c instanceof Element && /^(div|section|article|header|figure|p|h[1-6]|ul|ol|table|svg|footer|nav)$/i.test(c.tagName)) {
          if (buf.trim()) out += `${buf.trim()}\n\n`; buf = ""; out += block(c);
        } else buf += inline(c);
      }
      if (buf.trim()) out += `${buf.trim()}\n\n`;
      // 图在左、标题在右的面板：标题提到图前面
      return out.replace(/^(\s*⟦FIG \d+⟧\s*)(\n#{2,3} [^\n]+\n)/, "$2$1");
    };
    return { md: block(document.querySelector(".wrap")!), svgs };
  });
  // 每张图存成矢量 PDF：空白页里只放这张 SVG，纸张尺寸等于图的尺寸
  const ch = String(++chapter).padStart(2, "0");
  let text = md;
  for (const [i, f] of svgs.entries()) {
    const file = join(TMP, "fig", `${ch}-${it.slug}-${i}.pdf`);
    await figPage.setContent(`<!doctype html><html><head><style>@page{margin:0}html,body{margin:0}svg{display:block}</style></head><body>${f.svg}</body></html>`);
    await figPage.pdf({ path: file, width: `${f.w}px`, height: `${f.h + 1}px`, printBackground: true, pageRanges: "1" });
    text = text.replace(`⟦FIG ${i}⟧`, `![](${file})`);
  }
  // ▾ 是工作台菜单上的小三角，PingFang 没有这个字形，xelatex 会丢字
  text = text.replace(/\s*▾/g, "").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  // 目录只列 16 个术语：二、三级标题标 unlisted（techdoc.py 把 toc-depth 写死成 3）
  text = text.replace(/^(#{2,3} .*)$/gm, "$1 {.unlisted .unnumbered}");
  // 第一章和目录之间分页（techdoc.py 只在章与章之间插分页）
  if (chapter === 1) text = "```{=latex}\n\\newpage\n```\n\n" + text;
  // 章首写分组名，方便翻到哪一类
  text = text.replace(/^# (.*)\n/, (_, t) => `# ${t}\n\n*${g.name}*\n`);
  const mdFile = join(TMP, `${ch}-${it.slug}.md`);
  writeFileSync(mdFile, text);
  mdFiles.push(mdFile);
}
await browser.close();

const r = spawnSync("python3", [TECHDOC, OUT, ...mdFiles, "--title", "双均线概念图解", "--subtitle", "归雁工作台 · 16 个术语的示意图、对照和出处",
  "--meta", `${DATE} 版 · 图都是示意，不是真实行情`, "--toc", "--paper", "letter"], { encoding: "utf8", cwd: TMP });
process.stdout.write(r.stdout); process.stderr.write(r.stderr);
if (r.status !== 0) throw new Error("techdoc.py 失败");
if (!process.env.KEEP_BUILD) rmSync(TMP, { recursive: true, force: true });

/**
 * 概念图解的打印版：每页单独渲染成 PDF（各页自带的 <style> 互不干扰），再加封面、目录，合并后盖页码。
 * 用法（仓库根目录）：bun docs/glossary/tools/build-pdf.ts
 * 依赖：app/node_modules 里的 playwright（本机 Chrome），uv（合并和页码用 pypdf + reportlab）。
 */
import { chromium } from "../../../app/node_modules/playwright/index.mjs";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const G = resolve(import.meta.dir, "..");
const OUT = join(G, "双均线概念图解.pdf");
const TMP = join(G, "tools", ".build");
const DATE = new Date().toLocaleDateString("sv-SE"); // 本地日期 YYYY-MM-DD

// 目录顺序和分组照 index.html：读它的 <section><h2>分组</h2> 和每项的 href、标题、一句话
const index = readFileSync(join(G, "index.html"), "utf8");
const groups = [...index.matchAll(/<section><h2>(.*?)<\/h2><ul>([\s\S]*?)<\/ul><\/section>/g)].map(([, name, ul]) => ({
  name,
  items: [...ul.matchAll(/<a href="([\w-]+)\.html">(.*?)<span>(.*?)<\/span><\/a>/g)].map(([, slug, title, desc]) => ({ slug, title, desc })),
}));
const lede = index.match(/<p class="lede">(.*?)<\/p>/)![1];

const PRINT_CSS = `
:root { --bg: #ffffff; }
html, body { background: #fff !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-size: 13px; }
.wrap { max-width: none !important; padding: 0 !important; gap: 14px !important; }
.crumb { display: none !important; }
h1 { font-size: 26px; }
.chart, .tbl-wrap, .tblwrap, [class*="wrap"] { overflow: visible !important; }
.chart svg { min-width: 0 !important; }
.panel, .case, figure, table, .src, svg, .mirror { break-inside: avoid; }
h2, h3 { break-after: avoid; }
a { color: inherit !important; text-decoration: none !important; }
`;
const PDF = { format: "Letter" as const, printBackground: true, scale: 0.88, margin: { top: "0.75in", bottom: "0.7in", left: "0.6in", right: "0.6in" } };
const header = (t: string) => `<div style="width:100%;font:8px 'PingFang SC',sans-serif;color:#7a8494;padding:0 0.6in;display:flex;justify-content:space-between">
  <span>双均线概念图解</span><span>${t}</span></div>`;
const blank = `<div></div>`;

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
await page.emulateMedia({ colorScheme: "light", media: "print" });
const pages = (buf: Uint8Array) => (Buffer.from(buf).toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;

// 1) 各概念页
const parts: { file: string; title: string; slug: string; n: number }[] = [];
let i = 0;
for (const g of groups) for (const it of g.items) {
  await page.goto(`file://${join(G, it.slug + ".html")}`);
  await page.addStyleTag({ content: PRINT_CSS });
  await page.evaluate(() => document.fonts.ready);
  const file = join(TMP, `${String(++i).padStart(2, "0")}-${it.slug}.pdf`);
  const buf = await page.pdf({ ...PDF, path: file, displayHeaderFooter: true, headerTemplate: header(`${g.name} · ${it.title}`), footerTemplate: blank });
  parts.push({ file, title: it.title, slug: it.slug, n: pages(buf) });
}

// 2) 封面和目录（目录写页码：封面 1 页、目录 1 页之后接正文）
const css = readFileSync(join(G, "glossary.css"), "utf8");
const shell = (body: string) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>${css}${PRINT_CSS}
.cover { height: 9.2in; display: grid; align-content: space-between; }
.cover .band { border-top: 6px solid var(--ma); padding-top: 28px; display: grid; gap: 14px; }
.cover h1 { font-size: 44px; letter-spacing: .02em; margin: 0; }
.cover .sub { font-size: 17px; color: var(--muted); margin: 0; }
.cover .lede { font-size: 14px; max-width: 34em; }
.cover .groups { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px 24px; font-size: 13px; }
.cover .groups b { display: block; color: var(--ink); margin-bottom: 2px; }
.cover .groups span { color: var(--muted); }
.cover .foot { font-size: 12px; color: var(--muted); border-top: 1px solid var(--line); padding-top: 10px; }
.toc2 h1 { margin: 0 0 18px; }
.toc2 section { break-inside: avoid; margin-bottom: 14px; }
.toc2 h2 { font-size: 12px; color: var(--muted); letter-spacing: .08em; margin: 0 0 6px; }
.toc2 .row { display: flex; align-items: baseline; gap: 8px; font-size: 14px; padding: 5px 0; }
.toc2 .row .t { font-weight: 600; } .toc2 .row .d { color: var(--muted); font-size: 12px; }
.toc2 .row .dots { flex: 1; border-bottom: 1px dotted var(--line); transform: translateY(-3px); }
.toc2 .row .p { font-family: var(--mono); font-variant-numeric: tabular-nums; }
</style></head><body><div class="wrap">${body}</div></body></html>`;

let p = 3;
const pageOf = new Map(parts.map((x) => { const at = p; p += x.n; return [x.slug, at]; }));
const tocHtml = shell(`<div class="toc2"><h1>目录</h1>${groups.map((g) => `<section><h2>${g.name}</h2>${g.items.map((it) =>
  `<div class="row"><span class="t">${it.title}</span><span class="d">${it.desc}</span><span class="dots"></span><span class="p">${pageOf.get(it.slug)}</span></div>`).join("")}</section>`).join("")}</div>`);
const coverHtml = shell(`<div class="cover"><div class="band"><p class="sub">归雁 · 双均线工作台</p><h1>双均线概念图解</h1>
  <p class="lede">${lede}</p></div>
  <div class="groups">${groups.map((g) => `<div><b>${g.name}</b><span>${g.items.map((it) => it.title).join("、")}</span></div>`).join("")}</div>
  <div class="foot">${DATE} 版 · 概念和规则照 references/concepts.md、rules.md；引用的原话都和字幕核对过。图都是示意，不是真实行情。</div></div>`);
for (const [name, html] of [["00-cover", coverHtml], ["00-toc", tocHtml]] as const) {
  await page.setContent(html, { waitUntil: "load" });
  await page.pdf({ ...PDF, path: join(TMP, `${name}.pdf`), displayHeaderFooter: name === "00-toc", headerTemplate: header("目录"), footerTemplate: blank });
}
await browser.close();

// 3) 合并、盖页码（封面不盖）
const files = [join(TMP, "00-cover.pdf"), join(TMP, "00-toc.pdf"), ...parts.map((x) => x.file)];
const py = `
import sys, io
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas
out, files = sys.argv[1], sys.argv[2:]
w = PdfWriter()
for f in files:
    for pg in PdfReader(f).pages: w.add_page(pg)
for i, pg in enumerate(w.pages):
    if i == 0: continue
    W, H = float(pg.mediabox.width), float(pg.mediabox.height)
    buf = io.BytesIO(); c = canvas.Canvas(buf, pagesize=(W, H))
    c.setFont("Helvetica", 8); c.setFillGray(0.45); c.drawCentredString(W / 2, 0.4 * 72, str(i + 1)); c.save()
    pg.merge_page(PdfReader(io.BytesIO(buf.getvalue())).pages[0])
w.add_metadata({"/Title": "双均线概念图解", "/Subject": "归雁工作台术语图解"})
with open(out, "wb") as fh: w.write(fh)
print(len(w.pages))
`;
const r = spawnSync("uv", ["run", "--with", "pypdf", "--with", "reportlab", "python", "-c", py, OUT, ...files], { encoding: "utf8" });
if (r.status !== 0) throw new Error(r.stderr);
rmSync(TMP, { recursive: true, force: true });
console.log(`${OUT}：${r.stdout.trim()} 页`);

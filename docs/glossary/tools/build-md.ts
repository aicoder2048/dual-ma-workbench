/**
 * 从 17 个概念图解页生成一份结构统一的 markdown：docs/glossary/双均线概念图解.md，图存成矢量 PDF 放 figures/。
 * 每个术语同一个模板：一句话定义（引用块）→ 主图和图注 → 怎么判断（对照卡变成一张表）→ 其余说明 → 出处。
 * 用法（仓库根目录）：bun docs/glossary/tools/build-md.ts
 * 注意：会覆盖 双均线概念图解.md。改了 .md 又想保留手改，就别再跑这一步，直接 build-pdf。
 */
import { chromium } from "../../../app/node_modules/playwright/index.mjs";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const G = resolve(import.meta.dir, "..");
const MD = join(G, "双均线概念图解.md");
const FIG = join(G, "figures");

const index = readFileSync(join(G, "index.html"), "utf8");
const groups = [...index.matchAll(/<section><h2>(.*?)<\/h2><ul>([\s\S]*?)<\/ul><\/section>/g)].map(([, name, ul]) => ({
  name,
  items: [...ul.matchAll(/<a href="([\w-]+)\.html">(.*?)<span>(.*?)<\/span><\/a>/g)].map(([, slug, title]) => ({ slug, title })),
}));

type Fig = { svg: string; w: number; h: number };
type Page = { title: string; lede: string; blocks: string[]; figs: Fig[] };

rmSync(FIG, { recursive: true, force: true });
mkdirSync(FIG, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
await page.emulateMedia({ colorScheme: "light" });
const figPage = await browser.newPage();

const out: string[] = [
  "<!-- 由 tools/build-md.ts 从 docs/glossary/*.html 生成；排版成 PDF：bun docs/glossary/tools/build-pdf.ts -->",
  "",
  "工作台上的双均线术语，每个一节：一句话定义、示意图、怎么判断、要点和出处。按读图的顺序排，从均线本身读起。图都是示意，不是真实行情。",
  "",
];
let figNo = 0, part = 0;
const PART = ["一", "二", "三", "四", "五", "六"];
for (const g of groups) {
  out.push(`# 第${PART[part++]}部分　${g.name}`, "");
  for (const it of g.items) {
    await page.goto(`file://${join(G, it.slug + ".html")}`);
    await page.evaluate(() => document.fonts.ready);
    const p: Page = await page.evaluate(() => {
      const PROPS = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "stroke-opacity", "stroke-linecap",
        "stroke-linejoin", "opacity", "font-family", "font-size", "font-weight", "text-anchor", "dominant-baseline", "letter-spacing"];
      const figs: { svg: string; w: number; h: number }[] = [];
      const fig = (svg: SVGSVGElement) => {
        const r = svg.getBoundingClientRect(), clone = svg.cloneNode(true) as SVGSVGElement;
        const src = [svg, ...svg.querySelectorAll("*")], dst = [clone, ...clone.querySelectorAll("*")];
        src.forEach((el, i) => {
          const cs = getComputedStyle(el), d = dst[i] as SVGElement;
          d.setAttribute("style", PROPS.map((k) => `${k}:${cs.getPropertyValue(k)}`).join(";"));
          d.removeAttribute("class");
        });
        clone.setAttribute("width", String(Math.round(r.width)));
        clone.setAttribute("height", String(Math.round(r.height)));
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        figs.push({ svg: clone.outerHTML, w: Math.round(r.width), h: Math.round(r.height) });
        return figs.length - 1;
      };
      const esc = (t: string) => t.replace(/\\/g, "\\\\").replace(/([*_`#|<>\[\]$])/g, "\\$1");
      const NUM = "①②③④⑤⑥⑦⑧⑨";
      const inline = (n: Node, skip: (e: Element) => boolean = () => false): string => {
        if (n.nodeType === 3) return esc((n.textContent ?? "").replace(/\s+/g, " "));
        if (!(n instanceof Element) || skip(n)) return "";
        const kids = () => [...n.childNodes].map((c) => inline(c, skip)).join("");
        const tag = n.tagName.toLowerCase();
        if (tag === "svg") return "";
        if (tag === "br") return " ";
        if (n.classList.contains("tag")) return `**${n.textContent!.trim()}**`;
        if (n.classList.contains("n") || n.classList.contains("badge")) return `${NUM[Number(n.textContent) - 1] ?? n.textContent} `;
        if (tag === "b" || tag === "strong") { const t = kids().trim(); return t ? `**${t}**` : ""; }
        if (tag === "code") return `\`${n.textContent}\``;
        if (tag === "small") return `（${kids().trim()}）`;
        return kids();
      };
      const text = (n: Element) => inline(n).replace(/\s+/g, " ").trim();
      // 列宽：每列取最长内容的显示宽度（汉字算 2），按比例分 72 个短横，至少 6 个
      const width = (t: string) => [...t.replace(/\*\*|\\/g, "")].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
      const sep = (rows: string[][], n: number) => {
        const w = Array.from({ length: n }, (_, i) => Math.max(4, ...rows.map((r) => Math.min(width(r[i] ?? ""), 120))));
        const total = w.reduce((a, b) => a + b, 0);
        return `|${w.map((x) => "-".repeat(Math.max(9, Math.round((x / total) * 72)))).join("|")}|`;
      };
      const table = (t: HTMLTableElement) => {
        // 合并单元格（rowspan）在下面几行写「同上」
        const carry: { left: number; col: number }[] = [];
        const rows = [...t.rows].map((r) => {
          const cells: string[] = [];
          let col = 0;
          for (const c of r.cells) {
            while (carry.some((k) => k.col === col && k.left > 0)) { cells.push("同上"); carry.find((k) => k.col === col)!.left--; col++; }
            cells.push(text(c).replace(/\|/g, "\\|") || " ");
            if (c.rowSpan > 1) carry.push({ col, left: c.rowSpan - 1 });
            col++;
          }
          while (carry.some((k) => k.col === col && k.left > 0)) { cells.push("同上"); carry.find((k) => k.col === col)!.left--; col++; }
          return cells;
        });
        const head = t.tHead?.rows.length ? rows.shift()! : rows[0].map(() => " ");
        const n = Math.max(head.length, ...rows.map((r) => r.length));
        const line = (r: string[]) => `| ${[...r, ...Array(n - r.length).fill(" ")].join(" | ")} |`;
        return [line(head), sep([head, ...rows], n), ...rows.map(line)].join("\n");
      };
      const BLOCK = /^(div|section|article|header|figure|p|h[1-6]|ul|ol|table|svg|footer|nav)$/i;
      // 一个容器里的内容按顺序转 markdown；h2/h3 降成 ###/####（术语本身是 ##）
      const flow = (n: Element): string[] => {
        const res: string[] = [];
        let buf = "";
        const flush = () => { if (buf.trim()) res.push(buf.replace(/\s+/g, " ").trim()); buf = ""; };
        for (const c of n.childNodes) {
          if (!(c instanceof Element) || !BLOCK.test(c.tagName)) { buf += inline(c); continue; }
          flush();
          const tag = c.tagName.toLowerCase();
          if (tag === "svg") res.push(`⟦FIG ${fig(c as SVGSVGElement)}⟧`);
          else if (tag === "h2" || tag === "h3") res.push(`${tag === "h2" ? "###" : "####"} ${text(c)}`);
          else if (tag === "table") res.push(table(c as HTMLTableElement));
          else if (tag === "ul" || tag === "ol") res.push([...c.children].map((li, i) => `${tag === "ol" ? `${i + 1}.` : "-"} ${text(li)}`).join("\n"));
          else if (c.classList.contains("legend")) res.push(`LEGEND:${[...c.children].map(text).filter(Boolean).join("；")}`);
          else if ([...c.children].some((k) => BLOCK.test(k.tagName))) res.push(...flow(c));
          else { const t = text(c); if (t) res.push(t); }
        }
        flush();
        return res;
      };
      const wrap = document.querySelector(".wrap")!;
      const title = text(wrap.querySelector("h1")!);
      const lede = text(wrap.querySelector(".lede")!);
      const blocks: string[] = [];
      let judged = false, extra = false;
      for (const c of wrap.children) {
        if (c.matches("nav.crumb") || c.querySelector("h1")) continue;
        if (c.matches(".cases")) {
          // 对照卡 → 一张表：情况 | 判定 | 说明
          const rows = [...c.querySelectorAll(".case")].map((k) => {
            const h = k.querySelector("h3")!;
            const name = inline(h, (e) => e.classList.contains("verdict")).replace(/\s+/g, " ").trim();
            const verdict = h.querySelector(".verdict")?.textContent?.trim() ?? "";
            const body = [...k.children].filter((e) => e !== h).map(text).join(" ");
            return [name, verdict, body.replace(/\|/g, "\\|")];
          });
          const head = ["情况", "判定", "说明"];
          blocks.push("### 怎么判断", [`| ${head.join(" | ")} |`, sep([head, ...rows], 3), ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n"));
          judged = true;
          continue;
        }
        if (c.matches("footer")) {
          blocks.push("### 出处", [...c.children].map((d) => `- ${text(d)}`).join("\n"));
          continue;
        }
        // 插图面板开了新话题时，用 data-section 给合订本补一个小节标题（网页上面板自己的 h2 就是标题）
        const sec = (c as HTMLElement).dataset?.section;
        if (sec) blocks.push(`### ${sec}`);
        const parts = flow(c);
        // 只有标题 + 图 + 图例的面板是插图：标题当图注；别的内容照常排，标题当小节
        const figOnly = parts.every((x) => /^(###|⟦FIG|LEGEND:)/.test(x)) && parts.some((x) => x.startsWith("⟦FIG"));
        if (figOnly) {
          const cap = (parts.find((x) => x.startsWith("###")) ?? "").replace(/^#+ /, "");
          const legend = (parts.find((x) => x.startsWith("LEGEND:")) ?? "").slice(7);
          for (const f of parts.filter((x) => x.startsWith("⟦FIG"))) blocks.push(`${f}CAP:${cap}${legend ? `。图例：${legend}` : ""}`);
          continue;
        }
        if (judged && !extra && parts.length && !parts[0].startsWith("###")) { blocks.push("### 补充说明"); extra = true; }
        for (const x of parts) blocks.push(x.startsWith("LEGEND:") ? `*图例：${x.slice(7)}*` : x);
      }
      return { title, lede, blocks, figs };
    });
    out.push(`## ${p.title}`, "", `> ${p.lede}`, "");
    let local = 0;
    for (const b of p.blocks) {
      const m = b.match(/^⟦FIG (\d+)⟧(?:CAP:(.*))?$/s);
      if (!m) { out.push(b.replace(/^### 补充说明$/, "### 要点"), ""); continue; }
      const f = p.figs[Number(m[1])];
      const name = `${String(++figNo).padStart(2, "0")}-${it.slug}${local++ ? `-${local}` : ""}.pdf`;
      await figPage.setContent(`<!doctype html><html><head><style>@page{margin:0}html,body{margin:0}svg{display:block}</style></head><body>${f.svg}</body></html>`);
      await figPage.pdf({ path: join(FIG, name), width: `${f.w}px`, height: `${f.h + 1}px`, printBackground: true, pageRanges: "1" });
      out.push(`![](figures/${name})`, "");
      if (m[2]) out.push(`图 ${figNo}　${m[2]}`, "");
    }
  }
}
await browser.close();
// ▾ 是工作台菜单上的小三角，PingFang 没有这个字形
writeFileSync(MD, out.join("\n").replace(/\s*▾/g, "").replace(/\n{3,}/g, "\n\n"));
console.log(`${MD}：${figNo} 张图`);

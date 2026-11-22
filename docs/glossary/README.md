# 双均线概念图解

工作台上每个术语一页：一张示意图、算和不算的对照、规则编号和视频出处。从 `index.html` 开始看（用浏览器打开本地文件，GitHub 上不渲染 HTML）。

- 公用样式在 `glossary.css`，每页是独立的 HTML，不依赖脚本和外部资源。
- 内容照 `.agents/skills/dual-moving-averages/references/concepts.md` 和 `rules.md` 写；规则改了，对应的页要跟着改。
- 引用的原话写成 `视频 X mm:ss「原文」`，改完跑一遍核对：

  ```bash
  uv run python .agents/skills/dma-video-ingest/scripts/check_doc_quotes.py docs/glossary/*.html
  ```

- 图都是示意，不是真实行情；坐标按同一个价格刻度算。

## 合订本和打印版 PDF

```bash
bun docs/glossary/tools/build-md.ts    # 从各页生成 双均线概念图解.md，图存成矢量 PDF 放 figures/（会覆盖 .md）
bun docs/glossary/tools/build-pdf.ts   # 用 techdoc-pdf 技能把 .md 排成 双均线概念图解.pdf（US Letter）
```

- `双均线概念图解.md` 是合订本：每个术语同一个模板（一句话定义 → 图和图注 → 怎么判断 → 要点 → 出处），可以直接手改；手改过就别再跑 build-md，只跑 build-pdf。
- 排版用的东西（每个术语分页、目录只列部分和术语、关掉中西文自动间距）只加在临时副本里，`.md` 在 GitHub 上照样能读（图是 PDF，GitHub 不显示）。
- PDF 不进仓库。

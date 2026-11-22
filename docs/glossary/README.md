# 双均线概念图解

工作台上每个术语一页：一张示意图、算和不算的对照、规则编号和视频出处。从 `index.html` 开始看（用浏览器打开本地文件，GitHub 上不渲染 HTML）。

- 公用样式在 `glossary.css`，每页是独立的 HTML，不依赖脚本和外部资源。
- 内容照 `.agents/skills/dual-moving-averages/references/concepts.md` 和 `rules.md` 写；规则改了，对应的页要跟着改。
- 引用的原话写成 `视频 X mm:ss「原文」`，改完跑一遍核对：

  ```bash
  uv run python .agents/skills/dma-video-ingest/scripts/check_doc_quotes.py docs/glossary/*.html
  ```

- 图都是示意，不是真实行情；坐标按同一个价格刻度算。

## 打印版 PDF

```bash
bun docs/glossary/tools/build-pdf.ts   # 生成 docs/glossary/双均线概念图解.pdf（US Letter，封面、目录、每个术语一章）
```

用 techdoc-pdf 技能排版（pandoc → XeLaTeX）：脚本在浏览器里把每张示意图连同算好的样式存成矢量 PDF，按页面结构把文字转成 markdown（对照卡 → 小标题，表格 → 管道表），再交给 `~/.claude/skills/techdoc-pdf/techdoc.py`。目录只列 16 个术语。PDF 不进仓库；`KEEP_BUILD=1` 保留中间的 markdown 和图。

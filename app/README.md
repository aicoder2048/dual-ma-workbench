# 归雁 · 双均线工作台

dual-moving-averages skill 的网页版：左「自选股」、中「分析师」、右「鸿雁」。

```bash
cd app && bun install     # 第一次
bun start                 # 打开 http://127.0.0.1:5178
bun test                  # 单元测试（不调模型）
```

- **设置**（右上角齿轮，存在 `data/settings.json`）：
  - 大模型：默认 `openai-codex/gpt-6.1-sol`（Codex 订阅，需先在 `pi` 里登录）；可选 `deepseek/deepseek-flash`（**按量计费**，key 读项目根目录 `.env` 的 `DEEPSEEK_API_KEY`）。只允许这两个，`anthropic/*` 一律拒绝。切换后下一次提问生效，对话上下文保留，不改 Pi 的全局默认模型。
  - 市场数据：默认 Polygon/Massive（失败或超出约 5 年时回退 yfinance）；可选 yfinance。
  - `DMA_THINKING` 环境变量调思考强度。
- **数据**：调 skill 脚本 `dma_analyze.py --json`（Polygon，失败回退 yfinance），key 在项目根目录 `.env`。
- **引用**：`[[S:编号]]` 指原文片段（`bun run sources` 列出全部编号），`[[D:字段]]` 指当前分析数据。每轮回答结束后服务端逐条核对，找不到出处的显示红色。
- **自选股**：存在 `data/watchlist.json`。

## 结构

```
浏览器 ──HTTP/WebSocket── src/server.ts（Bun）
                           ├─ src/workbench.ts   两个 agent + 动态问法 + 当前视图
                           │   ├─ agents/host.ts     Pi 会话 → 浏览器事件，引用校验
                           │   ├─ agents/tools.ts    dma_analyze / search_sources / read_source / suggest_questions
                           │   ├─ agents/prompts.ts  分析师（方法论取自 SKILL.md）、鸿雁
                           │   └─ agents/suggest.ts  规则版问法 + 轻量 Pi 会话生成 AI 版
                           ├─ src/http.ts       页面、分析、自选股、原文片段
                           ├─ src/sources.ts    引用库（切片、检索）
                           ├─ src/citations.ts  引用解析、数据字段、校验
                           └─ src/analyze.ts    调 Python 脚本，带缓存
public/  app.js 页面状态 · agents.js 两个面板 · chart.js 图表 · cite.js 引用渲染 · selection.js 划选问鸿雁
```

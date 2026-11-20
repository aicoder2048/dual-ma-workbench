# 归雁 · 双均线工作台

dual-moving-averages skill 的网页版：左「自选股」、中「长风」、右「鸿雁」。中栏的分析 agent 叫「长风」，取李白"长风破浪会有时"，顺势而行，和归雁、鸿雁成一组。

```bash
cd app && bun install     # 第一次
bun start                 # 打开 http://127.0.0.1:5178
bun test                  # 单元测试（不调模型）
bun run e2e               # 端到端测试：真 Chrome（本机安装的），假行情、假语音
python3 e2e/ctrl_c.py     # 在真终端里按 Ctrl+C：退出码 0、没有报错、终端模式恢复
python3 e2e/watch.py      # 改服务端代码自动重启（--watch），之后 Ctrl+C 照样干净退出
bun scripts/replay.ts     # 回放验证：近 2 年每 20 个交易日一个点，对照之后 20 天走势，报告写到 reports/replay/
```

- **回放验证**（`scripts/replay.ts`，评估逻辑在 `src/replay.ts`）：默认 NVDA TSLA AAPL GOOG META MSFT AMZN SPY QQQ，可传代码和 `--years --step --horizon --jobs --refresh`。每只票取一次 yfinance 日线（只取到昨天）存 `reports/replay/data/`；缓存覆盖不到所需历史、超过 7 天没更新、或给了 `--refresh` 就重新取。每个点只用当天往前 3 年，和工作台一致，不够 3 年直接报错。看四件事：模糊判断各档之后涨跌、看方向的 MA20 推演对不对、空仓计划（"不买"类）之后涨跌、"站上 EMA20 + MA20 抵扣价"进场条件触发后表现。

- **设置**（右上角齿轮，存在 `data/settings.json`）：
  - 大模型：从 pi 动态读（`src/agents/catalog.ts`），列出在 pi 里登录过的 provider 的全部模型；计费：Pi 标明是订阅的 OAuth 算订阅，api_key 算按量计费，anthropic 一律按量，其他未知；不是订阅的切换前要确认。默认 `openai-codex/gpt-6.1-sol`；没选过时用 pi 的默认模型（是订阅才用）。切换后下一次提问生效，对话上下文保留，不改 Pi 的全局默认模型。
  - 思考程度：长风、鸿雁分开设，默认 medium；模型不支持时用最近的一档（`thinkingFor`）。
  - 市场数据：默认 Polygon/Massive（失败或超出约 5 年时回退 yfinance）；可选 yfinance。
- **数据**：调 skill 脚本 `dma_analyze.py --json`（Polygon，失败回退 yfinance），key 在项目根目录 `.env`。
- **引用**：`[[S:编号]]` 指原文片段（`bun run sources` 列出全部编号），`[[D:字段]]` 指当前分析数据。每轮回答结束后服务端逐条核对，找不到出处的显示红色。
- **自选股**：存在 `data/watchlist.json`。

## 结构

```
浏览器 ──HTTP/WebSocket── src/server.ts（Bun）
                           ├─ src/workbench.ts   两个 agent + 动态问法 + 当前视图
                           │   ├─ agents/host.ts     Pi 会话 → 浏览器事件，引用校验
                           │   ├─ agents/tools.ts    dma_analyze / search_sources / read_source / suggest_questions
                           │   ├─ agents/prompts.ts  长风（方法论取自 SKILL.md）、鸿雁
                           │   └─ agents/suggest.ts  规则版问法 + 轻量 Pi 会话生成 AI 版
                           ├─ src/http.ts       页面、分析、自选股、原文片段
                           ├─ src/sources.ts    引用库（切片、检索）
                           ├─ src/citations.ts  引用解析、数据字段、校验
                           └─ src/analyze.ts    调 Python 脚本，带缓存
public/  app.js 页面状态 · agents.js 两个面板 · chart.js 图表 · cite.js 引用渲染 · selection.js 划选问鸿雁
```

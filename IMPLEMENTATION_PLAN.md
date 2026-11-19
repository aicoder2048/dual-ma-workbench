# 双均线工作台（dual-moving-averages 升级版）

三栏网页：左「自选股」/ 中「分析师」（K 线 + 6 均线 + 底扣价小黄点 + 三步报告 + 分析对话）/ 右「均线参谋」（概念问答 + 划选解读）。

## 架构决定（2026-11-18 已和用户确认）

- 本地 **Bun 服务进程**（`app/server.ts`）= Electron main；浏览器 = renderer；**WebSocket** = IPC。
- **Pi SDK 在进程内**跑两个独立会话：分析师、均线参谋。模型只允许 `openai-codex/*`（订阅）；配置成别的 provider 就拒绝启动。
- 分析师不开 bash。自定义工具 `dma_analyze` 调 Python 脚本（子进程，PEP 723），结果**同时**返回给模型、推给浏览器刷新图表；`suggest_questions` 推动态问法。
- 均线参谋只读：`search_sources` / `read_source` 查引用库；提问时附带中间当前的分析快照和划选内容。
- 所有判断必须引用：`[[S:片段编号]]`（原文）或 `[[D:字段路径]]`（数据）。服务端校验编号存在，前端渲染成可点开的引用。
- 自选股的趋势标签走脚本规则初判，不经过 LLM，按天缓存。
- 代码放项目 `app/`；skill 仍是大脑（方法论 + 脚本）。

## Stage 1: 数据层 JSON 输出
**Goal**: `dma_analyze.py --json` 输出分析结果 + 图表序列（K 线、6 条均线、底扣价点、成交量），网页和 agent 共用。
**Success Criteria**: 同一份数据，Markdown 报告与 JSON 的数值一致；JSON 能被 `JSON.parse`。
**Tests**: pytest（合成 CSV，确定性）：底扣价推演、MA 方向、JSON 字段齐全且无 NaN。
**Status**: Complete

## Stage 2: 引用库
**Goal**: 把 SKILL.md、references/、主学习文章（带视频时间戳）、底扣价笔记、TA01/TA15、memo 切成带稳定编号的片段；提供搜索、读取、引用校验。
**Success Criteria**: 每个片段有唯一编号、标题、来源文件和行号；校验函数能找出不存在的编号。
**Tests**: bun test：切片编号稳定、搜索命中、引用解析与校验。
**Status**: Complete

## Stage 3: 服务骨架 + 三栏页面（不接 AI）
**Goal**: Bun 服务 + 静态前端。左栏自选股增删和趋势标签；中栏图表和规则版三步报告（带引用）；右栏空壳；亮/暗主题。
**Success Criteria**: 浏览器打开能切换股票、回放日期，图表和报告正确。
**Tests**: bun test 测 HTTP 接口；手动在浏览器里看一遍。
**Status**: Complete

## Stage 4: 分析师 agent
**Goal**: Pi SDK 会话 + skill + `dma_analyze` / `suggest_questions` 工具；WebSocket 流式回答、中断；动态问法按钮。
**Success Criteria**: 问"NVDA 能抄底吗"，图表刷新、回答带合法引用、出现新的动态问法。
**Tests**: 模型守卫单测；工具单测（不调模型）；一次真实对话冒烟（订阅）。
**Status**: Not Started

## Stage 5: 均线参谋 agent
**Goal**: 独立会话 + 引用库工具；划选文字 / 点图表（K 线、小黄点、均线）发起解读；概念类动态问法；引用点开看原文。
**Success Criteria**: 问"底扣价公式是什么"能引用原文；划选报告里一句话能得到结合当前数据的解读。
**Tests**: 上下文拼装单测；一次真实对话冒烟（订阅）。
**Status**: Not Started

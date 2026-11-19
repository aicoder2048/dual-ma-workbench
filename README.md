# dual-ma-workbench · 双均线工作台

用"双均线"方法看股票趋势的本地工作台，外加一个可以单独使用的 agent skill。

核心观点：均线是各周期的平均持仓成本，**均线的方向就是价格的最小阻力方向**。先认趋势类型，再选打法，最后用底扣价推演均线接下来往哪走。

> 只用于学习和复盘，不是投资建议。

## 包含什么

| 部分 | 位置 | 作用 |
|---|---|---|
| Skill | `.agents/skills/dual-moving-averages/` | 方法论（SKILL.md + references）和分析脚本 `dma_analyze.py`。Claude Code、Pi 都能直接用 |
| 工作台 | `app/` | 三栏网页：左「自选股」、中「分析师」、右「均线参谋」。AI 部分基于 Pi SDK |

工作台的主要功能：

- **图表**：日线 K 线、20/60/120 的 MA 和 EMA 共 6 条均线、底扣价小黄点、放量标记。
- **三步报告**（规则生成，不经过 AI）：看大局（均线状态表、价位梯子、乖离分位、交叉表）→ 定策略（趋势类型判定表）→ 看方向（底扣价小多图、价格不变时的推演）。
- **分析师**：问"现在能加仓吗""60 日线什么时候拐头""回放 TSLA 2021-04-14"。回答用表格、流程图、迷你 K 线图表达。
- **均线参谋**：解释概念；划选文字、点图表、或点卡片右上角「问参谋」，结合当前数据解读。
- **句句有出处**：判断都带引用。`[[D:…]]` 指当前数据，`[[S:…]]` 指方法论原文。服务端逐条核对，找不到出处的标红。

## 运行

需要：[uv](https://docs.astral.sh/uv/)（Python 脚本）和 [Bun](https://bun.sh)（工作台）。

```bash
cp .env.example .env          # 填入 POLYGON_API_KEY；没有也能用 yfinance
cd app && bun install
bun start                     # http://127.0.0.1:5178
bun test                      # 单元测试，不调用模型
```

### 依赖 Pi 吗？

只有 AI 功能依赖 Pi，而且依赖的是 Pi 的 SDK，不是 `pi` 命令行。

| 部分 | 依赖 Pi | 说明 |
|---|---|---|
| Skill 和 Python 脚本 | 不依赖 | 可以单独运行；Claude Code、Pi 都能加载这个 skill |
| 工作台：图表、三步报告、自选股、设置 | 不依赖 | 没有 Pi 也能打开页面，正常使用 |
| 工作台：分析师、均线参谋、AI 生成的问法 | 依赖 Pi SDK | `bun install` 自动安装 `@earendil-works/pi-coding-agent`，不需要另外装 |

用 Codex 订阅（默认模型）时，还要先登录一次：

```bash
npm i -g @earendil-works/pi-coding-agent   # 只为登录用
pi                                         # 在 pi 里登录 Codex；授权存在 ~/.pi/agent/auth.json
```

选 DeepSeek 时不用登录 Codex，在 `.env` 里填 `DEEPSEEK_API_KEY` 就行。

想换掉 Pi 的话，只需要重写 `app/src/agents/host.ts`（创建会话、转发流式事件、注册工具）。工具、提示词、引用校验和前端都和 harness 无关。

只用 skill 的命令行脚本：

```bash
uv run .agents/skills/dual-moving-averages/scripts/dma_analyze.py NVDA
uv run .agents/skills/dual-moving-averages/scripts/dma_analyze.py TSLA --asof 2021-04-14
```

## 模型和计费

右上角「设置」里选：

| 模型 | 计费 | 说明 |
|---|---|---|
| `openai-codex/gpt-6.1-sol`（默认） | 订阅 | 需要先在 `pi` 里登录 Codex |
| `deepseek/deepseek-flash` | **按量计费** | key 读 `.env` 的 `DEEPSEEK_API_KEY` |

只允许这两个。`anthropic/*` 在第三方 harness 里会走 API 按量计费，工作台一律拒绝。

## 没有放进仓库的内容

方法来自一段中文教学视频和几份均线讲义的学习笔记。这些转载内容（学习文章、底扣价笔记、讲义笔记、看片笔记）**不在公开仓库里**。

- 本地有这些文件时，引用库会读取它们。
- 没有时，报告里的原文引用自动改指 skill 自带的概念速查（`references/concepts.md`）里同主题的段落，不会报错，也不会标红。

## 目录

```
.agents/skills/dual-moving-averages/   skill：SKILL.md、references/、scripts/、tests/
.claude/skills/dual-moving-averages    → 指向上面的软链接（Claude Code 只认 .claude/skills）
app/                                   工作台（说明见 app/README.md）
references/ref-tools-from-learnoptions/  Polygon 取数参考脚本
```

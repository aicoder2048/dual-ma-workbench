# 交接：双均线学习与工具（2026-11-18）

新会话从这里开始：`cd ~/Python/Playground/DualMovingAveragesTrading && claude`，然后让 Claude 先读这个文件。

## 1. 目标

用户在学一个讲"双均线"的中文 YouTube 视频：<https://www.youtube.com/watch?v=4HTnAyS3TO0>。

1. **学懂**：双均线是什么、解决什么问题、怎么用。成果是学习文章和底扣价笔记。
2. **用起来**：做成 skill `dual-moving-averages`，能分析任意股票、回放历史日期、生成网页报告。
3. **可能的下一步**：做成独立的 app 或网页（还没定，见第 6 节）。

核心观点：均线是各周期的平均持仓成本，**均线的方向就是价格的最小阻力方向**。先判断趋势类型，再选打法，最后用底扣价推演均线方向。不机械地等金叉、死叉。

## 2. 项目文件（本目录，原名 LearnTrading，2026-11-18 改名）

| 路径 | 内容 |
|---|---|
| `chat/1118_what-I-want.md` | **主学习文章**（已重写）：用途 → 概念（MA/EMA、双交叉、底扣价、钟表方向、排列、乖离、标志性动作、结构性加仓）→ 趋势 5 步 → 五种趋势类型及打法（一张表）→ 三步流程 → TSLA/AAPL/GOOGL 案例 → 误区与资金原则 → 速查清单。开头有用户自己加的一行 notes："趋势, 抵扣价, 和均线之间的关系"，还没处理。 |
| `study-notes/261118-ma-drop-off-price.md` | 底扣价笔记（Obsidian 格式）。"EMA 怎么搭配"那条已从"待确认"改成"已核实"。 |
| `memo/模糊正确.md` | **用户自己看视频的笔记**：前 13 分钟在讲"模糊正确"，之后开始讲"双均线交易系统的缺陷"。 |
| `docs/moving-averages/` | 更早的均线笔记。TA01 主张"金叉进场、死叉离场"，和本视频的观点有张力，文章第 7 节已经说明两者怎么共存。TA15 讲趋势和震荡（EMA8/21）。 |
| `references/ref-tools-from-learnoptions/` | 用户从 LearnOptions 项目拷来的 Polygon 取数脚本（期权为主），只作参考。 |
| `reports/NVDA-2026-11-18.html` | NVDA 网页报告，已发布：<https://claude.ai/artifact/XukriE6gyTTGV3ePDhdwxz>（私有） |
| `.env` | API key：`POLYGON_API_KEY`、`MASSIVE_S3_ACCESS_KEY/SECRET_KEY`、`FINNHUB_API_KEY`。**不要打印或提交。** |
| `.claude/settings.json` | 项目启用了 `watch@claude-video` 等插件 |

视频内容的来源：除了 `memo/` 里用户自己的笔记，其余都来自 Gemini 看视频后的转述（watch 插件，gemini 引擎），不是 Claude 亲眼看的画面。

## 3. Skill：`~/.claude/skills/dual-moving-averages/`

位于 git 仓库 `aicoder2048/claude-skills`（私有）。用户规则：改完就 commit 并 push，提交信息写成 `dual-moving-averages: <改了什么>`，提交前跑 `gitleaks protect --staged`。最新提交 `43a5750`。

| 文件 | 作用 |
|---|---|
| `SKILL.md` | 原则、三步流程、趋势类型打法表、回答格式、网页报告流程、误区 |
| `references/concepts.md`、`cases.md` | 概念速查；视频案例（TSLA 2021、AAPL、GOOGL） |
| `scripts/dma_analyze.py` | 取数 → `analyze()` 得到结构化结果 → `render_markdown()` 输出文字报告；`--html`、`--commentary` 生成网页 |
| `scripts/html_report.py` | 网页渲染：lightweight-charts@4.2.0（jsDelivr）、6 条均线可开关、底扣价小黄点、放量标黄、亮/暗主题。点评 JSON 的格式写在文件开头 |

常用命令：

```bash
S=~/.claude/skills/dual-moving-averages/scripts/dma_analyze.py
uv run --with pandas --with yfinance $S NVDA                       # 文字报告
uv run --with pandas --with yfinance $S TSLA --asof 2021-04-14     # 回放历史
uv run --with pandas --with yfinance $S NVDA --html reports/NVDA-<日期>.html --commentary <点评.json>
```

脚本行为：
- **数据源**：先用 Polygon `/v2/aggs` 复权日线。key 的查找顺序：环境变量 → `--env-file` → 当前目录及父目录的 `.env` → `~/Python/Playground/DualMovingAveragesTrading/.env`。失败或 K 线不够时回退 yfinance，报告第一行写明来源和回退原因。`--source polygon|yfinance` 可以强制。
- **Polygon 档位限制**：只能查最近约 5 年。回放 2021 年会 403，然后自动回退 yfinance。
- **今日 K 线未完成提醒**：最后一根是今天、且美东时间早于 16:15 时提醒。半日市不处理。
- **趋势初判**是启发式规则，阈值在脚本顶部常量里。例如 NVDA 被判成"过渡态"，只是因为 MA60 还略高于 MA120，实际是下跌转向极度超卖。所以要人看图复核。
- **验证过**：TSLA 2021-04-14 回放和视频结论一致（排列混乱，60 日线扣高值）。refactor 前后的 Markdown 输出逐字一致。脚本**还没有自动化测试**。

## 4. 已做的决定

- 视频参数：20/60/120，每个周期 MA + EMA。颜色：20 黑/灰、60 红、120 蓝。视频强调参数不重要，重点是两种算法互证（**双交叉**）。
- 原文"有效跌破 60 日线就减仓"不是视频原话，文章里标成"用户自己的执行规则，待验证"。
- 网页报告的分工：脚本出数据和图，大模型只写点评 JSON。走 Claude 订阅，发布成私有 Artifact。网页是快照，不会自动更新行情。
- 关于做 app：讨论过，**还没决定**。见第 6 节。

## 5. 用户偏好

- 中文交流，技术术语可以用英文。Python 用 `uv`。
- 计费规则见 `~/.claude/CLAUDE.md`：Claude 只能在 Claude Code 里用订阅，**第三方 harness 不能用 `anthropic/*` 模型**（走 API 按量计费）。Codex 是订阅；DeepSeek 按量付费。
- 学习笔记的格式参考 `study-notes/`（Obsidian，`yymmdd-关键词.md`）。
- 用户在**人工看视频**，会对照 Gemini 转述的内容提出修正。

## 6. 待办 / 下一步

1. **用用户自己的看片笔记核对文章**：`memo/模糊正确.md` 说 13 分钟后开始讲"双均线交易系统的缺陷"。Gemini 的转述没有单独讲"缺陷"，只在误区里提到"机械化"。等用户看完视频，按他的笔记修正文章和 skill。
2. **处理文章开头的 notes**："趋势、底扣价和均线之间的关系"。可以单独写一节，把散在 2.3 节和第 5 节推演链里的内容串起来。问用户要不要。
3. **app / 网页的方向**，等用户决定：
   - 只自己用：本地网页（FastAPI 或 Streamlit + lightweight-charts）。点评走 `claude -p` 或 `codex exec`（订阅），也可以用模板，不用大模型。
   - 给别人用：点评改走 DeepSeek API；Polygon key 只放后端。
   - 或者继续用"在 Claude Code 里说一句话 → 生成 Artifact 网页"，现在已经能用。
4. **可选增强**：小时线（结构性加仓要看 1h/30m，Polygon `range/1/hour`）；给 `analyze()` 加 pytest；放宽"过渡态"规则（比如 EMA 已经空头、MA 只差一条线时，判成"趋势形成中"）。
5. **清理**：用户重建了空的 `~/Python/Playground/LearnTrading/`，用来迁移长期记忆。查过了，旧项目的记忆目录（`~/.claude/projects/-Users-szou-Python-Playground-LearnTrading/memory/` 和 `…-LearnTrading-docs/memory/`）都是空的，没有要迁移的。迁移结束、旧会话关掉后，这个空目录可以删。旧会话记录在 `~/.claude/projects/-Users-szou-Python-Playground-LearnTrading/`。

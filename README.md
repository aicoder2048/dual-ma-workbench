<p><img src="app/public/favicon.svg" width="56" alt="归雁 logo"></p>

# 归雁

**双均线工作台**（dual-ma-workbench）：用"双均线"方法看股票趋势的本地工作台，外加一个可以单独使用的 agent skill。

名字的意思：大雁知道往哪飞、什么时候动身。这套方法要做的也是这两件事：认清均线的方向，看准拐头的时机。

核心观点：均线是各周期的平均持仓成本，**均线的方向就是价格的最小阻力方向**。先认趋势类型，再选打法，最后用抵扣价推演均线接下来往哪走。

> 只用于学习和复盘，不是投资建议。

## 包含什么

| 部分 | 位置 | 作用 |
|---|---|---|
| Skill | `.agents/skills/dual-moving-averages/` | 方法论（SKILL.md + references）和分析脚本 `dma_analyze.py`。Pi 直接识别 `.agents/skills/` |
| 工作台 | `app/` | 三栏网页：左「自选股」、中「分析师」、右「鸿雁」。AI 部分基于 Pi SDK |

工作台的主要功能：

- **模糊判断**（页面最上方）：先回答"接下来几周对谁有利"。数 6 条均线的方向、看短中长期线组谁在上，合成"明显偏空 … 明显偏多"五档；一两处小错位不改变大方向。方向和排布打架时标出"反弹受压"（不买）或"回调有撑"。旁边是价格不变 10 天后的判断，和"什么价位会改变判断"（站上 / 跌破哪条 EMA、哪个抵扣价，离现价多远）。
- **图表**：日线 K 线、20/60/120 的 MA 和 EMA 共 6 条均线、抵扣价小黄点、放量标记。默认对数坐标（看斜率要用对数坐标），可切回普通坐标。
- **三步报告**（规则生成，不经过 AI）：模糊判断之后是细节。看大局（均线状态表、价位梯子、乖离分位、交叉表）→ 定策略（趋势类型判定表）→ 看方向（抵扣价小多图、价格不变时的推演）。
- **分析师**：问"现在能加仓吗""60 日线什么时候拐头""回放 TSLA 2021-04-14"。回答用表格、流程图、迷你 K 线图表达。
- **鸿雁**：解释概念；划选文字、点图表、或点卡片右上角「问鸿雁」，结合当前数据解读。
- **附件**：两个对话框都能附图和文件。点 📎 导入、直接粘贴截图（⌘V）、或拖进来。图片交给模型看（太大的截图自动缩小），csv、md、txt、json 的内容拼进问题；PDF 请截图后粘贴。最多 4 个。
- **语音播报**：每条回答旁有「▶ 朗读」，用微软 Edge 在线语音（edge-tts，免费，不用 key；回答文字会发到微软的服务）。设置里各选三男三女的声音：分析师默认云希（年轻男声），鸿雁默认晓晓（年轻女声）；可打开「回答完自动朗读」。
- **句句有出处**：判断都带引用。`[[D:…]]` 指当前数据，`[[S:…]]` 指方法论原文。服务端逐条核对，找不到出处的标红。

## 运行

需要：[uv](https://docs.astral.sh/uv/)（Python 脚本）、[Bun](https://bun.sh)（工作台），以及 Node.js 22.19+ 和 npm（装 pi 命令行用）。下面的命令都在仓库根目录运行。

### 1. 安装

```bash
cp .env.example .env                       # 填入 POLYGON_API_KEY；没有也能用 yfinance
(cd app && bun install)
npm install -g --ignore-scripts @earendil-works/pi-coding-agent   # pi 命令行：只用来登录和选模型
```

### 2. 安装后第一步：在 Pi 里登录、设置模型

不登录，分析师和鸿雁用不了。运行 `pi`，然后：

1. 输入 `/login`，登录 Codex（OpenAI 订阅）。要用 DeepSeek 的话，再登录 deepseek，填入你的 DeepSeek API key（按量计费）。授权存在 `~/.pi/agent/auth.json`。
2. 输入 `/model`，选 `gpt-6.1-sol [openai-codex]`，按 **Ctrl+S** 设为默认。前面打勾、后面标 `default` 就对了：

![在 pi 里用 /model 选 gpt-6.1-sol，按 Ctrl+S 设为默认](docs/images/pi-model.png)

列表里的 `[anthropic]` 模型不要设成默认：在 pi 这种第三方 harness 里用，走的是 Anthropic API 按量计费，不是 Claude 订阅。

工作台用到的是第 1 件（登录）：你在 pi 里登录过哪些 provider，设置里就列出它们的模型（见[模型和计费](#模型和计费)）。第 2 件改的是 pi 的全局默认（`~/.pi/agent/settings.json`）：工作台第一次启动、还没选过模型时，用它当初始值；以后工作台在自己的设置里选，不再跟随 pi。

### 3. 启动

```bash
cd app
bun start                     # http://127.0.0.1:5178
bun test                      # 单元测试，不调用模型（另开一个终端，同样在 app/ 下）
```

装了 [just](https://github.com/casey/just) 的话，`just wildgoose` 启动工作台，`just wildgoose 5179` 换端口（wild goose 就是大雁）。改了服务端代码（`app/src/`）会自动重启，前端文件刷新页面就生效；自动重启会清空两个 agent 的对话。改了 SKILL.md 或学习文章要手动重启，页面顶部会提示。

### 依赖 Pi 吗？

只有 AI 功能依赖 Pi，而且依赖的是 Pi 的 SDK，不是 `pi` 命令行。

| 部分 | 依赖 Pi | 说明 |
|---|---|---|
| Skill 和 Python 脚本 | 不依赖 | 可以单独运行；Claude Code、Pi 都能加载这个 skill |
| 工作台：图表、三步报告、自选股、设置 | 不依赖 | 没有 Pi 也能打开页面，正常使用 |
| 工作台：分析师、鸿雁、AI 生成的问法 | 依赖 Pi SDK | `bun install` 自动安装 `@earendil-works/pi-coding-agent`，不需要另外装 |

`pi` 命令行只用来登录和选模型（见上面第 2 步）。工作台只认 pi 存的凭据，不读 `.env` 或环境变量里的 key。没登录时，设置面板会提示。

想换掉 Pi 的话，只需要重写 `app/src/agents/host.ts`（创建会话、转发流式事件、注册工具）。工具、提示词、引用校验和前端都和 harness 无关。

只用 skill 的命令行脚本：

```bash
uv run .agents/skills/dual-moving-averages/scripts/dma_analyze.py NVDA
uv run .agents/skills/dual-moving-averages/scripts/dma_analyze.py TSLA --asof 2021-04-14
```

## 模型和计费

右上角「设置」里选。列表从 pi 动态读：你在 pi 里登录过的 provider（[第 2 步](#2-安装后第一步在-pi-里登录设置模型)），它们的模型都能选，按 provider 分组。

- **计费按登录方式推断**：订阅登录（oauth）标"订阅"；API key 标"**按量计费**"，选它时要先确认一次。只是推断，以各家账单为准。
- **已验证**：`openai-codex/gpt-6.1-sol`（订阅，默认）和 `deepseek/deepseek-flash`（按量计费）实测过引用格式和工具调用。其他模型标"未验证"，回答里的引用可能标红；不能看图的模型会标出来。
- `anthropic/*` 能选，但不会被当成默认：在第三方 harness 里它走 API 按量计费。
- **思考程度**：分析师、鸿雁分开设，默认都是 medium。模型不支持某一档时用最近的一档（两边一样近取低的，例如 DeepSeek flash 没有 medium，实际用 low），设置里会写明。

## 市场数据

所有数字都来自日线收盘价，图表、报告和两个 agent 用同一次计算的结果。右上角「设置」里选数据源：

| 数据源 | 需要 | 说明 |
|---|---|---|
| Polygon / Massive（默认） | `.env` 的 `POLYGON_API_KEY` | 付费 API，复权日线。失败、没有 key、或历史不够长时，自动回退 yfinance |
| yfinance | 不需要 key | 免费的非官方接口，偶尔不稳定 |

- **看清用的是哪个**：顶栏的「数据」胶囊和报告第一行都写明数据源。回退时会写明原因。
- **历史长度**：Polygon 的付费档位可能只有最近几年的数据（例如约 5 年）。回放更早的日期时，会自动改用 yfinance。
- **复权价**：两个数据源都按拆股、分红复权，价格可能和券商图上的绝对值不同。均线方向和相对关系不受影响。
- **盘中**：最后一根 K 线是今天、且美东时间还没到 16:15 时，页面会提醒"K 线未完成"。这时的结论相当于"假如今天收在这里"。
- **缓存**：最新行情缓存 10 分钟；回放某一天的结果一直缓存。切换数据源后自动重新取数。

命令行里用 `--source` 指定：`auto`（默认，先 Polygon 再 yfinance）、`polygon`（只用 Polygon）、`yfinance`。

```bash
uv run .agents/skills/dual-moving-averages/scripts/dma_analyze.py NVDA --source yfinance
```

## 目录

```
.agents/skills/dual-moving-averages/   skill：SKILL.md、references/、scripts/、tests/
app/                                   工作台（说明见 app/README.md）
```

## 许可证

[MIT](LICENSE)。只用于学习和复盘，不是投资建议。

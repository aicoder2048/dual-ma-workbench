# 归雁 · 双均线工作台

dual-moving-averages skill 的网页版：左「自选股 / 交易日志」、中「分析师·长风」、右「解语花·鸿雁」，顶栏「回测」「练习」各打开一页。分析师·长风负责判断，取李白"长风破浪会有时"，顺势而行，和归雁、鸿雁成一组；解语花·鸿雁负责解惑，解语花取"懂你的话、替你解答"之意。

**定位**：把双均线交易系统用到真实股票交易上的工作台；练习是辅助功能，练眼力（一眼看出图形和信号）。**风险提示**：2026-11-20 的评估（86 只票、2013–2026、事先定的标准、验证集）没找到这套方法可验证的交易优势：H1 模糊判断、H2 趋势类型方向相反或没用；H3 照方向持有回撤更浅，但收益/回撤低于 MA60、MA200 和买入持有；H4 推演最接近有用，没到标准；H5、H6 回测不支持。详见根目录 README。页面上推演求解给的提示标"辅助"并附 H4 的结论，`rules.md` 里标了"回测不支持"的规则在规则清单上带小标签，结论卡片的回测那句末尾也照说。

```bash
cd app && bun install     # 第一次
bun start                 # 打开 http://127.0.0.1:5178
bun test                  # 单元测试（不调模型）
bun run e2e               # 端到端测试：真 Chrome（本机安装的），假行情、假语音
python3 e2e/ctrl_c.py     # 在真终端里按 Ctrl+C：退出码 0、没有报错、终端模式恢复
python3 e2e/watch.py      # 改服务端代码自动重启（--watch），之后 Ctrl+C 照样干净退出
bun scripts/replay.ts     # 回放验证：近 2 年每 20 个交易日一个点，对照之后 20 天走势，报告写到 reports/replay/<日期>-20d.md
uv run ../.agents/skills/dual-moving-averages/scripts/backtest.py   # 逐笔回测：每个交易日按打法进出场，报告写到 reports/replay/<日期>.md
```

- **回放验证**（`scripts/replay.ts`，评估逻辑在 `src/replay.ts`）：默认 NVDA TSLA AAPL GOOG META MSFT AMZN SPY QQQ，可传代码和 `--years --step --horizon --jobs --refresh`。日线（yfinance 复权开高低收量）交给 skill 的 `backtest.py --fetch-only` 取，存 `reports/replay/data/`；缓存覆盖不到所需历史、超过 7 天没更新、或给了 `--refresh` 就重新取。每个点切当天往前 5 年交给 `dma_analyze.py --csv --asof`，和工作台实时取数一样（日线看最近 3 年，周线用 5 年），日线不够 3 年直接报错。看四件事：模糊判断各档之后涨跌、看方向的 MA20 推演对不对、空仓计划（"不买"类）之后涨跌、"站上 EMA20 + MA20 抵扣价"进场条件触发后表现。`--compare <另一次回放的 .json>` 在报告末尾加一节改造前后对照（同一批票和日期）。

- **逐笔回测**（skill 的 `scripts/backtest.py`，模拟在 `scripts/trades.py`）：每只票每个交易日收盘后按当天的打法决定进不进、走不走，次日开盘成交，记录每笔盈亏、持有天数、最大回撤、在场时间，和买入持有、MA60 朴素基准、同一只票随机进场比；另按规则编号统计触发后的表现。每天的分析和 `dma_analyze.py --csv <当天往前 5 年> --asof` 完全一样（测试断言），周线用 5 年历史，和实时取数一致，P13 用 Polygon 30 分钟线（约 5 年），更早的日子按三种口径各跑一遍。

- **设置**（右上角齿轮，存在 `data/settings.json`）：
  - 大模型：从 pi 动态读（`src/agents/catalog.ts`），列出在 pi 里登录过的 provider 的全部模型；计费：Pi 标明是订阅的 OAuth 算订阅，api_key 算按量计费，anthropic 一律按量，其他未知；不是订阅的切换前要确认。默认 `openai-codex/gpt-6.1-sol`；没选过时用 pi 的默认模型（是订阅才用）。切换后下一次提问生效，对话上下文保留，不改 Pi 的全局默认模型。
  - 思考程度：长风、鸿雁分开设，默认 medium；模型不支持时用最近的一档（`thinkingFor`）。
  - 市场数据：默认 Polygon/Massive（失败或超出约 5 年时回退 yfinance）；可选 yfinance。
  - 仓位：账户规模、每笔可承受亏损（默认账户的 1%，也可以填固定金额）。作为 `--account`、`--risk-pct` / `--risk-amount` 交给 `dma_analyze.py`，交易计划按它给建议股数；没填账户只给每 1 万元风险对应多少股。练习不带这几个参数。
- **交易计划**：结论卡片的进场、止损、目标位、盈亏比、股数都读脚本 JSON 的 `trade_plan`（skill 的 `tradeplan.py`），`plan.ts` 只配措辞，不重算。盈亏比不到 3:1 时空仓做法写"不做"和差多少。
- **财报日**：脚本 JSON 的 `earnings`（yfinance，每只票缓存一天，取不到写明原因）。图上时间轴上方标 E，最新一根右边留 4 根空位，下一次财报在里面也标；回放时只标回放那天及以前的和之后第一次。下次财报在 10 个交易日内（`EARNINGS_WARN_DAYS`，脚本自定），结论卡片多一行「N 天后财报：跳空可能越过止损价 X」，止损按找打法里选的处境取。只是信息，不改打法；长风可以引用 `[[D:财报.下次]]`。练习里没有财报日（`blind.ts` 的 `blindAnalysis`）：真实日期平移不掉，几次财报的间隔就能认出是哪只票。
- **图上的交互模式**（`public/chart.js` 的 `tool`）：无 / 画线 / 测量 / 选回放起点，同一时刻只有一种，换模式只走 `setTool`。回放状态机（`public/replay.js`）只管 off / replay。**测量**：按住从 A 拖到 B，框里写涨跌、涨跌幅、几根 K 线（几个自然日）、几个 ATR(14)（Wilder，和 skill 的 `fullplan.atr` 一样，取靠后那根当天的值，回放不偷看）；Esc 或再点一次清掉。读数条第一行有当天的量和量比（`chart_data` 的 `ratio`，50 日均量），大量标黄。
- **图层**（`public/layers.js` 一张表，`public/layermenu.js` 菜单，ADR 0019）：图上画什么都在工具栏的「图层 ▾」里。十个图层：均线、价位线、抵扣价、着色、顶底构造、形态、波段、缺口、缺口的「全部」、筹码。三个预设：简洁（默认，前三样）、结构（加构造、形态、波段、缺口）、全部；手动改过显示「自定」。回放、练习、周线下用不了的图层变灰并写原因（表里每行的 `available`）。开关存 localStorage 的 `dma-layers`。
- **数据**：调 skill 脚本 `dma_analyze.py --json`（Polygon，失败回退 yfinance），key 在项目根目录 `.env`。
- **K 线着色**：颜色由 Python 算好（skill 的 `tones.py`），放在每根 K 线的 `tone` 里，页面只负责上色。图表数据的 `tone_source` 说明颜色是谁算的：自带规则，或本机的着色插件（怎么换见根目录 README 的「换一套自己的着色规则」）。练习的 K 线只用自带规则（`practice/service.ts` 给脚本加 `--builtin-tones`，识别题的 `scan.py` 固定不读插件）。图例和按钮还没有读 `tone_source`。
- **引用**：`[[S:编号]]` 指原文片段（`bun run sources` 列出全部编号），`[[D:字段]]` 指当前分析数据。每轮回答结束后服务端逐条核对，找不到出处的显示红色。
- **自选股**：存在 `data/watchlist.json`。
- **交易日志**（`src/journal.ts`，页面 `public/journal.js`）：存在 `data/journal.json`。一笔的状态：计划 → 已进场 → 已离场，计划也可以放弃；不合法的转移返回 409。
  - 记入（`POST /api/journal`）：页面只发票、日期、处境、仓位、理由和一个随机编号；快照由服务端按这几样重新跑分析取，不信页面发来的计划。同一个编号记两次只算一次。
  - 之后（`POST /api/journal/<编号>`）：`enter` / `exit`（填错了可以再做一次来改）、`cancel`、`review`。请求里夹带别的字段（如快照）直接拒绝，快照记入后不变。
  - 文件读不了（不是 JSON、结构不对、编号重复）就报错并写明文件，不覆盖；写入先写 `journal.json.tmp` 再改名。
  - 收益按做多算，持有天数是自然日；汇总少于 10 笔标"只当参考"。列表和汇总只有实盘的单，练习的单在练习页「综合题」里看、复盘。长风读不到日志：照没照计划，左栏的汇总已经直接回答；要让长风读，得另改提示词和引用校验（日志里的数字不来自 dma_analyze）。

- **回测页**（`src/backtest/`，页面 `public/backtest.js`）：顶栏「回测」打开，和练习页一样盖在工作台上面；点一笔交易关掉回测，工作台回放到那笔的信号日。所有数字都由 skill 的 `planrun.py` 算，TypeScript 只读写文件、管运行、排版。
  - 方案（`plan.ts`）：typebox 的 `BacktestPlan`，在边界上从 TOML（`Bun.TOML.parse`）读进来校验，写回固定格式的 TOML；格式和 `planrun.py --template` 一样，Python 那边再严格校验一遍。存 `data/backtests/<名字>.toml`；新方案的默认值取 `planrun.py --template`，TypeScript 里不写默认参数。
  - 运行（`run.ts`）：排队 → 运行中 → 完成 / 失败 / 取消，一张状态 × 事件的表，表里没有的转移抛 409；每个状态带的字段用联合类型写死。
  - 服务（`service.ts`）：一次跑一个，其余排队；`planrun.py <plan> --out result.json` 单独一个进程组跑，stdout 每行一个 JSON 进度事件；取消时整组 SIGTERM（5 秒后 SIGKILL）。每次运行一个目录 `data/backtests/runs/<id>/`：`run.json`、`plan.toml`（自选股已经换成当时的代码）、`result.json`。工作台重启时没跑完的记为失败。
  - 结果（`result.ts`）：校验 `planrun.py` 写的 JSON 里页面要用的字段；测试用 CLI 真跑出来的 `test/fixtures/backtest-nvda-result.json`，单元测试和端到端用 `test/fixtures/fake-planrun.ts` 代替 Python（同样的参数和输出）。
  - 接口：`/api/backtest/template`、`estimate`、`plans`（列表、存、读、删、`duplicate`、`export`、`import`）、`runs`（列表、开始、读、`cancel`、`import`）。
- **练习页**（`public/practicepage.js`）：顶栏「练习」打开，`position: fixed` 盖在工作台上面，工作台的 DOM 和状态都不动；关掉或 Esc 回去。两种：识别题、综合题，选哪种记在本机。

- **识别题**（`src/practice/drillkinds.ts`、`drills.ts`、`drillstats.ts`，页面 `public/drills.js`、`drillchart.js`）：
  - 题型：`drillkinds.ts` 的 `KINDS` 和 `GENERATORS` 表，一种题一个出题函数，输入题目那一根收盘时的分析（dma_analyze 的 `analysis`），输出 0 到几份草稿：题干、选项、答案位置、答案类别、依据、规则编号、图上画什么。答案直接取分析的字段：看图 `regime.name`；看信号 `steps[0].current` 里日期是这一根、最靠后的一步；看抵扣价 `drops[].direction` 和 MA20 门槛路径的 `max_price`；看构造 `structure.top/bottom` 的 `state`、`complete_at` 和 J26；看打法按回测打法的进场条件（`discipline.ts` 的 `entryStateOf`）定「等 / 埋伏 / 不做 / 回撤买」，止损取空仓计划的 `stop`。「反弹卖」是持仓的做法，空仓永远不对，只当干扰项。
  - 出题（`DrillBank.fill`）：抽一只票、一天（`pool.ts`），往后连着 60 根都当候选；这段换算、平移（`blind.ts`），交给 skill 的 `scan.py`（一个进程逐根分析，每根都等于 `dma_analyze.py --csv --asof`，多进程，60 根约 3 秒）。草稿里的日期换成 T+n（题目那一根是 T0）。
  - 配平：按「题型 + 答案类别」入库，每类最多 3 道，同一段行情每类 1 道（相邻几根的题几乎一样）；一种题型攒够 9 道就停，所以要凑出至少 3 个不同的答案。给题时先等概率挑类别再挑题。不指定题型时按每种最近 20 题的错误率（加一对一错的先验）加权挑。少于 4 道在后台补，一轮最多抽 8 段。
  - 蒙眼和不偷看：页面只拿到题目那一根及以前的 K 线、均线、量、抵扣价位置，没有答案；交卷后才给答案、依据、规则编号。答过的题删掉，那段行情没题了文件也删掉。
  - 接口：`GET /api/drills`（统计、每种题还有几道、是否在补），`GET /api/drills/next?kind=`（不给 kind 按弱项），`POST /api/drills/<编号>/answer`（`{ picks, ms }`；每问都对才算对；同一题交两次 409）。
  - 存储：`data/practice/drills/bank.json`（题库）、`answers.json`（答题记录）、`windows/`（行情片段和整段图表）。读的时候用 typebox 校验，坏了报错不覆盖；写入先写临时文件再改名。

- **综合题**（整笔盲测，`src/practice/`，页面 `public/practice.js`）：在练习页「综合题」出题、列表、统计；开始或接着做时关掉练习页，在中栏做。一题在工作台里就是一只虚拟股票「练习 #n」，`Analyzer` 遇到这种代码转给练习模块，所以中栏、长风的取数工具、鸿雁的页面数据、推荐问法拿到的都是蒙过眼的数据。
  - 出题（`pool.ts`）：EVALUATION_PLAN 2.1 的指数 / ETF 和大盘股里抽一只，再抽一天：之前至少 3 年、之后至少 126 根（半年）。日线用 yfinance（`backtest.py --fetch-only`，缓存在 `data/practice/prices/`），Polygon 只有约 5 年。
  - 蒙眼（`blind.ts`）：只取开局前 5 年到之后 126 根（和实时取数一样：日线分析看最近 3 年，周线用 5 年）；价格乘一个系数（第一根收盘 = 100），成交量也换算；日期往后挪整数周到 2200 年附近（星期几、节假日空档不变，周线照样分组）。skill 的 `tests/test_rebase.py` 用真实行情验证过：换算后类型、阶段、打法、每条规则的状态都不变。对外的日期一律写成 T+n（开局那天 T0）；T 标签只用到当前那根为止的日历。
  - 不偷看：图表、分析只到当前那根（cursor）；`asof` 比现在晚返回 400。整段图表数据（`dma_analyze.py --chart-bars`）只留在服务端，逐根切给页面。
  - 状态（`session.ts`）：出题 → 决策中 → 推进中 → 揭晓。推进中一定有一笔进行中的单；离场或放弃回到决策中；走到最后一根自动揭晓。存在 `data/practice/sessions.json`，换算后的日线在 `data/practice/<编号>.csv`。
  - 成交：都依据已经看到的那根收盘，在下一根开盘成交。等触发：收盘站上（或跌到）触发价；下一根开盘买；只记判断不下单（之后也可以手动买）。止损：进场后收盘跌破。手动买卖也是下一根开盘。揭晓时没成交的计划放弃，持仓按最后一根收盘平掉。
  - 接口：`GET/POST /api/practice`（列表和统计、开一题；同一个编号开两次只算一次），`GET/POST /api/practice/<编号>`（`step` / `enter` / `exit` 带 `from`：页面以为现在是 T 几，对不上就不动；`plan`、`cancel`、`reveal`）。
  - 日志：练习的单记在交易日志文件里，带 `practice` 标记（哪一题、下的什么单），但不进左栏的列表和汇总；进出场只能由回放做，页面改返回 409，只能复盘（揭晓页上每一笔后面的「复盘」）。揭晓前显示「练习 #n」和 T+n，揭晓后换回真实代码和日期。
  - 揭晓：真实代码、开局和揭晓的日期、整段图表（换回真实日期和价格），这一题几笔复利的收益对比同期买入持有（T+1 开盘买，揭晓那根收盘卖）。统计：题数、跑赢持有几题、平均超额；练习的单照计划 / 没照计划分开算，不到 10 题、10 笔标只当参考。

## 结构

```
浏览器 ──HTTP/WebSocket── src/server.ts（Bun）
                           ├─ src/workbench.ts   两个 agent + 动态问法 + 当前视图
                           │   ├─ agents/host.ts     Pi 会话 → 浏览器事件，引用校验
                           │   ├─ agents/tools.ts    dma_analyze / search_sources / read_source / suggest_questions
                           │   ├─ agents/prompts.ts  长风（方法论取自 SKILL.md）、鸿雁
                           │   └─ agents/suggest.ts  规则版问法 + 轻量 Pi 会话生成 AI 版
                           ├─ src/http.ts       页面、分析、自选股、交易日志、原文片段
                           ├─ src/journal.ts    交易日志：状态转移、快照、汇总、读写 data/journal.json
                           ├─ src/backtest/     回测页：方案（TOML ↔ typebox）、运行状态机、后台跑 planrun.py
                           ├─ src/practice/     练习：识别题库（出题函数表、配平、统计），综合题（出题、蒙眼、状态机和成交、揭晓）
                           ├─ src/sources.ts    引用库（切片、检索）
                           ├─ src/citations.ts  引用解析、数据字段、校验
                           └─ src/analyze.ts    调 Python 脚本，带缓存
public/  app.js 页面状态 · journal.js 交易日志 · backtest.js 回测页 · practicepage.js 练习页 · drills.js 识别题 · practice.js 综合题 · agents.js 两个面板 · chart.js 图表 · cite.js 引用渲染 · selection.js 划选问鸿雁
```

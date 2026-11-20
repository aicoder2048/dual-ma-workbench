---
name: dma-video-ingest
description: 把一期新的双均线 / 趋势交易教学视频整理进 dual-moving-averages skill：拿字幕（没有就用本机 mlx-whisper 转写），抽出概念、规则、策略，每条附字幕原话和时间戳并用脚本逐条核对，和现有 concepts.md、rules.md、playbooks.md 对比标出新增、补充、冲突，用户确认后写入，并在 cases.md 补一个案例。Use when the user says "新视频入库"、"把这期视频整理进 skill"、"这期视频有哪些新规则"、"对照字幕核一下规则"、"ingest this video"、"add this video to the dual-MA skill"，or hands over a video or subtitle file about 均线、抵扣价、顶底构造、趋势类型 and wants it merged into the skill. 不用于只看视频摘要（用 watch），也不用于分析某只股票（用 dual-moving-averages）。
---

# 新视频入库

目标是 `<项目>/.agents/skills/dual-moving-averages/`（下称 DMA）的 `references/`。本 skill 不改 DMA 的脚本和测试。`<SKILL_DIR>` 是本文件所在目录。在 Claude Code 里用，先建软链接：`ln -s ../../.agents/skills/dma-video-ingest .claude/skills/`。

两条底线：

- **字幕是唯一依据。** 旧笔记（`chat/`、`memo/`）和 DMA 现有写法都可能是转述错的；和字幕不一致时以字幕为准，标"冲突"。
- **转载内容不进仓库。** 字幕、转写稿、条目文件都放 `videoes/`（已被 `.gitignore` 排除）。写进 DMA 的只有短句原话（脚本限 60 字）、视频代号和时间戳，不整段搬。

## 1. 拿字幕

按顺序取第一个能用的：

1. 用户给的 `.vtt`、`.srt`、`.txt`。
2. 视频自带字幕：`yt-dlp --skip-download --write-subs --write-auto-subs --sub-langs 'zh.*' --sub-format vtt -o 'videoes/%(title)s' <URL>`。
3. 本机转写（Apple Silicon，模型已缓存）：

```bash
~/Python/Playground/MacWhisper/mlx_whisper_venv/bin/mlx_whisper \
  --model ~/.cache/huggingface/hub/models--mlx-community--whisper-large-v3-turbo/snapshots/dc5237c23d9fb963ac9bd9bdc6530ac712b7ea66 \
  --language zh --output-format vtt -o videoes/ <视频或音频>
```

`--model` 必须指向这个 NPZ 快照目录。写成 `mlx-community/whisper-large-v3-turbo` 会取到新版 safetensors，0.3.0 报 `[load_npz] Input must be a zip file`。

**繁体字幕先转简体**（项目统一用简体，原话照简体抄）。作者 2020 年那批视频的人工字幕是繁体：

```bash
uv run <SKILL_DIR>/scripts/to_simplified.py videoes/<名字>.zh-Hant.vtt --move-raw
```

只换字形不改用词（OpenCC `t2s`），时间轴原样保留；写出 `<名字>.zh-Hans.vtt`，繁体原件挪到 `videoes/raw/`。之后所有步骤都用简体那份。

给视频定代号：读 DMA `references/cases.md` 开头的代号行，取下一个没用过的字母。同时在本 skill 的 `subtitles.json` 里登记 `"<代号>": "<字幕文件名>"`（字幕放 `videoes/`），第 5 步的全文核对靠它找字幕。

## 2. 抽条目，写条目文件

写到 `videoes/<字幕文件名去掉扩展名>.items.json`：

```json
{
  "video": "顶底构造（代号 D）",
  "items": [
    {"id": "C1", "layer": "概念", "text": "研究顶底构造只看每根 K 线的最高价和最低价",
     "quote": "我们只研究一根k线的最低价和最高价", "time": "00:58",
     "status": "新增", "target": "concepts.md#标志性动作与构造"},
    {"id": "R1", "layer": "规则", "kind": "判定",
     "text": "IF 顶部构造之后又创出更高的高点 THEN 构造作废，重新找",
     "quote": "那么我们认为这个顶部结构就被破坏了", "time": "06:54",
     "status": "新增", "target": "rules.md"},
    {"id": "I1", "layer": "规则", "kind": "动作", "inferred": true,
     "text": "推断（非字幕原文）：……", "status": "新增", "target": "rules.md"}
  ]
}
```

| 字段 | 填法 |
|---|---|
| `id` | 概念 `C1…`，规则 `R1…`，策略 `P1…`，推断 `I1…`。只在本文件内唯一 |
| `layer` | 概念（是什么）/ 规则（IF…THEN…）/ 策略（某种趋势、某种仓位下怎么做） |
| `kind` | 只有规则填：公理（数学事实）/ 判定（结论是状态）/ 动作（结论是该做什么） |
| `text` | 用自己的话写这一条；规则写成 IF … THEN … |
| `quote` | 字幕原字照抄，5 到 60 字。标点、空格、断行不影响核对；简繁、错别字要和字幕一致，听写错的字也照抄 |
| `time` | 原话所在那条字幕的开始时间，`mm:ss` 或 `hh:mm:ss` |
| `inferred` | 字幕里找不到支撑时写 `true`，不写 `quote`，`text` 以"推断（非字幕原文）"开头 |
| `status` | 第 4 步填：新增 / 补充 / 冲突 / 已有 |
| `target` | 第 4 步填：写进哪个文件哪一节，或改哪条规则编号 |
| `note` | 冲突时写现有说法，原样引用 |

抽法：

- 一条只说一件事。一个定义里的条件、例外、作废情形分成几条。
- 只收作者明说的条件和数字。只出现在画面上的东西（图上的价位、线的颜色）标 `inferred`，`text` 注明"需看画面"。
- 确认本期的配色和周期对应（例如黑 20、红 60、蓝 120），写进第一条概念。"红蓝交叉"这种说法要先翻译成周期再抽规则。

## 3. 核对原话

```bash
uv run <SKILL_DIR>/scripts/verify_quotes.py <字幕文件> videoes/<名字>.items.json
```

每条打印 `OK` / `FAIL` / `SKIP`，最后一行列出失败的编号，有失败时退出码为 1。逐条修到全过：

- 找不到：回字幕找原句重抄。常见原因是顺手改了词、把旧笔记的转述当原话，或者核对的是繁体原件（要用转好的简体那份）。找不到支撑就改成 `inferred`。
- 时间不符：改 `time`，脚本会给出原话实际所在的时间。默认容差 10 秒，`--tolerance` 可调。
- `.txt` 字幕没有时间轴，只核原话；能拿到 `.vtt` 就用 `.vtt`。

## 4. 和现有文件对比

读 DMA 的 `SKILL.md`、`references/concepts.md`、`references/playbooks.md`、`references/cases.md`，以及 `references/rules.md`（若有）。给每条填 `status` 和 `target`：

| 标签 | 含义 |
|---|---|
| 新增 | 现有文件没有 |
| 补充 | 现有写法没错，但缺条件、缺例外或说得含糊 |
| 冲突 | 现有写法和字幕不一致；`note` 原样引用现有说法 |
| 已有 | 现有写法已经一致，不写入，只在汇报里计数 |

冲突多半来自转述。例如"双交叉"被读成 20×60 和 60×120 都交叉，字幕里是同一对周期的 MA 和 EMA 都交叉。

## 5. 用户确认，再写入

先把对比结果交给用户，冲突排最前：

| 编号 | 层 | 内容 | 原话 @ 时间 | 标签 | 写到哪 |
|---|---|---|---|---|---|

附上第 3 步的核对结果（通过数、推断数）。用户确认或改完之后才动 DMA 文件：

- **概念** → `concepts.md` 对应小节，只讲是什么。
- **规则** → `rules.md`。文件已存在就照它的编号和列续写；不存在就新建，表头是 `编号 | 种类 | IF | THEN | 来源 | 由哪个计算判断`。来源写 `视频 D 06:54「原话」`，推断写"推断（非字幕原文）"。"由哪个计算判断"写 DMA 脚本里的函数名，没有就写"需看图"。
- **策略** → `playbooks.md` 对应趋势类型下。有 `rules.md` 时只引规则编号，不重写规则文字。
- **冲突** → 按字幕改原文，汇报时逐处列出改前、改后。
- **外部作者的视频**（不是 LEI 讲的）→ 不改 LEI 的规则。补空白的规则进 `rules.md`"外部交叉引用（非 LEI）"一节，编号 X1…，状态"需看图"；冲突只在相关规则的来源后加"对照：视频 N（外部来源：<作者>，非 LEI）mm:ss「原话」"。这种带括号的来源 `check_doc_quotes.py` 照样核对。
- **案例** → `cases.md` 加一节，格式照现有：`## <标的 年份>（<周期>，<代号>）：<一句读法>`，下面是"时间 | 现象 | 读法"表。用视频里走读的那段行情；没有具体行情就写作者画的示意图。同时把新代号加进开头的代号行。

写完后核对 DMA 全部文档里的原话（SKILL.md 和 references/*.md 里每一处 `视频 X mm:ss「原话」`）：

```bash
uv run <SKILL_DIR>/scripts/check_doc_quotes.py
```

失败的会列出"文件名:行号"和原因，改到全部通过再交。本机缺某期字幕会提示"跳过"；加 `--require-subs` 则算失败。

不改现有小节标题：工作台 `app/src/sources.ts` 按"文件#标题"引用。写完后告诉用户要重启工作台才生效。

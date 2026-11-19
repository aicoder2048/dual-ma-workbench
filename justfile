# 归雁 · 双均线工作台。`just` 列出全部命令。

skill := ".agents/skills/dual-moving-averages"
dma := skill / "scripts/dma_analyze.py"

# 列出全部命令
default:
    @just --list

# 第一次用：装工作台依赖，并从模板建 .env（已有就不动）
setup:
    test -f .env || cp .env.example .env
    cd app && bun install

# 启动工作台（默认 http://127.0.0.1:5178；PORT=5179 just start 换端口）
start:
    cd app && bun start

# 全部测试：skill 的 pytest + 工作台的 bun test + 类型检查
test: test-py test-app typecheck

# skill 脚本的测试（合成数据，不联网）
test-py:
    uv run --with pytest --with pandas pytest {{skill}}/tests -q

# 工作台单元测试（不调模型）
test-app:
    cd app && bun test

# 工作台类型检查
typecheck:
    cd app && bun x tsc --noEmit

# 文字报告：just analyze NVDA
analyze ticker *args:
    uv run {{dma}} {{ticker}} {{args}}

# 回放历史某一天：just replay TSLA 2021-04-14
replay ticker date *args:
    uv run {{dma}} {{ticker}} --asof {{date}} {{args}}

# 网页报告写到 reports/：just report NVDA（可加 --commentary 点评.json）
report ticker *args:
    mkdir -p reports
    uv run {{dma}} {{ticker}} --html reports/{{ticker}}-$(date +%Y-%m-%d).html {{args}}

# 列出引用库里的原文片段编号（[[S:...]] 用）
sources:
    cd app && bun run sources

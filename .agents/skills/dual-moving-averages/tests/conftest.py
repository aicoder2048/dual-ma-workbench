"""测试共用：把 scripts/ 加进导入路径，读提交进仓库的真实行情（tests/fixtures，不联网）。"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pandas as pd

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
FIXTURES = Path(__file__).resolve().parent / "fixtures"
sys.path.insert(0, str(SCRIPTS))
# 不用着色插件：本机放了 private/tone_plugin.py 或 .env 里配了也不改变测试结果（子进程跑的脚本继承这个环境变量）
os.environ["DMA_TONE_PLUGIN"] = ""

from indicators import add_indicators  # noqa: E402


def load_fixture(ticker: str, asof: str, years: int | None = 3) -> pd.DataFrame:
    """截到 asof，往前取 years 年（和脚本日线窗口一致），算好指标。years=None 取全部。"""
    df = pd.read_csv(FIXTURES / f"{ticker}.csv", parse_dates=["Date"]).set_index("Date")
    end = pd.Timestamp(asof)
    df = df[df.index <= end]
    if years is not None:
        df = df[df.index >= end - pd.DateOffset(years=years)]
    return add_indicators(df.copy())

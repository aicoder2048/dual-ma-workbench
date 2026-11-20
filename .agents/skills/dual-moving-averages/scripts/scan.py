#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "pandas",
# ]
# ///
"""一个 CSV、很多天：在一个进程里逐天跑 dma_analyze 的分析，给工作台的识别题库出题用。

用法：
  uv run scan.py --csv prices.csv --dates 2200-03-01,2200-03-02

每一天的分析和 `dma_analyze.py --csv prices.csv --asof <那天> --json` 的 analysis 完全一样
（tests/test_scan.py 断言）：同样按 windows 切出那天往前的日线和周线历史，CSV 模式不取小时线。
省掉的是每天重开一次 Python 的时间；--jobs 个进程分着算（默认 CPU 核数）。

输出一行 JSON：{"chart": 到最后一天的图表数据（整段）, "analyses": [每一天的 analysis，按 --dates 的顺序]}。
图表的均线、着色、放量都只看当天及以前，题库按题目那一根切开用，不会看到之后的 K 线。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from concurrent.futures import ProcessPoolExecutor
from functools import partial
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

import dma_analyze as dma  # noqa: E402
from html_report import chart_data  # noqa: E402
from indicators import add_indicators  # noqa: E402

CSV_HOURLY = {"available": False, "reason": "CSV 模式不取小时线"}


def analyze_at(df: pd.DataFrame, day: str, label: str) -> dict:
    """day 收盘时的分析，等于 dma_analyze.py --csv <label> --asof <day> 的 analysis。"""
    daily, history = dma.windows(df, pd.Timestamp(day))
    if len(daily) < dma.MIN_BARS:
        raise SystemExit(f"{day}：只有 {len(daily)} 根 K 线，至少需要 {dma.MIN_BARS} 根")
    a = dma.analyze(add_indicators(daily.copy()), label, f"CSV {label}", history, CSV_HOURLY)
    if a["date"] != day:
        raise SystemExit(f"{day} 不是交易日（分析落在 {a['date']}）")
    return a


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--csv", required=True, help="含 Date, Open, High, Low, Close, Volume 的日线")
    p.add_argument("--dates", required=True, help="逗号分隔的交易日，如 2200-03-01,2200-03-02")
    p.add_argument("--jobs", type=int, default=os.cpu_count() or 1, help="并行进程数")
    a = p.parse_args()
    df = pd.read_csv(a.csv, parse_dates=["Date"]).set_index("Date").sort_index().dropna(subset=["Close"])
    days = [d.strip() for d in a.dates.split(",") if d.strip()]
    if not days:
        p.error("--dates 是空的")
    if a.jobs > 1 and len(days) > 1:
        with ProcessPoolExecutor(min(a.jobs, len(days))) as pool:
            analyses = list(pool.map(partial(analyze_at, df, label=a.csv), days, chunksize=4))
    else:
        analyses = [analyze_at(df, d, a.csv) for d in days]
    last = dma.windows(df, pd.Timestamp(max(days)))[0]
    chart = chart_data(add_indicators(last.copy()), analyses[days.index(max(days))], 100_000)
    print(json.dumps({"chart": chart, "analyses": analyses}, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    main()

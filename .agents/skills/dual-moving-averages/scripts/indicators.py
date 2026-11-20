"""均线指标和排列判断：dma_analyze、推演、周线共用的一份。"""
from __future__ import annotations

import pandas as pd

PERIODS = (20, 60, 120)
# 对照用的朴素规则：收盘在 MA200 上方持有、否则空仓（评估 references/evaluation.toml 的 H3.naive_ma）。不进任何规则
NAIVE_MA = 200


def add_indicators(df: pd.DataFrame) -> pd.DataFrame:
    for n in PERIODS:
        df[f"MA{n}"] = df["Close"].rolling(n).mean()
        df[f"EMA{n}"] = df["Close"].ewm(span=n, adjust=False).mean()
    df["BIAS20"] = (df["Close"] / df["MA20"] - 1) * 100
    return df


def arrangement(row: pd.Series, kind: str) -> str:
    a, b, c = (row[f"{kind}{n}"] for n in PERIODS)
    if a > b > c:
        return "多头"
    if a < b < c:
        return "空头"
    return "混乱"

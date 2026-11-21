"""scan.py 一次跑很多天，每一天都要和 dma_analyze.py --csv --asof 那一天的 analysis 一模一样（工作台识别题的答案从这里来）。"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
CSV = Path(__file__).resolve().parent / "fixtures" / "SPY.csv"
DAYS = ["2024-04-19", "2024-08-05"]


def run(script: str, *args: str) -> dict:
    out = subprocess.run([sys.executable, str(SCRIPTS / script), *args], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def test_scan_matches_dma_analyze_each_day():
    scanned = run("scan.py", "--csv", str(CSV), "--dates", ",".join(DAYS), "--jobs", "2")
    assert [a["date"] for a in scanned["analyses"]] == DAYS
    for day, got in zip(DAYS, scanned["analyses"]):
        want = run("dma_analyze.py", "--csv", str(CSV), "--asof", day, "--json")["analysis"]
        assert got == want


def test_scan_chart_ends_on_last_day():
    scanned = run("scan.py", "--csv", str(CSV), "--dates", ",".join(DAYS), "--jobs", "1")
    assert scanned["chart"]["candles"][-1]["time"] == max(DAYS)


def test_scan_chart_end_extends_chart_only():
    """--chart-end 只把图表往后画：analyses 不变，原来那段的价格和 MA 一根不差。

    图表从 chart-end 往前切 3 年，起点跟着往后挪：EMA 从起点递推，最近一年只差到万分之一以下。
    """
    base = run("scan.py", "--csv", str(CSV), "--dates", DAYS[0], "--jobs", "1")
    later = "2024-06-03"
    longer = run("scan.py", "--csv", str(CSV), "--dates", DAYS[0], "--chart-end", later, "--jobs", "1")
    assert longer["analyses"] == base["analyses"]
    assert longer["chart"]["candles"][-1]["time"] == later
    ohlc = lambda c: (c["time"], c["open"], c["high"], c["low"], c["close"])  # noqa: E731
    candles = {c["time"]: ohlc(c) for c in longer["chart"]["candles"]}
    assert all(candles[c["time"]] == ohlc(c) for c in base["chart"]["candles"] if c["time"] in candles)
    for key in ("MA20", "MA60", "EMA20", "EMA60"):
        values = {p["time"]: p["value"] for p in longer["chart"]["lines"][key]}
        both = [(p["value"], values[p["time"]]) for p in base["chart"]["lines"][key] if p["time"] in values]
        if key.startswith("MA"):
            assert all(x == y for x, y in both)
        else:
            assert all(abs(x / y - 1) < 1e-4 for x, y in both[-250:])

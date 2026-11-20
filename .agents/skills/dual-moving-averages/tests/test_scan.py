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

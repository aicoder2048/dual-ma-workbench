"""to_simplified.py：繁转简只换字形，时间轴原样保留，转完的字幕能直接给 verify_quotes 用。

运行：uv run --with pytest --with opencc pytest .agents/skills/dma-video-ingest/tests -q
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
SCRIPTS = HERE.parent / "scripts"
sys.path.insert(0, str(SCRIPTS))

pytest.importorskip("opencc")  # 没装 opencc 时整个文件跳过；要先于 import to_simplified，否则收集阶段就报错

import to_simplified  # noqa: E402
import verify_quotes  # noqa: E402

HANT = """WEBVTT

00:00:01.000 --> 00:00:03.000
趨勢是由小到大

00:00:03.000 --> 00:00:05.000
由小級別向大級別逐步擴散
"""


def test_output_name_swaps_the_language_tag():
    assert to_simplified.simplified_path(Path("v/a.zh-Hant.vtt")) == Path("v/a.zh-Hans.vtt")
    assert to_simplified.simplified_path(Path("v/a.vtt")) == Path("v/a.zh-Hans.vtt")


def test_converts_characters_keeps_timeline_and_moves_raw(tmp_path):
    src = tmp_path / "x.zh-Hant.vtt"
    src.write_text(HANT, encoding="utf-8")
    subprocess.run([sys.executable, str(SCRIPTS / "to_simplified.py"), str(src), "--move-raw"], check=True)
    out = (tmp_path / "x.zh-Hans.vtt").read_text(encoding="utf-8")
    assert "由小级别向大级别逐步扩散" in out
    assert [l for l in out.splitlines() if "-->" in l] == [l for l in HANT.splitlines() if "-->" in l]
    assert (tmp_path / "raw" / "x.zh-Hant.vtt").exists() and not src.exists()
    # 简体原话跨两条字幕也能在转换后的文件里找到
    cues, _ = verify_quotes.read_cues(tmp_path / "x.zh-Hans.vtt")
    text, _ = verify_quotes.build_index(cues)
    assert verify_quotes.find_spans(text, verify_quotes.normalize("由小到大由小级别"))


def test_refuses_to_overwrite(tmp_path):
    src = tmp_path / "x.zh-Hant.vtt"
    src.write_text(HANT, encoding="utf-8")
    (tmp_path / "x.zh-Hans.vtt").write_text("old", encoding="utf-8")
    r = subprocess.run([sys.executable, str(SCRIPTS / "to_simplified.py"), str(src)], capture_output=True, text=True)
    assert r.returncode != 0 and "不覆盖" in (r.stderr + r.stdout)
    assert (tmp_path / "x.zh-Hans.vtt").read_text(encoding="utf-8") == "old"

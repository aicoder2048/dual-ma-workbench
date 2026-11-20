"""check_doc_quotes.py：文档里所有"视频 X mm:ss「原话」"按代号对各自字幕核对。只用合成字幕。"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

import check_doc_quotes as cdq  # noqa: E402

VTT = """WEBVTT

00:01:00.000 --> 00:01:04.000
只要当前价格高于相应的抵扣价

00:01:04.000 --> 00:01:08.000
这条MA均线就会往上走
"""


def setup(tmp_path: Path, doc: str) -> tuple[Path, Path, Path]:
    (tmp_path / "videoes").mkdir()
    (tmp_path / "videoes" / "b.vtt").write_text(VTT, encoding="utf-8")
    subs = tmp_path / "subtitles.json"
    subs.write_text(json.dumps({"B": "b.vtt", "Z": "missing.vtt"}), encoding="utf-8")
    md = tmp_path / "rules.md"
    md.write_text(doc, encoding="utf-8")
    return md, subs, tmp_path / "videoes"


def run(md, subs, videos, *extra) -> int:
    return cdq.main([str(md), "--subtitles", str(subs), "--videos", str(videos), *extra])


def test_quote_spanning_two_cues_passes(tmp_path, capsys):
    md, subs, v = setup(tmp_path, "来源：视频 B 01:01「当前价格高于相应的抵扣价这条MA均线」")
    assert run(md, subs, v) == 0
    assert "共 1 条原话，失败 0" in capsys.readouterr().out


def test_reworded_quote_fails_with_its_location(tmp_path, capsys):
    md, subs, v = setup(tmp_path, "| A1 | 视频 B 01:01「当前价格高过抵扣价」 |")
    assert run(md, subs, v) == 1
    out = capsys.readouterr().out
    assert "rules.md:1" in out and "找不到" in out


def test_wrong_timestamp_fails(tmp_path, capsys):
    md, subs, v = setup(tmp_path, "视频 B 05:00「只要当前价格高于相应的抵扣价」")
    assert run(md, subs, v) == 1
    assert "时间戳不符" in capsys.readouterr().out


def test_missing_subtitle_is_skipped_unless_required(tmp_path, capsys):
    md, subs, v = setup(tmp_path, "视频 Z 00:10「这一句的字幕不在本机」")
    assert run(md, subs, v) == 0
    assert "跳过" in capsys.readouterr().out
    assert run(md, subs, v, "--require-subs") == 1


def test_unknown_code_fails(tmp_path, capsys):
    md, subs, v = setup(tmp_path, "视频 Q 00:10「没有登记代号的视频」")
    assert run(md, subs, v) == 1
    assert "subtitles.json 里没有代号 Q" in capsys.readouterr().out


def test_labeled_external_source_is_checked(tmp_path, capsys):
    md, subs, v = setup(tmp_path, "视频 B（外部来源：某作者，非 LEI）01:01「当前价格高过抵扣价」")
    assert run(md, subs, v) == 1
    assert "共 1 条原话，失败 1" in capsys.readouterr().out

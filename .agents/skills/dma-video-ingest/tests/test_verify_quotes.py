"""verify_quotes.py 的确定性测试：只用 fixtures/ 里的合成字幕。

运行：uv run --with pytest pytest .agents/skills/dma-video-ingest/tests -q
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))

import verify_quotes  # noqa: E402

VTT = HERE / "fixtures" / "sample.vtt"
TXT = HERE / "fixtures" / "sample.txt"


def run(tmp_path, subtitle, items, capsys, *extra):
    path = tmp_path / "items.json"
    path.write_text(json.dumps({"items": items}, ensure_ascii=False), encoding="utf-8")
    code = verify_quotes.main([str(subtitle), str(path), *extra])
    return code, capsys.readouterr().out


def test_quote_in_one_cue_passes(tmp_path, capsys):
    code, out = run(tmp_path, VTT, [{"id": "C1", "quote": "在不出现这个路标之前", "time": "00:03"}], capsys)
    assert code == 0
    assert "OK" in out and "C1" in out


def test_missing_quote_fails_with_id(tmp_path, capsys):
    items = [
        {"id": "C1", "quote": "在不出现这个路标之前", "time": "00:03"},
        {"id": "R7", "quote": "金叉买入死叉卖出", "time": "00:05"},
    ]
    code, out = run(tmp_path, VTT, items, capsys)
    assert code == 1
    assert "失败 1（R7）" in out


def test_quote_split_across_cues_passes(tmp_path, capsys):
    items = [{"id": "R1", "quote": "同一周期的MA和EMA都交叉才叫双交叉", "time": "00:12"}]
    code, _ = run(tmp_path, VTT, items, capsys)
    assert code == 0


def test_punctuation_and_width_differences_are_ignored(tmp_path, capsys):
    items = [{"id": "C2", "quote": "大家好，本期 我们来聊一个路标。", "time": "00:00"}]
    code, _ = run(tmp_path, VTT, items, capsys)
    assert code == 0


def test_rolling_duplicate_cue_does_not_join_with_itself(tmp_path, capsys):
    items = [{"id": "X", "quote": "见到拐点市场就不会见到拐点", "time": "00:07"}]
    code, _ = run(tmp_path, VTT, items, capsys)
    assert code == 1


def test_wrong_timestamp_fails(tmp_path, capsys):
    items = [{"id": "C1", "quote": "在不出现这个路标之前", "time": "01:00"}]
    code, out = run(tmp_path, VTT, items, capsys)
    assert code == 1
    assert "00:03" in out


def test_tolerance_flag_widens_time_window(tmp_path, capsys):
    items = [{"id": "C1", "quote": "在不出现这个路标之前", "time": "00:30"}]
    code, _ = run(tmp_path, VTT, items, capsys, "--tolerance", "30")
    assert code == 0


def test_hour_timestamps_are_parsed(tmp_path, capsys):
    items = [{"id": "C3", "quote": "最后一句在一小时以后", "time": "1:02:04"}]
    code, _ = run(tmp_path, VTT, items, capsys)
    assert code == 0


def test_inferred_item_is_skipped(tmp_path, capsys):
    items = [{"id": "I1", "inferred": True}]
    code, out = run(tmp_path, VTT, items, capsys)
    assert code == 0
    assert "推断 1" in out


def test_item_without_quote_or_inferred_fails(tmp_path, capsys):
    code, out = run(tmp_path, VTT, [{"id": "R2", "time": "00:03"}], capsys)
    assert code == 1
    assert "R2" in out


def test_item_without_time_fails_on_vtt(tmp_path, capsys):
    code, _ = run(tmp_path, VTT, [{"id": "R3", "quote": "在不出现这个路标之前"}], capsys)
    assert code == 1


def test_too_short_quote_fails(tmp_path, capsys):
    code, _ = run(tmp_path, VTT, [{"id": "S", "quote": "路标", "time": "00:00"}], capsys)
    assert code == 1


def test_too_long_quote_fails(tmp_path, capsys):
    quote = "大家好本期我们来聊一个路标在不出现这个路标之前市场就不会见到拐点" * 2
    code, _ = run(tmp_path, VTT, [{"id": "L", "quote": quote, "time": "00:00"}], capsys)
    assert code == 1


def test_duplicate_ids_fail(tmp_path, capsys):
    items = [
        {"id": "C1", "quote": "在不出现这个路标之前", "time": "00:03"},
        {"id": "C1", "quote": "市场就不会见到拐点", "time": "00:07"},
    ]
    code, _ = run(tmp_path, VTT, items, capsys)
    assert code == 1


def test_plain_text_subtitle_matches_without_time_check(tmp_path, capsys):
    items = [{"id": "T1", "quote": "路标之前市场就不会见到拐点", "time": "09:99"}]
    code, out = run(tmp_path, TXT, items, capsys)
    assert code == 0
    assert "无时间轴" in out


def test_srt_subtitle_matches_across_numbered_cues(tmp_path, capsys):
    items = [{"id": "S1", "quote": "路标之前市场就不会见到拐点", "time": "00:00:04,000"}]
    code, _ = run(tmp_path, HERE / "fixtures" / "sample.srt", items, capsys)
    assert code == 0


@pytest.mark.parametrize("bad", ['{"items": "x"}', "[1, 2]", "not json"])
def test_malformed_items_file_exits_2(tmp_path, capsys, bad):
    path = tmp_path / "items.json"
    path.write_text(bad, encoding="utf-8")
    assert verify_quotes.main([str(VTT), str(path)]) == 2

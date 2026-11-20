#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""核对抽取条目里的原话确实出现在字幕里，时间戳也对得上。

用法：
  uv run verify_quotes.py <字幕.vtt|.srt|.txt> <items.json> [--tolerance 秒]

items.json 的格式见 SKILL.md"条目文件"。只读 id、quote、time、inferred 四个字段。

比对前两边都做同样的归一化：NFKC，只保留文字和数字（去掉空格、标点、换行）。
所以全角半角、逗号句号、字幕断行都不影响；简繁不互通，原话要照字幕的写法抄。
VTT/SRT 的各条 cue 先接成一串再找，跨 cue 的句子也能找到；和上一条完全相同的行
（滚动字幕的重复）只算一次。

退出码：0 全部通过，1 有条目失败，2 输入文件有问题。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path

MIN_CHARS = 5  # 太短的原话证明不了出处
MAX_CHARS = 60  # 公开仓库只引短句
TIMING = re.compile(r"^\s*((?:\d+:)?\d+:\d+(?:[.,]\d+)?)\s*-->\s*((?:\d+:)?\d+:\d+(?:[.,]\d+)?)")
TAG = re.compile(r"<[^>]*>")


@dataclass(frozen=True)
class Cue:
    start: float | None
    end: float | None
    text: str


def parse_time(value: str) -> float:
    parts = value.strip().replace(",", ".").split(":")
    if not 2 <= len(parts) <= 3:
        raise ValueError(f"时间格式应为 mm:ss 或 hh:mm:ss：{value!r}")
    seconds = 0.0
    for part in parts:
        seconds = seconds * 60 + float(part)
    return seconds


def format_time(seconds: float) -> str:
    whole = int(seconds)
    hours, rest = divmod(whole, 3600)
    minutes, secs = divmod(rest, 60)
    stamp = f"{minutes:02d}:{secs:02d}"
    return f"{hours}:{stamp}" if hours else stamp


def read_vtt(text: str) -> list[Cue]:
    cues: list[Cue] = []
    start = end = None
    for line in text.splitlines():
        timing = TIMING.match(line)
        if timing:
            start, end = parse_time(timing.group(1)), parse_time(timing.group(2))
            continue
        if not line.strip():
            start = end = None  # 空行结束一条 cue；文件头、NOTE、cue 编号都不在时间行之后
            continue
        content = TAG.sub("", line).strip()
        if start is not None and content:
            cues.append(Cue(start, end, content))
    return cues


def read_cues(path: Path) -> tuple[list[Cue], bool]:
    text = path.read_text(encoding="utf-8-sig")
    if path.suffix.lower() in (".vtt", ".srt"):
        return read_vtt(text), True
    return [Cue(None, None, line.strip()) for line in text.splitlines() if line.strip()], False


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).lower()
    return "".join(ch for ch in text if unicodedata.category(ch)[0] in "LN")


def build_index(cues: list[Cue]) -> tuple[str, list[int]]:
    """把各条 cue 归一化后接成一串，owner[i] 是第 i 个字所在的 cue。"""
    chunks: list[str] = []
    owner: list[int] = []
    previous = None
    for i, cue in enumerate(cues):
        norm = normalize(cue.text)
        if not norm or norm == previous:
            continue
        previous = norm
        chunks.append(norm)
        owner.extend([i] * len(norm))
    return "".join(chunks), owner


def find_spans(text: str, needle: str) -> list[tuple[int, int]]:
    spans = []
    at = text.find(needle)
    while at != -1:
        spans.append((at, at + len(needle) - 1))
        at = text.find(needle, at + 1)
    return spans


def check_item(item: dict, text: str, owner: list[int], cues: list[Cue], timed: bool, tolerance: float) -> tuple[str, str]:
    quote = item.get("quote")
    if not quote:
        if item.get("inferred") is True:
            return "SKIP", "推断（非字幕原文）"
        return "FAIL", "没有 quote，也没有标 inferred: true"
    needle = normalize(quote)
    if len(needle) < MIN_CHARS:
        return "FAIL", f"原话太短（{len(needle)} 字，至少 {MIN_CHARS}）：{quote}"
    if len(needle) > MAX_CHARS:
        return "FAIL", f"原话太长（{len(needle)} 字，最多 {MAX_CHARS}），只引短句"
    spans = find_spans(text, needle)
    if not spans:
        return "FAIL", f"字幕里找不到：{quote}"
    if not timed:
        return "OK", f"无时间轴，未核对时间：{quote}"
    claimed_raw = item.get("time")
    if not claimed_raw:
        return "FAIL", f"缺 time；原话在 {format_time(cues[owner[spans[0][0]]].start)}"
    try:
        claimed = parse_time(str(claimed_raw))
    except ValueError as err:
        return "FAIL", str(err)
    found = []
    for first, last in spans:
        start, end = cues[owner[first]].start, cues[owner[last]].end
        if start - tolerance <= claimed <= end + tolerance:
            return "OK", f"{format_time(start)}  {quote}"
        found.append(format_time(start))
    return "FAIL", f"时间戳不符：写的 {claimed_raw}，原话在 {'、'.join(found)}"


def load_items(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list) or not all(isinstance(it, dict) and it.get("id") for it in items):
        raise ValueError('items.json 应为 {"items": [{"id": ..., ...}, ...]}，每条都要有 id')
    return items


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="核对条目原话是否出现在字幕里")
    parser.add_argument("subtitle", type=Path)
    parser.add_argument("items", type=Path)
    parser.add_argument("--tolerance", type=float, default=10.0, help="时间戳容差，秒（默认 10）")
    args = parser.parse_args(argv)

    try:
        items = load_items(args.items)
        cues, timed = read_cues(args.subtitle)
    except (OSError, ValueError) as err:  # json.JSONDecodeError 是 ValueError
        print(f"输入错误：{err}")
        return 2

    text, owner = build_index(cues)
    failed, inferred, passed = [], 0, 0
    seen: set[str] = set()
    for item in items:
        item_id = str(item["id"])
        if item_id in seen:
            status, message = "FAIL", "编号重复"
        else:
            status, message = check_item(item, text, owner, cues, timed, args.tolerance)
        seen.add(item_id)
        print(f"{status:<5} {item_id:<6} {message}")
        if status == "FAIL":
            failed.append(item_id)
        elif status == "SKIP":
            inferred += 1
        else:
            passed += 1

    failed_note = f"（{', '.join(failed)}）" if failed else ""
    print(f"\n通过 {passed} / 失败 {len(failed)}{failed_note} / 推断 {inferred}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

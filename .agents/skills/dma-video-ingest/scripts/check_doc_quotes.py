#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# ///
"""核对文档里所有"视频 X mm:ss「原话」"：按代号找到那期字幕，逐句跑 verify_quotes 的同一套检查。

用法（在项目根目录）：
  uv run .agents/skills/dma-video-ingest/scripts/check_doc_quotes.py            # 默认查 DMA 的 SKILL.md 和 references/*.md
  uv run .agents/skills/dma-video-ingest/scripts/check_doc_quotes.py a.md b.md --require-subs

代号到字幕文件名的对照在 skill 目录的 subtitles.json，字幕在 videoes/（不进仓库）。
本机没有某期字幕时默认跳过并提示；加 --require-subs 则算失败。视频 C 没有字幕，不写进对照表，引用它的句子会报"没有代号"，
所以 C 的出处在文档里写"视频 C，未核对字幕"，不用「」引原话。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import verify_quotes as vq  # noqa: E402

SKILL = HERE.parent
DMA = SKILL.parent / "dual-moving-averages"
PROJECT = SKILL.parents[2]
# 代号后可带括号标注，例如外部来源"视频 N（外部来源：老猫与指标，非 LEI）01:24「…」"
QUOTE = re.compile(r"视频 ([A-Z])(?:（[^）]*）| )(\d{1,2}:\d{2}(?::\d{2})?)「([^」]+)」")


def collect(files: list[Path]) -> dict[str, list[dict]]:
    """按视频代号收集原话，id 写成"文件名:行号"，失败时能直接定位。"""
    by_code: dict[str, list[dict]] = defaultdict(list)
    for f in files:
        for n, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            for m in QUOTE.finditer(line):
                by_code[m.group(1)].append({"id": f"{f.name}:{n}", "time": m.group(2), "quote": m.group(3)})
    return by_code


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("files", nargs="*", type=Path)
    p.add_argument("--subtitles", type=Path, default=SKILL / "subtitles.json", help="代号 → 字幕文件名")
    p.add_argument("--videos", type=Path, default=PROJECT / "videoes", help="字幕所在目录")
    p.add_argument("--require-subs", action="store_true", help="缺字幕算失败")
    p.add_argument("--tolerance", type=float, default=10.0)
    a = p.parse_args(argv)

    files = a.files or [DMA / "SKILL.md", *sorted((DMA / "references").glob("*.md"))]
    subs = json.loads(a.subtitles.read_text(encoding="utf-8"))
    total = failed = 0
    for code, items in sorted(collect(files).items()):
        total += len(items)
        if code not in subs:
            print(f"FAIL  视频 {code}：subtitles.json 里没有代号 {code}（{len(items)} 句，如 {items[0]['id']}）")
            failed += len(items)
            continue
        path = a.videos / subs[code]
        if not path.is_file():
            print(f"{'FAIL' if a.require_subs else '跳过'}  视频 {code}：本机没有字幕 {path}（{len(items)} 句）")
            failed += len(items) if a.require_subs else 0
            continue
        cues, timed = vq.read_cues(path)
        text, owner = vq.build_index(cues)
        bad = [(it["id"], msg) for it in items
               for status, msg in [vq.check_item(it, text, owner, cues, timed, a.tolerance)] if status == "FAIL"]
        print(f"视频 {code}：{len(items)} 句，失败 {len(bad)}")
        for item_id, msg in bad:
            print(f"   FAIL {item_id}  {msg}")
        failed += len(bad)
    print(f"\n共 {total} 条原话，失败 {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

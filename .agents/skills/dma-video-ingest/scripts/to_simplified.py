#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["opencc"]
# ///
"""把繁体字幕（或任何文本）转成简体，只换字形不改用词（OpenCC t2s）。

用法：
  uv run to_simplified.py videoes/foo.zh-Hant.vtt            # 写出 videoes/foo.zh-Hans.vtt
  uv run to_simplified.py videoes/*.zh-Hant.vtt --move-raw   # 转完把繁体原件挪到 videoes/raw/

时间轴、空行原样保留，所以转换后的 VTT 时间戳和原件一一对应，verify_quotes.py 照常能用。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import opencc


def simplified_path(src: Path) -> Path:
    name = src.name
    for tag in (".zh-Hant.", ".zh-TW.", ".zh-HK."):
        if tag in name:
            return src.with_name(name.replace(tag, ".zh-Hans."))
    return src.with_name(f"{src.stem}.zh-Hans{src.suffix}")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("files", nargs="+", type=Path)
    p.add_argument("--move-raw", action="store_true", help="转完把原件挪到同目录下的 raw/")
    a = p.parse_args()
    conv = opencc.OpenCC("t2s")
    for src in a.files:
        if not src.is_file():
            sys.exit(f"找不到文件：{src}")
        dst = simplified_path(src)
        if dst.exists():
            sys.exit(f"目标已存在，不覆盖：{dst}")
        dst.write_text(conv.convert(src.read_text(encoding="utf-8")), encoding="utf-8")
        if a.move_raw:
            raw = src.parent / "raw"
            raw.mkdir(exist_ok=True)
            src.rename(raw / src.name)
        print(f"{src} → {dst}")


if __name__ == "__main__":
    main()

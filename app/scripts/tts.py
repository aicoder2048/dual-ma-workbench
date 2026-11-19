#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["edge-tts"]
# ///
"""用微软 Edge 在线语音合成一段文字，mp3 写到 stdout。

输入（stdin，JSON）：{"text": "...", "voice": "zh-CN-YunxiNeural"}
文字会发到微软的语音服务。工作台的 src/tts.ts 调用它，并负责校验 voice 和文字长度。
"""
import asyncio
import json
import sys

import edge_tts


async def main() -> None:
    req = json.load(sys.stdin)
    audio = bytearray()
    async for chunk in edge_tts.Communicate(req["text"], req["voice"]).stream():
        if chunk["type"] == "audio":
            audio += chunk["data"]
    if not audio:
        sys.exit("没有合成出音频")
    sys.stdout.buffer.write(audio)


asyncio.run(main())

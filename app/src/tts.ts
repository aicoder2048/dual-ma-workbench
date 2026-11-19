/**
 * 语音播报：调 app/scripts/tts.py（微软 Edge 在线语音）合成 mp3，按"声音 + 文字"缓存在内存。
 *
 * 文字会发到微软的语音服务。切句、去掉引用和 Markdown 在浏览器里做（public/speech.js），
 * 这里只收一小段纯文字。
 */
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { validVoice } from "./settings.ts";

export const MAX_TTS_CHARS = 2000;
const SCRIPT = resolve(import.meta.dir, "../scripts/tts.py");
const CACHE_LIMIT = 300;

export type Synth = (text: string, voice: string) => Promise<Uint8Array>;

const edgeSynth: Synth = (text, voice) =>
  new Promise((ok, fail) => {
    const child = execFile("uv", ["run", "--quiet", "--script", SCRIPT],
      { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: 60_000 },
      (err, stdout, stderr) => {
        if (err) return fail(new Error(`语音合成失败：${String(stderr).trim().split("\n").pop() || err.message}`));
        ok(new Uint8Array(stdout));
      });
    child.stdin!.end(JSON.stringify({ text, voice }));
  });

export class Speaker {
  private cache = new Map<string, Promise<Uint8Array>>();

  constructor(private synth: Synth = edgeSynth) {}

  /** 校验后合成；不合法的输入抛"不合法"错误（HTTP 层转成 400）。 */
  speak(textRaw: unknown, voice: unknown): Promise<Uint8Array> {
    const text = typeof textRaw === "string" ? textRaw.trim() : "";
    if (!validVoice(voice)) throw new Error(`声音不合法：${String(voice)}`);
    if (!text) throw new Error("朗读文字不合法：为空");
    if (text.length > MAX_TTS_CHARS) throw new Error(`朗读文字不合法：超过 ${MAX_TTS_CHARS} 字`);
    const key = `${voice}|${text}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const value = this.synth(text, voice);
    this.cache.set(key, value);
    value.catch(() => this.cache.delete(key)); // 失败不缓存
    if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }
}

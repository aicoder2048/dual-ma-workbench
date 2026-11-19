// 语音播报：把回答变成能读的文字、按句切段，逐段向服务端要 mp3 播放。
// speechText / speechChunks 是纯函数（bun test 直接测）；player 只在浏览器里用。

/** 回答（Markdown + 引用）→ 纯文字。代码块（流程图、迷你图）整段不读，表格只读单元格。 */
export function speechText(md) {
  return String(md ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s*\[\[(S|D):[^\]\n]+\]\]/g, "")
    .split("\n")
    .map((line) => {
      const l = line.trim();
      if (/^\|?\s*:?-{2,}/.test(l)) return ""; // 表格分隔行
      if (l.startsWith("|")) return l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).filter(Boolean).join("，") + "。";
      return l.replace(/^#{1,6}\s+|^[-*+]\s+|^\d+[.)]\s+|^>\s?/, "");
    })
    .join(" ")
    .replace(/\*\*|__|`|~~/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** 按句号切成不超过 max 字的段；第一段尽量短，好让声音快点出来。 */
export function speechChunks(text, max = 160) {
  const sentences = String(text).match(/[^。！？；!?;]+[。！？；!?;]*\s*/g) ?? [];
  const out = [];
  let cur = "";
  const limit = () => (out.length === 0 ? Math.min(60, max) : max);
  for (let s of sentences) {
    while (s.length > max) { // 没有标点的超长句：硬切
      if (cur) { out.push(cur); cur = ""; }
      out.push(s.slice(0, max));
      s = s.slice(max);
    }
    if (cur && cur.length + s.length > limit()) { out.push(cur); cur = ""; }
    cur += s;
  }
  if (cur) out.push(cur);
  return out;
}

// ---------- 浏览器：一次只播一段回答 ----------
let current = null; // { id, stop }

/** 正在播的回答 id（没有则 null）。 */
export const speakingId = () => current?.id ?? null;

export function stopSpeaking() {
  current?.stop();
  current = null;
}

/**
 * 朗读一段回答。onState(playing) 在开始、结束（含被打断、出错）时回调。
 * 下一段在当前段播放时就去取，段与段之间几乎没有停顿。
 */
export function speak(id, markdown, voice, onState = () => {}) {
  stopSpeaking();
  const chunks = speechChunks(speechText(markdown));
  if (!chunks.length) return;
  let stopped = false;
  const audio = new Audio();
  const urls = [];
  const fetchChunk = (i) => fetch("/api/tts", { method: "POST", body: JSON.stringify({ text: chunks[i], voice }) })
    .then(async (res) => {
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `语音合成失败（${res.status}）`);
      const url = URL.createObjectURL(await res.blob());
      urls.push(url);
      return url;
    });
  const me = {
    id,
    stop() {
      stopped = true;
      audio.pause();
      urls.forEach((u) => URL.revokeObjectURL(u));
      onState(false);
    },
  };
  current = me;
  onState(true);

  (async () => {
    let next = fetchChunk(0);
    for (let i = 0; i < chunks.length && !stopped; i++) {
      const url = await next;
      if (stopped) return;
      next = i + 1 < chunks.length ? fetchChunk(i + 1) : null;
      next?.catch(() => {}); // 出错在轮到它时再处理
      audio.src = url;
      await audio.play();
      await new Promise((ok, fail) => { audio.onended = ok; audio.onerror = () => fail(new Error("音频播放失败")); });
    }
    if (current === me) { current = null; onState(false); }
  })().catch((err) => {
    console.warn("[归雁] 朗读中断：", err.message);
    if (current === me) me.stop();
  });
}

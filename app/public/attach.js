// 对话框附件：📎 导入文件、粘贴截图、拖进来。读成 { kind, name, ... } 交给 Panel 随问题发出。
// 服务端会再校验一次（src/attachments.ts），这里先挡住明显不行的，并把大截图缩小。
const MAX = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_SIDE = 2400; // 截图最长边超过它就缩小，看图够用，也省流量
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|ya?ml|log|py|ts|js|html?)$/i;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const base64Of = (blob) => new Promise((ok, fail) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).split(",")[1]);
  r.onerror = () => fail(new Error("读取失败"));
  r.readAsDataURL(blob);
});

/** 太大的图缩到最长边 MAX_SIDE；还是太大就转 JPEG。 */
async function shrink(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size <= MAX_IMAGE_BYTES) return file;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const toBlob = (type, q) => new Promise((ok) => canvas.toBlob(ok, type, q));
  const png = await toBlob("image/png");
  return png.size <= MAX_IMAGE_BYTES ? png : toBlob("image/jpeg", 0.88);
}

/** File → 附件；不支持就抛错（错误信息直接给用户看）。 */
export async function readAttachment(file, fallbackName = "截图.png") {
  const name = file.name || fallbackName;
  if (IMAGE_TYPES.includes(file.type)) {
    const blob = file.type === "image/gif" ? file : await shrink(file);
    if (blob.size > MAX_IMAGE_BYTES) throw new Error(`图片「${name}」太大，缩小后仍超过 4MB`);
    return { kind: "image", name, mimeType: blob.type, data: await base64Of(blob), preview: URL.createObjectURL(blob) };
  }
  if (file.type.startsWith("text/") || file.type === "application/json" || TEXT_EXT.test(name)) {
    return { kind: "text", name, text: await file.text() };
  }
  throw new Error(`「${name}」暂不支持：只能导入图片和文本文件（csv、md、txt、json）。PDF 请截图后粘贴`);
}

/**
 * 给一个对话框装上附件：📎 按钮、粘贴、拖放、附件托盘。
 * 返回 { take() → 附件列表并清空, has() }。
 */
export function installAttachments({ form, input }) {
  let items = [];
  const tray = document.createElement("div");
  tray.className = "att-tray";
  tray.hidden = true;
  form.before(tray);

  const picker = document.createElement("input");
  picker.type = "file";
  picker.multiple = true;
  picker.accept = "image/*,.txt,.md,.csv,.tsv,.json,.yaml,.yml,.log";
  picker.hidden = true;
  const clip = document.createElement("button");
  clip.type = "button";
  clip.className = "att-btn";
  clip.title = "导入文件（图片、csv、md、txt、json）。也可以直接粘贴截图，或拖进来";
  clip.setAttribute("aria-label", "导入文件或截图");
  clip.textContent = "📎";
  form.prepend(picker, clip);

  let note = "";
  const paint = () => {
    tray.hidden = !items.length && !note;
    tray.innerHTML = items.map((a, i) => `<span class="att">${a.kind === "image"
      ? `<img src="${a.preview}" alt="">` : `<i>📄</i>`}<span>${esc(a.name)}</span><button type="button" data-i="${i}" aria-label="去掉 ${esc(a.name)}">×</button></span>`).join("")
      + (note ? `<span class="att-note">${esc(note)}</span>` : "");
  };
  const add = async (files, pasted = false) => {
    note = "";
    for (const f of files) {
      if (items.length >= MAX) { note = `最多 ${MAX} 个附件`; break; }
      try {
        items.push(await readAttachment(f, pasted ? `截图-${new Date().toTimeString().slice(0, 8).replace(/:/g, "")}.png` : undefined));
      } catch (err) {
        note = err.message;
      }
    }
    paint();
    input.focus();
  };

  clip.addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => { add([...picker.files]); picker.value = ""; });
  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return; // 普通文字照常粘贴
    e.preventDefault();
    add(files, true);
  });
  const zone = form.closest(".composer") ?? form;
  zone.addEventListener("dragover", (e) => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); zone.classList.add("drop"); } });
  zone.addEventListener("dragleave", () => zone.classList.remove("drop"));
  zone.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    zone.classList.remove("drop");
    add([...e.dataTransfer.files]);
  });
  tray.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-i]");
    if (!b) return;
    const [gone] = items.splice(Number(b.dataset.i), 1);
    if (gone?.preview) URL.revokeObjectURL(gone.preview);
    note = "";
    paint();
  });

  return {
    has: () => items.length > 0,
    /** 取走附件（去掉只给页面用的 preview），清空托盘。 */
    take() {
      const out = items.map(({ preview, ...a }) => a);
      items.forEach((a) => a.preview && URL.revokeObjectURL(a.preview));
      items = [];
      note = "";
      paint();
      return out;
    },
  };
}

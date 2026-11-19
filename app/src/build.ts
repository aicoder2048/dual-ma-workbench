/**
 * 代码指纹：判断服务端启动以后，磁盘上的代码有没有变。
 *
 * 页面文件每次从磁盘现读（不缓存），服务端代码却停在启动那一刻。两者不一致时，新页面会调用
 * 旧服务端没有的接口、发旧服务端不认识的字段（例如附件被悄悄丢掉）。所以页面一连上就比对，
 * 变了就提醒重启。
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function codeFingerprint(dirs: string[]): string {
  const h = createHash("sha1");
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|js|html|css)$/.test(e.name)) h.update(p).update(readFileSync(p));
    }
  };
  dirs.forEach(walk);
  return h.digest("hex");
}

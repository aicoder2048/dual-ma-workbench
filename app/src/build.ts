/**
 * 代码指纹：判断服务端启动以后，磁盘上的代码有没有变。
 *
 * 服务端代码和启动时读进来的文件（SKILL.md、学习文章，进了引用库和提示词）停在启动那一刻；
 * 代码改了 bun --watch 会自动重启，但 Markdown 不在它的监视范围里。页面一连上就比对，变了就提醒重启。
 * 页面文件（public/）不算：页面每次从磁盘现读，刷新就是新的。
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** paths 里可以是目录（只看其中的代码文件）或单个文件；不存在的跳过。 */
export function codeFingerprint(paths: string[]): string {
  const h = createHash("sha1");
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|js|html|css)$/.test(e.name)) h.update(p).update(readFileSync(p));
    }
  };
  for (const p of paths) {
    if (!existsSync(p)) continue;
    if (statSync(p).isDirectory()) walk(p);
    else h.update(p).update(readFileSync(p));
  }
  return h.digest("hex");
}

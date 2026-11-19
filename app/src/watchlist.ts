/** 自选股：存成 data/watchlist.json（股票代码数组）。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { normalizeTicker } from "./analyze.ts";
import { PROJECT_ROOT } from "./sources.ts";

export const DEFAULT_WATCHLIST = ["NVDA", "TSLA", "AAPL", "GOOGL"];
const MAX_ITEMS = 50;

export class Watchlist {
  constructor(private file = resolve(PROJECT_ROOT, "data/watchlist.json")) {}

  list(): string[] {
    if (!existsSync(this.file)) return [...DEFAULT_WATCHLIST];
    const data = JSON.parse(readFileSync(this.file, "utf8"));
    if (!Array.isArray(data)) throw new Error(`${this.file} 应该是股票代码数组`);
    return data.map(String);
  }

  add(raw: string): string[] {
    const t = normalizeTicker(raw);
    const items = this.list();
    if (items.includes(t)) return items;
    if (items.length >= MAX_ITEMS) throw new Error(`自选股最多 ${MAX_ITEMS} 只`);
    return this.save([...items, t]);
  }

  remove(raw: string): string[] {
    const t = normalizeTicker(raw);
    return this.save(this.list().filter((x) => x !== t));
  }

  private save(items: string[]): string[] {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(items, null, 2) + "\n");
    return items;
  }
}

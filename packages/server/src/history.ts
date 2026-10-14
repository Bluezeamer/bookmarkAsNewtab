// ADR-007: 浏览历史——append-only 走普通存储（零依赖实现 = JSONL 文件）。
// 去重键 = url|visitedAt（补漏重复无害）; 超 10000 条裁剪最旧; 查询=服务端过滤
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface HistoryEntry {
  url: string;
  title: string;
  visitedAt: string; // ISO
}

const CAP = 10000;
const FILE = "history.jsonl";

class HistoryStore {
  private entries = new Map<string, HistoryEntry>();

  load(dataDir: string): void {
    const file = path.join(dataDir, FILE);
    if (!existsSync(file)) return;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t) as HistoryEntry;
        if (e.url && e.visitedAt) this.entries.set(this.key(e), e);
      } catch {
        // 坏行跳过（append-only 文件, 单行损坏不拖垮整体）
      }
    }
  }

  private key(e: HistoryEntry): string {
    return `${e.url}|${e.visitedAt}`;
  }

  append(dataDir: string, incoming: HistoryEntry[]): { added: number; total: number } {
    let added = 0;
    for (const e of incoming) {
      if (!e.url || !e.visitedAt) continue;
      const k = this.key(e);
      if (!this.entries.has(k)) {
        this.entries.set(k, { url: e.url, title: e.title ?? "", visitedAt: e.visitedAt });
        added++;
      }
    }
    if (this.entries.size > CAP) this.prune();
    if (added > 0) this.persist(dataDir);
    return { added, total: this.entries.size };
  }

  // 裁剪: 按 visitedAt 升序删最旧, 至 CAP
  private prune(): void {
    if (this.entries.size <= CAP) return;
    const sorted = [...this.entries.values()].sort((a, b) => a.visitedAt.localeCompare(b.visitedAt));
    const excess = this.entries.size - CAP;
    for (let i = 0; i < excess; i++) this.entries.delete(this.key(sorted[i]));
  }

  private persist(dataDir: string): void {
    const file = path.join(dataDir, FILE);
    const lines = [...this.entries.values()]
      .sort((a, b) => b.visitedAt.localeCompare(a.visitedAt))
      .map((e) => JSON.stringify(e));
    writeFileSync(file, lines.join("\n") + "\n");
  }

  query(opts: {
    keyword?: string;
    domain?: string;
    from?: string;
    to?: string;
    limit?: number;
  }): { total: number; entries: HistoryEntry[] } {
    let out = [...this.entries.values()];
    const kw = opts.keyword?.toLowerCase();
    if (kw) {
      out = out.filter(
        (e) => e.url.toLowerCase().includes(kw) || e.title.toLowerCase().includes(kw)
      );
    }
    if (opts.domain) {
      out = out.filter((e) => {
        try {
          return new URL(e.url).host === opts.domain;
        } catch {
          return false;
        }
      });
    }
    if (opts.from) out = out.filter((e) => e.visitedAt >= opts.from!);
    if (opts.to) out = out.filter((e) => e.visitedAt <= opts.to!);
    out.sort((a, b) => b.visitedAt.localeCompare(a.visitedAt));
    const limit = Math.min(opts.limit ?? 100, 1000);
    return { total: out.length, entries: out.slice(0, limit) };
  }
}

export const history = new HistoryStore();

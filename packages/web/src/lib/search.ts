// 统一搜索（能力块 7 · I2）: 书签（客户端过滤）× 历史（服务端查询）合并为分组命中
// 纯函数集中在此, 便于单测; 组件只负责取数/渲染/键盘
import { domainOf, filterBookmarks, type Bookmark, type Folder } from "./logic.ts";
import type { HistoryEntry } from "./history.ts";
import { engineSearchUrl, type SearchEngine } from "./engines.ts";

export const SEARCH_LIMIT = 8; // 每组面板最多展示条数（超出给"还有 N 条"提示）

export interface BookmarkHit {
  kind: "bookmark";
  id: string;
  title: string;
  url: string;
  folderName: string | null;
}

export interface HistoryHit {
  kind: "history";
  url: string;
  title: string;
  visitedAt: string;
}

// 能力块 9 · I2: 末尾的「用 <引擎> 搜索」行（行为对齐 xiaoshu 插件）
export interface EngineHit {
  kind: "engine";
  query: string;
  url: string;
  engineName: string;
}

export type SearchHit = BookmarkHit | HistoryHit | EngineHit;

export interface MergedHits {
  bookmarks: BookmarkHit[];
  history: HistoryHit[];
  bookmarkTotal: number; // 关键词过滤后的书签总数
  historyTotal: number; // 服务端返回的命中总数
  engine: EngineHit | null; // 回车默认要用的引擎搜索目标（**不再是面板里的一行**）
  flat: SearchHit[]; // 面板顺序 = 书签组 → 历史组（引擎行不计入, 否则 ↑↓ 会停在它上面）
}

export function engineHit(engine: SearchEngine, query: string): EngineHit {
  return { kind: "engine", query: query.trim(), url: engineSearchUrl(engine, query), engineName: engine.name };
}

export function mergeHits(
  bookmarks: Bookmark[],
  folders: Folder[],
  history: HistoryEntry[],
  historyTotal: number,
  query: string,
  limit = SEARCH_LIMIT,
  engine?: SearchEngine
): MergedHits {
  const matched = filterBookmarks(bookmarks, query).sort((a, b) => a.order - b.order);
  const bookmarkHits: BookmarkHit[] = matched.slice(0, limit).map((b) => ({
    kind: "bookmark",
    id: b.id,
    title: b.title,
    url: b.url,
    folderName: b.folder ? (folders.find((f) => f.id === b.folder)?.name ?? null) : null,
  }));
  const historyHits: HistoryHit[] = history.slice(0, limit).map((e) => ({
    kind: "history",
    url: e.url,
    title: e.title || e.url,
    visitedAt: e.visitedAt,
  }));
  const engineRow = engine && query.trim() ? engineHit(engine, query) : null;
  return {
    bookmarks: bookmarkHits,
    history: historyHits,
    bookmarkTotal: matched.length,
    historyTotal,
    engine: engineRow,
    flat: [...bookmarkHits, ...historyHits],
  };
}

export const EMPTY_HITS: MergedHits = {
  bookmarks: [],
  history: [],
  bookmarkTotal: 0,
  historyTotal: 0,
  engine: null,
  flat: [],
};

// 键盘移动: 跨两组循环（到边界回绕）; 无项返回 -1
export function moveIndex(current: number, delta: number, total: number): number {
  if (total <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : total - 1;
  return (current + delta + total) % total;
}

// 扁平索引 → 组归属与组内序号
export function groupOf(
  index: number,
  bookmarkCount: number,
  historyCount = Number.POSITIVE_INFINITY // 不传 → 视为全部剩余项都属历史组（旧调用兼容）
): { group: "bookmarks" | "history" | "engine"; indexInGroup: number } | null {
  if (index < 0) return null;
  if (index < bookmarkCount) return { group: "bookmarks", indexInGroup: index };
  const inHistory = index - bookmarkCount;
  return inHistory < historyCount
    ? { group: "history", indexInGroup: inHistory }
    : { group: "engine", indexInGroup: inHistory - historyCount };
}

// aria-activedescendant / 列表项 id（稳定且唯一）
export function hitId(hit: SearchHit, index: number): string {
  return `search-hit-${hit.kind}-${index}`;
}

// 面板项副标题（书签: 域名 + 文件夹; 历史: 域名）
export function hitSubtitle(hit: SearchHit): string {
  if (hit.kind === "engine") return `在 ${hit.engineName} 中搜索`;
  const host = domainOf(hit.url);
  if (hit.kind === "bookmark") return hit.folderName ? `${host} · ${hit.folderName}` : host;
  return host;
}

import { DEFAULT_DENSITY, parseDensity, type Density } from "./density.ts";
import { DEFAULT_ENGINE_ID, parseEngine } from "./engines.ts";

// 纯逻辑（可单测, 无 DOM/Yjs 依赖）: 搜索过滤 / 文件夹分组 / URL 归一化
export interface Bookmark {
  id: string;
  title: string;
  url: string;
  folder: string | null;
  order: number;
  created: string;
  // ADR-005: meta.auto 里的建议（未启用分类时永远为空）
  suggestion?: Suggestion;
}

// 自动分类建议（服务端写入 meta.auto）
export interface Suggestion {
  folder?: string;
  tags: string[];
}

// 标签存为逗号分隔字符串（服务端 CRDT 写入格式）；读前清洗
// 独立成 pure 函数便于单测与将来换格式
export function parseTagsCsv(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

// 从 meta.auto 原始值读出建议；无有效内容 → undefined（UI 就不渲染建议条）
export function readSuggestion(
  raw?: { suggestedFolder?: unknown; tags?: unknown }
): Suggestion | undefined {
  if (!raw) return undefined;
  const folder =
    typeof raw.suggestedFolder === "string" && raw.suggestedFolder.trim()
      ? raw.suggestedFolder.trim()
      : undefined;
  const tags = parseTagsCsv(raw.tags);
  if (!folder && tags.length === 0) return undefined;
  return { folder, tags };
}

export interface Folder {
  id: string;
  name: string;
  parent: string | null;
  order: number;
}

// 搜索: 标题/URL 子串, 大小写不敏感
export function filterBookmarks(list: Bookmark[], query: string): Bookmark[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    (b) => b.title.toLowerCase().includes(q) || b.url.toLowerCase().includes(q)
  );
}

// URL 归一化: 无 scheme 补 https://
export function normalizeUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  if (/^https?:\/\//i.test(t)) return t;
  return `https://${t}`;
}

// ============ 能力块 2: 层级树 / 重排 / 取色 / 偏好（纯函数, 可单测） ============

export interface TreeGroup {
  id: string | null; // null = 未分组（根）
  name: string;
  depth: number;
  children: TreeGroup[];
  bookmarks: Bookmark[]; // 直属（已按 order）
  total: number; // 含子树的条目数
}

const byOrder = <T extends { order: number }>(a: T, b: T, name: (x: T) => string): number =>
  a.order !== b.order ? a.order - b.order : name(a).localeCompare(name(b));

// 文件夹树 + 书签归类: 防环、孤儿（父不存在/自指）挂根、按 order 排序
export function buildGroups(folders: Folder[], bookmarks: Bookmark[]): TreeGroup {
  const known = new Set(folders.map((f) => f.id));

  // 父链归一（非法父 → 根）, 再按父分组
  const childrenOf = new Map<string | null, Folder[]>();
  for (const f of folders) {
    const parent = f.parent && f.parent !== f.id && known.has(f.parent) ? f.parent : null;
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), f]);
  }

  // 书签按 folder 归类（指向未知夹 → 根）
  const bookmarksOf = new Map<string | null, Bookmark[]>();
  for (const b of bookmarks) {
    const key = b.folder && known.has(b.folder) ? b.folder : null;
    bookmarksOf.set(key, [...(bookmarksOf.get(key) ?? []), b]);
  }

  const seen = new Set<string>();
  function build(id: string | null, depth: number): TreeGroup {
    const folder = id ? folders.find((x) => x.id === id) : undefined;
    const node: TreeGroup = {
      id,
      name: folder ? folder.name : "未分组",
      depth,
      children: [],
      bookmarks: [...(bookmarksOf.get(id) ?? [])].sort((a, b) => byOrder(a, b, (x) => x.title)),
      total: 0,
    };
    if (id) seen.add(id); // 先标记再递归 → 环不会无限展开
    for (const child of [...(childrenOf.get(id) ?? [])].sort((a, b) => byOrder(a, b, (x) => x.name))) {
      if (seen.has(child.id)) continue;
      node.children.push(build(child.id, depth + 1));
    }
    node.total = node.bookmarks.length + node.children.reduce((s, c) => s + c.total, 0);
    return node;
  }

  const tree = build(null, 0);
  // 环中未被访问到的文件夹 → 挂根（否则会彻底看不见）
  for (const f of folders) {
    if (!seen.has(f.id)) tree.children.push(build(f.id, 1));
  }
  tree.total = tree.bookmarks.length + tree.children.reduce((s, c) => s + c.total, 0);
  return tree;
}

// 搜索态下隐藏空分组（保留层级）; 非搜索态保留空文件夹（要可见可管）
export function pruneEmptyGroups(g: TreeGroup): TreeGroup {
  const children = g.children.map(pruneEmptyGroups).filter((c) => c.total > 0);
  return { ...g, children, total: g.bookmarks.length + children.reduce((s, c) => s + c.total, 0) };
}

export type Place = "before" | "after";

// 拖拽落点: 指针在目标中线上方 = 插到前面
// 注: 上半区宽度取整（非下舍）, 保证中线上方严格为 before
export function placementFromPointer(rectTop: number, rectHeight: number, pointerY: number): Place {
  return pointerY < rectTop + rectHeight / 2 ? "before" : "after";
}

// 把 fromId 移到 targetId 的前/后; 返回新序列（null = 无变化或 targetId 不在序列中）
// fromId 不在序列里时视为「插入」（用于跨文件夹拖拽: 先插入目标序列再落库）
export function reorderIds(
  ids: string[],
  fromId: string,
  targetId: string,
  place: Place
): string[] | null {
  if (fromId === targetId) return null;
  if (!ids.includes(targetId)) return null;
  const rest = ids.filter((x) => x !== fromId);
  const at = rest.indexOf(targetId);
  const cut = place === "before" ? at : at + 1;
  const next = [...rest.slice(0, cut), fromId, ...rest.slice(cut)];
  return next.join("\u0000") === ids.join("\u0000") ? null : next;
}

// 域名（去 www）; URL 非法返回空串
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// 首字母色块色相: 域名稳定哈希（FNV-1a）→ 0..359; 无网络请求（不用 favicon 服务）
export function hueForDomain(domain: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < domain.length; i++) {
    h ^= domain.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 360;
}

// ---------- 偏好（存 CRDT settings 区, 多端一致） ----------
// 能力块 10 · ①: 暗色主题与壁纸预设已移除 —— 世界固定为 Dawn 亮色（背景即设计的一部分）
// 视图模式（能力块 7 增 icons: 图标+名称、无卡片壳）
export const VIEWS = ["list", "grid", "icons"] as const;
export type View = (typeof VIEWS)[number];
// 侧边栏模式（能力块 7）: auto=按断点 / pinned=始终展开 / hidden=始终隐藏
// 实际形态由 lib/layout.ts 的 resolveSidebar(mode, width) 决定
export const SIDEBAR_MODES = ["auto", "pinned", "hidden"] as const;
export type SidebarMode = (typeof SIDEBAR_MODES)[number];
export interface Prefs {
  view: View;
  sidebar: SidebarMode;
  density: Density; // 能力块 8: 列表密度三档
  searchEngine: string; // 能力块 9 · I2: 默认搜索引擎 id
  gapX: number; // 能力块 10 · ③: 书签横向间距 px
  gapY: number; // 能力块 10 · ③: 书签纵向间距 px
  navRow: number; // 能力块 12 · ③: 侧栏导航行高 px（点击目标大小, 默认比原先大）
}

// 间距范围: 4~40px（步长 2）; 非法/越界一律 clamp（不信任远端写入）
export const GAP_MIN = 4;
export const GAP_MAX = 40;
export const GAP_DEFAULT = 14;
// 导航行高范围: 26~48px（步长 2）; 非法/越界一律 clamp
export const NAV_ROW_MIN = 26;
export const NAV_ROW_MAX = 48;
export const NAV_ROW_DEFAULT = 34;
export const parseNavRow = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return NAV_ROW_DEFAULT;
  return Math.min(NAV_ROW_MAX, Math.max(NAV_ROW_MIN, Math.round(n)));
};

export const parseGap = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return GAP_DEFAULT;
  return Math.min(GAP_MAX, Math.max(GAP_MIN, Math.round(n)));
};

export const DEFAULT_PREFS: Prefs = {
  view: "list",
  sidebar: "auto",
  density: DEFAULT_DENSITY,
  searchEngine: DEFAULT_ENGINE_ID,
  gapX: GAP_DEFAULT,
  gapY: GAP_DEFAULT,
  navRow: NAV_ROW_DEFAULT,
};

export const parseView = (v: unknown): View => (VIEWS.includes(v as View) ? (v as View) : "list");
export const parseSidebar = (v: unknown): SidebarMode =>
  SIDEBAR_MODES.includes(v as SidebarMode) ? (v as SidebarMode) : "auto";

// 非法/缺失值一律回退默认（不信任远端写入）
export function parsePrefs(raw?: {
  view?: unknown;
  sidebar?: unknown;
  density?: unknown;
  searchEngine?: unknown;
  gapX?: unknown;
  gapY?: unknown;
  navRow?: unknown;
}): Prefs {
  return {
    view: parseView(raw?.view),
    sidebar: parseSidebar(raw?.sidebar),
    density: parseDensity(raw?.density),
    searchEngine: parseEngine(raw?.searchEngine),
    gapX: parseGap(raw?.gapX),
    gapY: parseGap(raw?.gapY),
    navRow: parseNavRow(raw?.navRow),
  };
}

// ---- 文件夹编辑（能力块 19）----
// 自身 + 全部子孙（用于：归属下拉防环、级联删除范围、菜单里的影响面文案）
export function descendantFolderIds(folders: Folder[], id: string): Set<string> {
  const out = new Set<string>([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of folders) {
      if (!out.has(f.id) && f.parent !== null && out.has(f.parent)) {
        out.add(f.id);
        grew = true;
      }
    }
  }
  return out;
}

// 归属下拉的可选项 = 全部文件夹 - 自身 - 子孙（防环; 顶层用空值表示）
export function folderParentOptions(folders: Folder[], id: string): Folder[] {
  const exclude = descendantFolderIds(folders, id);
  return folders.filter((f) => !exclude.has(f.id));
}

// 级联删除的影响面（菜单文案里要如实告知"连同 N 条书签"）
export function folderSubtreeSize(
  folders: Folder[],
  bookmarks: Bookmark[],
  id: string,
): { folders: number; bookmarks: number } {
  const ids = descendantFolderIds(folders, id);
  return {
    folders: ids.size - 1, // 不含自身
    bookmarks: bookmarks.filter((b) => b.folder !== null && ids.has(b.folder)).length,
  };
}

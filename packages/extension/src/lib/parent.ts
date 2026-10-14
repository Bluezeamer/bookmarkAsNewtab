// 归属解析 + 待办队列（能力块 15）—— 纯函数, 便于单测
//
// 背景（用户实测）: `onBookmarkCreated` 曾把 Chrome 书签栏（id "1"）**硬编码成 null**,
// 而 Chrome 添加书签的默认目标就是书签栏 → **所有新加书签都落进"未分组"** ✗

export interface ParentLookup {
  /** Chrome 节点 id → CRDT 夹 id（未映射返回 undefined） */
  mapped: (chromeId: string) => string | undefined;
  /** 取 Chrome 节点的父 id（顶层返回 undefined） */
  parentOf: (chromeId: string) => string | undefined;
}

/**
 * 解析新节点应归属的 CRDT 夹:
 *   ① 直接映射命中 → 用它
 *   ② 未命中 → 沿 Chrome 祖先**向上找**第一个有映射的夹（新增书签到"未映射的新夹"里时不再退化成 null）
 *   ③ 都没有 → null（未分组兜底）
 * 环安全（seen 集合）。
 */
export function resolveParentFolder(pid: string | undefined, look: ParentLookup): string | null {
  if (!pid) return null;
  const seen = new Set<string>();
  let cur: string | undefined = pid;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const hit = look.mapped(cur);
    if (hit) return hit;
    cur = look.parentOf(cur);
  }
  return null;
}

// ---- 待办队列（schema 未就绪 / 写入失败的事件不能静默丢） ----
//
// ⚠️ 必须持久化**完整载荷**（review 第 1 轮阻塞项）: handler 靠"有没有 url"区分书签/文件夹、
// 靠 parentId 解析归属。只存 {id} 就重放 → 会把书签当成文件夹（造空名幽灵夹）、
// 把 moved 的 parentId 当 undefined（挪回未分组）、把文件夹删除当书签删除（空操作 + 悬空）✗
export interface PendingEvent {
  type: "created" | "removed" | "moved";
  chromeId: string;
  at: string;
  /** created: 节点信息（title/url 必有, parentId 可能缺 = 顶层） */
  title?: string;
  url?: string;
  parentId?: string;
  /** removed: 被删的是不是文件夹（handler 用它决定 remove / removeTree） */
  isFolder?: boolean;
}

/** 从持久化事件重建 handler 载荷（纯函数, 便于单测） */
export function toCreatedNode(ev: PendingEvent): {
  id: string;
  title: string;
  url?: string;
  parentId?: string;
} {
  return {
    id: ev.chromeId,
    title: ev.title ?? ev.url ?? "",
    ...(ev.url ? { url: ev.url } : {}),
    ...(ev.parentId ? { parentId: ev.parentId } : {}),
  };
}

export function toMovedInfo(ev: PendingEvent): { id: string; parentId: string } {
  return { id: ev.chromeId, parentId: ev.parentId ?? "" };
}

export function toRemovedInfo(ev: PendingEvent): { id: string; node: { url?: string } } {
  // handler 用 info.node.url 判断文件夹（缺 url = 文件夹）
  return { id: ev.chromeId, node: ev.isFolder ? {} : { url: ev.url ?? "" } };
}

export const PENDING_MAX = 200;

/** 入队: 按 (type, chromeId) 去重（同一节点的同类事件只留一条）+ 上限（丢最旧） */
export function enqueuePending(queue: PendingEvent[], ev: PendingEvent): PendingEvent[] {
  const rest = queue.filter((q) => !(q.type === ev.type && q.chromeId === ev.chromeId));
  const next = [...rest, ev];
  return next.length > PENDING_MAX ? next.slice(next.length - PENDING_MAX) : next;
}

/** 重放计划: 先 created（可能带来新映射）, 再 moved, 最后 removed（删除放最后, 避免先删后建） */
export function planPendingReplay(queue: PendingEvent[]): PendingEvent[] {
  const rank = { created: 0, moved: 1, removed: 2 } as const;
  return [...queue].sort((a, b) => rank[a.type] - rank[b.type] || a.at.localeCompare(b.at));
}

// ---- Chrome 书签事件参数解析（能力块 15 · E2E 实测 bug）----
//
// ⚠️ Chrome 的事件签名是 **(id, info)**:
//   onCreated(id, node)      node 自带 id
//   onRemoved(id, removeInfo) removeInfo **没有 id**（只有 parentId/index/node）
//   onMoved(id, moveInfo)     moveInfo **没有 id**（只有 parentId/index/oldParentId/oldIndex）
// 原先三个 handler 都写 `const info = (b ?? a)` → 取的是第二个参数 →
// **onRemoved/onMoved 的 info.id 恒 undefined → 早退 → 移动/删除从未生效过**（浏览器 E2E 实测）。
// 这里统一解析: 优先第一个参数的 id, 缺了再从第二个参数兜底（兼容旧签名/测试）。
export function parseCreatedArgs(
  a: unknown,
  b: unknown
): { id: string; title: string; url?: string; parentId?: string } | null {
  const first = typeof a === "string" ? a : undefined;
  const raw = (b ?? a) as { id?: string; title?: string; url?: string; parentId?: string } | undefined;
  const id = first ?? raw?.id;
  if (!id) return null;
  return {
    id,
    title: raw?.title ?? raw?.url ?? "",
    ...(raw?.url ? { url: raw.url } : {}),
    ...(raw?.parentId ? { parentId: raw.parentId } : {}),
  };
}

export function parseRemovedArgs(
  a: unknown,
  b: unknown
): { id: string; isFolder: boolean; url?: string } | null {
  const first = typeof a === "string" ? a : undefined;
  const raw = (b ?? a) as
    | { id?: string; node?: { url?: string } }
    | undefined;
  const id = first ?? raw?.id;
  if (!id) return null;
  const url = raw?.node?.url;
  return { id, isFolder: !url, ...(url ? { url } : {}) };
}

export function parseMovedArgs(a: unknown, b: unknown): { id: string; parentId?: string } | null {
  const first = typeof a === "string" ? a : undefined;
  const raw = (b ?? a) as { id?: string; parentId?: string } | undefined;
  const id = first ?? raw?.id;
  if (!id) return null;
  return { id, ...(raw?.parentId ? { parentId: raw.parentId } : {}) };
}

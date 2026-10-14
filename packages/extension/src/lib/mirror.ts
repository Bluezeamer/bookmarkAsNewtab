import type { Snapshot } from "./writeback.ts";
import { chromeFolderKey } from "./prune.ts";

// 全量镜像规划器（能力块 14 · ①）—— 纯函数, 便于单测
//
// 用途: popup 的「当前状态 → 浏览器书签」= 用 CRDT（用户意图）**覆盖** Chrome 书签。
// 与 planWriteback 的区别:
//   · planWriteback = 增量（对比上一轮快照, 只处理变化）—— 覆盖不到"新建"（缺 create 动作）
//   · planFullMirror = 全量（对比 CRDT 与**实际 Chrome 树**）—— 含 create/move/rename/remove
//
// 边界:
//   · 只动"CRDT 里有的"与"nodeMap 映射过的"节点 → 用户原生的 Chrome 书签不会被删
//   · 顺序用 index 近似（Chrome 的 index 受未映射节点影响）; 目标是可见顺序大体一致

export interface ChromeNode {
  id: string;
  parentId: string | null; // null = 顶层（Chrome 根）
  title: string;
  index: number;
  isFolder: boolean;
  url?: string;
}

export interface ChromeSnapshot {
  byId: Map<string, ChromeNode>;
  /** url → chromeId（用于识别"这个书签浏览器里已经有了"） */
  byUrl: Map<string, string>;
}

export type MirrorAction =
  | {
      kind: "createBookmark";
      crdtId: string;
      title: string;
      url: string;
      parentCrdt: string | null;
      index: number;
    }
  | { kind: "createFolder"; crdtId: string; title: string; parentCrdt: string | null; index: number }
  | { kind: "move"; chromeId: string; parentCrdt: string | null; index: number }
  | { kind: "rename"; chromeId: string; title: string }
  | { kind: "remove"; chromeId: string };


export function chromeSnapshotFromTree(
  nodes: { id: string; parentId?: string; title: string; index?: number; url?: string; children?: unknown[] }[],
  rootId = "0"
): ChromeSnapshot {
  const byId = new Map<string, ChromeNode>();
  const byUrl = new Map<string, string>();
  let order = 0;
  for (const n of nodes) {
    const isFolder = !n.url;
    const node: ChromeNode = {
      id: n.id,
      parentId: n.parentId === rootId ? null : (n.parentId ?? null),
      title: n.title,
      index: typeof n.index === "number" ? n.index : order++,
      isFolder,
      ...(n.url ? { url: n.url } : {}),
    };
    byId.set(n.id, node);
    if (n.url && !byUrl.has(n.url)) byUrl.set(n.url, n.id);
  }
  return { byId, byUrl };
}

export function planFullMirror(
  crdt: Snapshot,
  chrome: ChromeSnapshot,
  nodeMap: Record<string, string>
): MirrorAction[] {
  const crdtToChrome = new Map<string, string>();
  for (const [chromeId, crdtId] of Object.entries(nodeMap)) crdtToChrome.set(crdtId, chromeId);
  const out: MirrorAction[] = [];

  // 浏览器里已有的 (父ChromeId|名称) —— 未映射的 CRDT 夹若同名同父, 视为"已有", 不再重复创建
  const chromeFolderKeys = new Set(
    [...chrome.byId.values()].filter((n) => n.isFolder).map((n) => chromeFolderKey(n.parentId, n.title))
  );

  // 新建夹必须**父先于子**: 执行器新建后会立刻记映射, 子夹才能解析到正确的父 Chrome id
  // （否则父未映射时子夹会落到"书签栏"兜底位置）
  // 记忆化（review 第 7 轮）: 原实现在 sort 的每次比较里递归重算 = O(n²·depth)
  const depthMemo = new Map<string, number>();
  const depthOf = (id: string, seen = new Set<string>()): number => {
    const cached = depthMemo.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0; // 防环
    seen.add(id);
    const f = crdt.folders.get(id);
    const d = f?.parent ? 1 + depthOf(f.parent, seen) : 0;
    depthMemo.set(id, d);
    return d;
  };
  const foldersByDepth = [...crdt.folders.entries()].sort((a, b) => depthOf(a[0]) - depthOf(b[0]));

  // 1) 文件夹: 缺失 → 新建; 标题不同 → 改名
  for (const [crdtId, f] of foldersByDepth) {
    const chromeId = crdtToChrome.get(crdtId);
    const node = chromeId ? chrome.byId.get(chromeId) : undefined;
    if (!node || !chromeId) {
      // 同名同父的夹已存在 → 跳过（否则 force-to-chrome 会把初导入的夹再建一份）。
      // 但**父夹未映射**时不能跳过（review 第 6 轮）: 那时无法判断"同名同父"是否真的对应同一个夹,
      // 跳过会让该夹永远进不了 Chrome（剪枝侧对同一情形是保守保留, 口径要一致）。
      const parentChrome = f.parent ? crdtToChrome.get(f.parent) : null;
      if (f.parent && !parentChrome) {
        out.push({ kind: "createFolder", crdtId, title: f.name, parentCrdt: f.parent, index: f.order });
        continue;
      }
      if (chromeFolderKeys.has(chromeFolderKey(parentChrome, f.name))) continue;
      out.push({
        kind: "createFolder",
        crdtId,
        title: f.name,
        parentCrdt: f.parent,
        index: f.order,
      });
      continue;
    }
    if (node.title !== f.name) out.push({ kind: "rename", chromeId, title: f.name });
    // 层级变化也要镜像（能力块 14 · ①: 补上原 ROADMAP 的"文件夹 parent 不镜像"缺口）
    const wantParent = f.parent ? crdtToChrome.get(f.parent) : null;
    const parentMismatch =
      (f.parent === null && node.parentId !== null) ||
      (f.parent !== null && !!wantParent && node.parentId !== wantParent);
    if (parentMismatch) out.push({ kind: "move", chromeId, parentCrdt: f.parent, index: f.order });
  }

  // 2) 书签: 缺失 → 新建; 位置不同 → 移动; 标题不同 → 改名（Chrome 用 update 改名）
  for (const [crdtId, b] of crdt.bookmarks) {
    const chromeId = crdtToChrome.get(crdtId);
    const node = chromeId ? chrome.byId.get(chromeId) : undefined;
    if (!node || !chromeId) {
      // 同 URL 已在浏览器里（未映射）→ 不重复创建
      if (b.url && chrome.byUrl.has(b.url)) continue;
      out.push({
        kind: "createBookmark",
        crdtId,
        title: b.title,
        url: b.url,
        parentCrdt: b.folder,
        index: b.order,
      });
      continue;
    }
    const wantParentChrome = b.folder ? crdtToChrome.get(b.folder) : undefined;
    const parentMismatch =
      (b.folder === null && node.parentId !== null) ||
      (b.folder !== null && !!wantParentChrome && node.parentId !== wantParentChrome);
    if (parentMismatch || node.index !== b.order) {
      out.push({ kind: "move", chromeId, parentCrdt: b.folder, index: b.order });
    }
    if (b.title && node.title !== b.title) out.push({ kind: "rename", chromeId, title: b.title });
  }

  // 3) 浏览器里"映射过但 CRDT 已没有"的节点 → 删除（覆盖语义; 未映射的原生书签不动）
  for (const [crdtId, chromeId] of crdtToChrome) {
    if (crdt.bookmarks.has(crdtId) || crdt.folders.has(crdtId)) continue;
    if (chrome.byId.has(chromeId)) out.push({ kind: "remove", chromeId });
  }

  return out;
}


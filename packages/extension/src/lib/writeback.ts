// CRDT → Chrome 回写规划器（能力块 13 · ③）—— 纯函数, 便于单测
//
// 背景: SW 原先只做 Chrome → CRDT。于是 WebUI 里的删除/移动/改名不会回写 Chrome,
// 下次同步又会被"内容幂等导入"（同 URL 复用）加回来 —— 用户感受是"整理不算数"。
//
// 设计:
//   - **CRDT 是用户意图的真相**, Chrome 跟随（不做双向冲突合并）
//   - 只处理**有 nodeMap 映射**的节点（扩展自己导入的）; 用户原生的 Chrome 书签不动
//   - 输出动作列表, 由调用方执行（执行期置 applyingRemote 抑制回环）

export interface BmSnapshot {
  folder: string | null;
  order: number;
  title: string;
  url: string; // 全量镜像新建书签时必须用（能力块 14 · ①）
}
export interface FolderSnapshot {
  name: string;
  parent: string | null;
  order: number;
}
export interface Snapshot {
  bookmarks: Map<string, BmSnapshot>;
  folders: Map<string, FolderSnapshot>;
}

export type WbAction =
  | { kind: "removeBookmark"; crdtId: string; chromeId: string }
  | { kind: "moveBookmark"; crdtId: string; chromeId: string; folder: string | null; order: number }
  | { kind: "renameFolder"; crdtId: string; chromeId: string; title: string }
  | { kind: "removeFolder"; crdtId: string; chromeId: string }
  // 新建（能力块 19 增补）: 原实现只处理"已映射"的节点 → WebUI 里新建的夹/书签**永远不会**
  // 出现在浏览器里 ✗（mirror.ts 也明写了这个缺口）。这里补上增量 create。
  | { kind: "createFolder"; crdtId: string; title: string; parent: string | null; order: number }
  | {
      kind: "createBookmark";
      crdtId: string;
      title: string;
      url: string;
      folder: string | null;
      order: number;
    };

// nodeMap: chrome 节点 id → CRDT 条目 id; 这里要反向查（crdtId → chromeId）
// 导出供 SW 复用（执行 moveBookmark 时需要同样的反查）
export function reverseNodeMap(nodeMap: Record<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [chromeId, crdtId] of Object.entries(nodeMap)) out.set(crdtId, chromeId);
  return out;
}

// 熔断（数据丢失级防护）: prev 有相当数量映射节点, 而 next **几乎为空** →
// 更像"服务端文档被清空/损坏", 而不是用户真删了所有书签。
// 命中则跳过回写并告警, 且**不推进基线**（保留 prev 供人工处理后继续对比）。
export const WIPE_MIN_MAPPED = 20;
export function countMapped(snap: Snapshot, nodeMap: Record<string, string>): number {
  const byCrdt = reverseNodeMap(nodeMap);
  let n = 0;
  for (const id of snap.bookmarks.keys()) if (byCrdt.has(id)) n++;
  for (const id of snap.folders.keys()) if (byCrdt.has(id)) n++;
  return n;
}

// 熔断阈值: next 的映射节点数 < max(5, prev 映射数 × 10%) 即视为"可疑清空"。
// 早期实现只拦"完全为空" → 服务端文档**部分损坏**（还剩几条）时熔断不触发,
// 于是对 prev 里所有映射节点产出删除/删子树 = 批量删掉用户 Chrome 书签。
export function isSuspiciousWipe(
  prev: Snapshot,
  next: Snapshot,
  nodeMap: Record<string, string>,
  minMapped: number = WIPE_MIN_MAPPED
): boolean {
  const prevMapped = countMapped(prev, nodeMap);
  if (prevMapped < minMapped) return false; // 新用户/小数据集不熔断（避免误拦）
  const floor = Math.max(5, Math.floor(prevMapped * 0.1));
  return countMapped(next, nodeMap) < floor;
}

export function planWriteback(
  prev: Snapshot,
  next: Snapshot,
  nodeMap: Record<string, string>,
  /** 浏览器里**已有**的 URL（用于避免把 WebUI 新建的书签重复创建到 Chrome） */
  chromeUrls: Set<string> = new Set()
): WbAction[] {
  const byCrdt = reverseNodeMap(nodeMap);
  const out: WbAction[] = [];

  // 0) 新建**必须最先**（能力块 19 增补 · review 自省）: 若排在 move 之后, 把书签移动到
  // "本轮刚新建的夹"会因为目标还没有映射而被跳过, 且基线已前移 → 该移动永久丢失 ✗
  // 新建: prev 里没有、也没有映射的 CRDT 节点 → 在 Chrome 侧创建
  //    文件夹按**深度**排序（父先于子）—— 执行器边建边记映射, 子夹才能挂到正确的父
  const depthMemo = new Map<string, number>();
  const depthOf = (id: string, seen = new Set<string>()): number => {
    const cached = depthMemo.get(id);
    if (cached !== undefined) return cached;
    const f = next.folders.get(id);
    if (!f?.parent || seen.has(id)) return 0;
    seen.add(id);
    const d = 1 + depthOf(f.parent, seen);
    depthMemo.set(id, d);
    return d;
  };
  const newFolders = [...next.folders.entries()]
    .filter(([id]) => !prev.folders.has(id) && !byCrdt.has(id))
    .sort((a, b) => depthOf(a[0]) - depthOf(b[0]));
  for (const [crdtId, f] of newFolders) {
    if (f.parent && !next.folders.has(f.parent)) continue; // 悬空父 → 等下一轮
    out.push({ kind: "createFolder", crdtId, title: f.name, parent: f.parent, order: f.order });
  }
  for (const [crdtId, b] of next.bookmarks) {
    if (prev.bookmarks.has(crdtId) || byCrdt.has(crdtId)) continue;
    if (b.url && chromeUrls.has(b.url)) continue; // 浏览器里已有同 URL → 不重复创建
    out.push({ kind: "createBookmark", crdtId, title: b.title, url: b.url, folder: b.folder, order: b.order });
  }


  // 1) 书签: 消失 → 删除; 归属/顺序变化 → 移动（Chrome 的 index 用 order 近似, 只求可见顺序一致）
  for (const [crdtId, before] of prev.bookmarks) {
    const chromeId = byCrdt.get(crdtId);
    if (!chromeId) continue; // 未映射（非扩展导入）→ 不动
    const after = next.bookmarks.get(crdtId);
    if (!after) {
      out.push({ kind: "removeBookmark", crdtId, chromeId });
      continue;
    }
    if (after.folder !== before.folder || after.order !== before.order) {
      out.push({
        kind: "moveBookmark",
        crdtId,
        chromeId,
        folder: after.folder,
        order: after.order,
      });
    }
  }

  // 2) 文件夹: 消失 → 删子树; 改名 → update
  for (const [crdtId, before] of prev.folders) {
    const chromeId = byCrdt.get(crdtId);
    if (!chromeId) continue;
    const after = next.folders.get(crdtId);
    if (!after) {
      out.push({ kind: "removeFolder", crdtId, chromeId });
      continue;
    }
    if (after.name !== before.name) {
      out.push({ kind: "renameFolder", crdtId, chromeId, title: after.name });
    }
  }

  return out;
}

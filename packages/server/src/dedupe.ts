// 书签去重（重复导入事故的清理与兜底）
// 触发场景: 扩展重装（新扩展 ID → chrome.storage 清空 → nodeMap 丢失）→ 全量再导入 → 同 URL 多份
// 策略: 同 URL 只保留一份（优先 Y.Map 节点 → created 最早 → id 最小）; 同时合并同名文件夹
import * as Y from "yjs";

export interface DedupeStats {
  bookmarksBefore: number;
  bookmarksAfter: number;
  removed: number;
  foldersMerged: number;
  danglingFixed: number;
  danglingFolderParents: number;
}

function fields(v: unknown): Record<string, unknown> {
  if (v instanceof Y.Map) {
    const o: Record<string, unknown> = {};
    for (const k of ["title", "url", "folder", "order", "created"]) o[k] = v.get(k);
    return o;
  }
  return (v as Record<string, unknown>) ?? {};
}

// 保留优先级: Y.Map 节点 > 普通对象; created 早 > 晚; id 小 > 大（确定性）
function better(
  a: { id: string; shape: number; created: string },
  b: { id: string; shape: number; created: string }
): boolean {
  if (a.shape !== b.shape) return a.shape > b.shape;
  if (a.created !== b.created) return a.created < b.created;
  return a.id < b.id;
}

export function dedupeBookmarks(doc: Y.Doc): DedupeStats {
  const root = doc.getMap("");
  const bookmarks = root.get("bookmarks");
  const folders = root.get("folders");
  if (!(bookmarks instanceof Y.Map)) {
    return {
      bookmarksBefore: 0,
      bookmarksAfter: 0,
      removed: 0,
      foldersMerged: 0,
      danglingFixed: 0,
      danglingFolderParents: 0,
    };
  }

  // ---- 1) 文件夹合并（迭代到不动点）----
  // 关键: 合并会改变子夹的 parent 键（c-old: f-old → f-new）,
  // 因此每轮必须先把「夹→夹」引用按 folderRemap 重定向, 再按重定向后的 父|名 合并 ——
  // 否则嵌套重复导入会留下孤儿子夹 + 重复子夹（审计发现的缺陷）
  let foldersMerged = 0;
  const folderRemap = new Map<string, string>(); // 被删夹 → 保留夹
  if (folders instanceof Y.Map) {
    const fmap = folders as Y.Map<unknown>;
    const setParent = (id: string, v: unknown, parent: string | null): void => {
      if (v instanceof Y.Map) v.set("parent", parent);
      else fmap.set(id, { ...fields(v), parent });
    };
    for (let round = 0; round < 16; round++) {
      // (a) 夹→夹 引用重定向
      doc.transact(() => {
        for (const [id, v] of fmap) {
          const f = fields(v);
          const cur = typeof f.parent === "string" ? f.parent : null;
          if (cur && folderRemap.has(cur) && folderRemap.get(cur) !== cur) {
            setParent(id, v, folderRemap.get(cur)!);
          }
        }
      });
      // (b) 按 父|名 分组, 合并同名同父
      const groups = new Map<string, { id: string; created: string }[]>();
      for (const [id, v] of fmap) {
        const f = fields(v);
        const key = `${typeof f.parent === "string" ? f.parent : ""}|${String(f.name ?? "").trim()}`;
        groups.set(key, [...(groups.get(key) ?? []), { id, created: String(f.created ?? "") }]);
      }
      const merges = [...groups.values()].filter((l) => l.length > 1);
      if (merges.length === 0) break; // 不动点
      doc.transact(() => {
        for (const list of merges) {
          const sorted = [...list].sort((a, b) =>
            a.created !== b.created ? a.created.localeCompare(b.created) : a.id.localeCompare(b.id)
          );
          const keep = sorted[0].id;
          for (const drop of sorted.slice(1)) {
            folderRemap.set(drop.id, keep);
            fmap.delete(drop.id);
            foldersMerged++;
          }
        }
      });
    }
  }

  // ---- 2) 同 URL 去重（保留一份, 并尽量不丢归属信息）----
  let removed = 0;
  let danglingFixed = 0;
  let danglingFolderParents = 0;
  const bookmarksBefore = bookmarks.size;
  const byUrl = new Map<string, { id: string; shape: number; created: string; folder: string | null }[]>();
  for (const [id, v] of bookmarks) {
    const f = fields(v);
    const url = String(f.url ?? "").trim();
    if (!url) continue;
    const folder = typeof f.folder === "string" ? f.folder : null;
    byUrl.set(url, [
      ...(byUrl.get(url) ?? []),
      { id, shape: v instanceof Y.Map ? 1 : 0, created: String(f.created ?? ""), folder },
    ]);
  }

  doc.transact(() => {
    for (const list of byUrl.values()) {
      if (list.length < 2) continue;
      const sorted = [...list].sort((a, b) => (better(a, b) ? -1 : 1));
      const keeper = sorted[0];
      const dropped = sorted.slice(1);
      // 保留者若没有归属、而被删的有 → 采纳（尽量保住信息）
      const keeperFolder = keeper.folder ? (folderRemap.get(keeper.folder) ?? keeper.folder) : null;
      let adopted = keeperFolder;
      if (!adopted) {
        for (const d of dropped) {
          const f = d.folder ? (folderRemap.get(d.folder) ?? d.folder) : null;
          if (f) {
            adopted = f;
            break;
          }
        }
      }
      const node = bookmarks.get(keeper.id);
      if (node instanceof Y.Map) {
        const cur = node.get("folder");
        const curRemapped = typeof cur === "string" ? (folderRemap.get(cur) ?? cur) : null;
        if (curRemapped !== adopted) node.set("folder", adopted);
      } else if (fields(node).folder !== adopted) {
        // 旧普通对象节点: 就地重写 folder（保持旧形状, 迁移交给其它写入路径）
        bookmarks.set(keeper.id, { ...fields(node), folder: adopted });
      }
      for (const d of dropped) {
        bookmarks.delete(d.id);
        removed++;
      }
    }
    // 剩余书签里仍指向被合并文件夹的 → 重定向
    for (const [id, v] of bookmarks) {
      const f = fields(v);
      const cur = typeof f.folder === "string" ? f.folder : null;
      if (cur && folderRemap.has(cur)) {
        const target = folderRemap.get(cur)!;
        if (v instanceof Y.Map) v.set("folder", target);
        else bookmarks.set(id, { ...f, folder: target });
      }
    }
    // 悬空归属: 指向不存在文件夹的 → 归到未分组
    // （重复导入事故会造成“书签指向从未创建的文件夹 id”, 表现为归属看不见）
    const alive = folders instanceof Y.Map ? new Set(folders.keys()) : new Set<string>();
    for (const [id, v] of bookmarks) {
      const f = fields(v);
      const cur = typeof f.folder === "string" ? f.folder : null;
      if (cur && !alive.has(cur)) {
        if (v instanceof Y.Map) v.set("folder", null);
        else bookmarks.set(id, { ...f, folder: null });
        danglingFixed++;
      }
    }
    // 悬空父夹: parent 指向不存在文件夹的 → 提升到根（避免孤儿子夹看不见）
    if (folders instanceof Y.Map) {
      for (const [id, v] of folders) {
        const f = fields(v);
        const cur = typeof f.parent === "string" ? f.parent : null;
        if (cur && !alive.has(cur)) {
          if (v instanceof Y.Map) v.set("parent", null);
          else folders.set(id, { ...f, parent: null });
          danglingFolderParents++;
        }
      }
    }
  });

  return {
    bookmarksBefore,
    bookmarksAfter: bookmarks.size,
    removed,
    foldersMerged,
    danglingFixed,
    danglingFolderParents,
  };
}

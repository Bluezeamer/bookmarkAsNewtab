// 侧栏树与文件夹拖拽的纯逻辑（能力块 9 · I1）
// 目标: 同层排序 + 跨层改父级（防环是数据完整性红线）
import type { Folder } from "./logic.ts";

export type DropZone = "before" | "inside" | "after";

// 某个文件夹的全部子孙 id（不含自身）
export function descendantIds(folders: Folder[], id: string): Set<string> {
  const out = new Set<string>();
  const byParent = new Map<string | null, Folder[]>();
  for (const f of folders) byParent.set(f.parent, [...(byParent.get(f.parent) ?? []), f]);
  const walk = (pid: string) => {
    for (const child of byParent.get(pid) ?? []) {
      if (out.has(child.id)) continue; // 防异常数据成环
      out.add(child.id);
      walk(child.id);
    }
  };
  walk(id);
  return out;
}

// 能否把 id 挂到 targetId 下（targetId=null 表示顶层）
// 非法: 自身、自己的子孙（会成环）
export function canReparent(folders: Folder[], id: string, targetId: string | null): boolean {
  if (targetId === null) return true;
  if (targetId === id) return false;
  return !descendantIds(folders, id).has(targetId);
}

// 落点三区: 上 1/4 = 之前, 下 1/4 = 之后, 中 1/2 = 放入
export function dropZoneOf(y: number, top: number, height: number): DropZone {
  const rel = y - top;
  if (rel < height * 0.25) return "before";
  if (rel > height * 0.75) return "after";
  return "inside";
}

export interface ReparentPlan {
  parent: string | null;
  orderedIds: string[]; // 目标父级下的新同层顺序
}

// 计算「改父级 + 同层插入」的计划（纯函数）; 非法/无变化 → null
export function reparentSiblings(
  folders: Folder[],
  id: string,
  targetId: string | null,
  zone: DropZone
): ReparentPlan | null {
  const me = folders.find((f) => f.id === id);
  if (!me) return null;
  if (!canReparent(folders, id, targetId)) return null;

  const siblingsOf = (parent: string | null) =>
    folders
      .filter((f) => f.parent === parent && f.id !== id)
      .sort((a, b) => a.order - b.order)
      .map((f) => f.id);

  if (targetId === null) {
    // 提升到顶层: 追加到末尾（拖到「未分组」行/空白区的语义）
    const next = [...siblingsOf(null), id];
    return { parent: null, orderedIds: next };
  }

  const target = folders.find((f) => f.id === targetId);
  if (!target) return null;

  if (zone === "inside") {
    const next = [...siblingsOf(targetId), id];
    return { parent: targetId, orderedIds: next };
  }
  const parent = target.parent;
  const list = siblingsOf(parent);
  const at = list.indexOf(targetId);
  if (at < 0) return null;
  const cut = zone === "before" ? at : at + 1;
  const next = [...list.slice(0, cut), id, ...list.slice(cut)];
  return { parent, orderedIds: next };
}

// 折叠状态下的可见序列（供渲染/测试）: depth 与父链由调用方 TreeGroup 提供
export function visibleIds(
  nodes: { id: string | null; children: { id: string | null; children: unknown[] }[] }[],
  collapsed: Set<string>
): (string | null)[] {
  const out: (string | null)[] = [];
  const walk = (list: typeof nodes) => {
    for (const n of list) {
      out.push(n.id);
      if (n.id && collapsed.has(n.id)) continue;
      walk(n.children as typeof nodes);
    }
  };
  walk(nodes);
  return out;
}

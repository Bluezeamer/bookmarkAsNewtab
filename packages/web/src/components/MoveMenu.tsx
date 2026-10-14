import { buildGroups, type Folder } from "../lib/logic";
import type { MenuItem } from "./ContextMenu";

// 「移动到…」的二级菜单内容（能力块 10 · ③）
// 由 ContextMenu 渲染成菜单项: 键盘/触摸/鼠标同一条路径（原来的常驻 <select> 已移除, 被卡片菜单取代）
// 路径标签沿用同一套树逻辑（父 / 子）, 与侧栏树、编辑弹窗的层级写法一致
export function moveTargetItems(
  folders: Folder[],
  current: string | null,
  onMove: (folderId: string | null) => void,
): MenuItem[] {
  const out: MenuItem[] = [
    { key: "__root__", label: "未分组", current: current === null, run: () => onMove(null) },
  ];
  const walk = (nodes: ReturnType<typeof buildGroups>["children"], prefix: string) => {
    for (const n of nodes) {
      if (n.id) {
        const id = n.id;
        out.push({
          key: id,
          label: `${prefix}${n.name}`,
          current: current === id,
          run: () => onMove(id),
        });
      }
      walk(n.children, `${prefix}${n.name} / `);
    }
  };
  walk(buildGroups(folders, []).children, "");
  return out;
}

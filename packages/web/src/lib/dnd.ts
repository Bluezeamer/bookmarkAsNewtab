// 拖拽契约（能力块 7 · I3, 参考 小舒同学/SortableJS 的做法重写）
// 原则（消除频闪）:
//   1) 拖动中**不重排真实列表**（没有每帧 React 状态变更 → 无重渲染、无动画重启）
//   2) 浮动副本 = 脱离 React 的 DOM 克隆, 用 transform 直接移动（零重渲染）
//   3) 只在**跨槽位**时更新一个 dropIndex（每次一格, 触发一次让位动画）
//   4) 落定才提交 CRDT
import type { PointerEvent as ReactPointerEvent } from "react";

export interface DragState {
  id: string;
  folder: string | null; // 源分组（null = 未分组）
}

export interface DndApi {
  /** 搜索态禁用（可见序列是子集, 重排会打乱隐藏项） */
  enabled: boolean;
  dragging: DragState | null;
  /** 目标槽位（该分组内第几个位置; null = 不在本分组上方） */
  dropIndex: number | null;
  /** 指针当前悬停的分组（移夹高亮; "root" 归一为 null） */
  dropFolderId: string | null;
  /** 卡片 pointerdown 武装: 位移超过阈值才真正进入拖拽（否则视为点击） */
  armDrag: (e: ReactPointerEvent<HTMLElement>, id: string, folder: string | null) => void;
  /** 键盘等价路径: 聚焦卡片后 Alt+↑/↓ 同组内移动一位 */
  keyMove: (id: string, dir: -1 | 1) => void;
}

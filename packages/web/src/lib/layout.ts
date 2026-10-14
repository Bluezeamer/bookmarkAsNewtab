// 布局决策（纯函数, 可单测）: 侧边栏三档响应式（能力块 7 · I1）
// 形态: expanded(240px) / rail(56px 窄条) / overlay(隐藏, 顶栏按钮唤出浮层)
import type { SidebarMode } from "./logic.ts";

// 断点: ≥rail 展开; (overlay, rail) 窄条; ≤overlay 隐藏为浮层
export const BREAKPOINTS = { rail: 1280, overlay: 640 } as const;

export type SidebarShape = "expanded" | "rail" | "overlay";

export function resolveSidebar(mode: SidebarMode, width: number): SidebarShape {
  // 手动固定: 大屏展开、小屏（手机）仍只能浮层（无空间并置）
  if (mode === "pinned") return width <= BREAKPOINTS.overlay ? "overlay" : "expanded";
  // 手动隐藏: 一律浮层
  if (mode === "hidden") return "overlay";
  // auto: 按宽度
  if (width >= BREAKPOINTS.rail) return "expanded";
  if (width > BREAKPOINTS.overlay) return "rail";
  return "overlay";
}

// 主内容列宽策略（供测试与未来列数计算; 实际由 CSS auto-fill 承担）
export function contentColumns(shape: SidebarShape, width: number): number {
  const min = 260;
  const sidebar = shape === "expanded" ? 240 + 24 : shape === "rail" ? 56 + 16 : 0;
  const avail = Math.max(width - sidebar - 48, min);
  return Math.max(1, Math.floor(avail / min));
}

// 侧边栏条目（纯函数, 供 Sidebar 组件与测试共用）
export interface SidebarItem {
  key: string; // "all" | "root" | 文件夹 id
  groupId: string | null; // 对应 section[data-group]
  name: string;
  depth: number;
  count: number;
  isAll?: boolean;
}

// 把分组树压平成侧边栏条目: 「全部」+ 未分组 + 文件夹（层级缩进）

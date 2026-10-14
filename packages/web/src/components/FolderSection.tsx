import { Fragment, useRef, useState } from "react";
import type { Bookmark, Folder, TreeGroup, View } from "../lib/logic";
import { LIST_MIN_COL, densityParams, type Density } from "../lib/density";
import { folderSubtreeSize } from "../lib/logic";
import { deleteFolder, moveFolder } from "../lib/crdt";
import type { DndApi } from "../lib/dnd";
import BookmarkItem from "./BookmarkItem";
import ContextMenu, { MenuIcon, type MenuItem } from "./ContextMenu";

// 目标槽位占位（拖拽中显示; 尺寸随视图变化, 让后续卡片自然让位）
function DropSlot({ view, density }: { view: View; density: Density }) {
  const p = densityParams(density);
  const h = view === "icons" ? p.iconGrid + 46 : p.rowH;
  return (
    <div
      data-dnd-placeholder
      aria-hidden
      style={{ minHeight: h }}
      className="rounded-[var(--radius-card)] border border-dashed border-accent/40 bg-accent/[0.06]"
    />
  );
}

// 分组渲染: 根（未分组）+ 文件夹层级递归; 既是拖拽目标也能被拖拽排序
// 能力块 10 · ③: 常驻的 ↑/↓/删除 实体按钮换成标题上的「更多」+ 右键菜单（复用同一份 moveFolder/deleteFolder）
export default function FolderSection({
  group,
  folders,
  view,
  density,
  dnd,
  bookmarks,
  onEdit,
  onEditFolder,
  onNewFolder,
  menu,
  onMenuOpen,
  onMenuClose,
}: {
  group: TreeGroup;
  folders: Folder[];
  view: View;
  density: Density;
  dnd: DndApi;
  /** 全部书签（用于级联删除的影响面文案: 能力块 19） */
  bookmarks: Bookmark[];
  onEdit: (b: Bookmark) => void;
  onEditFolder: (f: Folder) => void;
  onNewFolder: (parent: string | null) => void;
  /** 本分组内条目打开的菜单（由 BookmarkList 持有: 触摸长按在拖拽引擎里判定） */
  menu: { id: string; x: number; y: number } | null;
  onMenuOpen: (id: string, x: number, y: number) => void;
  onMenuClose: () => void;
}) {
  const dp = densityParams(density);
  const isRoot = group.id === null;
  const dropActive = dnd.dragging !== null && dnd.dropFolderId === group.id;
  // 占位槽只画在源分组内（跨分组时松手才落定）
  const showSlot =
    dnd.dragging !== null &&
    dnd.dragging.folder === group.id &&
    dnd.dropIndex !== null &&
    dnd.dropIndex >= 0;

  // 分组标题菜单（能力块 19 起含「编辑文件夹」）
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number } | null>(null);
  const folderBtnRef = useRef<HTMLButtonElement | null>(null);
  const self = folders.find((f) => f.id === group.id) ?? null;
  const size = group.id ? folderSubtreeSize(folders, bookmarks, group.id) : null;
  const folderMenuItems: MenuItem[] = isRoot
    ? []
    : [
        {
          key: "new",
          label: "新建子文件夹…",
          icon: "plus",
          run: () => onNewFolder(group.id),
        },
        {
          key: "edit",
          label: "编辑文件夹…",
          icon: "edit",
          run: () => self && onEditFolder(self),
        },
        {
          key: "up",
          label: "文件夹上移",
          icon: "up",
          run: () => moveFolder(group.id!, -1, folders),
        },
        {
          key: "down",
          label: "文件夹下移",
          icon: "down",
          run: () => moveFolder(group.id!, 1, folders),
        },
        {
          key: "delete",
          // 能力块 19: 级联删除（含子文件夹与其书签）→ 文案必须如实告知影响面
          label: `删除文件夹（连同 ${size?.bookmarks ?? 0} 条书签${size?.folders ? `、${size.folders} 个子文件夹` : ""}）`,
          icon: "delete",
          danger: true,
          run: () => deleteFolder(group.id!),
        },
      ];

  return (
    <section
      data-group={group.id ?? "root"}
      data-depth={group.depth}
      // 注意: 不要在这里写内联 scrollMarginTop —— 曾经的锚点变量方案已被"瞬时居中跳转"取代,
      // 任何内联偏移都会与居中跳转的落点互相干扰
      style={{ marginLeft: group.depth > 1 ? (group.depth - 1) * 14 : 0 }}
      className={group.depth > 1 ? "border-l border-ink/15 pl-3" : ""}
    >
      {/* 未分组为空时隐藏标题（能力块 15 · D）: 归属修好后它通常为空, 显示"未分组 0"会像遗留物 */}
      {!(isRoot && group.bookmarks.length === 0 && group.children.length > 0) && (
      <div
        data-drop-group={group.id ?? "root"}
        data-drop-active={dropActive ? "true" : undefined}
        // 拖拽悬停高亮: .glass-card 的底色是未分层规则, 工具类盖不住 → 用内联样式表达状态
        style={
          dropActive
            ? {
                background: "rgba(85,88,224,0.16)",
                boxShadow: "var(--shadow-card), 0 0 0 3px rgba(85,88,224,0.22)",
              }
            : undefined
        }
        onContextMenu={(e) => {
          if (isRoot) return;
          e.preventDefault();
          setFolderMenu({ x: e.clientX, y: e.clientY });
        }}
        className="glass-card mb-2 flex items-center gap-2 px-3 py-1.5"
      >
        {!isRoot && (
          <span className="shrink-0 text-ink-3">
            <MenuIcon name="folder" />
          </span>
        )}
        <h2 className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink">
          {isRoot ? "未分组" : group.name}
        </h2>
        <span className="shrink-0 rounded-full bg-ink/[0.07] px-1.5 py-0.5 text-[11.5px] leading-none font-medium text-ink-2 tabular-nums">
          {group.total}
        </span>
        {!isRoot && (
          <button
            ref={folderBtnRef}
            data-group-menu={group.id}
            onClick={() => {
              const r = folderBtnRef.current?.getBoundingClientRect();
              setFolderMenu({ x: Math.round(r?.left ?? 0), y: Math.round((r?.bottom ?? 0) + 4) });
            }}
            title="文件夹操作"
            aria-haspopup="menu"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-ink/[0.06] hover:text-ink max-sm:h-11 max-sm:w-11"
          >
            <MenuIcon name="more" />
          </button>
        )}
      </div>
      )}

      {folderMenu && (
        <ContextMenu
          x={folderMenu.x}
          y={folderMenu.y}
          items={folderMenuItems}
          onClose={() => setFolderMenu(null)}
          returnFocusTo={folderBtnRef.current}
          label={`文件夹 ${group.name}`}
        />
      )}

      {group.bookmarks.length > 0 && (
        <div
          data-items-group={group.id ?? "root"}
          data-drag-folder={dnd.dragging?.folder ?? ""}
          data-drop-index={dnd.dropIndex === null ? "" : String(dnd.dropIndex)}
          className={view === "grid" ? "bk-grid" : view === "icons" ? "icon-grid" : ""}
          style={
            {
              // 能力块 8（spec Design）: 尺寸走 CSS 变量注入, 卡片/行/标题从中取值 —— 机制保持不动
              "--bnt-card-min": `${dp.cardMin}px`,
              "--bnt-row-h": `${dp.rowH}px`,
              "--bnt-pad": `${dp.pad}px`,
              "--bnt-icon": `${dp.iconCard}px`,
              "--bnt-icon-lg": `${dp.iconGrid}px`,
              "--bnt-title": `${dp.titlePx}px`,
              // 能力块 10 · ③: 栅格间距由偏好 --bnt-gap-x/--bnt-gap-y 驱动
              // （卡片/仅图标走 .bk-grid / .icon-grid, 列表形态在这里消费同一对变量）
              ...(view === "list"
                ? {
                    display: "grid" as const,
                    columnGap: "var(--bnt-gap-x, 14px)",
                    rowGap: "var(--bnt-gap-y, 14px)",
                  }
                : {}),
              gridTemplateColumns:
                view === "list"
                  ? `repeat(auto-fill, minmax(${LIST_MIN_COL}px, 1fr))`
                  : view === "grid"
                    ? `repeat(auto-fill, minmax(var(--bnt-card-min, 230px), 1fr))`
                    : `repeat(auto-fill, minmax(calc(var(--bnt-icon-lg, 40px) * 2.4), 1fr))`,
            } as React.CSSProperties
          }
        >
          {group.bookmarks.map((b, i) => (
            <Fragment key={b.id}>
              {showSlot && dnd.dropIndex === i && <DropSlot view={view} density={density} />}
              <BookmarkItem
                bookmark={b}
                folders={folders}
                view={view}
                density={density}
                dnd={dnd}
                onEdit={onEdit}
                menu={menu?.id === b.id ? { x: menu.x, y: menu.y } : null}
                onMenuOpen={(x, y) => onMenuOpen(b.id, x, y)}
                onMenuClose={onMenuClose}
              />
            </Fragment>
          ))}
          {showSlot && dnd.dropIndex === group.bookmarks.length && (
            <DropSlot view={view} density={density} />
          )}
        </div>
      )}

      {group.children.length > 0 && (
        <div className="mt-3 space-y-4">
          {group.children.map((child) => (
            <FolderSection
              key={child.id}
              group={child}
              folders={folders}
              view={view}
              density={density}
              dnd={dnd}
              bookmarks={bookmarks}
              onEdit={onEdit}
              onEditFolder={onEditFolder}
              onNewFolder={onNewFolder}
              menu={menu}
              onMenuOpen={onMenuOpen}
              onMenuClose={onMenuClose}
            />
          ))}
        </div>
      )}
    </section>
  );
}

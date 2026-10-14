import { useRef } from "react";
import { domainOf, type Bookmark, type Folder, type View } from "../lib/logic";
import { densityParams, type Density } from "../lib/density";
import { acceptSuggestion, deleteBookmark, dismissSuggestion, moveBookmarkTo } from "../lib/crdt";
import { DRAG_THRESHOLD } from "../lib/dnd-math";
import type { DndApi } from "../lib/dnd";
import BookmarkIcon from "./BookmarkIcon";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import { moveTargetItems } from "./MoveMenu";

// 书签条目: 列表行 / 卡片 / 仅图标 三形态（同一组件, 三手势三形态都不漂移）
//   ① 点击（按下即松） = 打开链接: 整条是 <a target=_blank rel=noopener>（原生新标签/中键/键盘 Enter）
//   ② 按住后位移 >8px = 拖拽（引擎在 BookmarkList）; 触摸/触控笔静止按住 ≥500ms = 上下文菜单
//   ③ 右键 = 同一个上下文菜单; 键盘: ContextMenu / Shift+F10 打开, Alt+↑/↓ 同组移动一位
// 常驻的 编辑/移动/删除 实体按钮已移除（能力块 10 · ③）: 编辑 / 移动到… / 复制链接 / 删除 都在菜单里
// 注意: 鼠标路径不做 setPointerCapture（捕获会把补发的 click 重定向, 卡片链接就收不到点击）
export default function BookmarkItem({
  bookmark,
  folders,
  view,
  density,
  dnd,
  onEdit,
  menu,
  onMenuOpen,
  onMenuClose,
}: {
  bookmark: Bookmark;
  folders: Folder[];
  view: View;
  density: Density;
  dnd: DndApi;
  onEdit: (b: Bookmark) => void;
  /** 本条目的上下文菜单位置（null = 未打开） */
  menu: { x: number; y: number } | null;
  onMenuOpen: (x: number, y: number) => void;
  onMenuClose: () => void;
}) {
  const dom = domainOf(bookmark.url);
  const p = densityParams(density);
  const linkRef = useRef<HTMLAnchorElement | null>(null);
  const pressRef = useRef<{ x: number; y: number } | null>(null);
  const isDragging = dnd.dragging?.id === bookmark.id;
  // 能力块 8: 拖动中被拖项**从列表移除**（只在插入位留占位槽）→ 不再"多出一个书签"
  const hidden = isDragging ? { display: "none" as const } : undefined;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return; // 中/右键不参与（右键交给上下文菜单）
    // 按下点留在这里: 拖拽/长按之后的补发 click 靠它判定"这已不是点击"
    pressRef.current = { x: e.clientX, y: e.clientY };
    if (!dnd.enabled) return;
    const t = e.target as HTMLElement;
    // 卡内真实控件（建议条的按钮等）不启动拖拽; **卡片链接本身允许拖**（整卡可拖是 ③ 的前提）
    if (t.closest("button,select,input,textarea,summary,[role='button'],[role='menuitem']")) return;
    dnd.armDrag(e, bookmark.id, bookmark.folder);
  };

  // 拖拽/长按结束后浏览器还会补一个 click（触摸捕获会让它落回卡片）→ 不能当"点击"打开链接
  const onClickCapture = (e: React.MouseEvent<HTMLAnchorElement>) => {
    const press = pressRef.current;
    pressRef.current = null;
    if (menu) {
      // 菜单开着（触摸长按那次手势的余波）: 既不开链接也不关菜单
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // 键盘触发的 click detail=0（Enter 打开链接必须照常放行）
    if (
      e.detail > 0 &&
      press &&
      Math.hypot(e.clientX - press.x, e.clientY - press.y) > DRAG_THRESHOLD
    ) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // I3 键盘等价路径: Alt+↑/↓ 同组内移动一位
    if (e.altKey && dnd.enabled && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      dnd.keyMove(bookmark.id, e.key === "ArrowUp" ? -1 : 1);
      return;
    }
    // 键盘等价路径: ContextMenu 键 / Shift+F10 打开同一菜单（开在条目中心）
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      onMenuOpen(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    }
  };

  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault(); // 必须: 屏蔽浏览器原生菜单（intent 约束）, 不破坏中键/新标签等原生路径
    onMenuOpen(e.clientX, e.clientY);
  };

  const copyLink = () => {
    const done = navigator.clipboard?.writeText(bookmark.url);
    if (done) void done.catch(() => {});
  };

  const menuItems: MenuItem[] = [
    { key: "open", label: "打开", icon: "open", href: bookmark.url },
    {
      key: "edit",
      label: "编辑",
      icon: "edit",
      attrs: { "data-bk-edit": "" },
      run: () => onEdit(bookmark),
    },
    {
      key: "move",
      label: "移动到…",
      icon: "move",
      submenu: moveTargetItems(folders, bookmark.folder, (f) => moveBookmarkTo(bookmark.id, f)),
    },
    { key: "copy", label: "复制链接", icon: "copy", run: copyLink },
    {
      key: "delete",
      label: "删除",
      icon: "delete",
      danger: true,
      run: () => deleteBookmark(bookmark.id),
    },
  ];

  // 悬停/聚焦才出现的"去打开"箭头（16px arrow-up-right）
  const goArrow = (
    <svg
      className="shrink-0 text-ink-2 opacity-0 transition-opacity duration-200 group-hover/card:opacity-100 group-focus-visible/card:opacity-100"
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M7.5 16.5 16.5 7.5" />
      <path d="M9.8 7.5h6.7v6.7" />
    </svg>
  );

  const suggestion = bookmark.suggestion ? (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 rounded-[var(--radius-tile)] bg-accent/[0.08] px-2.5 py-1.5 text-[11.5px] text-ink-2">
      <span className="font-semibold text-ink">建议</span>
      {bookmark.suggestion.folder && (
        <span className="rounded-full bg-white/70 px-2 py-0.5 font-medium">
          {bookmark.suggestion.folder}
        </span>
      )}
      {bookmark.suggestion.tags.map((t) => (
        <span key={t} className="rounded-full bg-white/70 px-2 py-0.5 font-mono">
          {t}
        </span>
      ))}
      <button
        data-accept-suggestion
        onClick={() => {
          const f = bookmark.suggestion?.folder;
          if (f) acceptSuggestion(bookmark.id, f);
          else dismissSuggestion(bookmark.id);
        }}
        className="ml-auto rounded-full bg-accent px-2.5 py-1 text-[11.5px] font-semibold text-white shadow-[0_4px_10px_-4px_rgba(85,88,224,0.55)] transition-transform hover:-translate-y-[1px]"
      >
        接受
      </button>
      <button
        data-dismiss-suggestion
        onClick={() => dismissSuggestion(bookmark.id)}
        className="rounded-full border border-[color:var(--color-glass-edge)] bg-white/60 px-2.5 py-1 text-[11.5px] font-medium text-ink-2 transition-colors hover:bg-white/85"
      >
        忽略
      </button>
    </div>
  ) : null;

  const menuOverlay = menu ? (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      items={menuItems}
      onClose={onMenuClose}
      returnFocusTo={linkRef.current}
      label={bookmark.title || "书签操作"}
    />
  ) : null;

  // 三种形态共用的外壳: 拖拽锚点（data-bk）+ 三个手势 + 建议条 + 菜单
  // 外壳保持可聚焦（role=group + tabIndex）: Alt+↑/↓ 的重排路径挂在它身上（I3 既有契约, 不改语义）
  const shellProps = {
    "data-bk": bookmark.id,
    "data-dragging": isDragging ? "true" : undefined,
    style: hidden,
    className: "rise-in relative",
    onPointerDown,
    onKeyDown,
    onContextMenu,
    tabIndex: dnd.enabled ? 0 : undefined,
    role: dnd.enabled ? ("group" as const) : undefined,
    "aria-roledescription": dnd.enabled
      ? "可拖拽排序的书签（Alt+↑/↓ 移动; 右键或长按打开菜单）"
      : undefined,
    "aria-keyshortcuts": dnd.enabled ? "Alt+ArrowUp Alt+ArrowDown" : undefined,
    title: dnd.enabled ? "点击打开 · 右键/长按菜单 · 拖动排序" : undefined,
  };

  // ---- 仅图标形态（无卡片壳, 高密度） ----
  if (view === "icons") {
    return (
      <div {...shellProps}>
        <a
          ref={linkRef}
          href={bookmark.url}
          target="_blank"
          rel="noreferrer noopener"
          draggable={false}
          onClickCapture={onClickCapture}
          title={bookmark.title}
          className="group/card flex w-full cursor-grab select-none flex-col items-center gap-1.5 rounded-[var(--radius-tile)] px-1.5 py-2 transition-colors hover:bg-white/70 focus-visible:bg-white/70 active:cursor-grabbing"
        >
          <BookmarkIcon url={bookmark.url} title={bookmark.title} size={p.iconGrid} />
          <span
            className="line-clamp-2 w-full text-center font-medium leading-tight text-ink"
            // 图标格较小, 标题小 1px（spec: 小于参数表是刻意的两行标题取舍）
            style={{ fontSize: "calc(var(--bnt-title, 14px) - 1px)" }}
          >
            {bookmark.title}
          </span>
        </a>
        {suggestion}
        {menuOverlay}
      </div>
    );
  }

  // ---- 卡片形态 ----
  if (view === "grid") {
    return (
      <div {...shellProps}>
        <a
          ref={linkRef}
          href={bookmark.url}
          target="_blank"
          rel="noreferrer noopener"
          draggable={false}
          onClickCapture={onClickCapture}
          title={bookmark.title}
          className="group/card block cursor-grab select-none active:cursor-grabbing"
        >
          {/* 玻璃面板在内层: 卡片的 hover 抬升/扫光（原语）与外层链接的 focus 环互不覆盖 */}
          <div
            className="glass-card lift sheen relative flex items-center gap-3 overflow-hidden"
            style={{ padding: "var(--bnt-pad, 10px)", minHeight: "var(--bnt-row-h, 68px)" }}
          >
            <BookmarkIcon url={bookmark.url} title={bookmark.title} size={p.iconCard} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14.5px] font-semibold leading-[1.3] text-ink">
                {bookmark.title}
              </span>
              <span className="mt-0.5 block truncate text-[12.5px] leading-[1.3] text-ink-3">
                {dom}
              </span>
            </span>
            {goArrow}
          </div>
        </a>
        {suggestion}
        {menuOverlay}
      </div>
    );
  }

  // ---- 列表行形态 ----
  return (
    <div {...shellProps}>
      <a
        ref={linkRef}
        href={bookmark.url}
        target="_blank"
        rel="noreferrer noopener"
        draggable={false}
        onClickCapture={onClickCapture}
        title={bookmark.title}
        className="group/card block cursor-grab select-none active:cursor-grabbing"
      >
        <div
          className="glass-card pressable relative grid items-center gap-3 overflow-hidden"
          style={{
            gridTemplateColumns: "var(--bnt-icon, 32px) minmax(0, 1fr) 16px",
            minHeight: "var(--bnt-row-h, 68px)",
            padding: "var(--bnt-pad, 10px)",
          }}
        >
          <BookmarkIcon url={bookmark.url} title={bookmark.title} size={p.iconCard} />
          <span className="min-w-0">
            <span
              className="block truncate font-semibold leading-[1.3] text-ink"
              style={{ fontSize: "var(--bnt-title, 14px)" }}
            >
              {bookmark.title}
            </span>
            <span className="mt-0.5 block truncate font-mono text-[11.5px] leading-[1.3] text-ink-3">
              {bookmark.url}
            </span>
          </span>
          {goArrow}
        </div>
      </a>
      {suggestion}
      {menuOverlay}
    </div>
  );
}

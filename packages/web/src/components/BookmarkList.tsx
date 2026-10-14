import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { buildGroups, pruneEmptyGroups, type Bookmark, type Folder, type View } from "../lib/logic";
import { moveBookmarkTo, reorderBookmarks, setBookmarkOrder } from "../lib/crdt";
import { DRAG_THRESHOLD, computeInsertIndex, nextOrder } from "../lib/dnd-math";
import { captureRects, flipFrom, playFlip } from "../lib/flip";
import type { DragState, DndApi } from "../lib/dnd";
import type { Density } from "../lib/density";
import FolderSection from "./FolderSection";

// 触摸/触控笔静止按住多久 = 上下文菜单（能力块 10 · ③）; 鼠标没有长按（右键就是菜单）
const LONG_PRESS_MS = 500;

// 列表渲染 + 拖拽编排（能力块 7 · I3 v2, 参考 SortableJS 的做法）
// 反频闪要点: 拖动中列表 DOM 保持稳定（无 preview 重排）; 幽灵是脱离 React 的 DOM 克隆;
//             只在跨槽位时更新 dropIndex（每格一次, 触发一次 180ms 让位动画）; 落定才写 CRDT
// 能力块 10 · ③: 三手势在这里汇合 —— 位移 >8px = 拖拽; 静止按住 ≥500ms = 菜单（同一次按下只可能走一条）
export default function BookmarkList({
  bookmarks,
  folders,
  query,
  view,
  density,
  onEdit,
  onEditFolder,
  onNewFolder,
}: {
  bookmarks: Bookmark[];
  folders: Folder[];
  query: string;
  view: View;
  density: Density;
  onEdit: (b: Bookmark) => void;
  onEditFolder: (f: Folder) => void;
  onNewFolder: (parent: string | null) => void;
}) {
  const [dragging, setDragging] = useState<DragState | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [dropFolderId, setDropFolderId] = useState<string | null>(null);
  // 上下文菜单（一次只开一个; 由引擎长按或条目右键/键盘触发）
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);
  const bookmarksRef = useRef<Bookmark[]>(bookmarks);
  const flipRef = useRef<Map<string, DOMRect> | null>(null);
  // 幽灵副本释放时的矩形（能力块 11 · ①）: 落定动画的起点必须是"手松开的位置", 而不是 (0,0) 或原槽位
  const ghostRectRef = useRef<{ id: string; rect: DOMRect } | null>(null);
  const rafRef = useRef(0);
  const pointerRef = useRef({ x: 0, y: 0 });
  // 长按判定活在武装回调里（与 armedRef 同一处状态, 便于取消）
  const armRef = useRef<((e: { pointerType: string }) => void) | null>(null);
  const armedRef = useRef<{
    id: string;
    folder: string | null;
    x: number;
    y: number;
    pointerId: number;
    pointerType: string;
    el: HTMLElement | null;
  } | null>(null);
  const dragRef = useRef<{
    state: DragState;
    order: string[];
    fromIndex: number;
    dropIndex: number;
    dropFolder: string | null;
    el: HTMLElement | null;
    clone: HTMLElement | null;
    origin: { x: number; y: number };
    // 落点几何快照（拖拽开始时测一次）: 避免"占位槽插入导致布局位移 → 落点追着自己跑"的抖动,
    // 也避免 FLIP 的 transform 污染实时测量
    baseBoxes: { id: string; x: number; y: number; w: number; h: number }[];
    startScroll: { x: number; y: number };
    wasFocused: boolean; // 拖动中被拖项被隐藏 → 结束后把焦点还回去（不留焦点陷阱）
  } | null>(null);

  const enabled = !query.trim();

  useEffect(() => {
    bookmarksRef.current = bookmarks;
  }, [bookmarks]);

  // 搜索态切换（可见序列变了）时不留悬挂菜单
  useEffect(() => {
    setMenu(null);
  }, [query]);

  const tree = useMemo(() => {
    const t = buildGroups(folders, bookmarks);
    return query.trim() ? pruneEmptyGroups(t) : t;
  }, [folders, bookmarks, query]);

  // 让位动画: dropIndex 变化（跨槽位）或落定后播放一次 FLIP（180ms, 尊重 reduced-motion）
  useLayoutEffect(() => {
    const ghost = ghostRectRef.current;
    ghostRectRef.current = null;
    if (flipRef.current) {
      // 先给被拖卡片做"从释放点落位"的动画, 再让其它卡片走常规让位 FLIP
      if (ghost) {
        const el = listRef.current?.querySelector<HTMLElement>(`[data-bk="${CSS.escape(ghost.id)}"]`);
        flipFrom(el ?? null, ghost.rect, 200);
      }
      playFlip(listRef.current, flipRef.current, 180);
      flipRef.current = null;
    } else if (ghost) {
      // 无重排（取消/原地放下）: 卡片仍应从释放点飞回自己的槽位
      const el = listRef.current?.querySelector<HTMLElement>(`[data-bk="${CSS.escape(ghost.id)}"]`);
      flipFrom(el ?? null, ghost.rect, 200);
    }
  }, [dropIndex, bookmarks]);

  useEffect(() => {
    if (!enabled) return;

    const sectionEl = (folder: string | null) =>
      listRef.current?.querySelector<HTMLElement>(`[data-group="${CSS.escape(folder ?? "root")}"]`);

    const boxesOf = (folder: string | null) =>
      [...(sectionEl(folder)?.querySelectorAll<HTMLElement>("[data-bk]") ?? [])].map((el) => {
        const r = el.getBoundingClientRect();
        return {
          id: el.getAttribute("data-bk") ?? "",
          x: r.left,
          y: r.top,
          w: r.width,
          h: r.height,
        };
      });

    // 浮动副本: 克隆卡片 → fixed 定位 → 之后只改 transform（零 React 重渲染 = 不闪）
    const makeClone = (el: HTMLElement): HTMLElement => {
      const rect = el.getBoundingClientRect();
      const clone = el.cloneNode(true) as HTMLElement;
      clone.setAttribute("data-dnd-ghost", "");
      clone.removeAttribute("data-dragging"); // 避免被 Tailwind 的拖拽态变体变暗
      clone.classList.remove("rise-in"); // 入场动画的 fill:both 会永久覆盖 inline transform（副本不跟随）
      clone.classList.add("dnd-clone");
      Object.assign(clone.style, {
        position: "fixed",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        margin: "0",
        pointerEvents: "none",
        zIndex: "60",
        transition: "none",
        animation: "none",
      });
      document.body.appendChild(clone);
      return clone;
    };

    const startDrag = (
      armed: {
        id: string;
        folder: string | null;
        pointerId: number;
        pointerType: string;
        el: HTMLElement | null;
      },
      x: number,
      y: number,
    ) => {
      const el = armed.el;
      if (!el) return;
      // 捕获: 必须在拖拽真正开始后（pointerdown 就捕获会让卡片内 <a> 收不到 click）;
      // 且鼠标不需要捕获（window 已监听 + select-none 阻断原生拖拽）—— 捕获会连 no-op 拖拽的 click 一起吞掉
      if (armed.pointerType !== "mouse") {
        try {
          el.setPointerCapture(armed.pointerId);
        } catch {
          /* 忽略: 个别环境不支持 */
        }
      }
      const baseBoxes = boxesOf(armed.folder); // 占位槽尚未渲染 → 干净的原始几何
      const ids = baseBoxes.map((b) => b.id);
      if (!ids.includes(armed.id)) return;
      const clone = makeClone(el);
      dragRef.current = {
        state: { id: armed.id, folder: armed.folder },
        order: ids,
        fromIndex: ids.indexOf(armed.id),
        dropIndex: ids.indexOf(armed.id),
        dropFolder: armed.folder,
        el,
        clone,
        origin: { x, y },
        baseBoxes,
        startScroll: { x: window.scrollX, y: window.scrollY },
        wasFocused: el.contains(document.activeElement),
      };
      armedRef.current = null;
      setDragging(dragRef.current.state);
      setDropIndex(dragRef.current.dropIndex);
    };

    // 侧栏文件夹行高亮（能力块 12 · ②）: 用 DOM 属性直接设置, 不引入 React 状态
    // （遵守"拖动中不重渲染"的既有原则）
    const SIDEBAR_DROP_ATTR = "data-bk-drop";
    const highlightRow = (row: HTMLElement | null) => {
      for (const el of document.querySelectorAll<HTMLElement>(`[data-folder-row][${SIDEBAR_DROP_ATTR}]`)) {
        if (el !== row) el.removeAttribute(SIDEBAR_DROP_ATTR);
      }
      if (row && !row.hasAttribute(SIDEBAR_DROP_ATTR)) row.setAttribute(SIDEBAR_DROP_ATTR, "true");
    };
    const clearRowHighlight = () => highlightRow(null);

    const updateTarget = (x: number, y: number) => {
      const drag = dragRef.current;
      if (!drag) return;
      const hitEl = document.elementFromPoint(x, y) as HTMLElement | null;
      // ① 侧栏文件夹行 = 直接改归属（拖到哪个夹就归哪个夹; 松手落到该夹末尾）
      const row = hitEl?.closest<HTMLElement>("[data-folder-row]") ?? null;
      if (row) {
        const rawRow = row.getAttribute("data-folder-row");
        const rowFolder = rawRow === "root" ? null : rawRow;
        // 拖到自己所在的文件夹行: 不高亮（松手是 no-op, 高亮会误导"会改归属"）
        highlightRow(rowFolder === drag.state.folder ? null : row);
        if (rowFolder !== drag.dropFolder) {
          drag.dropFolder = rowFolder;
          setDropFolderId(rowFolder);
        }
        if (drag.dropIndex !== -1) {
          drag.dropIndex = -1;
          setDropIndex(-1);
        }
        return; // 侧栏区域内不做组内让位
      }
      clearRowHighlight();
      // ② 主列表分组标题 → 目标分组; 不在标题上则保持源分组
      const under = hitEl?.closest<HTMLElement>("[data-drop-group]");
      const raw = under?.getAttribute("data-drop-group") ?? null;
      const dropFolder = under ? (raw === "root" ? null : raw) : drag.state.folder;
      if (dropFolder !== drag.dropFolder) {
        drag.dropFolder = dropFolder;
        setDropFolderId(dropFolder);
      }
      if (dropFolder !== drag.state.folder) {
        // 跨分组: 不做组内让位（松手时一次性完成）
        if (drag.dropIndex !== -1) {
          drag.dropIndex = -1;
          setDropIndex(-1);
        }
        return;
      }
      // 页面滚动时, 快照需要平移相同的位移
      const sx = window.scrollX - drag.startScroll.x;
      const sy = window.scrollY - drag.startScroll.y;
      const idx = computeInsertIndex(drag.baseBoxes, x + sx, y + sy);
      if (idx === drag.dropIndex) return;
      flipRef.current = captureRects(listRef.current); // 让位动画基准
      drag.dropIndex = idx;
      setDropIndex(idx);
    };

    const removeClone = () => {
      clearRowHighlight();
      const clone = dragRef.current?.clone;
      const id = dragRef.current?.state.id;
      if (clone && id) {
        // 记录释放点（含 transform 后的可视矩形）→ 落定动画从这里开始
        ghostRectRef.current = { id, rect: clone.getBoundingClientRect() };
      }
      clone?.remove();
    };

    const finish = (commit: boolean) => {
      const el = dragRef.current?.el ?? armedRef.current?.el ?? null;
      if (el) el.style.touchAction = "";
      removeClone();
      armedRef.current = null;
      const drag = dragRef.current;
      dragRef.current = null;
      setDragging(null);
      setDropIndex(null);
      setDropFolderId(null);
      if (!drag) return;
      // 被拖项在拖动中被隐藏, 结束后把焦点还给它（键盘/读屏可用性）
      if (drag.wasFocused && drag.el) {
        requestAnimationFrame(() => drag.el?.focus?.());
      }
      const { state, order, fromIndex, dropIndex: at, dropFolder } = drag;
      if (!commit || at < 0) {
        if (commit && dropFolder !== state.folder) {
          // 跨分组但未确定槽位（悬停标题）→ 落到目标组末尾
          const maxOrder = bookmarksRef.current
            .filter((b) => b.folder === dropFolder)
            .reduce((m, b) => Math.max(m, b.order), -1);
          flipRef.current = captureRects(listRef.current);
          moveBookmarkTo(state.id, dropFolder);
          setBookmarkOrder(state.id, maxOrder + 1);
        }
        return;
      }
      flipRef.current = captureRects(listRef.current);
      if (dropFolder !== state.folder) {
        // 跨分组落定: ① 源组剩余项按原顺序提交 ② 被拖项显式落到目标组末尾
        const rest = order.filter((id) => id !== state.id);
        reorderBookmarks(rest);
        const maxOrder = bookmarksRef.current
          .filter((b) => b.folder === dropFolder)
          .reduce((m, b) => Math.max(m, b.order), -1);
        moveBookmarkTo(state.id, dropFolder);
        setBookmarkOrder(state.id, maxOrder + 1);
        return;
      }
      const next = nextOrder(order, fromIndex, at);
      if (next !== order) reorderBookmarks(next);
      else flipRef.current = null; // 无变化 → 不需要动画
    };

    // 静止按住 ≥500ms（触摸/触控笔）= 上下文菜单: 同一次按下只可能走菜单或拖拽其中一条
    let pressTimer = 0;
    const cancelPress = () => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = 0;
      }
    };

    const onMove = (e: PointerEvent) => {
      const armed = armedRef.current;
      if (armed && !dragRef.current) {
        if (Math.hypot(e.clientX - armed.x, e.clientY - armed.y) < DRAG_THRESHOLD) return;
        cancelPress(); // 已经进入拖拽 → 不再长按
        startDrag(armed, e.clientX, e.clientY);
      }
      const drag = dragRef.current;
      if (!drag) return;
      e.preventDefault(); // 拖拽中阻止文本选择/触摸滚动
      pointerRef.current = { x: e.clientX, y: e.clientY };
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const { x, y } = pointerRef.current;
        const d = dragRef.current;
        if (!d) return;
        // 幽灵只改 transform（无重渲染 → 不闪）
        d.clone?.style.setProperty(
          "transform",
          `translate3d(${x - d.origin.x}px, ${y - d.origin.y}px, 0) rotate(2deg)`,
        );
        updateTarget(x, y);
      });
    };
    const onUp = () => {
      cancelPress();
      finish(true);
    };
    const onCancel = () => {
      cancelPress();
      finish(false);
    };
    // 指针在窗口外松手收不到 pointerup → 失焦/隐藏兜底取消（spec 4）
    const onBlur = () => {
      cancelPress();
      if (armedRef.current || dragRef.current) finish(false);
    };
    const onVisibility = () => {
      if (document.hidden) onBlur();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && (armedRef.current || dragRef.current)) {
        e.preventDefault();
        finish(false);
      }
    };

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("keydown", onKey);
    const arm = (e: { pointerType: string }) => {
      cancelPress();
      if (e.pointerType === "mouse") return; // 鼠标没有长按菜单（右键就是菜单）
      const armed = armedRef.current;
      if (!armed) return;
      pressTimer = window.setTimeout(() => {
        pressTimer = 0;
        if (!armedRef.current || dragRef.current) return; // 已经开拖/已收手 → 不再开菜单
        const { id, x, y } = armedRef.current;
        finish(false); // 放弃这次武装（还原 touch-action）, 否则松手后移动还会开拖
        setMenu({ id, x: Math.round(x), y: Math.round(y) });
      }, LONG_PRESS_MS);
    };
    armRef.current = arm;
    return () => {
      armRef.current = null;
      cancelPress();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("keydown", onKey);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      // 重订阅（如搜索态切换）时清掉拖拽残留, 避免幽灵悬挂
      removeClone();
      const el = dragRef.current?.el ?? armedRef.current?.el ?? null;
      if (el) el.style.touchAction = "";
      armedRef.current = null;
      dragRef.current = null;
      setDragging(null);
      setDropIndex(null);
      setDropFolderId(null);
    };
  }, [enabled]);

  // 键盘等价: Alt+↑/↓ 同组内移动一位（一次提交 + 一次 FLIP）
  const keyMove = (id: string, dir: -1 | 1) => {
    const me = bookmarks.find((b) => b.id === id);
    if (!me) return;
    const siblings = bookmarks
      .filter((b) => b.folder === me.folder)
      .sort((a, b) => a.order - b.order)
      .map((b) => b.id);
    const from = siblings.indexOf(id);
    const next = nextOrder(siblings, from, dir > 0 ? from + 2 : from - 1);
    if (next === siblings) return;
    flipRef.current = captureRects(listRef.current);
    reorderBookmarks(next);
  };

  const dnd: DndApi = {
    enabled,
    dragging,
    dropIndex,
    dropFolderId,
    armDrag: (e, id, folder) => {
      const el = e.currentTarget as HTMLElement;
      // 触摸端: 按下即交出滚动控制（拖拽态再设已晚, 浏览器可能已判为滚动）
      el.style.touchAction = "none";
      armedRef.current = {
        id,
        folder,
        x: e.clientX,
        y: e.clientY,
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        el,
      };
      armRef.current?.(e); // 触摸/触控笔: 启动 500ms 长按（鼠标直接返回）
    },
    keyMove,
  };

  if (tree.total === 0 && tree.children.length === 0) {
    return (
      <div className="glass-card rise-in flex flex-col items-center px-8 py-14 text-center">
        {/* 绘制图标（空态: 书签缎带 + 斜线） */}
        <svg
          className="mb-4 text-ink-3"
          viewBox="0 0 24 24"
          width="34"
          height="34"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M7 4h10a1 1 0 0 1 1 1v14.4l-6-4-6 4V5a1 1 0 0 1 1-1z" />
          <path d="M4.5 20.5 19.5 3.5" />
        </svg>
        <p className="font-serif text-[23px] font-medium tracking-[-0.01em] text-ink">还没有书签</p>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
          安装浏览器扩展后，你的书签与浏览历史会自动汇入（添加书签走浏览器原生, 不再手填）
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6" ref={listRef}>
      <FolderSection
        group={tree}
        folders={folders}
        view={view}
        density={density}
        dnd={dnd}
        bookmarks={bookmarks}
        onEdit={onEdit}
        onEditFolder={onEditFolder}
        onNewFolder={onNewFolder}
        menu={menu}
        onMenuOpen={(id, x, y) => setMenu({ id, x, y })}
        onMenuClose={() => setMenu(null)}
      />
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import type { Bookmark, Folder, SidebarMode, TreeGroup } from "../lib/logic";
import type { SidebarShape } from "../lib/layout";
import { folderSubtreeSize } from "../lib/logic";
import { deleteFolder, reorderFolders, setFolderParent } from "../lib/crdt";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import { DRAG_THRESHOLD } from "../lib/dnd-math";
import { dropZoneOf, reparentSiblings, type DropZone } from "../lib/sidebar-tree";

// 左侧导览（能力块 9 · I1 + 能力块 10 · ①a Dawn 重绘）: 视口等高玻璃面板 + 文件夹**树**（缩进/折叠）+ 拖拽
//   - 拖拽: 复用 I3 指针引擎思路（阈值/克隆幽灵/落定才提交）; 落点三区: 上=前 / 中=放入 / 下=后
//   - 高度: sticky + 100dvh 语义 → 页面滚动时位置与高度都不变, 内容超出时面板内部滚动
//   - Dawn: 面板 = .glass（磨砂必须看得见背景）; 状态只用一个 accent; 图标全部绘制 SVG（不用 emoji）
//     active 行沿用 mock 的 chip.is-active 配方（accent 实底 + 白字）—— 状态语言只有一种
// 侧栏顶部 quiet chrome 按钮（沿用 mock 的 chip 配方: 白 45% 底 + 发丝边 + 药丸）; 不用 .btn-quiet
// 是因为它固定了 14.4px 侧内距, 窄条态（56px 面板）放不下
// 字色交给调用点（模式按钮要能换成更弱的 ink-3）: 同一属性的两个工具类谁赢看源序, 不靠它
const CHROME_BTN =
  "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[color:var(--color-glass-edge)] bg-white/45 text-[12.5px] font-medium transition-colors hover:bg-white/70";

// 侧栏模式图标（绘制, 替代 📌/🚫/↔）: 固定 = 图钉, 隐藏 = 划掉的眼睛, 自动 = 左右双向箭头
function ModeIcon({ mode }: { mode: SidebarMode }) {
  const paths =
    mode === "pinned" ? (
      <>
        <path d="M12 21.4s6.2-6.1 6.2-10.6a6.2 6.2 0 1 0-12.4 0C5.8 15.3 12 21.4 12 21.4z" />
        <circle cx="12" cy="10.7" r="2.1" />
      </>
    ) : mode === "hidden" ? (
      <>
        <path d="M3.2 12S7 5.7 12 5.7c1 0 1.9.2 2.8.5" />
        <path d="M19.3 8.5c1 1.1 1.5 2.3 1.5 3.5 0 0-3.8 6.3-8.8 6.3-1.5 0-2.9-.4-4.1-1.1" />
        <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
        <path d="M4 4l16 16" />
      </>
    ) : (
      <>
        <path d="M3.5 12h17" />
        <path d="M7.6 7.9 3.5 12l4.1 4.1" />
        <path d="M16.4 7.9 20.5 12l-4.1 4.1" />
      </>
    );
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {paths}
    </svg>
  );
}

// 视图入口图标（绘制, 替代 📑/🕘）: 书签 = 缎带, 历史 = 钟面
function TabIcon({ kind }: { kind: "bookmarks" | "history" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {kind === "history" ? (
        <>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 7.6V12l3.2 2" />
        </>
      ) : (
        <path d="M7 4h10a1 1 0 0 1 1 1v14.4l-6-4-6 4V5a1 1 0 0 1 1-1z" />
      )}
    </svg>
  );
}

export default function Sidebar({
  tree,
  folders,
  bookmarks,
  shape,
  mode,
  tab,
  onTabChange,
  activeGroupId,
  onEditFolder,
  onNewFolder,
  onJump,
  onCycleMode,
  onClose,
}: {
  tree: TreeGroup;
  folders: Folder[];
  shape: SidebarShape;
  mode: SidebarMode;
  tab: "bookmarks" | "history"; // 能力块 9 · I2: 视图切换移入侧栏
  onTabChange: (t: "bookmarks" | "history") => void;
  activeGroupId: string | null;
  /** 全部书签（级联删除的影响面文案: 能力块 19） */
  bookmarks: Bookmark[];
  /** 打开「编辑文件夹」弹窗（能力块 19: 侧栏行右键） */
  onEditFolder: (f: Folder) => void;
  /** 新建文件夹（能力块 19 增补: 父夹 id, null = 顶层） */
  onNewFolder: (parent: string | null) => void;
  onJump: (groupId: string | null) => void;
  onCycleMode: () => void;
  onClose?: () => void;
}) {
  const rail = shape === "rail";
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drop, setDrop] = useState<{ targetId: string | null; zone: DropZone } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const foldersRef = useRef<Folder[]>(folders);
  const armedRef = useRef<{
    id: string;
    x: number;
    y: number;
    pointerId: number;
    pointerType: string;
    el: HTMLElement | null;
  } | null>(null);
  const dragRef = useRef<{
    id: string;
    el: HTMLElement | null;
    clone: HTMLElement | null;
    origin: { x: number; y: number };
  } | null>(null);
  const rafRef = useRef(0);
  const pointerRef = useRef({ x: 0, y: 0 });
  const justDraggedRef = useRef(false);
  const dropRef = useRef<{ targetId: string | null; zone: DropZone } | null>(null);

  // 文件夹行右键菜单（能力块 19: 与卡片右键同一套 ContextMenu; 未分组是叶子, 不参与）
  // id = null 表示「未分组」行（它没有文件夹, 只能在这里新建**顶层**夹）
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number; id: string | null } | null>(null);

  useEffect(() => {
    foldersRef.current = folders;
  }, [folders]);

  // 文件夹拖拽（侧栏内）
  useEffect(() => {
    if (rail) return; // 窄条态不拖拽（信息量不足）

    const makeClone = (el: HTMLElement): HTMLElement => {
      const rect = el.getBoundingClientRect();
      const clone = el.cloneNode(true) as HTMLElement;
      clone.setAttribute("data-dnd-ghost", "");
      clone.classList.add("dnd-clone");
      Object.assign(clone.style, {
        position: "fixed",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
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
      armed: { id: string; pointerId: number; pointerType: string; el: HTMLElement | null },
      x: number,
      y: number,
    ) => {
      if (!armed.el) return;
      // 指针捕获的时机与对象都有讲究:
      //   1) 不能在 pointerdown 就捕获 —— 会把后续 click 重定向到行容器, 内层 button 收不到点击（= "点不动"根因）
      //   2) 鼠标**完全不需要**捕获: window 上已监听 pointermove/up, 且已用 select-none 阻断原生选区拖拽;
      //      一旦捕获, 连"没拖动成"的拖拽也会吞掉 click（= "要点两次"）
      //   3) 触摸/触控笔需要捕获: 保证指针移出行后仍能收到事件, 并阻止滚动接管
      if (armed.pointerType !== "mouse") {
        try {
          armed.el.setPointerCapture(armed.pointerId);
        } catch {
          /* 忽略: 个别环境不支持 */
        }
      }
      const clone = makeClone(armed.el);
      dragRef.current = { id: armed.id, el: armed.el, clone, origin: { x, y } };
      armedRef.current = null;
      setDraggingId(armed.id);
    };

    const updateTarget = (x: number, y: number) => {
      const drag = dragRef.current;
      if (!drag) return;
      const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>(
        "[data-folder-row]",
      );
      if (!el) {
        if (dropRef.current) {
          dropRef.current = null;
          setDrop(null);
        }
        return;
      }
      const raw = el.getAttribute("data-folder-row");
      const targetId = raw === "root" ? null : raw;
      const rect = el.getBoundingClientRect();
      const zone = dropZoneOf(y, rect.top, rect.height);
      if (
        targetId === drag.id || // 落回自身 = 无操作
        (dropRef.current && dropRef.current.targetId === targetId && dropRef.current.zone === zone)
      ) {
        return;
      }
      dropRef.current = { targetId, zone };
      setDrop({ targetId, zone });
    };

    const finish = (commit: boolean) => {
      // 只有**真的改了结构**才抑制随后的 click: 手抖 9px 触发的"原地放下"必须仍算点击
      // （否则侧栏要连点好几次才有反应 —— 能力块 11 · ② 实测 clicks 到了但 scrollY 仍为 0）
      let changed = false;
      const el = dragRef.current?.el ?? armedRef.current?.el ?? null;
      if (el) el.style.touchAction = "";
      dragRef.current?.clone?.remove();
      const drag = dragRef.current;
      dragRef.current = null;
      armedRef.current = null;
      setDraggingId(null);
      setDrop(null);
      const target = dropRef.current;
      dropRef.current = null;
      if (!commit || !drag || !target) return;
      const plan = reparentSiblings(foldersRef.current, drag.id, target.targetId, target.zone);
      if (!plan) return; // 防环/非法 → 不提交
      const me = foldersRef.current.find((f) => f.id === drag.id);
      if (me && me.parent !== plan.parent) {
        setFolderParent(drag.id, plan.parent);
        changed = true;
      }
      const before = foldersRef.current
        .filter((f) => f.parent === plan.parent)
        .sort((a, b) => a.order - b.order)
        .map((f) => f.id);
      if (before.join() !== plan.orderedIds.join()) {
        reorderFolders(plan.orderedIds);
        changed = true;
      }
      if (changed) justDraggedRef.current = true; // 抑制尾随 click（避免"拖完又跳走"）
    };

    const onMove = (e: PointerEvent) => {
      const armed = armedRef.current;
      if (armed && !dragRef.current) {
        if (Math.hypot(e.clientX - armed.x, e.clientY - armed.y) < DRAG_THRESHOLD) return;
        startDrag(armed, e.clientX, e.clientY);
      }
      if (!dragRef.current) return;
      e.preventDefault();
      pointerRef.current = { x: e.clientX, y: e.clientY };
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const d = dragRef.current;
        if (!d) return;
        const { x, y } = pointerRef.current;
        d.clone?.style.setProperty(
          "transform",
          `translate3d(${x - d.origin.x}px, ${y - d.origin.y}px, 0) rotate(1deg)`,
        );
        updateTarget(x, y);
      });
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onBlur = () => {
      if (armedRef.current || dragRef.current) finish(false);
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
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onKey);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      dragRef.current?.clone?.remove();
      dragRef.current = null;
      armedRef.current = null;
      dropRef.current = null;
      setDraggingId(null);
      setDrop(null);
    };
  }, [rail]);

  // 文件夹行（树）: 层级靠 缩进 + 引导线 + 字号/字重/墨色 三重区分（原实现只有 12px 缩进, 看不出树）
  const row = (node: TreeGroup, opts: { hasChildren: boolean; empty?: boolean }) => {
    const isRoot = node.id === null;
    const key = node.id ?? "root";
    const active = !isRoot && node.id === activeGroupId;
    const isCollapsed = node.id ? collapsed.has(node.id) : false;
    const dropZone = drop && drop.targetId === node.id ? drop.zone : undefined;
    const level = node.depth; // 0=未分组叶子, 1 = 顶层文件夹, 2+ = 子级
    const isChild = level >= 2;
    // 层级降权: 顶层 12.5/600 ink → 子级 11.5/500 ink-2 → 更深 11.5/400 ink-3（字号守住 Micro 下限）
    const nameSize =
      level <= 1
        ? "text-[12.5px] font-semibold"
        : level === 2
          ? "text-[11.5px] font-medium"
          : "text-[11.5px] font-normal";
    const nameTone = active
      ? "text-white"
      : level <= 1
        ? "text-ink"
        : level === 2
          ? "text-ink-2"
          : "text-ink-3";
    return (
      <div key={key} className={rail ? "flex justify-center" : ""}>
        <div
          data-folder-row={key}
          data-folder-id={node.id ?? ""}
          data-depth={node.depth}
          data-drop={dropZone}
          data-empty={opts.empty ? "true" : undefined}
          data-active={active ? "true" : undefined}
          data-dragging={draggingId && draggingId === node.id ? "true" : undefined}
          style={rail ? undefined : { paddingLeft: 2 }}
          /* 能力块 12 · ③: **整行**是点击目标。原先只有内层 label 按钮可点, 行的 padding/缝隙/计数徽标
             都是死区 —— 实测 pointerup/click 落在行 DIV 上却无处理器（"视觉锁定在这行但点击没反应"）。
             箭头按钮自己 stopPropagation（只折叠不跳转）。 */
          onClick={() => {
            if (rail) return;
            onJump(node.id);
          }}
          onContextMenu={(e) => {
            if (rail) return; // 收起态（只留图标）不参与
            e.preventDefault(); // 屏蔽浏览器原生菜单（与卡片一致）
            setFolderMenu({ x: e.clientX, y: e.clientY, id: node.id });
          }}
          className={`group/row relative flex select-none items-center gap-0.5 rounded-[var(--radius-tile)] text-left transition-colors ${
            rail ? "justify-center px-1 py-1.5" : "py-1"
          } ${active ? "bg-accent text-white" : "hover:bg-ink/[0.06]"} ${
            draggingId === node.id ? "opacity-40" : ""
          } data-[drop=inside]:bg-accent/[0.14] data-[drop=before]:shadow-[inset_0_2px_0_var(--color-accent)] data-[drop=after]:shadow-[inset_0_-2px_0_var(--color-accent)]`}
          onPointerDown={(e) => {
            // 新的一次按下 = 新手势: 清掉可能残留的"抑制尾随 click"标志。
            // 若不清: 真拖拽后尾随 click 有时根本不触发（拖拽中 preventDefault(pointermove) 会抑制它）
            // → 标志残留 → **下一次正常点击被吞**（实测 C12 第一次点击无效）
            justDraggedRef.current = false;
            if (rail || isRoot) return; // 未分组不是文件夹, 不作为拖拽源
            if ((e.target as HTMLElement).closest("[data-folder-toggle]")) return; // 箭头只负责折叠
            const el = e.currentTarget as HTMLElement;
            // 触摸端: 按下即交出滚动控制（拖拽态再设已晚, 浏览器可能已判为滚动）
            el.style.touchAction = "none";
            armedRef.current = {
              id: node.id!,
              x: e.clientX,
              y: e.clientY,
              pointerId: e.pointerId,
              pointerType: e.pointerType,
              el,
            };
          }}
        >
          {opts.hasChildren && !rail ? (
            <button
              data-folder-toggle={node.id}
              aria-expanded={!isCollapsed}
              onClick={(e) => {
                e.stopPropagation();
                if (!node.id) return;
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(node.id!)) next.delete(node.id!);
                  else next.add(node.id!);
                  return next;
                });
              }}
              title={isCollapsed ? "展开" : "折叠"}
              className={`relative z-[1] grid w-4 shrink-0 place-items-center ${
                active ? "text-white/90" : isChild ? "text-ink-3" : "text-ink-2"
              }`}
            >
              {/* 绘制箭头（替代 ▸▾ 文本）: 折叠时旋转 -90° */}
              <svg
                viewBox="0 0 12 12"
                width="10"
                height="10"
                aria-hidden
                className={`transition-transform duration-150 ${isCollapsed ? "-rotate-90" : ""}`}
              >
                <path
                  d="M2.5 4.5 L6 8 L9.5 4.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          ) : (
            !rail && <span className="w-4 shrink-0" aria-hidden />
          )}
          <button
            data-sidebar-item={key}
            title={`${node.name}（${node.total}）`}
            className={`relative z-[1] min-w-0 flex-1 truncate text-left ${
              rail ? "text-[12px] font-semibold" : nameSize
            } ${active ? "text-white" : rail ? "text-ink" : nameTone}`}
          >
            {rail ? node.name.slice(0, 1) : isRoot ? "未分组" : node.name}
          </button>
          {!rail && (
            <span
              data-folder-count={node.id ?? "root"}
              className={`relative z-[1] shrink-0 rounded-full px-1.5 py-0.5 text-[11.5px] leading-none font-medium tabular-nums ${
                active ? "bg-white/90 text-accent" : "bg-ink/[0.07] text-ink-2"
              }`}
            >
              {node.total}
            </span>
          )}
        </div>
        {!isCollapsed && node.children.length > 0 && (
          // 引导线 + 逐级缩进: 缩进由**容器**承担（ml-2 8px + 1px 发丝线 + pl-1.5 6px = 15px/级）——
          // 若只给行内 padding, 引导线会全部堆在最左侧、外层量到的 left 也只差 1px（实测: 4 层只差 3px, 看不出树）
          <div className="mt-0.5 ml-2 space-y-px border-l border-ink/15 pb-0.5 pl-1.5">
            {node.children.map((c) => row(c, { hasChildren: c.children.length > 0 }))}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside
      onClickCapture={(e) => {
        if (justDraggedRef.current) {
          justDraggedRef.current = false;
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      data-sidebar
      data-shape={shape}
      className={`glass flex flex-col overflow-y-auto overscroll-contain ${
        shape === "overlay"
          ? `fixed top-0 left-0 z-40 m-2 h-[calc(100dvh-1rem)] w-64 ${rail ? "p-2" : "p-3"}`
          : `sticky top-5 z-20 h-[calc(100dvh-2.5rem)] shrink-0 ${rail ? "w-14 p-2" : "w-60 p-3"}`
      }`}
    >
      <div
        className={
          rail ? "flex flex-col items-center gap-2" : "flex items-center justify-between gap-2"
        }
      >
        <button
          data-sidebar-top
          onClick={() => onJump("__top__" as unknown as null)}
          title="回到顶部"
          className={`${CHROME_BTN} text-ink-2 ${rail ? "h-9 w-9 justify-center" : "px-3 py-1.5"}`}
        >
          {/* 绘制图标（craft-floor: 不用 emoji 当图标） */}
          <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M12 19.5V4.5" />
            <path d="M5.5 11 12 4.5 18.5 11" />
          </svg>
          {rail ? <span className="sr-only">回到顶部</span> : <span>回到顶部</span>}
        </button>
        {!rail && (
          <div className="flex items-center gap-1.5">
            <button
              data-sidebar-mode
              onClick={onCycleMode}
              title={`侧边栏模式：${mode}（点击切换 自动/固定/隐藏）`}
              aria-label={`侧边栏模式：${mode}`}
              className={`${CHROME_BTN} h-9 w-9 justify-center ${mode === "hidden" ? "text-ink-3" : "text-ink-2"}`}
            >
              <ModeIcon mode={mode} />
            </button>
            {onClose && (
              <button
                data-sidebar-close
                onClick={onClose}
                title="收起"
                aria-label="收起"
                className={`${CHROME_BTN} h-9 w-9 justify-center text-ink-2`}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="15"
                  height="15"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M6.5 6.5 17.5 17.5" />
                  <path d="M17.5 6.5 6.5 17.5" />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>

      <nav
        data-sidebar-nav
        // 能力块 12 · ③: 卡在行与行之间的缝隙时, 取**竖直距离最近**的行作为跳转目标
        // （用户要求: 只要视觉上像落在某个条目上, 点击就应以它为目标）
        onClick={(e) => {
          if (rail) return;
          const t = e.target as HTMLElement;
          if (t.closest("[data-folder-row]") || t.closest("button")) return; // 行内/按钮已各自处理
          const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-folder-row]")];
          if (rows.length === 0) return;
          let best: HTMLElement | null = null;
          let bestDist = Number.POSITIVE_INFINITY;
          for (const r of rows) {
            const b = r.getBoundingClientRect();
            const d = Math.abs(e.clientY - (b.top + b.height / 2));
            if (d < bestDist) {
              bestDist = d;
              best = r;
            }
          }
          if (!best) return;
          const raw = best.getAttribute("data-folder-row");
          onJump(raw === "root" ? null : raw);
        }}
        className={`mt-3 flex-1 space-y-1 ${rail ? "flex flex-col items-center" : ""}`}
      >
        {/* 视图入口: 书签 / 历史（能力块 9 · I2 从顶栏移入） */}
        <div className={`flex gap-1.5 ${rail ? "flex-col" : ""}`}>
          {(
            [
              { id: "bookmarks", label: "书签" },
              { id: "history", label: "历史" },
            ] as const
          ).map((v) => (
            <button
              key={v.id}
              data-tab={v.id}
              onClick={() => {
                onTabChange(v.id);
                onClose?.();
              }}
              title={v.label}
              className={`inline-flex items-center gap-1.5 rounded-full border text-[12.5px] font-medium transition-colors ${
                rail ? "h-9 w-9 justify-center" : "flex-1 justify-center px-2.5 py-2"
              } ${
                tab === v.id
                  ? "border-transparent bg-accent text-white"
                  : "border-[color:var(--color-glass-edge)] bg-white/45 text-ink-2 hover:bg-white/70"
              }`}
            >
              <TabIcon kind={v.id} />
              {rail ? (
                <span className="sr-only">{v.label}</span>
              ) : (
                <span className="min-w-0 truncate">{v.label}</span>
              )}
            </button>
          ))}
        </div>

        {/* 「全部」入口（非树节点）: 与顶层文件夹同名起列对齐（箭头列用空位占宽） */}
        <div className={rail ? "flex justify-center" : ""}>
          <button
            data-sidebar-item="all"
            onClick={() => onJump("__top__" as unknown as null)}
            title="全部（回到顶部）"
            className={`flex w-full items-center gap-0.5 rounded-[var(--radius-tile)] text-left text-[12.5px] font-semibold text-ink transition-colors hover:bg-ink/[0.06] ${
              rail ? "h-9 w-9 justify-center" : "py-1 pr-1.5 pl-0.5"
            }`}
          >
            {rail ? (
              <span>全</span>
            ) : (
              <>
                <span className="w-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate">全部</span>
              </>
            )}
          </button>
        </div>
        {/* 未分组 = 叶子（它只含"没有文件夹"的书签）; 顶层文件夹是它的**同级**, 不是子级 ——
            否则树根显示成"未分组 > 收藏夹栏 > …", 层级语义错乱（截图实测）。
            能力块 15 · D: 为空时隐藏（归属修好后它通常为空, 显示"未分组 0"像遗留物）。
            隐藏交给 CSS（见 index.css 的 [data-folder-row="root"][data-empty]）; 这里只打标记。
            注: 为空时它**不作为拖拽落点**（拖拽中临时显示会布局跳动 → 落点偏移）,
            "移到未分组"走右键菜单。 */}
        {row(
          { ...tree, children: [], total: tree.bookmarks.length },
          { hasChildren: false, empty: tree.bookmarks.length === 0 }
        )}
        {tree.children.map((c) => row(c, { hasChildren: c.children.length > 0 }))}
      </nav>
      {folderMenu &&
        (() => {
          const f = folderMenu.id ? folders.find((x) => x.id === folderMenu.id) : null;
          if (folderMenu.id && !f) return null;
          if (!f) {
            // 「未分组」行: 只能新建顶层夹
            return (
              <ContextMenu
                x={folderMenu.x}
                y={folderMenu.y}
                items={[{ key: "new", label: "新建文件夹…", icon: "plus", run: () => onNewFolder(null) }]}
                label="文件夹操作"
                onClose={() => setFolderMenu(null)}
              />
            );
          }
          const size = folderSubtreeSize(folders, bookmarks, f.id);
          const items: MenuItem[] = [
            { key: "new", label: "新建子文件夹…", icon: "plus", run: () => onNewFolder(f.id) },
            { key: "edit", label: "编辑文件夹…", icon: "edit", run: () => onEditFolder(f) },
            {
              key: "delete",
              // 级联删除（能力块 19）→ 文案如实告知影响面
              label: `删除文件夹（连同 ${size.bookmarks} 条书签${size.folders ? `、${size.folders} 个子文件夹` : ""}）`,
              icon: "delete",
              danger: true,
              run: () => deleteFolder(f.id),
            },
          ];
          return (
            <ContextMenu
              x={folderMenu.x}
              y={folderMenu.y}
              items={items}
              label="文件夹操作"
              onClose={() => setFolderMenu(null)}
            />
          );
        })()}
    </aside>
  );
}

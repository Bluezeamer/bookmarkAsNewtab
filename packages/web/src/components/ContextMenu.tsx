import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// 上下文菜单（能力块 10 · ③）: 右键 / 触摸长按 / 键盘（ContextMenu 键、Shift+F10）打开同一份菜单
//   - 键盘: ↑↓ 移动, → 展开子菜单, ←/Esc 退回（无子菜单时关闭）, Home/End 首尾, Tab 在菜单内环游
//   - 关闭: Esc / 点击空白 / 页面滚动 / 右键空白; 关闭后焦点回到触发元素
//   - 定位: 固定于指针处并夹进视口; 子菜单与父项顶对齐, 右侧放不下时翻到左侧
//   - 渲染在 body 上的 portal: 卡片/抽屉有 backdrop-filter, 会给 position:fixed 造新的包含块
export type MenuIconName =
  "open" | "edit" | "move" | "copy" | "delete" | "folder" | "up" | "down" | "more" | "plus";

export interface MenuItem {
  /** 稳定 key（React key） */
  key: string;
  label: string;
  /** 触发动作（有 href 的导航项交给链接本身, 不看 run） */
  run?: () => void;
  /** 导航项: 渲染成真链接（原生新标签页/中键/键盘可用）, 选中后只负责关闭菜单 */
  href?: string;
  /** 二级菜单（「移动到…」） */
  submenu?: MenuItem[];
  /** 当前值（移动子菜单里给当前文件夹打勾） */
  current?: boolean;
  /** 危险动作: 悬停用暖色（apricot 辉光, 不引入第二个 accent） */
  danger?: boolean;
  /** 前缀图标（全部绘制, craft-floor 禁 emoji） */
  icon?: MenuIconName;
  /** 透传 data-* 锚点（如 data-bk-edit） */
  attrs?: Record<string, string>;
}

// 绘制图标集（1.7 描边 = 图标语言）
export function MenuIcon({ name }: { name: MenuIconName }) {
  const d: Record<MenuIconName, string[]> = {
    open: ["M7 17 17 7", "M9.6 7H17v7.4"],
    edit: ["M5 19h3.6L19.4 8.2a2.2 2.2 0 0 0-3.1-3.1L5.5 15.9z", "M14.6 6.7l2.7 2.7"],
    move: [
      "M3.6 7.6A1.6 1.6 0 0 1 5.2 6h3.1l1.6 2h8.1a1.6 1.6 0 0 1 1.6 1.6v7.8a1.6 1.6 0 0 1-1.6 1.6H5.2a1.6 1.6 0 0 1-1.6-1.6z",
      "M9.8 13.4h5",
      "M12.8 11.2l2.2 2.2-2.2 2.2",
    ],
    copy: [
      "M9.2 9.2h9.3v9.3H9.2z",
      "M15 6.6v-.4A1.6 1.6 0 0 0 13.4 4.6H6A1.6 1.6 0 0 0 4.4 6.2v7.4A1.6 1.6 0 0 0 6 15.2h.4",
    ],
    delete: [
      "M4.8 7.4h14.4",
      "M9.6 7.4V6.2a1.3 1.3 0 0 1 1.3-1.3h2.2a1.3 1.3 0 0 1 1.3 1.3v1.2",
      "M6.5 7.4l.9 11.1a1.4 1.4 0 0 0 1.4 1.3h6.4a1.4 1.4 0 0 0 1.4-1.3l.9-11.1",
      "M10.5 11v5.2M13.5 11v5.2",
    ],
    folder: [
      "M3.6 7.6A1.6 1.6 0 0 1 5.2 6h3.1l1.6 2h8.1a1.6 1.6 0 0 1 1.6 1.6v7.8a1.6 1.6 0 0 1-1.6 1.6H5.2a1.6 1.6 0 0 1-1.6-1.6z",
    ],
    up: ["M12 19V5.4", "M6.6 10.8 12 5.4l5.4 5.4"],
    down: ["M12 5v13.6", "M6.6 13.2 12 18.6l5.4-5.4"],
    more: ["M6 12h.01M12 12h.01M18 12h.01"],
    plus: ["M12 6.4v11.2", "M6.4 12h11.2"],
  };
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
      {d[name].map((p) => (
        <path key={p} d={p} />
      ))}
    </svg>
  );
}

// 菜单面板: **不透明实底**（能力块 12 · ④: 半透明会让背后内容透出来）; 用 .popover 原语
const PANEL = "popover min-w-[11.5rem] p-1.5";
// 44px 行高 = 触摸目标（intent D）
const ITEM =
  "flex min-h-11 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left text-[13.5px] font-medium text-ink transition-colors";
const ITEM_IDLE = "hover:bg-accent/[0.10]";
const ITEM_DANGER = "hover:bg-[rgba(251,191,163,0.35)]";

export default function ContextMenu({
  x,
  y,
  items,
  onClose,
  returnFocusTo,
  label = "操作",
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  /** 关闭后焦点回归的元素（通常是触发条目的链接） */
  returnFocusTo?: HTMLElement | null;
  label?: string;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const subPanelRef = useRef<HTMLDivElement | null>(null);
  const subParentRef = useRef<HTMLElement | null>(null);
  const focusSubRef = useRef(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [openSub, setOpenSub] = useState<number | null>(null);
  const [subStyle, setSubStyle] = useState<{ top: number; flip: boolean } | null>(null);

  // ① 夹进视口: 先量尺寸（首帧隐藏, 避免闪一下再跳位）
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const m = 8;
    setPos({
      left: Math.max(m, Math.min(x, window.innerWidth - r.width - m)),
      top: Math.max(m, Math.min(y, window.innerHeight - r.height - m)),
    });
  }, [x, y]);

  // ② 子菜单: 与父项顶对齐; 右侧放不下就翻到左侧
  useLayoutEffect(() => {
    if (openSub === null) {
      setSubStyle(null);
      return;
    }
    const parent = subParentRef.current;
    const sub = subPanelRef.current;
    const root = panelRef.current;
    if (!parent || !sub || !root) return;
    const left = pos?.left ?? x;
    const flip = left + root.offsetWidth + sub.offsetWidth + 12 > window.innerWidth;
    const top = Math.max(
      8,
      Math.min(parent.offsetTop, window.innerHeight - sub.offsetHeight - 8 - (pos?.top ?? y)),
    );
    setSubStyle({ top, flip });
    if (focusSubRef.current) {
      focusSubRef.current = false;
      sub.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    }
  }, [openSub, pos, x, y]);

  // 关闭后把焦点还给触发元素（不留在已卸载的节点上）
  useEffect(() => () => returnFocusTo?.focus?.(), [returnFocusTo]);

  // 打开即交焦点（键盘立刻可用）。必须等 pos 算完 —— 定位前外层是 visibility:hidden,
  // 对隐藏元素调 focus() 是 no-op（实测: 右键打开后 activeElement 仍停在条目上, Esc/↑↓ 全失效）
  const focusedRef = useRef(false);
  useEffect(() => {
    if (focusedRef.current || !pos) return;
    focusedRef.current = true;
    panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [pos]);

  // Esc 全局兜底: 菜单是浮层, 不该要求焦点先在菜单里（右键后直接按 Esc 是最自然的动作）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Esc / 滚动 / 缩放都关闭; 菜单内部滚动不关（长文件夹列表要能滚）
  useEffect(() => {
    const onScroll = (e: Event) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onResize = () => onClose();
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onResize);
    };
  }, [onClose]);

  const menuItemsOf = (panel: HTMLElement | null) => [
    ...(panel?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
  ];

  const move = (panel: HTMLElement | null, dir: 1 | -1 | "first" | "last") => {
    const list = menuItemsOf(panel);
    if (list.length === 0) return;
    const i = list.indexOf(document.activeElement as HTMLElement);
    const next =
      dir === "first"
        ? 0
        : dir === "last"
          ? list.length - 1
          : (i + dir + list.length) % list.length;
    list[next]?.focus();
  };

  const closeSub = () => {
    const parent = subParentRef.current;
    setOpenSub(null);
    parent?.focus();
  };

  const openSubmenu = (i: number, viaKeyboard: boolean) => {
    subParentRef.current = menuItemsOf(panelRef.current)[i] ?? null;
    focusSubRef.current = viaKeyboard;
    setOpenSub(i);
  };

  const onRootKeyDown = (e: React.KeyboardEvent) => {
    const list = menuItemsOf(panelRef.current);
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(panelRef.current, 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(panelRef.current, -1);
    } else if (e.key === "Home") {
      e.preventDefault();
      move(panelRef.current, "first");
    } else if (e.key === "End") {
      e.preventDefault();
      move(panelRef.current, "last");
    } else if (e.key === "Tab") {
      // 焦点环游在菜单内（Tab 不会把焦点丢到背后的页面）
      e.preventDefault();
      move(panelRef.current, e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowLeft" && openSub !== null) {
      e.preventDefault();
      closeSub();
    } else if (e.key === "ArrowRight" && i >= 0 && items[i].submenu) {
      e.preventDefault();
      openSubmenu(i, true);
    }
  };

  const onSubKeyDown = (e: React.KeyboardEvent) => {
    if (
      e.key === "ArrowDown" ||
      e.key === "ArrowUp" ||
      e.key === "Home" ||
      e.key === "End" ||
      e.key === "Tab"
    ) {
      e.preventDefault();
      e.stopPropagation();
      move(
        subPanelRef.current,
        e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : e.key === "Home" ? "first" : "last",
      );
    } else if (e.key === "Escape" || e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      closeSub();
    }
  };

  const itemClass = (it: MenuItem, active: boolean) =>
    `${ITEM} ${it.danger ? ITEM_DANGER : ITEM_IDLE} ${active ? "bg-accent/[0.10]" : ""}`;

  return createPortal(
    <>
      {/* 空白层: 只吃 pointerdown（长按/右键那次手势的补发 click 不会误关菜单） */}
      <div
        aria-hidden
        className="fixed inset-0 z-[70]"
        onPointerDown={(e) => {
          e.preventDefault();
          onClose();
        }}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div
        ref={wrapRef}
        className="fixed z-[71]"
        style={{ left: pos?.left ?? x, top: pos?.top ?? y, visibility: pos ? undefined : "hidden" }}
        onKeyDown={onRootKeyDown}
      >
        <div
          ref={panelRef}
          role="menu"
          aria-label={label}
          data-ctx-menu
          className={`rise-in ${PANEL}`}
        >
          {items.map((it, i) => {
            const active = openSub === i;
            const inner = (
              <>
                {it.icon && (
                  <span className="shrink-0 text-ink-3">
                    <MenuIcon name={it.icon} />
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{it.label}</span>
                {it.submenu && (
                  <svg
                    className="shrink-0 text-ink-3"
                    viewBox="0 0 24 24"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M9.5 6.5 15 12l-5.5 5.5" />
                  </svg>
                )}
              </>
            );
            // 导航项用真链接: 中键/键盘/新标签页语义都由浏览器负责, 这里只补"选中即关菜单"
            if (it.href) {
              return (
                <a
                  key={it.key}
                  {...it.attrs}
                  role="menuitem"
                  href={it.href}
                  target="_blank"
                  rel="noreferrer noopener"
                  onPointerEnter={() => setOpenSub(null)}
                  onClick={onClose}
                  className={itemClass(it, active)}
                >
                  {inner}
                </a>
              );
            }
            return (
              <button
                key={it.key}
                {...it.attrs}
                type="button"
                role="menuitem"
                aria-haspopup={it.submenu ? "menu" : undefined}
                aria-expanded={it.submenu ? active : undefined}
                onPointerEnter={() => {
                  // 鼠标悬停即展开子菜单（原生菜单语义）, 移到他项则收起
                  if (it.submenu) openSubmenu(i, false);
                  else if (openSub !== null) setOpenSub(null);
                }}
                onClick={() => {
                  if (it.submenu) {
                    if (openSub === i) setOpenSub(null);
                    else openSubmenu(i, false);
                    return;
                  }
                  it.run?.();
                  onClose();
                }}
                className={itemClass(it, active)}
              >
                {inner}
              </button>
            );
          })}
        </div>

        {openSub !== null && items[openSub]?.submenu && (
          <div
            ref={subPanelRef}
            role="menu"
            aria-label={items[openSub].label}
            data-ctx-submenu
            className={`rise-in absolute max-h-[min(60vh,20rem)] overflow-y-auto ${PANEL}`}
            style={{
              top: subStyle?.top ?? 0,
              left: subStyle && !subStyle.flip ? "100%" : undefined,
              right: subStyle?.flip ? "100%" : undefined,
              marginLeft: subStyle && !subStyle.flip ? 4 : undefined,
              marginRight: subStyle?.flip ? 4 : undefined,
              visibility: subStyle ? undefined : "hidden",
            }}
            onKeyDown={onSubKeyDown}
          >
            {items[openSub].submenu!.map((s) => (
              <button
                key={s.key}
                type="button"
                role="menuitem"
                onClick={() => {
                  s.run?.();
                  onClose();
                }}
                className={`${ITEM} ${s.danger ? ITEM_DANGER : ITEM_IDLE}`}
              >
                {s.icon && (
                  <span className="shrink-0 text-ink-3">
                    <MenuIcon name={s.icon} />
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{s.label}</span>
                {s.current && (
                  <svg
                    className="shrink-0 text-accent"
                    viewBox="0 0 24 24"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.9"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M5.5 12.5 10 17l8.5-9.5" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </>,
    document.body,
  );
}

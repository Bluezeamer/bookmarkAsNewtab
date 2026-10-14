import { useEffect, useRef, type ReactNode } from "react";

// 设置抽屉（右侧独立层, 不占主页面空间、无路由）; Esc 关闭 + 遮罩点击关闭 + 焦点回归
// Dawn 重绘（能力块 10 · ①b）: 玻璃层 + 发丝左缘 + 衬线不参与（标题走无衬线 UI 语气）
// 注意: 不用 .glass 原语 —— 它固定了 28px 圆角（console 语义）, 全高抽屉要的是直边
export default function SettingsDrawer({
  open,
  onClose,
  returnFocusTo,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** 关闭后焦点回归的元素（显式指定比 activeElement 可靠 —— 程序化点击/键盘路径都成立） */
  returnFocusTo?: HTMLElement | null;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // 焦点进入抽屉（可访问性最小契约）
    panel.current?.querySelector<HTMLElement>("button, select, input")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      (returnFocusTo ?? (opener.current as HTMLElement | null))?.focus?.();
    };
  }, [open, onClose, returnFocusTo]);

  if (!open) return null;
  return (
    <div data-settings-overlay className="fixed inset-0 z-50 flex justify-end">
      <button
        aria-label="关闭设置"
        onClick={onClose}
        className="flex-1 bg-ink/20 backdrop-blur-[1px]"
        tabIndex={-1}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        data-settings-panel
        className="drawer-in h-full w-[min(22rem,90vw)] overflow-y-auto border-l border-[color:var(--color-glass-edge)] bg-[rgba(255,255,255,0.78)] p-4 shadow-[0_24px_64px_-16px_rgba(85,88,224,0.20)] backdrop-blur-2xl backdrop-saturate-150"
      >
        <div className="mb-4 flex items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-ink">设置</h2>
          <button data-settings-close onClick={onClose} className="btn-quiet">
            {/* 绘制叉（替代 ✕ 文本） */}
            <svg
              viewBox="0 0 24 24"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
            </svg>
            关闭
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

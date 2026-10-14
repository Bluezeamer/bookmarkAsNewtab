import type { ConnStatus } from "../lib/crdt";

// 只在“确实断开”时提示; connecting 阶段（首连/短暂重连）不打扰
// Dawn（能力块 10 · ①a）: 状态线 = ink-2 文字 + accent 淡底 + 发丝玻璃边; 警告图标是绘制的（不用 emoji）
export default function StatusBanner({ status }: { status: ConnStatus }) {
  if (status !== "disconnected") return null;
  return (
    <div className="rise-in mb-4 flex items-start gap-2.5 rounded-[var(--radius-card)] border border-[color:var(--color-glass-edge)] bg-accent/[0.10] px-4 py-3 text-[13px] font-medium text-ink-2">
      <svg
        className="mt-0.5 shrink-0"
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
        <circle cx="12" cy="12" r="8.4" />
        <path d="M12 7.8v4.6" />
        <path d="M12 15.8h.01" />
      </svg>
      <span>后端连接不可达——请检查 server 是否运行（无离线缓存，恢复后数据自动同步）</span>
    </div>
  );
}

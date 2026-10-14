import { useState } from "react";

// 首次访问的 token 门禁（Dawn · 能力块 10 · ①a）: 衬线标题 + 玻璃卡 + 一个主按钮
// 自绘辉光层: TokenGate 在 App 的 <Background/> 之前就 return 了, 没有它玻璃卡无背景可磨（One Frost Rule）
export default function TokenGate({
  onSubmit,
  defaultServerUrl,
}: {
  onSubmit: (token: string, serverUrl: string) => void;
  defaultServerUrl?: string;
}) {
  const [value, setValue] = useState("");
  // 后端地址（能力块 14 · ③）: 缺省同源; 允许指向别的后端（自托管多实例 / 静态托管场景）
  const [server, setServer] = useState(defaultServerUrl ?? "");
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="dawn-glow dawn-glow-peri" />
        <div className="dawn-glow dawn-glow-aqua" />
        <div className="dawn-glow dawn-glow-apricot" />
      </div>
      <form
        className="rise-in glass relative w-full max-w-md p-7 sm:p-8"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim(), server.trim());
        }}
      >
        <h1 className="mb-2 font-serif text-[28px] font-medium leading-tight tracking-[-0.015em] text-ink">
          bookmarkAsNewtab
          <span
            aria-hidden
            className="ml-1 inline-block h-[5px] w-[5px] -translate-y-1.5 rounded-full bg-accent"
          />
        </h1>
        <p className="mb-6 text-[13.5px] leading-relaxed text-ink-2">
          首次使用，请输入访问 token（server 的 <code>SYNC_TOKEN</code>）。留空服务器地址则用当前站点。
        </p>
        <input
          type="text"
          value={server}
          onChange={(e) => setServer(e.target.value)}
          placeholder={`服务器地址（留空 = ${typeof location !== "undefined" ? location.origin : "同源"}）`}
          aria-label="服务器地址"
          className="field mb-3 h-12 w-full px-3.5 text-[13.5px] text-ink"
        />
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="token"
          autoFocus
          aria-label="访问 token"
          className="field mb-4 h-12 w-full px-3.5 text-[13.5px] text-ink"
        />
        <button
          type="submit"
          disabled={!value.trim()}
          className="btn-accent w-full justify-center disabled:opacity-40"
        >
          进入我的书签世界
          {/* 绘制箭头（替代文本里的 → ） */}
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
            <path d="M4.5 12h14" />
            <path d="M13 6.5 18.5 12 13 17.5" />
          </svg>
        </button>
      </form>
    </div>
  );
}

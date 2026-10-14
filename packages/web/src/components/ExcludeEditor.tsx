import { useState } from "react";
import { validDomain } from "../lib/history";
import { addExcludeDomain, readExcludeDomains, removeExcludeDomain } from "../lib/crdt";

// 排除列表编辑（ADR-007: 配置区走 CRDT → 多端同步, 扩展采集端立即生效）
// Dawn 重绘: 折叠卡 + .field 输入 + pill 操作; data-exclude-* 锚点不变
export default function ExcludeEditor() {
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const domains = readExcludeDomains();

  function add() {
    const d = input.trim().toLowerCase();
    if (!d) return;
    if (!validDomain(d)) {
      setError("域名格式不对（只要域名, 如 example.com, 不带 http:// 或路径）");
      return;
    }
    if (!addExcludeDomain(d)) {
      setError("未连上后端，稍后再试");
      return;
    }
    setError("");
    setInput("");
  }

  return (
    <details className="glass-card p-3">
      <summary className="cursor-pointer text-[13px] font-semibold text-ink">
        排除域名（{domains.length}）——不计入历史采集
      </summary>
      <div className="mt-3 flex flex-wrap gap-2">
        <input
          data-exclude-input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          placeholder="example.com"
          aria-label="要排除的域名"
          className="field h-10 min-w-[12rem] flex-1 px-3 font-mono text-[13px] text-ink"
        />
        <button data-exclude-add onClick={add} className="btn-accent shrink-0">
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden
          >
            <path d="M12 5.5v13M5.5 12h13" />
          </svg>
          排除
        </button>
      </div>
      {error && (
        <p className="mt-2 flex items-start gap-2 rounded-[var(--radius-tile)] bg-accent/[0.08] px-2.5 py-2 text-[12px] font-medium text-ink">
          <svg
            className="mt-0.5 shrink-0 text-ink-2"
            viewBox="0 0 24 24"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="12" cy="12" r="8.4" />
            <path d="M12 7.8v4.6M12 15.8h.01" />
          </svg>
          {error}
        </p>
      )}
      {domains.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {domains.map((d) => (
            <li
              key={d}
              data-exclude-item={d}
              className="flex items-center gap-2 rounded-full border border-[color:var(--color-glass-edge)] bg-white/60 px-2.5 py-1 font-mono text-[11.5px] text-ink-2"
            >
              {d}
              <button
                onClick={() => removeExcludeDomain(d) || setError("未连上后端，稍后再试")}
                title="移除"
                aria-label={`移除 ${d}`}
                className="grid h-5 w-5 place-items-center rounded-full text-ink-3 transition-colors hover:bg-ink/[0.08] hover:text-ink"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="12"
                  height="12"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  aria-hidden
                >
                  <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">
        精确匹配该域名（含 www 的写法请分别添加）；配置多端同步，浏览器扩展采集端即时生效。
      </p>
    </details>
  );
}

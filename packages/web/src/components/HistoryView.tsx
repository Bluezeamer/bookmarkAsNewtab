import { useEffect, useState } from "react";
import {
  MAX_LIMIT,
  PAGE_SIZE,
  fetchHistory,
  hostOf,
  relTime,
  type HistoryEntry,
  type HistoryFilters,
} from "../lib/history";
import BookmarkIcon from "./BookmarkIcon";

// 历史视图（能力块 7 · I2 精简）: 筛选条已收进统一搜索栏的「筛选」二级
// 本视图只负责: 按共享的关键词+筛选取数、列表呈现、加载更多、空/错态
// Dawn 重绘（能力块 10 · ①b）: 玻璃行 + ink 三级 + 唯一 accent 的主按钮; data-hist-* 锚点不变
export default function HistoryView({
  token,
  query,
  filters,
}: {
  token: string;
  query: string;
  filters: HistoryFilters;
}) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [total, setTotal] = useState(0);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);

  // 300ms 防抖（关键词来自统一搜索栏）
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const r = await fetchHistory(token, { ...filters, keyword: query }, limit);
        if (!alive) return;
        setTotal(r.total);
        setEntries(r.entries);
      } catch (e) {
        if (!alive) return;
        setTotal(0);
        setEntries([]);
        setError(`历史查询失败：${(e as Error).message}（检查后端可达性）`);
      } finally {
        if (alive) setLoading(false);
      }
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [token, query, filters, limit]);

  if (error) {
    return (
      <p className="glass-card flex items-start gap-2.5 px-4 py-3 text-[13px] font-medium text-ink-2">
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
          <path d="M12 7.8v4.6M12 15.8h.01" />
        </svg>
        {error}
      </p>
    );
  }
  if (loading && entries.length === 0)
    return <p className="text-[13px] font-medium text-ink-3">加载中…</p>;
  if (total === 0) {
    return (
      <div className="glass-card flex flex-col items-center px-8 py-14 text-center">
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
          <circle cx="12" cy="12" r="8" />
          <path d="M12 7.6V12l3.2 2" />
        </svg>
        <p className="font-serif text-[23px] font-medium tracking-[-0.01em] text-ink">
          没有匹配的历史
        </p>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-2">
          换个关键词或时间范围试试；桌面扩展安装后才会开始采集
        </p>
      </div>
    );
  }

  return (
    <>
      <p className="mb-2 text-[12.5px] text-ink-2 tabular-nums" data-hist-count>
        命中 {total} 条，已显示 {entries.length} 条
      </p>
      <ul className="space-y-2">
        {entries.map((e) => (
          <li key={`${e.url}|${e.visitedAt}`} data-hist className="rise-in glass-card p-2.5">
            <div className="flex items-start gap-2.5">
              <BookmarkIcon url={e.url} title={e.title || e.url} size={20} />
              <a
                href={e.url}
                target="_blank"
                rel="noreferrer noopener"
                className="block min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink hover:underline"
                title={e.title || e.url}
              >
                {e.title || e.url}
              </a>
              <span className="shrink-0 text-[11.5px] text-ink-3 tabular-nums">
                {relTime(e.visitedAt)}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 pl-[30px] text-[11.5px]">
              <span className="shrink-0 rounded-full bg-ink/[0.07] px-1.5 py-0.5 font-mono text-ink-2">
                {hostOf(e.url)}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-ink-3">{e.url}</span>
            </div>
          </li>
        ))}
      </ul>
      {entries.length < total && entries.length < MAX_LIMIT && (
        <button
          data-hist-more
          onClick={() => setLimit((l) => Math.min(l + PAGE_SIZE, MAX_LIMIT))}
          className="btn-quiet mt-3 w-full justify-center"
        >
          加载更多
        </button>
      )}
    </>
  );
}

import { useEffect, useRef, useState } from "react";
import { fetchHistory, relTime, type HistoryEntry, type HistoryFilters } from "../lib/history";
import {
  EMPTY_HITS,
  SEARCH_LIMIT,
  hitId,
  hitSubtitle,
  mergeHits,
  moveIndex,
  type SearchHit,
} from "../lib/search";
import type { Bookmark, Folder } from "../lib/logic";
import { ENGINES, engineById, engineShort } from "../lib/engines";
import BookmarkIcon from "./BookmarkIcon";
import HistoryFiltersBar from "./HistoryFiltersBar";

// 统一搜索栏（能力块 7 · I2 + 能力块 9 · I2 + 能力块 10 · ①a Dawn 重绘）
// 一次输入同时命中书签（本地过滤）与历史（服务端查询）; 结果分组呈现
// 能力块 16 的交互范式: **默认无选中**（输入即"搜索态"）——
//   Enter = 用当前引擎搜; ↑↓ 才进入候选导航, 此时 Enter = 打开选中候选; 任何输入变化都回到无选中
// 能力块 9: 顶栏只留搜索框 —— 引擎切换在框左、筛选收进框内右侧; 面板末尾追加「用 <引擎> 搜索」行
// 能力块 10 · ①a: 56px 玻璃输入框（.field）; 两个框内按钮是**绝对定位在 input 矩形内**的玻璃小格
//   （浏览器验收会量: (data-engine-btn / data-search-filters) 矩形必须完全落在 input 矩形内且 ≥24×24）
// 悬浮面板的阴影用内联 var(--shadow-console): 原语 .glass-card 在源序上晚于工具类, 工具类覆盖不了它的阴影
export default function UnifiedSearch({
  token,
  bookmarks,
  folders,
  query,
  onQueryChange,
  filters,
  onFiltersChange,
  onOpenExclude,
  engineId,
  onEngineChange,
}: {
  token: string;
  bookmarks: Bookmark[];
  folders: Folder[];
  query: string;
  onQueryChange: (q: string) => void;
  filters: HistoryFilters;
  onFiltersChange: (f: HistoryFilters) => void;
  onOpenExclude: () => void;
  engineId: string;
  onEngineChange: (id: string) => void;
}) {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyError, setHistoryError] = useState("");
  const [active, setActive] = useState(-1);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [enginesOpen, setEnginesOpen] = useState(false);
  const seq = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const engine = engineById(engineId);
  const open = query.trim().length > 0;
  const hits = open
    ? mergeHits(bookmarks, folders, history, historyTotal, query, SEARCH_LIMIT, engine)
    : EMPTY_HITS;

  // 历史命中: 300ms 防抖 + 请求序号丢弃过期响应
  useEffect(() => {
    if (!open) {
      setHistory([]);
      setHistoryTotal(0);
      setHistoryError("");
      return;
    }
    const my = ++seq.current;
    const timer = setTimeout(async () => {
      try {
        const r = await fetchHistory(token, { ...filters, keyword: query }, SEARCH_LIMIT);
        if (my !== seq.current) return;
        setHistory(r.entries);
        setHistoryTotal(r.total);
        setHistoryError("");
      } catch {
        if (my !== seq.current) return;
        setHistory([]);
        setHistoryTotal(0);
        setHistoryError("历史查询失败（后端不可达）");
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [token, query, filters, open]);

  // 命中变化时高亮复位到首项
  useEffect(() => {
    // 能力块 16 · E: 任何输入变化都回到"搜索栏态"（不预选候选）
    setActive(-1);
    // 只在查询或命中数变化时复位高亮（刻意不依赖 hits 对象本身）
  }, [query, hits.flat.length]);

  // 全局 "/" 聚焦搜索栏（非输入态；无修饰键）
  useEffect(() => {
    const onDoc = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener("keydown", onDoc);
    return () => document.removeEventListener("keydown", onDoc);
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      onQueryChange("");
      setActive(-1);
      return;
    }
    if (!open) return;
    // 注意（能力块 16）: 不能因为"没有候选"就整体早退 —— 无候选时**回车仍要走引擎搜索** ✗
    // （flat 现在不含引擎行, 所以 flat 为空是常态而非异常）
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (hits.flat.length === 0) return; // 没候选就没得导航
      e.preventDefault();
      setActive((i) => moveIndex(i, e.key === "ArrowDown" ? 1 : -1, hits.flat.length));
      return;
    }
    if (e.key === "Enter") {
      // 有选中（↑↓ 之后）→ 打开选中候选; 否则 → 直接用当前引擎搜
      const hit = active >= 0 ? hits.flat[active] : undefined;
      const target = hit ?? hits.engine;
      if (target) {
        e.preventDefault();
        window.open(target.url, "_blank", "noopener");
        onQueryChange("");
        setActive(-1);
      }
    }
  }

  const activeFilterCount =
    (filters.domain ? 1 : 0) +
    (filters.fromDate || filters.toDate || filters.preset !== "all" ? 1 : 0);

  const item = (hit: SearchHit, index: number) => {
    const engineRow = hit.kind === "engine";
    const on = active === index;
    const title = engineRow ? `用 ${hit.engineName} 搜索「${hit.query}」` : hit.title;
    return (
      <div
        key={hitId(hit, index)}
        id={hitId(hit, index)}
        role="option"
        aria-selected={on}
        data-search-hit={hit.kind}
        onMouseEnter={() => setActive(index)}
        onClick={() => {
          window.open(hit.url, "_blank", "noopener");
          if (engineRow) onQueryChange("");
        }}
        className={`flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-tile)] px-2 py-1.5 transition-colors ${
          on ? "bg-accent text-white" : "hover:bg-white/60"
        }`}
      >
        {engineRow ? (
          // 绘制引擎短标格（不动 .icon-tile 的衬线字: 与 favicon 首字母同一族）
          <span className="icon-tile h-6 w-6 shrink-0 bg-white/70 text-[11.5px] text-accent">
            {engineShort(engine)}
          </span>
        ) : (
          <BookmarkIcon url={hit.url} title={title} size={20} />
        )}
        <span className="min-w-0 flex-1">
          {/* 命中行层级: 标题 13.5/500 ink, 副题 11.5 ink-3（两层就够, 不再叠第三层强调） */}
          <span
            className={`block truncate text-[13.5px] font-medium ${on ? "text-white" : "text-ink"}`}
          >
            {title}
          </span>
          <span
            className={`block truncate text-[11.5px] tabular-nums ${on ? "text-white/90" : "text-ink-3"}`}
          >
            {hitSubtitle(hit)}
          </span>
        </span>
        {hit.kind === "history" && (
          <span
            className={`shrink-0 text-[11.5px] font-medium tabular-nums ${on ? "text-white/90" : "text-ink-3"}`}
          >
            {relTime(hit.visitedAt)}
          </span>
        )}
        {engineRow && (
          <svg
            className={`shrink-0 ${on ? "text-white/90" : "text-ink-2"}`}
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
            <path d="M7 17 17 7" />
            <path d="M9 7h8v8" />
          </svg>
        )}
      </div>
    );
  };

  return (
    <div data-unified-search className="relative">
      <div className="relative">
        <input
          ref={inputRef}
          data-search-input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={open}
          aria-controls="search-panel"
          aria-autocomplete="list"
          aria-activedescendant={
            active >= 0 && hits.flat[active] ? hitId(hits.flat[active], active) : undefined
          }
          placeholder={`搜索书签与历史，回车用 ${engine.name} 搜（按 / 聚焦）`}
          className="field h-14 w-full min-w-0 pr-12 pl-[4.5rem] text-[15.5px] font-normal text-ink"
        />
        {/* 放大镜（搜索框: 19px 绘制, 1.8 描边）: 纯装饰, 不吃点击 */}
        <svg
          className="pointer-events-none absolute top-1/2 left-11 -translate-y-1/2 text-ink-2"
          viewBox="0 0 24 24"
          width="19"
          height="19"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.8-3.8" />
        </svg>
        <button
          data-engine-btn
          onClick={() => setEnginesOpen((v) => !v)}
          title={`搜索引擎：${engine.name}（点击切换）`}
          aria-label={`搜索引擎：${engine.name}`}
          aria-expanded={enginesOpen}
          className={`absolute top-1/2 left-1.5 z-10 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-[var(--radius-tile)] border text-[12px] font-semibold transition-colors ${
            enginesOpen
              ? "border-[color:var(--color-accent)] bg-accent/[0.14] text-accent"
              : "border-[color:var(--color-glass-edge)] bg-white/70 text-ink-2 hover:bg-white/90"
          }`}
        >
          {engineShort(engine)}
        </button>
        {enginesOpen && (
          <ul
            data-engine-menu
            // 引擎菜单必须**高于结果面板**（两者都开着时, 面板在 DOM 后面会盖住菜单 —— 实测命中测试失败）
            className="rise-in popover absolute top-full left-0 z-[45] mt-1.5 w-44 p-1"
            style={{ boxShadow: "var(--shadow-console)" }}
          >
            {ENGINES.map((e) => (
              <li key={e.id}>
                <button
                  data-engine-option={e.id}
                  onClick={() => {
                    onEngineChange(e.id);
                    setEnginesOpen(false);
                    inputRef.current?.focus();
                  }}
                  className={`flex w-full items-center gap-2 rounded-[var(--radius-tile)] px-2 py-1.5 text-left text-[12.5px] font-medium transition-colors ${
                    e.id === engine.id ? "bg-accent text-white" : "text-ink hover:bg-white/70"
                  }`}
                >
                  <span
                    className={`grid h-5 w-5 shrink-0 place-items-center rounded-[6px] border text-[11.5px] font-semibold ${
                      e.id === engine.id
                        ? "border-transparent bg-white/90 text-accent"
                        : "border-[color:var(--color-glass-edge)] bg-white/70 text-ink-2"
                    }`}
                  >
                    {engineShort(e)}
                  </span>
                  {e.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          data-search-filters
          onClick={() => setFiltersOpen((v) => !v)}
          title="历史筛选"
          aria-label={`历史筛选${activeFilterCount ? `（已启用 ${activeFilterCount} 项）` : ""}`}
          className={`absolute top-1/2 right-1.5 z-10 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-[var(--radius-tile)] border transition-colors ${
            filtersOpen || activeFilterCount
              ? "border-[color:var(--color-accent)] bg-accent/[0.14] text-accent"
              : "border-[color:var(--color-glass-edge)] bg-white/70 text-ink-2 hover:bg-white/90"
          }`}
        >
          {/* 漏斗（绘制, 替代 ⚙）; 启用项数用 accent 徽标 */}
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
            <path d="M4.5 6.5h15l-5.6 6.3v5.4l-3.8-2v-3.4z" />
          </svg>
          {activeFilterCount > 0 && (
            <span className="absolute -top-1 -right-1 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-1 text-[11.5px] leading-none font-semibold text-white tabular-nums">
              {activeFilterCount}
            </span>
          )}
        </button>
      </div>

      {filtersOpen && (
        <div className="rise-in glass-card mt-2 p-3" style={{ boxShadow: "var(--shadow-console)" }}>
          <HistoryFiltersBar
            filters={filters}
            onChange={onFiltersChange}
            onOpenExclude={onOpenExclude}
          />
        </div>
      )}

      {open && (
        <div
          id="search-panel"
          role="listbox"
          data-search-panel
          className="rise-in popover absolute z-40 mt-2 max-h-[60vh] w-full overflow-y-auto p-2"
          style={{ boxShadow: "var(--shadow-console)" }}
        >
          {hits.flat.length === 0 ? (
            <p className="p-3 text-[13px] text-ink-2">
              {historyError ? "没有匹配的书签；历史查询失败（后端不可达）" : "没有匹配的书签或历史"}
            </p>
          ) : (
            <>
              {hits.bookmarks.length > 0 && (
                <p
                  data-search-group="bookmarks"
                  className="px-2 py-1 text-[11.5px] font-medium text-ink-3 tabular-nums"
                >
                  书签 {hits.bookmarkTotal}
                </p>
              )}
              {hits.bookmarks.map((h, i) => item(h, i))}
              {hits.bookmarkTotal > hits.bookmarks.length && (
                <p className="px-2 pb-1 text-[11.5px] text-ink-3">
                  还有 {hits.bookmarkTotal - hits.bookmarks.length} 条书签…
                </p>
              )}
              {(hits.history.length > 0 || historyError) && (
                <p
                  data-search-group="history"
                  className="px-2 py-1 text-[11.5px] font-medium text-ink-3 tabular-nums"
                >
                  {historyError ? "历史（查询失败）" : `历史 ${hits.historyTotal}`}
                </p>
              )}
              {hits.history.map((h, i) => item(h, hits.bookmarks.length + i))}
              {hits.historyTotal > hits.history.length && (
                <p className="px-2 pb-1 text-[11.5px] text-ink-3">
                  还有 {hits.historyTotal - hits.history.length} 条历史…
                </p>
              )}
              {/* 引擎搜索行（能力块 9 · I2）: 始终最后一行, 无高亮时 Enter 即走它; Dawn: 用浅一档的玻璃块分开, 不画分隔线 */}
              {/* 引擎搜索提示（能力块 16 · D）: **不是列表项**（不可选中、不计入 ↑↓）, 只做可发现性提示 */}
              {hits.engine && (
                <p
                  data-engine-hint
                  className="mt-1 border-t-2 border-dashed border-ink/20 px-2 pt-2 text-[11.5px] text-ink-3"
                >
                  回车用 <span className="font-semibold text-ink-2">{hits.engine.engineName}</span> 搜索「
                  {hits.engine.query}」 · ↑↓ 选择下方候选
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

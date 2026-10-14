import { RANGE_PRESETS, type HistoryFilters, type RangePreset } from "../lib/history";

const PRESET_LABEL: Record<RangePreset, string> = {
  today: "今天",
  "7d": "近 7 天",
  "30d": "近 30 天",
  all: "全部",
};

// 历史筛选控件块（能力块 7 · I2: 从历史页顶部搬到统一搜索栏的「筛选」二级）
// Dawn 重绘（能力块 10 · ①b）: chips 配方（白 45% 底 / 发丝边 / 选中 = accent 实底）
// data-history-filters / data-hist-preset / data-hist-from / data-hist-to / data-hist-domain / data-hist-exclude-link 锚点不变
export default function HistoryFiltersBar({
  filters,
  onChange,
  onOpenExclude,
}: {
  filters: HistoryFilters;
  onChange: (f: HistoryFilters) => void;
  onOpenExclude: () => void;
}) {
  const patch = (p: Partial<HistoryFilters>) => onChange({ ...filters, ...p });
  const presetActive = (p: RangePreset) =>
    filters.preset === p && !filters.fromDate && !filters.toDate;

  return (
    <div data-history-filters className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          data-hist-domain
          value={filters.domain}
          onChange={(e) => patch({ domain: e.target.value })}
          placeholder="域名精确匹配（example.com）"
          aria-label="域名精确匹配"
          className="field h-10 min-w-[10rem] flex-1 px-3 font-mono text-[12.5px] text-ink"
        />
        <button data-hist-exclude-link onClick={onOpenExclude} className="btn-quiet shrink-0">
          排除域名…
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {RANGE_PRESETS.map((p) => (
          <button
            key={p}
            data-hist-preset={p}
            onClick={() => patch({ preset: p, fromDate: "", toDate: "" })}
            className={`rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors ${
              presetActive(p)
                ? "bg-accent text-white shadow-[0_6px_16px_-8px_rgba(85,88,224,0.55)]"
                : "border border-[color:var(--color-glass-edge)] bg-white/45 text-[#3C4560] hover:bg-white/78"
            }`}
          >
            {PRESET_LABEL[p]}
          </button>
        ))}
        <span className="ml-1 text-[11.5px] font-medium text-ink-3">自定义</span>
        <input
          data-hist-from
          type="date"
          value={filters.fromDate}
          onChange={(e) => patch({ fromDate: e.target.value })}
          aria-label="起始日期"
          className="field h-9 px-2 font-mono text-[12px] text-ink"
        />
        <span className="text-[11.5px] text-ink-3">~</span>
        <input
          data-hist-to
          type="date"
          value={filters.toDate}
          onChange={(e) => patch({ toDate: e.target.value })}
          aria-label="结束日期"
          className="field h-9 px-2 font-mono text-[12px] text-ink"
        />
      </div>
      <p className="text-[11px] font-medium text-ink-3">
        筛选只作用于「历史」命中；书签命中仅受关键词影响。
      </p>
    </div>
  );
}

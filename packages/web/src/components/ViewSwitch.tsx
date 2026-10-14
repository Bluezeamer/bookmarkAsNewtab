import type { Prefs } from "../lib/logic";
import { GAP_MAX, GAP_MIN, NAV_ROW_MAX, NAV_ROW_MIN } from "../lib/logic";
import { DENSITIES, type Density } from "../lib/density";

const seg = (active: boolean) =>
  `px-2.5 py-1.5 text-xs font-semibold transition-colors ${
    active ? "bg-accent text-white" : "text-[#3C4560] hover:bg-white/70"
  }`;

// 外观控制（能力块 10 · ①: 暗色与壁纸已移除, 世界固定 Dawn 亮色）
// 视图三档 / 密度三档 / 书签间距 x·y（间距写入 CRDT, 见 lib/prefs.ts）
export default function ViewSwitch({
  prefs,
  onChange,
}: {
  prefs: Prefs;
  onChange: (patch: Partial<Prefs>) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-10 shrink-0 text-[11.5px] font-medium text-ink-3">视图</span>
        <div className="flex overflow-hidden rounded-full border border-[color:var(--color-glass-edge)] bg-white/45">
          {(
            [
              ["list", "列表"],
              ["grid", "卡片"],
              ["icons", "仅图标"],
            ] as const
          ).map(([v, label]) => (
            <button key={v} data-view-btn={v} className={seg(prefs.view === v)} onClick={() => onChange({ view: v })}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="w-10 shrink-0 text-[11.5px] font-medium text-ink-3">密度</span>
        <div className="flex overflow-hidden rounded-full border border-[color:var(--color-glass-edge)] bg-white/45">
          {DENSITIES.map((d) => (
            <button
              key={d}
              data-density-btn={d}
              className={seg(prefs.density === d)}
              onClick={() => onChange({ density: d })}
              title={`密度：${DENSITY_LABEL[d]}`}
            >
              {DENSITY_LABEL[d]}
            </button>
          ))}
        </div>
      </div>

      {(
        [
          ["gapX", "横向间距", prefs.gapX, GAP_MIN, GAP_MAX],
          ["gapY", "纵向间距", prefs.gapY, GAP_MIN, GAP_MAX],
          // 能力块 12 · ③: 侧栏导航行的点击目标高度（视觉与点击范围对齐后, 目标越大越好点）
          ["navRow", "导航行高", prefs.navRow, NAV_ROW_MIN, NAV_ROW_MAX],
        ] as const
      ).map(([key, label, value, min, max]) => (
        <label key={key} className="flex flex-wrap items-center gap-2 text-[11.5px] font-medium text-ink-3">
          <span className="w-10 shrink-0">{label}</span>
          <input
            type="range"
            data-gap-slider={key}
            min={min}
            max={max}
            step={2}
            value={value}
            onChange={(e) => onChange({ [key]: Number(e.target.value) } as Partial<Prefs>)}
            className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-[rgba(35,42,59,0.14)] accent-[color:var(--color-accent)]"
          />
          <span data-gap-value={key} className="w-10 shrink-0 text-right tabular-nums text-ink-2">
            {value}px
          </span>
        </label>
      ))}
    </div>
  );
}

const DENSITY_LABEL: Record<Density, string> = {
  compact: "紧凑",
  cozy: "标准",
  comfortable: "宽松",
};

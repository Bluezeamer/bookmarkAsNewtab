// 列表密度（能力块 8）: 三档尺寸参数（纯函数, 单一真相源）
// 目的: 空间利用率 —— 参考实测（1440px/12 条）: 原列表行 1121×106、图标格 95×180
export const DENSITIES = ["compact", "cozy", "comfortable"] as const;
export type Density = (typeof DENSITIES)[number];

export interface DensityParams {
  gap: number; // 栅格间距
  cardMin: number; // 卡片最小宽度（卡片视图）
  rowH: number; // 列表行最小高度
  pad: number; // 单元格内边距
  iconCard: number; // 卡片视图图标尺寸
  iconGrid: number; // 仅图标视图图标尺寸
  titlePx: number; // 标题字号
}

// 档位参数表（spec 2）
const TABLE: Record<Density, DensityParams> = {
  compact: { gap: 6, cardMin: 168, rowH: 56, pad: 8, iconCard: 28, iconGrid: 32, titlePx: 13 },
  cozy: { gap: 10, cardMin: 220, rowH: 68, pad: 10, iconCard: 32, iconGrid: 40, titlePx: 14 },
  comfortable: { gap: 14, cardMin: 284, rowH: 84, pad: 14, iconCard: 40, iconGrid: 48, titlePx: 15 },
};

export const DEFAULT_DENSITY: Density = "cozy";

export const parseDensity = (v: unknown): Density =>
  DENSITIES.includes(v as Density) ? (v as Density) : DEFAULT_DENSITY;

export const densityParams = (d: Density): DensityParams => TABLE[parseDensity(d)];

// 列表视图列数: 可用宽度 ≥ ~860px 时两列（提升宽屏利用率; 顺序仍 row-major）
// 注: 实际布局由 CSS `repeat(auto-fill, minmax(LIST_MIN_COL, 1fr))` 承担（跟随容器宽度自适应）;
//     本函数是同一规则的**纯函数表述**, 供单测/文档/未来 JS 侧布局判断使用
export const LIST_MIN_COL = 420;
export function listColumns(availableWidth: number): number {
  return availableWidth >= LIST_MIN_COL * 2 + 20 ? 2 : 1;
}

import { apiUrl } from "./crdt.ts";
// 浏览历史（ADR-007）: 条目走 HTTP API（不进 CRDT）, 排除列表走 CRDT 配置区
// 纯函数集中在此, 便于单测; 网络封装只有 fetchHistory
export interface HistoryEntry {
  url: string;
  title: string;
  visitedAt: string; // ISO (UTC)
}

export const RANGE_PRESETS = ["today", "7d", "30d", "all"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export interface HistoryFilters {
  keyword: string;
  domain: string;
  preset: RangePreset;
  // 自定义时间段（本地 date 字符串 YYYY-MM-DD）; 设置后 preset 视为 custom
  fromDate: string;
  toDate: string;
}

export const DEFAULT_FILTERS: HistoryFilters = {
  keyword: "",
  domain: "",
  preset: "all",
  fromDate: "",
  toDate: "",
};

export const PAGE_SIZE = 300; // 每次加载条数; server 上限 1000
export const MAX_LIMIT = 1000;

// 本地日界 → ISO 边界（"今天/近7天/近30天"口径）
export function rangeForPreset(
  preset: RangePreset,
  now = new Date()
): { from?: string; to?: string } {
  if (preset === "all") return {};
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // 今日 00:00 本地
  const days = preset === "today" ? 0 : preset === "7d" ? 6 : 29; // 含今天
  start.setDate(start.getDate() - days);
  return { from: start.toISOString() };
}

// 自定义日期 → ISO 起止（from 当日 00:00, to 当日 23:59:59.999 本地）
export function rangeForDates(fromDate: string, toDate: string): { from?: string; to?: string } {
  const out: { from?: string; to?: string } = {};
  if (/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    const [y, m, d] = fromDate.split("-").map(Number);
    out.from = new Date(y, m - 1, d).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    const [y, m, d] = toDate.split("-").map(Number);
    out.to = new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
  }
  return out;
}

// 组装查询串（跳过空值; 自定义日期优先于快捷区间）
export function buildQuery(filters: HistoryFilters, limit: number, now = new Date()): string {
  const range = filters.fromDate || filters.toDate
    ? rangeForDates(filters.fromDate, filters.toDate)
    : rangeForPreset(filters.preset, now);
  const p = new URLSearchParams();
  if (filters.keyword.trim()) p.set("keyword", filters.keyword.trim());
  if (filters.domain.trim()) p.set("domain", filters.domain.trim());
  if (range.from) p.set("from", range.from);
  if (range.to) p.set("to", range.to);
  p.set("limit", String(Math.min(limit, MAX_LIMIT)));
  return p.toString();
}

// 排除列表域名校验: 小写字母/数字/连字符/点, 带至少一个点, 不含 scheme/路径/端口
export function validDomain(raw: string): boolean {
  const d = raw.trim().toLowerCase();
  if (d.length < 4 || d.length > 253) return false;
  if (!/^[a-z0-9.-]+$/.test(d)) return false;
  if (d.startsWith("-") || d.endsWith("-") || d.includes("..")) return false;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d);
}

// 相对时间（"3 分钟前"）; 超过 7 天显示本地日期
export function relTime(iso: string, now = new Date()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = now.getTime() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  return new Date(t).toLocaleDateString();
}

// 条目域名（host, 含端口与 www —— 与 server 的精确匹配语义一致）
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export async function fetchHistory(
  token: string,
  filters: HistoryFilters,
  limit = PAGE_SIZE,
  now = new Date()
): Promise<{ total: number; entries: HistoryEntry[] }> {
  const r = await fetch(apiUrl(`/api/history?${buildQuery(filters, limit, now)}`), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = (await r.json()) as { total?: number; entries?: HistoryEntry[] };
  return { total: j.total ?? 0, entries: j.entries ?? [] };
}

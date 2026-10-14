// 浏览历史: onVisited 缓冲 → 批量 POST /api/history（server 去重）+ 启动补漏
import { readExcludeDomains } from "./crdt.ts";
import { ensureState } from "./state.ts";

export interface HistoryEntry {
  url: string;
  title: string;
  visitedAt: string; // ISO
}

const BATCH = 500; // server 单批上限

// 纯函数: 排除域过滤（精确域 + 子域）
export function excluded(url: string, domains: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return true; // 非法 URL 不采
  }
  return domains.some((d) => host === d || host.endsWith("." + d));
}

// 纯函数: 分块
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

let buffer: HistoryEntry[] = [];
let flushing = false;

export function pushHistory(entry: HistoryEntry): void {
  if (excluded(entry.url, readExcludeDomains())) return;
  buffer.push(entry);
  // 不在此处 flush: SW 事件上下文拿不到 token —— 由 1 分钟 alarm 统一 flush
}

export async function flush(serverUrl: string, token: string): Promise<number> {
  if (flushing) return 0;
  if (buffer.length === 0) return 0;
  flushing = true;
  try {
    let sent = 0;
    for (const batch of chunk(buffer, BATCH)) {
      const r = await fetch(`${serverUrl}/api/history`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ entries: batch }),
      });
      if (r.ok) sent += batch.length;
      // 非 ok: 保留缓冲下轮重试（不 ack 失败的批）
      if (!r.ok) break;
    }
    if (sent === buffer.length) buffer = [];
    return sent;
  } finally {
    flushing = false;
  }
}

// 启动补漏: 全量搜索 → 过滤 → 批量上报（server url|visitedAt 去重, 重复无害）
export async function backfill(serverUrl: string, token: string): Promise<number> {
  const results = await chrome.history.search({ text: "", maxResults: 2000 });
  let sent = 0;
  const entries: HistoryEntry[] = [];
  for (const r of results) {
    if (!r.url || r.lastVisitTime === undefined) continue;
    const visitedAt = new Date(r.lastVisitTime).toISOString();
    if (excluded(r.url, readExcludeDomains())) continue;
    entries.push({ url: r.url, title: r.title ?? "", visitedAt });
  }
  for (const batch of chunk(entries, BATCH)) {
    const res = await fetch(`${serverUrl}/api/history`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ entries: batch }),
    });
    if (res.ok) sent += batch.length;
    else break;
  }
  return sent;
}

// 由 index.ts 顶层注册的监听器转发到这里（未配置则不上报）
export async function onVisited(item: chrome.history.HistoryItem): Promise<void> {
  if (!item.url || item.lastVisitTime === undefined) return;
  const s = await ensureState();
  if (!s) return;
  pushHistory({
    url: item.url,
    title: item.title ?? "",
    visitedAt: new Date(item.lastVisitTime).toISOString(),
  });
}

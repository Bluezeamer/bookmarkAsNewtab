// 扩展侧状态快照（能力块 13 · ②）: 纯函数, 便于单测
// SW 在每次同步后写入 chrome.storage.local.status; popup 读取并渲染。
// 目的: 让用户**在扩展侧**就能看到"连没连上/上次同步什么时候/有多少数据",
// 而不是只能在 WebUI 里猜（此前扩展侧完全无状态可见性）。
export interface StatusSnapshot {
  ok: boolean; // 上次同步是否成功
  lastSyncAt?: string; // ISO
  serverUrl?: string;
  bookmarks?: number; // CRDT 中的书签数
  folders?: number;
  historyUploaded?: number; // 累计上报的历史条数
  message?: string; // 失败原因（成功时为空）
}

export interface StatusView {
  ok: boolean;
  /** 形如 "刚刚 / 3 分钟前 / 2 小时前 / 3 天前 / 从未同步" */
  lastSyncText: string;
  counts: string;
  message: string;
}

// 相对时间（不引依赖; 只做粗粒度, 够 popup 用）
export function relTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "从未同步";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "从未同步";
  const d = now - t;
  if (d < 0) return "刚刚";
  const min = Math.floor(d / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

export function statusView(s: StatusSnapshot | undefined, now: number = Date.now()): StatusView {
  const st = s ?? { ok: false };
  const parts: string[] = [];
  if (typeof st.bookmarks === "number") parts.push(`${st.bookmarks} 条书签`);
  if (typeof st.folders === "number") parts.push(`${st.folders} 个文件夹`);
  if (typeof st.historyUploaded === "number") parts.push(`已上报 ${st.historyUploaded} 条历史`);
  return {
    ok: st.ok === true,
    lastSyncText: relTime(st.lastSyncAt, now),
    counts: parts.length > 0 ? parts.join(" · ") : "尚无数据",
    // 成功时也要把 message 带出来（强制同步会写"成功 X 项·失败 Y 项"这类结果, 原先 ok 时被抹成空串 → 用户看不到）
    message: st.message ?? (st.ok ? "" : "尚未同步（检查服务器地址与 token）"),
  };
}

// 把技术性异常映射为**可操作**的中文提示（AGENTS.md UX 标准: 错误状态给非技术性语言）
export function friendlyError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  const m = raw.toLowerCase();
  if (m.includes("failed to fetch") || m.includes("networkerror") || m.includes("network error")) {
    return "无法连接服务器：请检查地址与网络后重试";
  }
  if (m.includes("schema")) {
    return "尚未完成与服务器的首次同步（服务器可能正在重启），请稍后重试";
  }
  if (m.includes("401") || m.includes("403") || m.includes("unauthorized") || m.includes("forbidden")) {
    return "token 无效或已失效：请重新填写访问 token";
  }
  if (m.includes("timeout") || m.includes("timed out")) {
    return "连接超时：服务器可能不可达，请检查网络后重试";
  }
  return "同步失败：请稍后重试（若持续失败请检查服务器状态与 token）";
}

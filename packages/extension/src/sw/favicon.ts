// 图标回传（仅桌面）: 内核端点取字节 → 回传服务端持久化副本
// 依据参考文档: 图标由内核算, 服务端只存副本（供移动端/清缓存后使用）
// 约束: 只上传服务端缺失的; 单轮限批; 单条失败静默; 不阻塞导入/同步主流程
import * as Y from "yjs";
import { doc } from "./crdt.ts";
import type { SwState } from "./state.ts";

const BATCH = 20;

function bookmarkUrls(): string[] {
  const bm = doc.getMap("").get("bookmarks");
  const out: string[] = [];
  if (bm instanceof Y.Map) {
    for (const [, v] of bm) {
      const url = v instanceof Y.Map ? v.get("url") : (v as { url?: unknown } | undefined)?.url;
      if (typeof url === "string" && url) out.push(url);
    }
  }
  return out;
}

// 返回本轮成功上传数量（幂等: 服务端按 origin 去重; 下轮 alarm 继续收敛）
export async function uploadMissingIcons(state: SwState, batch = BATCH): Promise<number> {
  const urls = bookmarkUrls();
  if (urls.length === 0) return 0;

  let missing: string[];
  try {
    const r = await fetch(`${state.serverUrl}/api/favicon/missing`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${state.token}` },
      body: JSON.stringify({ urls }),
    });
    if (!r.ok) return 0;
    missing = ((await r.json()) as { missing?: string[] }).missing ?? [];
  } catch {
    return 0; // 后端不可达: 下轮再试
  }

  let done = 0;
  for (const url of missing.slice(0, batch)) {
    try {
      // 内核端点（零网络: 浏览器已缓存解析结果）
      const iconUrl = chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`);
      const iconRes = await fetch(iconUrl);
      if (!iconRes.ok) continue;
      const bytes = await iconRes.arrayBuffer();
      if (bytes.byteLength === 0) continue;
      const up = await fetch(`${state.serverUrl}/api/favicon?url=${encodeURIComponent(url)}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${state.token}`,
          "content-type": iconRes.headers.get("content-type") ?? "image/png",
        },
        body: bytes,
      });
      if (up.ok) done++;
    } catch {
      /* 单条失败不影响其它 */
    }
  }
  return done;
}

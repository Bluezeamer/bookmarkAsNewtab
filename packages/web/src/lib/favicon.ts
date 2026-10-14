import { apiUrl } from "./crdt.ts";
// 书签图标（favicon）: 三级降级 = 内核 _favicon/ → 服务端缓存 → 首字母色块
// 设计依据:
//   **不自己抓图标**（不拼接 /favicon.ico、不解析 link、不接第三方服务、不用 new Image() 验证）
//   桌面直接用内核端点; 服务端只保存客户端回传的副本（供移动端/清缓存后使用）
let faviconBase: string | null = null;
let authToken: string | null = null;

export function setFaviconContext(ctx: { base?: string | null; token?: string | null }): void {
  if (ctx.base !== undefined) faviconBase = ctx.base?.trim() ? ctx.base.trim() : null;
  if (ctx.token !== undefined) authToken = ctx.token ?? null;
}

export function getFaviconBase(): string | null {
  return faviconBase;
}

// 内核端点 URL（形态与参考文档一致）
export function kernelIconUrl(base: string, pageUrl: string, size = 32): string {
  const u = new URL(base);
  u.searchParams.set("pageUrl", pageUrl);
  u.searchParams.set("size", String(size));
  return u.toString();
}

export interface IconPlan {
  kernel: string | null; // 内核端点（无扩展/未传基址时为 null）
  server: string; // 服务端缓存端点（需 Bearer）
  size: number;
}

// 纯函数: 图标来源候选（便于单测; 实际渲染由 BookmarkIcon 依次尝试）
export function planIcon(pageUrl: string, base: string | null, size = 32): IconPlan {
  return {
    kernel: base ? kernelIconUrl(base, pageUrl, size) : null,
    server: apiUrl(`/api/favicon?url=${encodeURIComponent(pageUrl)}`),
    size,
  };
}

// 服务端字节 → object URL（调用方负责 revoke）; 失败/无 token → null
export async function fetchServerIcon(pageUrl: string): Promise<string | null> {
  if (!authToken) return null;
  try {
    const r = await fetch(apiUrl(`/api/favicon?url=${encodeURIComponent(pageUrl)}`), {
      headers: { authorization: `Bearer ${authToken}` },
    });
    if (!r.ok) return null;
    return URL.createObjectURL(await r.blob());
  } catch {
    return null;
  }
}

// ---- 内核"取不到"的判定（能力块 18 · ①）----
// 背景: _favicon/ 对**未访问过**的站点返回 HTTP 200 + 默认 globe 占位图（不是错误 ✗）
// → <img> 的 onError 永远不触发 → "内核没有"被当成"有", 停在占位图上,
//   而纯 web UI（无内核基址）直接走服务端 → 于是"web 有图标、插件 newtab 没有" ✗
// 实测（真 Chrome + 真扩展）:
//   有图标 = 1301B / 取不到 = 601B（跨 headless/headful 稳定）; naturalWidth 两边都是 32（不可用 ✗）
// 判定方式: 用 .invalid 域名取一次**基准占位图**再逐字节比 —— 不写死 hash, 跨 Chrome 版本/平台都稳。
// 注意: 占位图**按 size 分档**（实测 16/20/28 → 350B, 32/40/48 → 601B）→ 基准必须按 size 各校准一次;
// 用单个全局基准会让"非首次校准尺寸"永远比不相等 → 静默失效 ✗（review 阻塞项）
const PLACEHOLDER_PROBE_URL = "https://bnt-favicon-probe.invalid/";
const placeholderBytes = new Map<number, ArrayBuffer>(); // size → 基准占位图
const missingCache = new Map<string, boolean>(); // 内核 URL → 是否取不到（同一会话内不重复请求）

export function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

async function fetchIconBytes(u: string): Promise<ArrayBuffer | null> {
  try {
    const r = await fetch(u);
    return r.ok ? await r.arrayBuffer() : null;
  } catch {
    return null;
  }
}

// 内核端点是否"取不到"图标。任何异常一律返回 false（不误判, 交给 <img> 的 onError 兜底）
export async function kernelIconMissing(base: string, pageUrl: string, size = 32): Promise<boolean> {
  const u = kernelIconUrl(base, pageUrl, size);
  const cached = missingCache.get(u);
  if (cached !== undefined) return cached;
  let placeholder = placeholderBytes.get(size);
  if (!placeholder) {
    const fetched = await fetchIconBytes(kernelIconUrl(base, PLACEHOLDER_PROBE_URL, size));
    if (!fetched) return false; // 基准都拿不到 → 不判（保持原行为, 且不写缓存以便重试）
    placeholderBytes.set(size, fetched);
    placeholder = fetched;
  }
  const bytes = await fetchIconBytes(u);
  if (!bytes) return false; // 取字节失败（瞬时故障）→ 不判定**也不缓存**, 下次渲染还有机会重试
  const missing = sameBytes(bytes, placeholder);
  missingCache.set(u, missing);
  return missing;
}

// Yjs 客户端: 单 Doc + WebsocketProvider（与 ② 的 server 中继同 wire 协议）
// 注意: Yjs 13.6 本地编辑 origin=null, WebsocketProvider 内部按 origin!==provider 转发
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import type { Bookmark, Folder } from "./logic.ts";
import { descendantFolderIds, readSuggestion } from "./logic.ts";

export const doc = new Y.Doc();
let provider: WebsocketProvider | null = null;

export type ConnStatus = "connecting" | "connected" | "disconnected";

// 连接状态订阅: 模块持有 provider, 事件转发也由模块负责 ——
// 调用方（组件）无需知道 provider 何时被创建（异步 connect 下极易漏订阅）
const statusListeners = new Set<(s: ConnStatus) => void>();
// 初始值用 connecting（不是 disconnected）: 首次连接前"还没连上"≠"断开"，
// 用 disconnected 会让横幅在**每次加载时闪一下**（首帧就回放给订阅者）
let lastStatus: ConnStatus = "connecting";

// 抖动抑制（能力块 17 · ②）: y-websocket 自带指数退避重连（实测源码:
// min(2^n × 100ms, 2500ms) → 100/200/400/800/1600/2500ms），
// 网络抖动/容器重建会让连接经历 connected → disconnected → connecting → connected，
// 整个周期常常只有 100~800ms。零延迟透传 disconnected 会让状态横幅**闪现** ✗
// → 宽限期内恢复就当无事发生（1500ms 覆盖前四次重试，又不会掩盖真实掉线）。
const DISCONNECT_GRACE_MS = 1500;
let disconnectTimer: ReturnType<typeof setTimeout> | null = null;

function publish(s: ConnStatus): void {
  lastStatus = s;
  for (const f of statusListeners) f(s);
}

function emitStatus(s: ConnStatus): void {
  if (s === "disconnected") {
    if (disconnectTimer) return; // 宽限期内重复的 disconnected 只排一次
    disconnectTimer = setTimeout(() => {
      disconnectTimer = null;
      publish("disconnected");
    }, DISCONNECT_GRACE_MS);
    return;
  }
  if (disconnectTimer) {
    clearTimeout(disconnectTimer); // 宽限期内恢复（connecting/connected）→ 撤销, 不打扰用户
    disconnectTimer = null;
  }
  publish(s);
}

// 返回退订函数（可直接作为 useEffect 的 cleanup）
export function onStatus(cb: (s: ConnStatus) => void): () => void {
  statusListeners.add(cb);
  cb(lastStatus); // 立即回放当前值
  return () => {
    statusListeners.delete(cb);
  };
}

// 后端基址（能力块 14 · ③）: 允许在设置里改（存 localStorage）; 缺省用同源
export const SERVER_URL_KEY = "bnt.serverUrl";

// location.origin 在测试 stub（只有 protocol/host）里可能不存在 → 自行拼
function locationOrigin(): string {
  if (typeof location === "undefined") return "";
  const l = location as Location & { origin?: string };
  return l.origin ?? `${l.protocol}//${l.host}`;
}

export function resolveServerUrl(): string {
  // 防御式: 本模块会被 favicon/history 间接 import, 单测在 Node 下跑（可能没有 localStorage）
  // 注意: localStorage 缺失时**不能提前 return** —— 要回落到 location.origin（Node 测试会 stub location）
  let stored = "";
  try {
    stored = (globalThis.localStorage?.getItem(SERVER_URL_KEY) ?? "").trim().replace(/\/+$/, "");
  } catch {
    stored = "";
  }
  if (!stored) return locationOrigin();
  try {
    return new URL(stored).origin;
  } catch {
    return locationOrigin();
  }
}

// 后端 HTTP 接口基址（与 WS 同一配置）: 设置里改了后端, /api 也要跟着走
export function apiUrl(path: string): string {
  return `${resolveServerUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

export function connect(token: string): WebsocketProvider {
  disconnect();
  const base = resolveServerUrl();
  const proto = base.startsWith("https:") ? "wss" : base.startsWith("http:") ? "ws" : locationOrigin().startsWith("https:") ? "wss" : "ws";
  // room 拼在 url 后: <origin>/ws?token=***
  provider = new WebsocketProvider(`${proto}://${base.replace(/^https?:\/\//, "")}`, `ws?token=${encodeURIComponent(token)}`, doc);
  // y-websocket 3.x 的 status 载荷可能是 [{status}]（旧 API）或 {status} —— 两种都拆
  provider.on("status", (arg: unknown) => {
    const e = (Array.isArray(arg) ? arg[0] : arg) as { status?: ConnStatus } | undefined;
    if (e?.status) emitStatus(e.status);
  });
  // 构造函数内的首次 connecting 可能早于监听器注册 —— 用运行时 status 兑底
  emitStatus((provider as unknown as { status?: ConnStatus }).status ?? "connecting");
  return provider;
}

export function disconnect(): void {
  provider?.destroy();
  provider = null;
  emitStatus("disconnected");
}

function asMap(v: unknown): Y.Map<unknown> | undefined {
  return v instanceof Y.Map ? v : undefined;
}

// ---------- 节点形状（能力块 5 修正） ----------
// 书签节点必须是 Y.Map: 普通对象值里的嵌套 Y.Map 不会被集成到文档（跨文档后退化为普通对象）,
// 即 ADR-005 的 meta.auto 在旧形状下是死数据。旧普通对象节点仍可读, 写入时自动升级。

export function nodeFields(v: unknown): Record<string, unknown> | undefined {
  if (v instanceof Y.Map) {
    const o: Record<string, unknown> = {};
    for (const k of ["title", "url", "folder", "order", "created"]) o[k] = v.get(k);
    return o;
  }
  if (v && typeof v === "object") return v as Record<string, unknown>;
  return undefined;
}

// 读 meta.auto（兼容旧形状: meta/auto 可能是普通对象）
function suggestionRaw(v: unknown): { suggestedFolder?: unknown; tags?: unknown } | undefined {
  const meta = v instanceof Y.Map ? v.get("meta") : (v as Record<string, unknown> | undefined)?.meta;
  if (!meta) return undefined;
  const auto = meta instanceof Y.Map ? meta.get("auto") : (meta as Record<string, unknown>).auto;
  if (!auto) return undefined;
  if (auto instanceof Y.Map) return { suggestedFolder: auto.get("suggestedFolder"), tags: auto.get("tags") };
  if (typeof auto === "object") return auto as { suggestedFolder?: unknown; tags?: unknown };
  return undefined;
}

// 新建 Y.Map 节点（含 meta.auto 命名空间, ADR-005）
function newNode(fields: Record<string, unknown>): Y.Map<unknown> {
  const node = new Y.Map<unknown>();
  node.set("title", typeof fields.title === "string" ? fields.title : "");
  node.set("url", typeof fields.url === "string" ? fields.url : "");
  node.set("folder", typeof fields.folder === "string" ? fields.folder : null);
  node.set("order", typeof fields.order === "number" ? fields.order : 0);
  node.set("created", typeof fields.created === "string" ? fields.created : new Date().toISOString());
  const meta = new Y.Map<unknown>();
  const legacy = fields.meta;
  if (legacy && typeof legacy === "object" && !(legacy instanceof Y.Map)) {
    for (const [k, val] of Object.entries(legacy as Record<string, unknown>)) {
      if (k !== "auto") meta.set(k, val); // 保留旧的 meta 键
    }
  }
  meta.set("auto", new Y.Map<unknown>());
  node.set("meta", meta);
  return node;
}

// 写字段: Y.Map 节点逐键 set; 旧普通对象节点迁移为 Y.Map 后写
function writeNode(bm: Y.Map<unknown>, id: string, patch: Record<string, unknown>): boolean {
  const cur = bm.get(id);
  if (cur instanceof Y.Map) {
    doc.transact(() => {
      for (const [k, val] of Object.entries(patch)) cur.set(k, val);
    });
    return true;
  }
  bm.set(id, newNode({ ...(nodeFields(cur) ?? {}), ...patch }));
  return true;
}

export function readBookmarks(d: Y.Doc): Bookmark[] {
  const bm = asMap(d.getMap("").get("bookmarks"));
  if (!bm) return [];
  const out: Bookmark[] = [];
  for (const [id, v] of bm) {
    const o = nodeFields(v);
    if (!o) continue;
    out.push({
      id,
      title: typeof o.title === "string" ? o.title : "",
      url: typeof o.url === "string" ? o.url : "",
      folder: typeof o.folder === "string" ? o.folder : null,
      order: typeof o.order === "number" ? o.order : 0,
      created: typeof o.created === "string" ? o.created : "",
      suggestion: readSuggestion(suggestionRaw(v)),
    });
  }
  return out.sort((a, b) => a.order - b.order);
}

export function readFolders(d: Y.Doc): Folder[] {
  const fm = asMap(d.getMap("").get("folders"));
  if (!fm) return [];
  const out: Folder[] = [];
  for (const [id, v] of fm) {
    if (v && typeof v === "object" && !(v instanceof Y.Map)) {
      const o = v as Record<string, unknown>;
      out.push({
        id,
        name: typeof o.name === "string" ? o.name : "",
        parent: typeof o.parent === "string" ? o.parent : null,
        order: typeof o.order === "number" ? o.order : 0,
      });
    }
  }
  return out.sort((a, b) => a.order - b.order);
}

// --- 写操作（本地 origin=null → provider 自动同步） ---

export function addBookmark(title: string, url: string, folder: string | null): void {
  const root = doc.getMap("");
  const bm = asMap(root.get("bookmarks"));
  if (!bm) return;
  // 写入 Y.Map 节点（含 meta.auto 命名空间）—— 普通对象承载不了嵌套共享类型
  writeNode(bm, crypto.randomUUID(), {
    title,
    url,
    folder,
    order: bm.size,
    created: new Date().toISOString(),
  });
}

export function updateBookmark(id: string, patch: { title?: string; url?: string; folder?: string | null }): void {
  const bm = asMap(doc.getMap("").get("bookmarks"));
  if (!bm) return;
  const clean: Record<string, unknown> = {};
  if (patch.title !== undefined) clean.title = patch.title;
  if (patch.url !== undefined) clean.url = patch.url;
  if (patch.folder !== undefined) clean.folder = patch.folder;
  if (Object.keys(clean).length) writeNode(bm, id, clean);
}

export function deleteBookmark(id: string): void {
  asMap(doc.getMap("").get("bookmarks"))?.delete(id);
}

// 上移/下移: 与相邻（同文件夹）条目交换 order
export function moveBookmark(id: string, dir: -1 | 1, all: Bookmark[]): void {
  const me = all.find((b) => b.id === id);
  if (!me) return;
  const siblings = all
    .filter((b) => b.folder === me.folder)
    .sort((a, b) => a.order - b.order);
  const idx = siblings.findIndex((b) => b.id === id);
  const other = siblings[idx + dir];
  if (!other) return;
  const bm = asMap(doc.getMap("").get("bookmarks"));
  if (!bm) return;
  writeNode(bm, id, { order: other.order });
  writeNode(bm, other.id, { order: me.order });
}

// 文件夹: 按名找; 不存在则创建
export function findOrCreateFolder(name: string): string | null {
  const t = name.trim();
  if (!t) return null;
  const fm = asMap(doc.getMap("").get("folders"));
  if (!fm) return null;
  for (const [id, v] of fm) {
    if (v && typeof v === "object" && (v as Record<string, unknown>).name === t) return id;
  }
  const id = crypto.randomUUID();
  fm.set(id, { name: t, parent: null, order: fm.size });
  return id;
}

// ---------- 能力块 2: 移动 / 重排（写入返回 boolean: schema 未就绪时明确失败） ----------

// 移到指定文件夹（null = 未分组）
export function moveBookmarkTo(id: string, folder: string | null): boolean {
  const bm = asMap(doc.getMap("").get("bookmarks"));
  if (!bm || !bm.has(id)) return false;
  return writeNode(bm, id, { folder });
}

// 按给定顺序重写 bookmarks 的 order（0..n-1）; 只动 order, 其余字段原样
// （拖拽排序落库入口; 只改可见序列, 不影响其它文件夹）
export function reorderBookmarks(orderedIds: string[]): boolean {
  const bm = asMap(doc.getMap("").get("bookmarks"));
  if (!bm) return false;
  let touched = false;
  doc.transact(() => {
    orderedIds.forEach((id, i) => {
      const o = nodeFields(bm.get(id));
      if (!o) return;
      touched = true;
      if (o.order !== i) writeNode(bm, id, { order: i });
    });
  });
  return touched;
}

// 显式设置单个书签的 order（跨分组拖拽落位需要——目标组末尾 = max+1）
export function setBookmarkOrder(id: string, order: number): boolean {
  const bm = asMap(doc.getMap("").get("bookmarks"));
  if (!bm || !bm.has(id)) return false;
  return writeNode(bm, id, { order });
}

// 改父级（能力块 9: 侧栏拖拽调整层级）; 调用方负责防环（lib/sidebar-tree.canReparent）
export function setFolderParent(id: string, parent: string | null): boolean {
  const fm = asMap(doc.getMap("").get("folders"));
  const cur = fm?.get(id);
  if (!fm || !cur || typeof cur !== "object" || cur instanceof Y.Map) return false;
  fm.set(id, { ...(cur as Record<string, unknown>), parent });
  return true;
}

// 按给定顺序重写同父文件的 order（拖拽文件夹排序入口）
export function reorderFolders(orderedIds: string[]): boolean {
  const fm = asMap(doc.getMap("").get("folders"));
  if (!fm) return false;
  let touched = false;
  doc.transact(() => {
    orderedIds.forEach((id, i) => {
      const cur = fm.get(id);
      if (!cur || typeof cur !== "object" || cur instanceof Y.Map) return;
      const o = cur as Record<string, unknown>;
      touched = true;
      if (o.order !== i) fm.set(id, { ...o, order: i });
    });
  });
  return touched;
}

// 文件夹上/下移: 与相邻同父文件夹交换 order（按钮路径, 触摸/键盘可用）
export function moveFolder(id: string, dir: -1 | 1, folders: Folder[]): boolean {
  const fm = asMap(doc.getMap("").get("folders"));
  const me = folders.find((f) => f.id === id);
  if (!fm || !me) return false;
  const siblings = folders
    .filter((f) => f.parent === me.parent)
    .sort((a, b) => a.order - b.order);
  const other = siblings[siblings.indexOf(me) + dir];
  if (!other) return false;
  const a = { ...(fm.get(id) as Record<string, unknown>) };
  const b = { ...(fm.get(other.id) as Record<string, unknown>) };
  a.order = other.order;
  b.order = me.order;
  fm.set(id, a);
  fm.set(other.id, b);
  return true;
}

// 新建文件夹（能力块 19 增补）: 挂在指定父夹下（null = 顶层）, order 取同级末尾 + 1
export function addFolder(name: string, parent: string | null): string | null {
  const fm = asMap(doc.getMap("").get("folders"));
  const next = name.trim();
  if (!fm || !next) return null;
  const order = readFolders(doc)
    .filter((f) => f.parent === parent)
    .reduce((m, f) => Math.max(m, f.order), -1) + 1;
  const id = crypto.randomUUID();
  fm.set(id, { name: next, parent, order });
  return id;
}

// 文件夹改名（能力块 19）: 文件夹节点是**普通对象**（ADR-009 只约束书签节点）→ 整体重写并保留 parent/order
export function renameFolder(id: string, name: string): boolean {
  const fm = asMap(doc.getMap("").get("folders"));
  const cur = fm?.get(id);
  if (!fm || !cur || typeof cur !== "object" || cur instanceof Y.Map) return false;
  const o = cur as Record<string, unknown>;
  const next = name.trim();
  if (!next) return false;
  fm.set(id, {
    name: next,
    parent: typeof o.parent === "string" ? o.parent : null,
    order: typeof o.order === "number" ? o.order : 0,
  });
  return true;
}

// 删除文件夹（能力块 19）: **级联** —— 子文件夹与其中的书签一起删除。
// 原实现是"组内书签回根（未分组）", 用户明确要求改成连书签一起删 ✗ 不是丢到未分类。
export function deleteFolder(id: string): void {
  const root = doc.getMap("");
  const fm = asMap(root.get("folders"));
  const bm = asMap(root.get("bookmarks"));
  const ids = descendantFolderIds(readFolders(doc), id);
  if (bm) {
    for (const [bid, v] of bm) {
      const f = nodeFields(v)?.folder;
      if (typeof f === "string" && ids.has(f)) bm.delete(bid);
    }
  }
  for (const fid of ids) fm?.delete(fid);
}

// ---------- 能力块 5: 建议接受 / 忽略 ----------

function clearSuggestion(node: unknown): boolean {
  if (!(node instanceof Y.Map)) return false; // 旧普通对象节点无可用 auto
  const meta = node.get("meta");
  if (!(meta instanceof Y.Map)) return false;
  const auto = meta.get("auto");
  if (!(auto instanceof Y.Map)) return false;
  doc.transact(() => {
    auto.delete("suggestedFolder");
    auto.delete("tags");
    auto.set("acceptedAt", new Date().toISOString());
  });
  return true;
}

// 接受: 移入建议文件夹（无则创建）+ 清除建议
export function acceptSuggestion(id: string, folderName: string): boolean {
  const bm = asMap(doc.getMap("").get("bookmarks"));
  if (!bm || !bm.has(id)) return false;
  const folderId = findOrCreateFolder(folderName);
  if (!folderId) return false;
  writeNode(bm, id, { folder: folderId });
  clearSuggestion(bm.get(id));
  return true;
}

// 忽略: 仅清除建议（不动书签归属）
export function dismissSuggestion(id: string): boolean {
  const bm = asMap(doc.getMap("").get("bookmarks"));
  return clearSuggestion(bm?.get(id));
}

// ---------- 能力块 3: 历史排除列表（ADR-007: 配置走 CRDT, 多端同步） ----------

function excludeArray(): Y.Array<string> | undefined {
  const settings = asMap(doc.getMap("").get("settings"));
  const arr = settings?.get("excludeDomains");
  return arr instanceof Y.Array ? arr : undefined;
}

export function readExcludeDomains(): string[] {
  const arr = excludeArray();
  if (!arr) return [];
  return arr.toArray().filter((d): d is string => typeof d === "string");
}

// 添加（已存在则 no-op 但视为成功）; false = schema 未就绪（调用方要提示, 不假装成功）
export function addExcludeDomain(domain: string): boolean {
  const arr = excludeArray();
  if (!arr) return false;
  const d = domain.trim().toLowerCase();
  if (!d || arr.toArray().includes(d)) return true;
  arr.push([d]);
  return true;
}

// 删除所有同值项（Y.Array 无去重语义, 兼容多端并发追加出的重复项）
export function removeExcludeDomain(domain: string): boolean {
  const arr = excludeArray();
  if (!arr) return false;
  const d = domain.trim().toLowerCase();
  doc.transact(() => {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr.get(i) === d) arr.delete(i, 1);
    }
  });
  return true;
}

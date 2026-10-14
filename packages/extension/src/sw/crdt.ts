// SW 侧 CRDT 客户端: 与 web 包同 schema（bookmarks/folders/settings）,
// 与 server 手写 relay 同 wire 协议（y-protocols）
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

export const doc = new Y.Doc();
let provider: WebsocketProvider | null = null;

// serverUrl 形如 https://host[:port]（storage.local, 用户配置）
// 幂等: 同参数且已有连接时直接复用。
// 为什么需要: keepalive alarm 每分钟都会调 connect(), 原来无条件 disconnect() →
// ① 把活连接掐掉重连（浪费 + 丢消息窗口） ② 与 bootstrap 里 waitInitialSync 的 provider 竞态（白等满 8s）
let currentKey = "";
// 真实连接状态（review 阻塞项）: WebsocketProvider 连不上时**不抛错**（静默重试）,
// 所以不能把"流程走完"当作"已连接" —— popup 必须显示这里的状态。
let connState = { connected: false, synced: false };
export function getConnState(): { connected: boolean; synced: boolean } {
  return connState;
}
export function connect(token: string, serverUrl: string): WebsocketProvider {
  const key = `${serverUrl}|${token}`;
  if (provider && key === currentKey) return provider;
  currentKey = key;
  disconnect();
  connState = { connected: false, synced: false };
  const base = serverUrl.replace(/^http/, "ws");
  // 与 web crdt.ts 一致: serverUrl + '/' + room（room 内带 query, 防拼接破坏）
  provider = new WebsocketProvider(base, `ws?token=${encodeURIComponent(token)}`, doc);
  // 后台客户端的可观测性: SW 出问题没有任何 UI 提示, 状态与错误必须落日志
  provider.on("status", (arg: unknown) => {
    // y-websocket 3.x 的载荷是数组（AGENTS.md 坑点）
    const e = (Array.isArray(arg) ? arg[0] : arg) as { status?: string } | undefined;
    if (e?.status) {
      connState.connected = e.status === "connected";
      if (!connState.connected) connState.synced = false; // 断开即视为未同步
      console.log(`[bnt] ws ${e.status}`);
    }
  });
  provider.on("sync", (isSynced: boolean) => {
    connState.synced = isSynced === true;
  });
  provider.on("connection-error", () => console.warn("[bnt] ws connection-error"));
  return provider;
}

export function disconnect(): void {
  provider?.destroy();
  provider = null;
  currentKey = "";
  connState = { connected: false, synced: false };
}

function asMap(v: unknown): Y.Map<unknown> | undefined {
  return v instanceof Y.Map ? v : undefined;
}

export function readExcludeDomains(): string[] {
  const settings = asMap(doc.getMap("").get("settings"));
  const arr = settings?.get("excludeDomains");
  if (!(arr instanceof Y.Array)) return [];
  return arr.toArray().filter((d): d is string => typeof d === "string");
}

function newMeta(): Y.Map<Y.Map<unknown>> {
  const meta = new Y.Map<Y.Map<unknown>>();
  meta.set("auto", new Y.Map<unknown>());
  return meta;
}

// ---- 节点形状（与 web 包同一规则）: 书签节点必须是 Y.Map ----
// 普通对象值里的嵌套 Y.Map 不会被集成（跨文档后退化）, meta.auto 就成死数据。
// 旧普通对象节点仍可读, 写入时升级为 Y.Map。
export function nodeFields(v: unknown): Record<string, unknown> | undefined {
  if (v instanceof Y.Map) {
    const o: Record<string, unknown> = {};
    for (const k of ["title", "url", "folder", "order", "created"]) o[k] = v.get(k);
    return o;
  }
  if (v && typeof v === "object") return v as Record<string, unknown>;
  return undefined;
}

function newNode(fields: Record<string, unknown>): Y.Map<unknown> {
  const node = new Y.Map<unknown>();
  node.set("title", typeof fields.title === "string" ? fields.title : "");
  node.set("url", typeof fields.url === "string" ? fields.url : "");
  node.set("folder", typeof fields.folder === "string" ? fields.folder : null);
  node.set("order", typeof fields.order === "number" ? fields.order : 0);
  node.set("created", typeof fields.created === "string" ? fields.created : new Date().toISOString());
  node.set("meta", newMeta());
  return node;
}

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

// CRDT schema（bookmarks/folders/settings）由 server 启动时 bootstrap, 经首次同步下发。
// 写入前必须确认已就绪 —— 否则会被静默丢弃（曾导致“连上了但书签一条都传不上去”）
export function hasSchema(): boolean {
  const root = doc.getMap("");
  return root.get("bookmarks") instanceof Y.Map && root.get("folders") instanceof Y.Map;
}

// 以下写操作返回 boolean: false = schema 未就绪, 调用方必须当失败处理（不得假装成功）
export function crdtAddBookmark(
  id: string,
  title: string,
  url: string,
  folder: string | null,
  order: number
): boolean {
  const bm = asMap(doc.getMap("").get("bookmarks"));
  if (!bm) return false;
  return writeNode(bm, id, { title, url, folder, order, created: new Date().toISOString() });
}

export function crdtDeleteBookmark(id: string): void {
  asMap(doc.getMap("").get("bookmarks"))?.delete(id);
}

// 顺序回写（能力块 13 · ③ review）: Chrome 侧移动后必须同时写实际 index,
// 否则回写会把节点挪回"旧序号"位置（拖到末尾却被放到开头）
export function crdtSetBookmarkOrder(id: string, order: number): boolean {
  const bm = asMap(doc.getMap("").get("bookmarks"));
  if (!bm || !(bm.get(id) instanceof Y.Map)) return false;
  const cur = bm.get(id) as Y.Map<unknown>;
  if (cur.get("order") === order) return true;
  doc.transact(() => cur.set("order", order));
  return true;
}

export function crdtSetBookmarkFolder(id: string, folder: string | null): boolean {
  const bm = asMap(doc.getMap("").get("bookmarks"));
  if (!bm || !bm.has(id)) return false;
  return writeNode(bm, id, { folder });
}

export function crdtAddFolder(id: string, name: string, parent: string | null, order: number): boolean {
  const fm = asMap(doc.getMap("").get("folders"));
  if (!fm) return false;
  fm.set(id, { name, parent, order });
  return true;
}

// ---- 覆盖同步所需的写操作（能力块 20）----
// 「浏览器覆盖后端」要把 CRDT 对齐到浏览器真实状态: 改名 / 改归属 / 改标题 / 改顺序。
// 文件夹节点是**普通对象**（ADR-009 只约束书签节点）→ 整体重写并保留未涉及字段。
export function crdtSetBookmarkTitle(id: string, title: string): boolean {
  const bm = asMap(doc.getMap("").get("bookmarks"));
  if (!bm || !bm.has(id)) return false;
  return writeNode(bm, id, { title });
}

function rewriteFolder(id: string, patch: { name?: string; parent?: string | null; order?: number }): boolean {
  const fm = asMap(doc.getMap("").get("folders"));
  const cur = fm?.get(id);
  if (!fm || !cur || typeof cur !== "object" || cur instanceof Y.Map) return false;
  const o = cur as Record<string, unknown>;
  fm.set(id, {
    name: patch.name ?? (typeof o.name === "string" ? o.name : ""),
    parent: patch.parent !== undefined ? patch.parent : typeof o.parent === "string" ? o.parent : null,
    order: patch.order ?? (typeof o.order === "number" ? o.order : 0),
  });
  return true;
}

export function crdtSetFolderName(id: string, name: string): boolean {
  return rewriteFolder(id, { name });
}

export function crdtSetFolderParent(id: string, parent: string | null): boolean {
  return rewriteFolder(id, { parent });
}

export function crdtSetFolderOrder(id: string, order: number): boolean {
  return rewriteFolder(id, { order });
}

export function crdtDeleteFolder(id: string): void {
  const root = doc.getMap("");
  const fm = asMap(root.get("folders"));
  const bm = asMap(root.get("bookmarks"));
  if (bm) {
    for (const [bid, v] of bm) {
      if (nodeFields(v)?.folder === id) writeNode(bm, bid, { folder: null });
    }
  }
  fm?.delete(id);
}

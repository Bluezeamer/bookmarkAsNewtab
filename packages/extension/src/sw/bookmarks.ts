// 书签: 一次性全量导入（getTree → CRDT + nodeMap）+ 增量同步（on* 事件）
import * as Y from "yjs";
import { doc, getConnState } from "./crdt.ts";
import { chromeFolderKey, planFolderPrune } from "../lib/prune.ts";
import {
  enqueuePending,
  parseCreatedArgs,
  parseMovedArgs,
  parseRemovedArgs,
  planPendingReplay,
  resolveParentFolder,
  toCreatedNode,
  toMovedInfo,
  toRemovedInfo,
  type PendingEvent,
} from "../lib/parent.ts";
import { reverseNodeMap } from "../lib/writeback.ts";
import {
  crdtAddBookmark,
  crdtAddFolder,
  crdtDeleteBookmark,
  crdtDeleteFolder,
  crdtSetBookmarkFolder,
  crdtSetBookmarkOrder,
  crdtSetBookmarkTitle,
  crdtSetFolderName,
  crdtSetFolderParent,
  hasSchema,
  nodeFields,
} from "./crdt.ts";
import { saveNodeMap } from "./settings.ts";
import { ensureState, forgetNode, rememberNode } from "./state.ts";

export interface CrdtRecords {
  // 注: folders 也必须带 chromeId —— 否则导入后无法建立"Chrome 夹 ↔ CRDT 夹"映射,
  // 剪枝/镜像的全量路径都会把它当"未映射"（能力块 14 · ② review 阻塞项）
  folders: Record<string, { name: string; parent: string | null; order: number; chromeId: string }>;
  bookmarks: Record<
    string,
    { title: string; url: string; folder: string | null; order: number; chromeId: string }
  >;
}

// 纯函数: chrome 书签树 → CRDT 记录（供单测）
// chrome 根节点(id=1) 不导入; 文件夹嵌套保留 parent 链
export function treeToRecords(tree: chrome.bookmarks.BookmarkTreeNode[]): CrdtRecords {
  const folders: CrdtRecords["folders"] = {};
  const bookmarks: CrdtRecords["bookmarks"] = {};
  let fOrder = 0;
  let bOrder = 0;

  function walk(node: chrome.bookmarks.BookmarkTreeNode, parentCrdt: string | null) {
    for (const child of node.children ?? []) {
      if (child.id === undefined) continue;
      if (child.url) {
        const id = crypto.randomUUID();
        bookmarks[id] = {
          title: child.title || child.url,
          url: child.url,
          folder: parentCrdt,
          order: bOrder++,
          chromeId: child.id,
        };
      } else {
        const id = crypto.randomUUID();
        folders[id] = { name: child.title, parent: parentCrdt, order: fOrder++, chromeId: child.id };
        walk(child, id);
      }
    }
  }

  walk(tree[0] ?? { id: "1", title: "", children: [] }, null);
  return { folders, bookmarks };
}

// 已有 CRDT 内容索引: 用于把 chrome 节点匹配到已有条目
// （导入的幂等不能只靠扩展本地 nodeMap —— 扩展重装/换目录会丢 storage, 那样就会全量重导 → 重复）
export interface ExistingIndex {
  byUrl: Map<string, string>; // url → 已有书签 crdtId
  byFolderKey: Map<string, string>; // "parentCrdtId|name" → 已有文件夹 crdtId
  folderOf: Map<string, string | null>; // 已有书签 crdtId → 其 folder
  aliveFolders: Set<string>; // 现存文件夹 id（用于识别悬空归属）
}

// 夹字段读取（形状无关: Y.Map 或旧普通对象）—— 与书签侧的 nodeFields 对称
export function folderFields(v: unknown): { name: string; parent: string | null } | undefined {
  const raw = v instanceof Y.Map
    ? { name: v.get("name"), parent: v.get("parent") }
    : (v as { name?: unknown; parent?: unknown } | undefined);
  if (!raw || typeof raw !== "object") return undefined;
  return {
    name: String(raw.name ?? "").trim(),
    parent: typeof raw.parent === "string" ? raw.parent : null,
  };
}

export function existingIndex(): ExistingIndex {
  const root = doc.getMap("");
  const byUrl = new Map<string, string>();
  const byFolderKey = new Map<string, string>();
  const folderOf = new Map<string, string | null>();
  const aliveFolders = new Set<string>();
  const bm = root.get("bookmarks");
  if (bm instanceof Y.Map) {
    for (const [id, v] of bm) {
      const f = nodeFields(v);
      if (!f) continue;
      const url = String(f.url ?? "").trim();
      if (url && !byUrl.has(url)) byUrl.set(url, id);
      folderOf.set(id, typeof f.folder === "string" ? f.folder : null);
    }
  }
  const fm = root.get("folders");
  if (fm instanceof Y.Map) {
    for (const [id, v] of fm) {
      const f = folderFields(v);
      if (!f) continue;
      aliveFolders.add(id);
      if (!byFolderKey.has(`${f.parent ?? ""}|${f.name}`)) byFolderKey.set(`${f.parent ?? ""}|${f.name}`, id);
    }
  }
  return { byUrl, byFolderKey, folderOf, aliveFolders };
}

export interface ImportPlan {
  folderUseId: Record<string, string>; // 临时文件夹 id → 实际使用 id
  folderCreate: string[]; // 需新建的临时文件夹 id
  bookmarkUseId: Record<string, string>; // 临时书签 id → 复用的已有 id
  bookmarkRefolder: Record<string, string | null>; // 复用条目需修正归属（仅现存归属为空/悬空时）
  newFolders: number;
  newBookmarks: number;
  reused: number;
}

// 纯函数: chrome 树记录 → 「复用已有 / 新建」计划
export function planImport(records: CrdtRecords, existing: ExistingIndex): ImportPlan {
  const folderUseId: Record<string, string> = {};
  const folderCreate: string[] = [];

  // O(n): 按 parent 建子夹索引, 父解析完即入栈（避免每轮全表扫描的 O(n×depth)）
  const childrenOf = new Map<string | null, string[]>();
  for (const [id, f] of Object.entries(records.folders)) {
    childrenOf.set(f.parent, [...(childrenOf.get(f.parent) ?? []), id]);
  }
  const resolve = (id: string): void => {
    const f = records.folders[id];
    const parentCrdt = f.parent ? folderUseId[f.parent] ?? null : null;
    const key = `${parentCrdt ?? ""}|${f.name.trim()}`;
    const hit = existing.byFolderKey.get(key);
    if (hit) folderUseId[id] = hit;
    else {
      folderUseId[id] = id;
      folderCreate.push(id);
    }
  };
  const stack = [...(childrenOf.get(null) ?? [])].reverse();
  while (stack.length) {
    const id = stack.pop()!;
    if (id in folderUseId) continue; // 防重复入栈
    resolve(id);
    for (const child of childrenOf.get(id) ?? []) stack.push(child);
  }
  // 环或父不存在的孤儿 → 当新夹（父视为根）; 同样顺子夹下走
  for (const id of Object.keys(records.folders)) {
    if (id in folderUseId) continue;
    folderUseId[id] = id;
    folderCreate.push(id);
    const sub = [...(childrenOf.get(id) ?? [])].reverse();
    while (sub.length) {
      const child = sub.pop()!;
      if (child in folderUseId) continue;
      resolve(child);
      for (const grand of childrenOf.get(child) ?? []) sub.push(grand);
    }
  }

  const bookmarkUseId: Record<string, string> = {};
  const bookmarkRefolder: Record<string, string | null> = {};
  let newBookmarks = 0;
  let reused = 0;
  for (const [recId, b] of Object.entries(records.bookmarks)) {
    const folderCrdt = b.folder ? (folderUseId[b.folder] ?? b.folder) : null;
    const hit = existing.byUrl.get(b.url.trim());
    if (hit) {
      // 同 URL 一律复用（导入绝不新建副本 —— 重复导入事故的根治点）
      bookmarkUseId[recId] = hit;
      reused++;
      // 仅当现存归属为空/悬空时才采纳 chrome 侧的归属（不覆盖用户在 UI 里的移动）
      const cur = existing.folderOf.get(hit) ?? null;
      const curAlive = cur && existing.aliveFolders.has(cur) ? cur : null;
      if (!curAlive && folderCrdt) bookmarkRefolder[recId] = folderCrdt;
    } else {
      newBookmarks++;
    }
  }
  return {
    folderUseId,
    folderCreate,
    bookmarkUseId,
    bookmarkRefolder,
    newFolders: folderCreate.length,
    newBookmarks,
    reused,
  };
}

// 一次性全量导入（幂等: 已有映射的 chrome 节点跳过; 另外按内容匹配复用已有条目）
/**
 * 从导入计划推导 nodeMap 更新（能力块 14 · ②, 纯函数）: chrome 节点 id → CRDT 条目 id。
 * 关键: **文件夹也要记映射**（原实现只记书签 → 剪枝/镜像的文件夹分支全失效）。
 * 原先只记书签 → 剪枝/全量镜像的文件夹分支全部按"未映射"处理 → 用户实测"覆盖后残留空文件夹"未修好。
 */
export function planNodeMapUpdates(
  records: CrdtRecords,
  plan: ImportPlan
): Record<string, string> {
  const out: Record<string, string> = {};
  // 注: 只产出**复用**项（已确认存在于 CRDT）; 新建项的映射由 importTree 在 crdtAdd* 成功后写,
  // 避免"记住了但实际没写"（AGENTS.md 坑点: folders map 缺失时 crdtAddFolder 返回 false）。
  // ⚠️ 必须显式排除 folderCreate: planImport 对新建夹也写 folderUseId[id] = id,
  // 不排除就会在 crdtAddFolder **之前**预写新建项映射（review 第 5 轮实测）
  const created = new Set(plan.folderCreate);
  for (const [recId, actualId] of Object.entries(plan.folderUseId)) {
    if (created.has(recId)) continue;
    const f = records.folders[recId];
    if (f) out[f.chromeId] = actualId; // 复用已有夹 → 建立映射
  }
  for (const [recId, b] of Object.entries(records.bookmarks)) {
    const existingId = plan.bookmarkUseId[recId];
    if (existingId) out[b.chromeId] = existingId;
  }
  return out;
}

/**
 * 是否需要为了补映射而再导入一次（能力块 14 · ② review 第 5 轮）。
 * 只有"**CRDT 里确实有夹, 但一个都没映射**"才需要 —— 否则"CRDT 里没有夹"（书签全在顶层）这类
 * 正常终态会让 mappedFolders 恒 0 → 每次 bootstrap + 每分钟 keepalive 都全量重导（永久循环）。
 */
// 重入守卫（review 第 7 轮）: bootstrap / onStartup / keepalive 可在同一 SW 求值内并发触发导入;
// 两个 planImport 若在对方 transact 提交前读文档, 仍可能产生重复夹 → 直接串行化
let importRunning = false;

export async function importTree(
  opts: { overwrite?: boolean } = {}
): Promise<{ folders: number; bookmarks: number; reused: number }> {
  if (importRunning) return { folders: 0, bookmarks: 0, reused: 0 };
  importRunning = true;
  try {
    return await importTreeInner(opts);
  } finally {
    importRunning = false;
  }
}

// 「浏览器覆盖后端」的收尾（能力块 20）: 把 CRDT 里**没有归属**（folder === null）的书签直接删掉。
// 用户明确要求: 覆盖时"没有归属的直接删掉, 而不是跑到未分类里去" ✗ 回未分组。
export async function purgeUngroupedBookmarks(): Promise<number> {
  const s = await ensureState();
  const bm = doc.getMap("").get("bookmarks") as Y.Map<unknown> | undefined;
  if (!s || !bm) return 0;
  const ids: string[] = [];
  bm.forEach((v, k) => {
    if ((nodeFields(v)?.folder ?? null) === null) ids.push(k);
  });
  if (ids.length === 0) return 0;
  doc.transact(() => {
    for (const id of ids) crdtDeleteBookmark(id);
  });
  // 映射一并清理（否则每次覆盖都累积一批无界增长, 且熔断的 countMapped 会误判）
  const reverse = reverseNodeMap(s.nodeMap);
  const forgotten = ids.map((id) => reverse.get(id)).filter((x): x is string => !!x);
  if (forgotten.length > 0) {
    for (const chromeId of forgotten) delete s.nodeMap[chromeId];
    await saveNodeMap(s.nodeMap);
  }
  return ids.length;
}

async function importTreeInner(
  opts: { overwrite?: boolean } = {}
): Promise<{ folders: number; bookmarks: number; reused: number }> {
  const s = await ensureState();
  if (!s) return { folders: 0, bookmarks: 0, reused: 0 };
  // schema 未就绪（server bootstrap 尚未同步到）→ 抛错让调用方重试; 静默丢弃写入是事故根源
  if (!hasSchema()) throw new Error("CRDT schema 未就绪（server bootstrap 未到达）");
  const nodeMap = s.nodeMap;
  const tree = await chrome.bookmarks.getTree();
  const records = treeToRecords(tree);
  const plan = planImport(records, existingIndex());

  let newFolders = 0;
  let newBookmarks = 0;
  let reused = 0;

  // 复用项（已确认存在于 CRDT）的映射可以直接写; **新建项**的映射必须在 crdtAdd* 成功后才写
  // （否则会出现"记住了但实际没写"—— folders map 缺失时 crdtAddFolder 返回 false）
  Object.assign(nodeMap, planNodeMapUpdates(records, plan));

  doc.transact(() => {
    for (const recId of plan.folderCreate) {
      const f = records.folders[recId];
      const parent = f.parent ? (plan.folderUseId[f.parent] ?? f.parent) : null;
      if (crdtAddFolder(recId, f.name, parent, f.order)) {
        nodeMap[f.chromeId] = recId; // 成功才记映射（与书签侧一致）
        newFolders++;
      }
    }
    for (const [recId, b] of Object.entries(records.bookmarks)) {
      const folder = b.folder ? (plan.folderUseId[b.folder] ?? b.folder) : null;
      const existingId = plan.bookmarkUseId[recId];
      if (existingId) {
        // 映射已由 planNodeMapUpdates 建立
        reused++;
        // 现存归属为空/悬空 → 采纳 chrome 侧归属（补齐结构）
        const refolder = plan.bookmarkRefolder[recId];
        if (refolder !== undefined && refolder !== null) crdtSetBookmarkFolder(existingId, refolder);
        continue;
      }
      if (nodeMap[b.chromeId]) {
        reused++; // 本地映射已在（上次导入过）
        continue;
      }
      if (crdtAddBookmark(recId, b.title, b.url, folder, b.order)) {
        nodeMap[b.chromeId] = recId;
        newBookmarks++;
      }
    }
  });
  // 覆盖模式（能力块 20 · 用户要求"完全覆盖, 结构全部对齐"）:
  // 已映射的夹/书签要**对齐到浏览器的真实状态**（改名 / 改归属 / 改标题 / 改顺序）。
  // 增量模式**不做**这一步（增量只补不删、也不覆盖用户在 WebUI 里的移动）。
  if (opts.overwrite) {
    // 注: **只对齐"层级 + 名称 + 标题"**, 不对齐顺序 —— 导入侧的 order 是遍历序号（非 Chrome index）,
    // 用它覆盖只会造成无意义抖动。顺序以浏览器为准的诉求由"后端覆盖浏览器"方向负责。
    const fm = doc.getMap("").get("folders") as Y.Map<unknown> | undefined;
    const bmMap = doc.getMap("").get("bookmarks") as Y.Map<unknown> | undefined;
    for (const [recId, f] of Object.entries(records.folders)) {
      const crdtId = plan.folderUseId[recId] ?? recId;
      const cur = folderFields(fm?.get(crdtId));
      if (!cur) continue;
      const wantParent = f.parent ? (plan.folderUseId[f.parent] ?? null) : null;
      if (cur.name !== f.name) crdtSetFolderName(crdtId, f.name);
      if ((cur.parent ?? null) !== wantParent) crdtSetFolderParent(crdtId, wantParent);
    }
    for (const [recId, b] of Object.entries(records.bookmarks)) {
      const crdtId = plan.bookmarkUseId[recId] ?? nodeMap[b.chromeId];
      if (!crdtId) continue; // 浏览器里没有归属 → 不导入（由 purgeUngroupedBookmarks 统一清）
      const cur = nodeFields(bmMap?.get(crdtId));
      if (!cur) continue;
      const want = b.folder ? (plan.folderUseId[b.folder] ?? null) : null;
      if (cur.title !== b.title) crdtSetBookmarkTitle(crdtId, b.title);
      if ((cur.folder ?? null) !== want) crdtSetBookmarkFolder(crdtId, want);
    }
  }

  await saveNodeMap(nodeMap);
  return { folders: newFolders, bookmarks: newBookmarks, reused: plan.reused + reused };
}

// 注: 文件夹幂等现由 planImport（按 父|名 匹配复用）负责, 不再需要单独的同名判断

// 增量同步: 由 index.ts 顶层注册的监听器转发到这里
// 注: @types/chrome 0.3.x 把书签事件标成 (id, info) 双参, 而 Chrome 运行时只传一个对象 —— `b ?? a` 归一
export async function onBookmarkCreated(a: unknown, b?: unknown): Promise<void> {
  // Chrome 事件签名 (id, node) —— 统一用纯函数解析（见 lib/parent.ts 的注释）
  const node = parseCreatedArgs(a, b);
  if (!node?.id) return;
  const s = await ensureState();
  if (!s) return;
  // 幂等（review 第 1 轮阻塞项）: 重放时若导入已建立映射 → 直接跳过（否则会覆盖正确映射/造副本）
  if (s.nodeMap[node.id]) return;
  if (!chromeParentLoaded) await refreshChromeParentMap(); // 父链缓存（懒加载一次）
  // 归属解析（能力块 15）: 原先 `pid === "1" ? null` 把 Chrome 书签栏硬编码成未分组,
  // 而 Chrome 添加书签的默认目标就是书签栏 → 所有新加书签都进"未分组" ✗
  const parent = resolveParentFolder(node.parentId, chromeParentLookup(s.nodeMap));
  // URL 幂等（能力块 15）: 事件路径原先没有, 同 URL 重复添加会产生副本（生产实测 YouTube/bilibili 各两份）
  if (node.url) {
    const existing = findBookmarkByUrl(node.url);
    if (existing) {
      await rememberNode(node.id, existing);
      return;
    }
  }
  const crdtId = crypto.randomUUID();
  // doc.transact 返回回调返回值 → 拿到「是否真的写入」
  const written = node.url
    ? doc.transact(() =>
        crdtAddBookmark(crdtId, node.title || node.url || "", node.url || "", parent, Object.keys(s.nodeMap).length)
      )
    : doc.transact(() => crdtAddFolder(crdtId, node.title || "", parent, Object.keys(s.nodeMap).length));
  if (!written) {
    // 不记映射: 否则会出现“记住了但实际没写”的静默丢数据。
    // 但也不能静默丢事件 → 入待办队列, 等 schema 就绪后重放（能力块 15）
    console.warn("[bnt] onCreated: schema 未就绪 → 事件入待办队列, 稍后重放");
    await pushPending({
      type: "created",
      chromeId: node.id,
      at: new Date().toISOString(),
      title: node.title || node.url || "",
      ...(node.url ? { url: node.url } : {}),
      ...(node.parentId ? { parentId: node.parentId } : {}),
    });
    return;
  }
  await rememberNode(node.id, crdtId);
  await backupIfOffline({
    type: "created",
    chromeId: node.id,
    at: new Date().toISOString(),
    title: node.title || node.url || "",
    ...(node.url ? { url: node.url } : {}),
    ...(node.parentId ? { parentId: node.parentId } : {}),
  });
}

// Chrome 侧父链查询（供 resolveParentFolder 使用）
function chromeParentLookup(nodeMap: Record<string, string>): {
  mapped: (id: string) => string | undefined;
  parentOf: (id: string) => string | undefined;
} {
  return {
    mapped: (id) => nodeMap[id],
    parentOf: (id) => chromeParentOf.get(id),
  };
}

// 缓存 Chrome 父链（一次 getTree 建立; 事件期间复用）
let chromeParentOf = new Map<string, string>();
// 用标志区分"未加载"与"加载后确实为空"（用户书签树为空时 size 恒 0, 原判据会每个事件重跑 getTree）
let chromeParentLoaded = false;
export async function refreshChromeParentMap(): Promise<void> {
  // 不抛错: 它在事件处理与重放的**关键路径**上, 一抛就会丢事件（review 重要项）
  try {
    const snap = await readChromeSnapshot();
    chromeParentOf = new Map(snap.filter((n) => n.parentId).map((n) => [n.id, n.parentId!]));
    chromeParentLoaded = true;
  } catch (e) {
    console.warn("[bnt] 刷新 Chrome 父链失败（沿用旧缓存）:", e);
  }
}

// 离线备份（E2E 暴露）: 本地 doc 里 schema 还在时写入会"成功", 但**未同步到服务端** →
// 若 SW 随后被回收（扩展不持久化 doc）→ 这次写入就丢了。
// 所以在"未同步"时**同时入队**做持久备份; 重放是幂等的（URL / 映射判据）→ 不会产生副本。
async function backupIfOffline(ev: PendingEvent): Promise<void> {
  if (getConnState().synced) return;
  await pushPending(ev);
}

// 按 URL 查现有 CRDT 节点（事件路径的幂等判据）
export function findBookmarkByUrl(url: string): string | undefined {
  const bm = doc.getMap("").get("bookmarks") as Y.Map<unknown> | undefined;
  let hit: string | undefined;
  bm?.forEach((v, k) => {
    if (!hit && nodeFields(v)?.url === url) hit = k;
  });
  return hit;
}

// ---- 待办队列（schema 未就绪时的事件不丢） ----
const PENDING_KEY = "pendingEvents";

// 读改写串行化（review 建议）: 多个事件并发时后写会覆盖先写 → 用 promise 链排队
let pendingChain: Promise<void> = Promise.resolve();
export async function pushPending(ev: PendingEvent): Promise<void> {
  pendingChain = pendingChain.then(async () => {
    const cur = ((await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY] ?? []) as PendingEvent[];
    await chrome.storage.local.set({ [PENDING_KEY]: enqueuePending(cur, ev) });
  });
  return pendingChain;
}

export async function drainPending(): Promise<PendingEvent[]> {
  const cur = ((await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY] ?? []) as PendingEvent[];
  await chrome.storage.local.remove(PENDING_KEY);
  return planPendingReplay(cur);
}

// 重放待办事件（导入成功后调用）: 幂等（URL / 映射判据都在各自的 handler 里）
// **必须重建完整载荷**（只传 {id} 会把书签当文件夹 / 把归属解析成未分组 ✗）
// 分批处理: 每处理一批就把**剩余**写回存储 → SW 中途被回收也不会整批丢失
export async function replayPending(): Promise<{ ok: number; skipped: number; requeued: number }> {
  // 先刷父链（在 drain 之前 —— 它失败也不会丢已取出的批次）
  await refreshChromeParentMap();
  const events = await drainPending();
  if (events.length === 0) return { ok: 0, skipped: 0, requeued: 0 };
  const BATCH = 10;
  let ok = 0;
  for (let i = 0; i < events.length; i += BATCH) {
    const batch = events.slice(i, i + BATCH);
    for (const ev of batch) {
      try {
        if (ev.type === "created") await onBookmarkCreated(toCreatedNode(ev));
        else if (ev.type === "removed") await onBookmarkRemoved(toRemovedInfo(ev));
        else await onBookmarkMoved(toMovedInfo(ev));
        ok++;
      } catch {
        /* 单个失败不影响其它 */
      }
    }
    const rest = events.slice(i + BATCH);
    if (rest.length > 0) {
      // ⚠️ 必须与"批内 handler 重新入队的事件"合并 —— 直接 set(rest) 会把它们覆盖掉（review 阻塞项）:
      // 典型场景 = bootstrap 时 schema 未就绪, 首批 10 条全部走 pushPending 回队 → 被 rest 覆盖 → 永久丢失
      const cur = ((await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY] ?? []) as PendingEvent[];
      let merged = cur;
      for (const ev of rest) merged = enqueuePending(merged, ev);
      await chrome.storage.local.set({ [PENDING_KEY]: merged });
    }
  }
  // 剩余 = 本轮重新入队的（handler 失败会 pushPending）; 分开计数, 别把"回队"当成功
  const left = ((await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY] ?? []) as PendingEvent[];
  console.warn(`[bnt] 待办事件重放: 成功 ${ok} / 总数 ${events.length} / 仍在队列 ${left.length}`);
  return { ok, skipped: events.length - ok - left.length, requeued: left.length };
}

export async function onBookmarkRemoved(a: unknown, b?: unknown): Promise<void> {
  // ⚠️ (id, removeInfo): removeInfo 没有 id —— 原写法 (b ?? a) 会让 id 恒 undefined（E2E 实测 bug）
  const parsed = parseRemovedArgs(a, b);
  if (!parsed) return;
  const info = { id: parsed.id, node: parsed.url ? { url: parsed.url } : undefined };
  const s = await ensureState();
  if (!s) return;
  const crdtId = s.nodeMap[info.id];
  const isFolder = info.node ? !info.node.url : false;
  if (!crdtId) {
    // 未映射（或 schema 未就绪导致映射还没建）→ 不能静默丢: 入队等导入后重放
    await pushPending({
      type: "removed",
      chromeId: info.id,
      at: new Date().toISOString(),
      isFolder,
      ...(info.node?.url ? { url: info.node.url } : {}),
    });
    return;
  }
  // 删除函数返回 void → 用 schema 就绪性判断"能不能删"（未就绪时删除会静默 no-op）
  if (!hasSchema()) {
    await pushPending({
      type: "removed",
      chromeId: info.id,
      at: new Date().toISOString(),
      isFolder,
      ...(info.node?.url ? { url: info.node.url } : {}),
    });
    return;
  }
  doc.transact(() => (isFolder ? crdtDeleteFolder(crdtId) : crdtDeleteBookmark(crdtId)));
  await forgetNode(info.id);
  await backupIfOffline({
    type: "removed",
    chromeId: info.id,
    at: new Date().toISOString(),
    isFolder,
    ...(info.node?.url ? { url: info.node.url } : {}),
  });
}

export async function onBookmarkMoved(a: unknown, b?: unknown): Promise<void> {
  // ⚠️ (id, moveInfo): moveInfo 没有 id（同理, 移动事件此前也从未生效）
  const info = parseMovedArgs(a, b);
  if (!info) return;
  const s = await ensureState();
  if (!s) return;
  const crdtId = s.nodeMap[info.id];
  if (!crdtId) {
    // 未映射（冷启动时映射还没建）→ 入队, 不能静默丢（spec「任何写入失败」）
    await pushPending({
      type: "moved",
      chromeId: info.id,
      at: new Date().toISOString(),
      ...(info.parentId ? { parentId: info.parentId } : {}),
    });
    return;
  }
  if (!chromeParentLoaded) await refreshChromeParentMap();
  // 同样去掉 `parentId === "1" ? null` 的硬编码（书签栏是 CRDT 里正常的夹）
  const parent = resolveParentFolder(info.parentId, chromeParentLookup(s.nodeMap));
  // 文件夹的 crdtId 不在 bookmarks 里 → crdtSetBookmarkFolder 自然空操作
  // moved === false 有两种成因, 必须区分:
  //   ① schema 未就绪 → 该入队重放
  //   ② 节点其实是**文件夹**（crdtSetBookmarkFolder 对 folder id 返回 false, 属预期 no-op）
  //      → 不能入队（否则每次移动文件夹都塞一条永远完不成的 moved, 去重使其常驻,
  //        最终挤掉真正待重放的 created/removed = 丢数据）
  if (!hasSchema()) {
    await pushPending({
      type: "moved",
      chromeId: info.id,
      at: new Date().toISOString(),
      ...(info.parentId ? { parentId: info.parentId } : {}),
    });
    return;
  }
  doc.transact(() => crdtSetBookmarkFolder(crdtId, parent));
  await backupIfOffline({
    type: "moved",
    chromeId: info.id,
    at: new Date().toISOString(),
    ...(info.parentId ? { parentId: info.parentId } : {}),
  });
  // 同时写**实际 index → order**（review 重要项）: 只写 folder 会让 order 停留在旧值,
  // 回写时按旧 order 移动 → 用户拖到末尾却被放到开头（"整理不算数"的反向版本）
  if (info.parentId) {
    try {
      const siblings = await chrome.bookmarks.getChildren(info.parentId);
      const idx = siblings.findIndex((n) => n.id === info.id);
      if (idx >= 0) crdtSetBookmarkOrder(crdtId, idx);
    } catch {
      /* 取不到子节点列表 → 只更新归属 */
    }
  }
}

// ---- 能力块 14 · ①/②: 强制同步的 Chrome 侧辅助 ----

// 读一份 Chrome 树快照（全量镜像规划器 / 剪枝都用）
export async function readChromeSnapshot(): Promise<
  { id: string; parentId: string; title: string; index: number; url?: string }[]
> {
  const tree = await chrome.bookmarks.getTree();
  const out: { id: string; parentId: string; title: string; index: number; url?: string }[] = [];
  const walk = (node: chrome.bookmarks.BookmarkTreeNode, parentId: string, index: number) => {
    out.push({ id: node.id, parentId, title: node.title, index, ...(node.url ? { url: node.url } : {}) });
    (node.children ?? []).forEach((c, i) => walk(c, node.id, i));
  };
  // 根节点(id=0)本身不入快照; 它的子节点（书签栏/其他/移动设备）作为顶层
  (tree[0]?.children ?? []).forEach((c, i) => walk(c, tree[0].id, i));
  return out;
}

// 浏览器里存在哪些 URL（剪枝 / 避免重复创建）
export async function chromeUrlSet(): Promise<Set<string>> {
  const snap = await readChromeSnapshot();
  return new Set(snap.filter((n) => n.url).map((n) => n.url!));
}

// 用浏览器书签**覆盖** CRDT: 删除浏览器里已不存在的书签与文件夹（含子树）。
// 判据（spec 定稿）= **"浏览器里是否存在对应节点"**: 书签按 URL, 文件夹按映射或(父级+名称)
// → **未映射的条目也可能被删**（"覆盖"语义如此, popup 的 confirm 已明确提示）。
export async function pruneMissingFromChrome(): Promise<{ bookmarks: number; folders: number }> {
  const s = await ensureState();
  if (!s) return { bookmarks: 0, folders: 0 };
  // 一次取树, 派生 URL 集 / 文件夹 id 集 / 文件夹 (父ChromeId|名称) 集（原先取两次）
  const snap = await readChromeSnapshot();
  const urls = new Set(snap.filter((n) => n.url).map((n) => n.url!));
  const chromeFolderIds = new Set(snap.filter((n) => !n.url).map((n) => n.id));
  // 键归一（review 重要项）: readChromeSnapshot 的顶层容器 parentId 是 "0",
  // 而 CRDT 顶层夹 parent === null → planFolderPrune 查的是 "root|名称"。
  // 不归一的话 "0|名称" 永远匹配不上 "root|名称" → **未映射的顶层夹会被误剪**。
  const chromeFolderKeys = new Set(
    snap.filter((n) => !n.url).map((n) => chromeFolderKey(n.parentId, n.title))
  );
  const root = doc.getMap("");
  const bm = root.get("bookmarks") as Y.Map<unknown> | undefined;
  const fm = root.get("folders") as Y.Map<unknown> | undefined;

  const crdtFolders = new Map<string, { parent: string | null; name: string }>();
  fm?.forEach((v, k) => {
    const f = folderFields(v);
    crdtFolders.set(k, { parent: f?.parent ?? null, name: f?.name ?? "" });
  });

  let removedBookmarks = 0;
  const removedBookmarkIds: string[] = [];
  doc.transact(() => {
    bm?.forEach((v, k) => {
      const url = nodeFields(v)?.url;
      if (typeof url === "string" && !urls.has(url)) {
        crdtDeleteBookmark(k);
        removedBookmarkIds.push(k);
        removedBookmarks++;
      }
    });
  });

  const pruneIds = planFolderPrune(crdtFolders, s.nodeMap, chromeFolderIds, chromeFolderKeys);
  const reverse = reverseNodeMap(s.nodeMap);
  // 整批放进一个事务（原先逐条 crdtDeleteFolder 各自开事务 → N 个 update 逐条广播）
  doc.transact(() => {
    for (const id of pruneIds) crdtDeleteFolder(id);
  });
  // 映射清理一次性落盘
  // 书签与文件夹的映射都要清（原先只清夹 → 被剪书签的映射残留, 每次「覆盖」累积一批, 无界增长）
  const forgotten: string[] = [];
  for (const id of [...pruneIds, ...removedBookmarkIds]) {
    const chromeId = reverse.get(id);
    if (chromeId) forgotten.push(chromeId);
  }
  if (forgotten.length > 0) {
    // 必须**原地**改内存缓存（与 forgetNode 同模式）: 只落盘副本会让 state.nodeMap 与 storage 分叉,
    // 直到 resetState()/SW 重启 —— 熔断的 countMapped 会把已剪节点仍算作"映射", 放大误判
    for (const chromeId of forgotten) delete s.nodeMap[chromeId];
    await saveNodeMap(s.nodeMap);
  }
  return { bookmarks: removedBookmarks, folders: pruneIds.length };
}

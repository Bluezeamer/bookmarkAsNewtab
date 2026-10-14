// MV3 service worker 入口
//
// 铁律: 事件监听器必须在**顶层同步**注册。
// SW 被回收后事件到来时, Chrome 会重新求值本脚本并按事件找到监听器 ——
// 若注册发生在 await 之后（旧写法在 async init() 里注册）, 事件到来时监听器还不存在,
// 事件被直接丢弃。这是"扩展装上了但一条书签/历史都收不到"的根因之一。
//
// 另一个根因: 首次安装时还没配置 server/token, 旧写法 init() 直接 return 后再无人唤醒 SW,
// 用户在新标签页保存配置也不会触发任何动作。现在由 storage.onChanged 兜住。
import { connect, doc, getConnState, hasSchema, nodeFields } from "./crdt.ts";
import type { WebsocketProvider } from "y-websocket";
import {
  refreshChromeParentMap,
  replayPending,
  importTree,
  purgeUngroupedBookmarks,
  onBookmarkCreated,
  onBookmarkMoved,
  onBookmarkRemoved,
  pruneMissingFromChrome,
  readChromeSnapshot,
} from "./bookmarks.ts";
import { backfill, flush, onVisited } from "./history.ts";
import { uploadMissingIcons } from "./favicon.ts";
import {
  ensureState,
  forgetNode,
  rememberNode,
  resetState,
  setLastBackfill,
  type SwState,
} from "./state.ts";
import { saveNodeMap } from "./settings.ts";
import { friendlyError, type StatusSnapshot } from "../lib/status.ts";
import {
  isSuspiciousWipe,
  planWriteback,
  reverseNodeMap,
  type Snapshot,
  type WbAction,
} from "../lib/writeback.ts";
import {
  baselinePlan,
  deserializeSnapshot,
  serializeSnapshot,
  snapshotFromRoot,
} from "../lib/snapshot.ts";
import { chromeSnapshotFromTree, planFullMirror, type MirrorAction } from "../lib/mirror.ts";
import * as Y from "yjs";

const KEEPALIVE = "keepalive";
const DAY = 24 * 60 * 60 * 1000;

// --- 顶层同步注册（必须在任何 await 之前）---
// 且监听器要**返回 promise**: MV3 靠它得知有异步工作在进行, 否则 SW 可能在 await 中途被回收
// （写成 `=> void handler()` 就会丢掉这个信号 —— 表现为“首次导入时灵时不灵”）
// 回写期间（applyingRemote）跳过: 否则 CRDT→Chrome→CRDT 会成环（能力块 13 · ③）
chrome.bookmarks.onCreated.addListener((a, b) => (isApplyingRemote() ? undefined : onBookmarkCreated(a, b)));
chrome.bookmarks.onRemoved.addListener((a, b) => (isApplyingRemote() ? undefined : onBookmarkRemoved(a, b)));
chrome.bookmarks.onMoved.addListener((a, b) => (isApplyingRemote() ? undefined : onBookmarkMoved(a, b)));
chrome.history.onVisited.addListener((item) => onVisited(item));
chrome.alarms.onAlarm.addListener((alarm) => onAlarm(alarm));
// 新标签页保存 server/token → 立刻引导（首次全量导入就在这条路上发生）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || (!changes.token && !changes.serverUrl)) return;
  resetState();
  return bootstrap();
});
chrome.runtime.onInstalled.addListener(() => bootstrap());
chrome.runtime.onStartup.addListener(() => bootstrap());
// 扩展面板「立即同步」（能力块 13 · ②）: 顶层同步注册 + 返回 promise（MV3 保活）
chrome.runtime.onMessage.addListener((msg: unknown) => {
  const t = (msg as { type?: string } | null)?.type;
  // 能力块 20: 三种**显式**同步（安装/启动/改配置都不再自动注入 ✗）
  if (t === "inject-from-chrome") return injectFromChrome(); // ① 增量注入（只补不删）
  if (t === "overwrite-from-chrome") return overwriteFromChrome(); // ② 浏览器覆盖后端（完全覆盖）
  if (t === "overwrite-to-chrome") return overwriteToChrome(); // ③ 后端覆盖浏览器（清空重建）
  if (t === "sync-preview") return syncPreview(); // 确认框里的数量（只读）
  return undefined;
});

// ---- 能力块 20: 三种显式同步 ----
// 用户要求: 安装 / 启动 / 改配置**都不再自动注入** —— 只有点击才动数据。
//   ① 增量注入: 只补不删（未归属仍按上溯逻辑落未分组, 保持旧行为）
//   ② 浏览器覆盖后端: 完全覆盖 —— 导入 + 对齐（层级/名称/标题）+ 剪掉浏览器没有的 + **未归属直接删**
//   ③ 后端覆盖浏览器: 先**清空**浏览器书签状态, 再按后端树重建（浏览器侧 = 后端树的精确镜像）

async function injectFromChrome(): Promise<void> {
  const s = await ensureState();
  if (!s) {
    await writeStatus({ ok: false, message: "尚未配置服务器与 token" });
    return;
  }
  forceInFlight = true;
  try {
    await waitForWritebackIdle();
    const provider = connect(s.token, s.serverUrl);
    await waitInitialSync(provider, 6000);
    const sent = await flush(s.serverUrl, s.token);
    const r = await importTree(); // 只创建缺失项, 不删任何东西
    await runWriteback(); // 冷启动时也把停机期间累积的变更补上
    const conn = getConnState();
    await writeStatus({
      ok: conn.synced,
      ...(conn.synced ? { lastSyncAt: new Date().toISOString() } : {}),
      serverUrl: s.serverUrl,
      bookmarks: crdtCount("bookmarks"),
      folders: crdtCount("folders"),
      historyUploaded: await addHistoryUploaded(sent),
      message: `增量注入完成：新建 ${r.bookmarks} 条书签 / ${r.folders} 个文件夹 · 复用 ${r.reused} 条（未删除任何内容）`,
    });
  } catch (e) {
    await writeStatus({ ok: false, serverUrl: s.serverUrl, message: friendlyError(e) });
  } finally {
    forceInFlight = false;
  }
}

async function overwriteFromChrome(): Promise<void> {
  const s = await ensureState();
  if (!s) {
    await writeStatus({ ok: false, message: "尚未配置服务器与 token" });
    return;
  }
  forceInFlight = true;
  try {
    await waitForWritebackIdle();
    const provider = connect(s.token, s.serverUrl);
    await waitInitialSync(provider, 6000);
    // 防回环守卫（spec req 2）: 本路径只写 CRDT、不改 Chrome（Chrome 事件不会触发）,
    // 但守卫一起置上, 避免将来引入 Chrome 写入时漏掉
    applyingRemote = true;
    await refreshChromeParentMap();
    let r: { folders: number; bookmarks: number; reused: number };
    let ungrouped = 0;
    let pruned: { bookmarks: number; folders: number };
    try {
      r = await importTree({ overwrite: true }); // 导入 + 对齐（层级/名称/标题）
      ungrouped = await purgeUngroupedBookmarks(); // 未归属的直接删（不回未分组）
      pruned = await pruneMissingFromChrome(); // 浏览器已不存在的剪掉
      // 覆盖是**用户有意的动作** → 结果就是真相, 直接写成新基线。
      // 否则 300ms 后的回写会拿旧基线对比新快照 → 命中"可疑清空"熔断 → 假告警且无法自愈
      await chrome.storage.local.set({
        writebackBase: serializeSnapshot(snapshotFromRoot(doc.getMap(""))),
      });
    } finally {
      applyingRemote = false;
      forceInFlight = false;
    }
    await writeStatus({
      ok: getConnState().synced,
      ...(getConnState().synced ? { lastSyncAt: new Date().toISOString() } : {}),
      serverUrl: s.serverUrl,
      bookmarks: crdtCount("bookmarks"),
      folders: crdtCount("folders"),
      message: `已用浏览器书签完全覆盖：新增 ${r.bookmarks} · 复用 ${r.reused} · 对齐后清理 ${pruned.bookmarks} 条书签 / ${pruned.folders} 个文件夹 · 未归属删除 ${ungrouped} 条`,
    });
  } catch (e) {
    forceInFlight = false;
    await writeStatus({ ok: false, serverUrl: s.serverUrl, message: friendlyError(e) });
  }
}

// 确认框里的数量（只读, 不动数据）
async function syncPreview(): Promise<{
  chromeBookmarks: number;
  crdtBookmarks: number;
  crdtFolders: number;
  ungrouped: number;
  willDelete: number;
}> {
  const snap = chromeSnapshotFromTree(await readChromeSnapshot());
  const chromeBookmarks = [...snap.byId.values()].filter((n) => !n.isFolder).length;
  const root = doc.getMap("");
  const bm = root.get("bookmarks") as Y.Map<unknown> | undefined;
  let ungrouped = 0;
  let willDelete = 0;
  bm?.forEach((v) => {
    const o = nodeFields(v);
    const folder = o?.folder ?? null;
    if (folder === null) ungrouped++;
    const url = typeof o?.url === "string" ? o.url : "";
    if (!url || !snap.byUrl.has(url)) willDelete++;
  });
  return {
    chromeBookmarks,
    crdtBookmarks: crdtCount("bookmarks") ?? 0,
    crdtFolders: crdtCount("folders") ?? 0,
    ungrouped,
    willDelete,
  };
}

// 等在跑的增量回写收尾（有界等待, 避免与其快照/基线互相踩）
async function waitForWritebackIdle(timeoutMs = 1500): Promise<void> {
  const t0 = Date.now();
  while (wbRunning && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

// 用**当前状态覆盖浏览器书签**（能力块 20 · 用户定义）:
//   ① 完全删除浏览器当前的书签状态（保留根容器: 书签栏 / 其他书签 / 移动设备书签）
//   ② 作废全部节点映射
//   ③ 按后端 CRDT 树在浏览器侧**重建**（planFullMirror 在空快照 + 空映射下 = 全量创建, 父先于子）
// 注: 这是**有意为之**的破坏性动作 —— 浏览器里用户原生的书签也会被清掉（popup 确认框里写明数量）。
async function overwriteToChrome(): Promise<void> {
  const s = await ensureState();
  if (!s) {
    await writeStatus({ ok: false, message: "尚未配置服务器与 token" });
    return;
  }
  forceInFlight = true;
  try {
    await waitForWritebackIdle();
    const provider = connect(s.token, s.serverUrl);
    await waitInitialSync(provider, 6000);
    if (!hasSchema()) throw new Error("CRDT schema 未就绪（server bootstrap 未到达）");
    const crdt = snapshotFromRoot(doc.getMap(""));
    applyingRemote = true; // 关键: 清空产生的 Chrome 事件不得反向写回 CRDT
    let removed = 0;
    let applied = 0;
    let failed = 0;
    try {
      const tree = await chrome.bookmarks.getTree();
      const containers = tree[0]?.children ?? [];
      // 保留**根容器**（书签栏 / 其他书签 / 移动设备书签）:
      // CRDT 里它们的对应物是顶层夹 → 若不保留映射, 重建会再造一份同名夹（实测出现重复的 "Bookmarks bar"）
      const keptIds = new Set(containers.map((c) => c.id));
      const kept = containers.map((c) => ({
        id: c.id,
        parentId: "0",
        title: c.title,
        index: typeof c.index === "number" ? c.index : 0,
      }));
      for (const container of containers) {
        for (const child of container.children ?? []) {
          if (child.children) await chrome.bookmarks.removeTree(child.id);
          else await chrome.bookmarks.remove(child.id);
          removed++;
        }
      }
      const keptMap: Record<string, string> = {};
      for (const [chromeId, crdtId] of Object.entries(s.nodeMap)) {
        if (keptIds.has(chromeId)) keptMap[chromeId] = crdtId;
      }
      s.nodeMap = keptMap; // 其余映射作废（节点已不存在）
      await saveNodeMap(s.nodeMap);
      const actions = planFullMirror(crdt, chromeSnapshotFromTree(kept), s.nodeMap);
      for (const a of actions) {
        // applyMirrorAction 内部吞掉单条失败 → 返回是否成功, 便于回显"成功/失败"条数
        if (await applyMirrorAction(a, s)) applied++;
        else failed++;
      }
    } finally {
      applyingRemote = false;
    }
    forceInFlight = false;
    await writeStatus({
      ok: true,
      lastSyncAt: new Date().toISOString(),
      serverUrl: s.serverUrl,
      bookmarks: crdtCount("bookmarks"),
      folders: crdtCount("folders"),
      message: `已清空浏览器书签并重建：删除 ${removed} 个节点 · 新建 ${applied} 项${failed ? ` · 失败 ${failed} 项` : ""}`,
    });
  } catch (e) {
    forceInFlight = false;
    await writeStatus({ ok: false, serverUrl: s.serverUrl, message: friendlyError(e) });
  }
}

// 执行一条镜像动作（新建时把新节点 id 记进 nodeMap, 供后续增量回写使用）
// 安全下标（能力块 20 实测 bug）: CRDT 的 order 是**全局计数器**, 不是"父夹内的下标" ✗
// → create/move 传一个超出子节点数的 index, Chrome 会直接抛错（实测"新建 3 项 · 失败 6 项"）。
// 超界就**不传 index**（= 追加到末尾）, 由计划里的顺序决定最终位置。
async function safeIndex(parentId: string, index: number): Promise<number | undefined> {
  try {
    const kids = await chrome.bookmarks.getChildren(parentId);
    return index >= 0 && index < kids.length ? index : undefined;
  } catch {
    return undefined;
  }
}

async function applyMirrorAction(a: MirrorAction, s: SwState): Promise<boolean> {
  const parentOf = (crdtId: string | null): string =>
    crdtId ? (reverseNodeMap(s.nodeMap).get(crdtId) ?? CHROME_BOOKMARKS_BAR) : CHROME_BOOKMARKS_BAR;
  try {
    if (a.kind === "createFolder") {
      const parentId = parentOf(a.parentCrdt);
      const index = await safeIndex(parentId, a.index);
      const created = await chrome.bookmarks.create({
        parentId,
        title: a.title,
        ...(index === undefined ? {} : { index }),
      });
      await rememberNode(created.id, a.crdtId);
    } else if (a.kind === "createBookmark") {
      if (!a.url) return false; // 没有 URL 无法创建
      const parentId = parentOf(a.parentCrdt);
      const index = await safeIndex(parentId, a.index);
      const created = await chrome.bookmarks.create({
        parentId,
        title: a.title || a.url,
        url: a.url,
        ...(index === undefined ? {} : { index }),
      });
      await rememberNode(created.id, a.crdtId);
    } else if (a.kind === "move") {
      const parentId = parentOf(a.parentCrdt);
      const index = await safeIndex(parentId, a.index);
      await chrome.bookmarks.move(a.chromeId, {
        parentId,
        ...(index === undefined ? {} : { index }),
      });
    } else if (a.kind === "rename") {
      await chrome.bookmarks.update(a.chromeId, { title: a.title });
    } else if (a.kind === "remove") {
      const node = (await chrome.bookmarks.get(a.chromeId).catch(() => []))[0];
      if (node?.url) await chrome.bookmarks.remove(a.chromeId);
      else await chrome.bookmarks.removeTree(a.chromeId);
      await forgetNode(a.chromeId);
    }
    return true;
  } catch {
    return false; // 单条失败（节点已被用户删除等）→ 继续下一条
  }
}

// 状态快照（popup 读取）: 让用户在扩展侧看到"连没连上/上次同步/多少数据"
export async function writeStatus(patch: Partial<StatusSnapshot>): Promise<void> {
  const prev = ((await chrome.storage.local.get("status")) as { status?: StatusSnapshot }).status ?? { ok: false };
  await chrome.storage.local.set({ status: { ...prev, ...patch } });
}

// 历史条数是**累计值**: flush() 返回的是本次发送条数（缓冲空时为 0）,
// 直接写会把"已上报"显示成 0（用户看到的误导）。
async function addHistoryUploaded(sent: number): Promise<number> {
  const prev = ((await chrome.storage.local.get("status")) as { status?: StatusSnapshot }).status;
  return (prev?.historyUploaded ?? 0) + Math.max(0, sent);
}

// 连接/同步状态变化 → 刷新 status（模块级单例, 见 bootstrap 注释）
function pushStatus(): void {
  void (async () => {
    const st = await ensureState();
    const c = getConnState();
    await writeStatus({
      ok: c.synced,
      serverUrl: st?.serverUrl,
      // 断开时**不要**清掉上次成功时间（否则 popup 从"3 分钟前"变成"从未同步"）
      ...(c.synced ? { lastSyncAt: new Date().toISOString() } : {}),
      bookmarks: crdtCount("bookmarks"),
      folders: crdtCount("folders"),
      message: c.synced ? "" : "尚未连接服务器（正在重试）",
    });
  })();
}

// 引导: 幂等, 每次 SW 启动/配置变更/安装都会走
async function bootstrap(): Promise<void> {
  const s = await ensureState();
  if (!s) return; // 未配置: 等 storage.onChanged 唤醒
  const provider = connect(s.token, s.serverUrl);
  chrome.alarms.create(KEEPALIVE, { periodInMinutes: 1 });
  // 等首次同步完成再导入: CRDT schema（bookmarks/folders）由 server bootstrap, 未到时写入会被丢弃
  await waitInitialSync(provider, 8000);
  // 回写基线 + 订阅（能力块 13 · ③）
  // 关键: **先读持久化基线**。MV3 的 SW 空闲约 30s 就被回收, 而用户多半在 WebUI 里操作
  // （那时 SW 通常在休眠）→ 若每次启动都无条件用"当前快照"覆盖基线, 停机期间到达的远端变更
  // 会被直接吸收, 回写静默丢失（持久化就成了死代码）。
  const plan = baselinePlan(await loadBaseline(), snapshotFromRoot(doc.getMap("")));
  if (plan.persist) void chrome.storage.local.set({ writebackBase: serializeSnapshot(plan.baseline) });
  doc.off("update", scheduleWriteback);
  doc.on("update", scheduleWriteback);
  if (plan.catchUp) void runWriteback(); // 有持久化基线 → 立刻补一轮（覆盖停机期间到达的变更）
  // 连接状态订阅: provider 的状态变化要反映到 status（否则 popup 永远显示启动那一刻的结论）
  // 注意: pushStatus 是**模块级单例** —— bootstrap 每次 SW 求值/onInstalled/onStartup/storage 变更都会跑,
  // 若用每次新建的闭包, off 是 no-op 而 on 每次都加 → 同一生命周期累积 2N 个监听器, 每个事件触发 N 次写。
  const providerNow = connect(s.token, s.serverUrl);
  providerNow.off("status", pushStatus);
  providerNow.on("status", pushStatus);
  providerNow.off("sync", pushStatus);
  providerNow.on("sync", pushStatus);

  try {
    // 能力块 20: **不再自动注入**（用户要求"主动点击后再同步"）——
    // 只重放待办事件（那是 Chrome 事件路径, 与"注入"无关）+ 历史回填。
    void replayPending(); // schema 就绪后重放之前丢弃的事件（能力块 15）
    await backfillIfNeeded(s);
    // 关键（review 阻塞项）: 服务器不可达时 connect() 不抛错、importTree 的 schema 错误又被吞掉,
    // 原来这里会无条件写 ok:true → 最常见的故障场景 popup 却显示绿点"已连接"。
    // 现在 ok 只由**真实同步状态**决定。
    const conn = getConnState();
    await writeStatus({
      ok: conn.synced,
      ...(conn.synced ? { lastSyncAt: new Date().toISOString() } : {}),
      serverUrl: s.serverUrl,
      bookmarks: crdtCount("bookmarks"),
      folders: crdtCount("folders"),
      historyUploaded: await addHistoryUploaded(0), // 保留累计值（bootstrap 不 flush）
      // 能力块 20: 配好 token 后**不写任何数据**, 只提示用户去点「增量注入」
      message: !conn.synced
        ? "尚未连接服务器：请检查地址与网络（后台会自动重试）"
        : (crdtCount("bookmarks") ?? 0) === 0
          ? "尚未注入书签：点「增量注入」把浏览器书签导入（或「后端覆盖浏览器」反向覆盖）"
          : "",
    });
  } catch (e) {
    // schema 未就绪等 → 记录可操作原因, 由 alarm 兜底重试（不再静默）
    await writeStatus({ ok: false, serverUrl: s.serverUrl, message: friendlyError(e) });
  }
  // 图标回传（能力块 6）: 仅上传服务端缺失项, 限批; 失败不阻塞主流程
  void uploadMissingIcons(s).catch(() => {});
}

// ---- CRDT → Chrome 回写（能力块 13 · ③）----
// 为什么需要: WebUI 里的删除/移动/改名不回写 Chrome → 下次同步又被"内容幂等导入"加回来。
// 防回环: 执行期间 applyingRemote=true, Chrome 事件监听器看到它就不再写回 CRDT。
// Chrome 内置书签栏 id（0=根, 1=书签栏, 2=其他书签, 3=移动设备书签）: 跨 profile 稳定
const CHROME_BOOKMARKS_BAR = "1";
let applyingRemote = false;
// 强制同步进行中（review 第 7 轮）: 回写收尾前移基线前必须检查它 ——
// 否则"300ms 去抖回写在跑"时用户点「覆盖」, 回写会用**import/剪枝之前**的旧 next 覆盖新基线
// → 基线回退 → 下轮 diff 命中 isSuspiciousWipe → 又是长期红点假告警
let forceInFlight = false;
let wbRunning = false;
let wbQueued = false;
let wbTimer: ReturnType<typeof setTimeout> | null = null;

export function isApplyingRemote(): boolean {
  return applyingRemote;
}

// 执行一条动作（失败不抛: 记录并继续; 节点可能已被用户在 Chrome 侧删掉）
async function applyAction(a: WbAction, s: SwState): Promise<void> {
  const chromeId = "chromeId" in a ? a.chromeId : "";
  const parentOf = (crdtId: string | null): string | undefined =>
    crdtId ? reverseNodeMap(s.nodeMap).get(crdtId) : CHROME_BOOKMARKS_BAR;
  try {
    if (a.kind === "createFolder") {
      const parentId = parentOf(a.parent);
      if (!parentId) return; // 父夹还没有映射 → 跳过（保守: 不乱放）
      const index = await safeIndex(parentId, a.order);
      const created = await chrome.bookmarks.create({
        parentId,
        title: a.title,
        ...(index === undefined ? {} : { index }),
      });
      await rememberNode(created.id, a.crdtId);
    } else if (a.kind === "createBookmark") {
      const parentId = parentOf(a.folder);
      if (!parentId || !a.url) return;
      const index = await safeIndex(parentId, a.order);
      const created = await chrome.bookmarks.create({
        parentId,
        title: a.title || a.url,
        url: a.url,
        ...(index === undefined ? {} : { index }),
      });
      await rememberNode(created.id, a.crdtId);
    } else if (a.kind === "removeBookmark") await chrome.bookmarks.remove(chromeId);
    else if (a.kind === "removeFolder") await chrome.bookmarks.removeTree(chromeId);
    else if (a.kind === "renameFolder") await chrome.bookmarks.update(chromeId, { title: a.title });
    else if (a.kind === "moveBookmark") {
      // 目标为 null = WebUI 的「未分组」: Chrome 侧没有对应节点 → 回退到书签栏（id "1", 稳定内置 id）。
      // 若目标文件夹存在但**没有 Chrome 映射** → 跳过（保守: 不动用户的 Chrome 结构）。
      const parentId = a.folder ? (reverseNodeMap(s.nodeMap).get(a.folder) ?? undefined) : CHROME_BOOKMARKS_BAR;
      if (!parentId) return;
      await chrome.bookmarks.move(chromeId, { parentId, index: Math.max(0, a.order) });
    }
  } catch {
    /* 节点不存在等 → 跳过; 下次快照对比不会重复尝试（已在 next 快照里） */
  }
}

// CRDT 变更 → 去抖 300ms → 规划 → 执行
function scheduleWriteback(): void {
  // 自己正在改 CRDT（导入/剪枝/镜像）时不调度回写 —— 否则会拿"改之前的基线"对比"改之后的快照",
  // 把用户有意的大批量删除误判成"远端被清空"并触发熔断（能力块 14 · ② review 重要项）
  if (isApplyingRemote()) return;
  if (wbTimer) clearTimeout(wbTimer);
  wbTimer = setTimeout(() => {
    wbTimer = null;
    void runWriteback();
  }, 300);
}

// 读持久化基线（**不做早退**: 即使内存里已有快照, 也要以存储为准 —— 见 baselinePlan 注释）
async function loadBaseline(): Promise<Snapshot | null> {
  const raw = (await chrome.storage.local.get("writebackBase")).writebackBase;
  return deserializeSnapshot(raw);
}

async function runWriteback(): Promise<void> {
  // 重入保护（review 重要项）: 批量动作顺序 await 可能超过 debounce 窗口,
  // 并发两轮会对**同一份未前移的基线**做 diff, 后完成者可能写入更旧的快照并对 Chrome 交错执行 stale 动作
  if (wbRunning) {
    wbQueued = true;
    return;
  }
  wbRunning = true;
  try {
    await runWritebackInner();
  } finally {
    wbRunning = false;
    if (wbQueued) {
      wbQueued = false;
      void runWriteback(); // 执行期间有新变更 → 补跑一轮
    }
  }
}

async function runWritebackInner(): Promise<void> {
  // 已挂起的 300ms 定时器可能在 import/剪枝中途 fire → 入口复查一次（review 第 5 轮建议）
  if (isApplyingRemote()) return;
  // 强制同步已开始（含"回写在跑时点覆盖"的竞态）→ 本轮不再动作, 避免用旧快照覆盖新基线
  if (forceInFlight) return;
  const s = await ensureState();
  if (!s) return;
  // ⚠️ 数据丢失级守卫（能力块 13 · ③ review）: 本地 schema 未同步到（server 重启/断网/慢网时
  // waitInitialSync 会超时）→ doc 为空 → snapshotFromRoot 得到空快照, 而 prev 是完整基线
  // → planWriteback 会对每个映射节点产出 removeBookmark/removeTree = **把 Chrome 书签全删**。
  // importTree 一直有这道守卫, 回写同样必须有。
  if (!hasSchema()) return;
  const next = snapshotFromRoot(doc.getMap(""));
  const prev = await loadBaseline();
  if (!prev) {
    // 首次只记基线
    await chrome.storage.local.set({ writebackBase: serializeSnapshot(next) });
    return;
  }
  // 熔断: prev 有 ≥20 个映射节点而 next 几乎为空 → 更像服务端文档被清空/损坏, 而非用户删除
  if (isSuspiciousWipe(prev, next, s.nodeMap)) {
    await writeStatus({
      ok: false,
      message: "检测到远端书签突然清空, 已跳过回写以免误删 Chrome 书签（请检查服务端数据后手动同步）",
    });
    return; // 不推进基线: 保留 prev, 人工处理后仍能继续对比
  }
  // 浏览器已有的 URL（避免把 WebUI 新建的书签重复创建到 Chrome）
  const chromeUrls = new Set<string>(
    (await readChromeSnapshot().catch(() => []))
      .map((n) => n.url)
      .filter((u): u is string => typeof u === "string")
  );
  const actions = planWriteback(prev, next, s.nodeMap, chromeUrls);
  if (actions.length === 0) {
    await chrome.storage.local.set({ writebackBase: serializeSnapshot(next) });
    return;
  }
  applyingRemote = true;
  try {
    for (const a of actions) await applyAction(a, s);
    // **动作全部执行完才前移基线**（review 重要项）: 批量删除/移动期间 SW 可能被 MV3 回收,
    // 若提前前移, 剩余动作不会再重试（下轮 prev == next, diff 为空）→ 回写尾部永久丢失
    // 且若期间用户点了强制同步 → **不得**用旧快照覆盖它的新基线
    if (!forceInFlight) await chrome.storage.local.set({ writebackBase: serializeSnapshot(next) });
  } finally {
    applyingRemote = false;
  }
}

// CRDT 文档里的条目数（状态快照用; 未连上时为 undefined）
function crdtCount(key: string): number | undefined {
  try {
    // Y.Map 有 .size（不是 JS Map, 别用 instanceof 判断）
    const m = doc.getMap("").get(key) as { size?: number } | undefined;
    return typeof m?.size === "number" ? m.size : undefined;
  } catch {
    return undefined;
  }
}

// 等 server 首次同步（'sync' 事件）; 超时也往下走 —— importTree 在 schema 缺失时会抛错, 由 alarm 兜底重试
function waitInitialSync(provider: WebsocketProvider, ms: number): Promise<void> {
  if ((provider as unknown as { synced?: boolean }).synced) return Promise.resolve();
  return new Promise((resolve) => {
    const onSync = (isSynced: boolean) => {
      if (isSynced) done();
    };
    const timer = setTimeout(() => done(), ms);
    function done() {
      clearTimeout(timer);
      provider.off("sync", onSync);
      resolve();
    }
    provider.on("sync", onSync);
  });
}

// 首次全量导入（幂等判据 = nodeMap 为空）

// 历史补漏（>24h 才重跑; server 端 url|visitedAt 去重, 重复无害）
async function backfillIfNeeded(s: SwState): Promise<void> {
  const last = s.lastBackfill ? Date.parse(s.lastBackfill) : 0;
  if (Date.now() - last <= DAY) return;
  try {
    await backfill(s.serverUrl, s.token);
    await setLastBackfill(new Date().toISOString());
  } catch (e) {
    console.warn("[bnt] backfill 失败(下轮重试):", e);
  }
}

// keepalive 闹钟: 保活 CRDT 连接 + flush 历史缓冲 + 兜底补做引导
async function onAlarm(alarm: chrome.alarms.Alarm): Promise<void> {
  if (alarm.name !== KEEPALIVE) return;
  const s = await ensureState();
  if (!s) return;
  connect(s.token, s.serverUrl);
  await flush(s.serverUrl, s.token);
  // 能力块 20: 这里**不再**兜底导入 —— 注入只由用户显式点击触发（"主动点击后再同步"）
  void replayPending(); // 但待办事件仍要兜底重放（Chrome 事件路径, 与注入无关）
  // 图标回传兜底: 每轮补一点（限批）, 逐步收敛
  void uploadMissingIcons(s).catch(() => {});
}

// MV3 无可靠的 onSuspend —— 被杀的尾巴靠 1 分钟 alarm + 下轮补漏找回

void bootstrap();

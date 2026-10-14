#!/usr/bin/env node
// 扩展纯逻辑测试（spec R8）: 树转换 / 排除域过滤 / 批量分块
// 注意: treeToRecords 用了 crypto.randomUUID —— node 22 全局可用
import assert from "node:assert";
import * as Y from "yjs";
import { planImport, treeToRecords } from "../src/sw/bookmarks.ts";
import { buildFrameSrc } from "../src/lib/frame.ts";
import { friendlyError, relTime, statusView } from "../src/lib/status.ts";
import { looksLikeToken, looksLikeUrl, normalizeConfig } from "../src/lib/config.ts";
import { isSuspiciousWipe, planWriteback, type Snapshot } from "../src/lib/writeback.ts";
import { chromeSnapshotFromTree, planFullMirror } from "../src/lib/mirror.ts";
import { chromeFolderKey, folderSubtree, planFolderPrune } from "../src/lib/prune.ts";
import {
  PENDING_MAX,
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
} from "../src/lib/parent.ts";
import { planNodeMapUpdates } from "../src/sw/bookmarks.ts";
import {
  baselinePlan,
  deserializeSnapshot,
  fieldOf,
  serializeSnapshot,
  snapshotFromRoot,
} from "../src/lib/snapshot.ts";
import { excluded, chunk } from "../src/sw/history.ts";
import { crdtAddBookmark, crdtAddFolder, hasSchema, doc } from "../src/sw/crdt.ts";

let total = 0;
let failed = 0;
async function test(name: string, fn: () => void) {
  total++;
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}: ${(e as Error).message}`);
  }
}

// 模拟 chrome 书签树: 根(1) → [书签a, 文件夹F(含书签b/嵌套文件夹G(含书签c))]
const tree = [
  {
    id: "1",
    title: "Bookmarks bar",
    children: [
      { id: "a", title: "Google", url: "https://google.com" },
      {
        id: "f",
        title: "Dev",
        children: [
          { id: "b", title: "MDN", url: "https://developer.mozilla.org" },
          {
            id: "g",
            title: "Nested",
            children: [{ id: "c", title: "GitHub", url: "https://github.com" }],
          },
        ],
      },
    ],
  },
] as chrome.bookmarks.BookmarkTreeNode[];

await test("T1 树转换: 书签/文件夹计数与字段", () => {
  const r = treeToRecords(tree);
  assert.equal(Object.keys(r.bookmarks).length, 3);
  assert.equal(Object.keys(r.folders).length, 2);
  const [bm] = Object.values(r.bookmarks);
  for (const b of Object.values(r.bookmarks)) {
    assert.ok(b.title && b.url && typeof b.order === "number");
  }
  // 根下书签 folder=null
  const rootBm = Object.values(r.bookmarks).find((b) => b.chromeId === "a");
  assert.equal(rootBm?.folder, null);
  // 嵌套书签的 folder 指向嵌套文件夹（非 null）
  const nested = Object.values(r.bookmarks).find((b) => b.chromeId === "c");
  assert.ok(nested?.folder);
  const nestedFolder = r.folders[nested!.folder!];
  assert.equal(nestedFolder.name, "Nested");
  assert.ok(nestedFolder.parent, "嵌套文件夹保留 parent 链");
});

await test("T2 排除域: 精确 + 子域 + 放行", () => {
  assert.equal(excluded("https://github.com/x", ["github.com"]), true);
  assert.equal(excluded("https://gist.github.com/x", ["github.com"]), true, "子域排除");
  assert.equal(excluded("https://notgithub.com/x", ["github.com"]), false, "前缀相似不中");
  assert.equal(excluded("https://example.com", ["github.com"]), false);
  assert.equal(excluded("not-a-url", []), true, "非法 URL 不采");
});

await test("T3 分块: ≤500/批", () => {
  const arr = Array.from({ length: 1200 }, (_, i) => i);
  const c = chunk(arr, 500);
  assert.equal(c.length, 3);
  assert.deepEqual(c.map((x) => x.length), [500, 500, 200]);
  assert.equal(chunk([], 500).length, 0);
});

await test("T4 schema 未就绪: 写入必须明确失败（不得静默丢弃）", () => {
  // 生产事故根因: 导入在 server bootstrap 到达前跑 → 写入被静默丢 → 一条书签都传不上去, 计数器却照样 +1
  assert.equal(hasSchema(), false, "空 doc 不应有 schema");
  assert.equal(crdtAddBookmark("x", "标题", "https://x.example", null, 0), false);
  assert.equal(crdtAddFolder("f", "夹子", null, 0), false);
});

await test("T5 schema 就绪后写入成功", () => {
  const root = doc.getMap("");
  root.set("bookmarks", new Y.Map());
  root.set("folders", new Y.Map());
  assert.equal(hasSchema(), true);
  assert.equal(crdtAddBookmark("x", "标题", "https://x.example", null, 0), true);
  assert.equal(crdtAddFolder("f", "夹子", null, 0), true);
});

// ---------- 能力块 5 追加: 导入幂等（防重复） ----------

await test("T6 planImport: 空索引 → 全部新建", () => {
  const rec = treeToRecords(tree);
  const plan = planImport(rec, { byUrl: new Map(), byFolderKey: new Map(), folderOf: new Map(), aliveFolders: new Set() });
  assert.equal(plan.newBookmarks, 3);
  assert.equal(plan.newFolders, 2);
  assert.equal(plan.reused, 0);
});

await test("T7 planImport: 同 URL 且归属一致 → 全量复用（重装扩展不再产生副本）", () => {
  const rec = treeToRecords(tree);
  // 模拟"已经导入过一次"的 CRDT 现状: 文件夹按 父|名 命中, 书签按 url 命中且归属一致
  const folderUse = {};
  const byFolderKey = new Map();
  for (const [id, f] of Object.entries(rec.folders)) {
    const parent = f.parent ? folderUse[f.parent] : null;
    byFolderKey.set(`${parent ?? ""}|${f.name}`, id);
    folderUse[id] = id;
  }
  const byUrl = new Map();
  const folderOf = new Map();
  for (const [id, b] of Object.entries(rec.bookmarks)) {
    byUrl.set(b.url, id);
    folderOf.set(id, b.folder ? folderUse[b.folder] : null);
  }
  const plan = planImport(rec, {
    byUrl,
    byFolderKey,
    folderOf,
    aliveFolders: new Set(Object.keys(rec.folders)),
  });
  assert.equal(plan.reused, 3, "三条书签全部复用");
  assert.equal(plan.newBookmarks, 0);
  assert.equal(plan.newFolders, 0, "同名文件夹不重建");
  assert.equal(plan.folderCreate.length, 0);
});

await test("T8 planImport: 同 URL 一律复用（绝不新建副本），不覆盖有效归属", () => {
  const rec = treeToRecords(tree);
  // MDN 已有条目，且归属有效（在别的夹里）→ 复用 + 不动归属
  const mdBm = Object.values(rec.bookmarks).find((b) => b.url.includes("mozilla"))!;
  const byUrl = new Map([[mdBm.url, "existing-id"]]);
  const folderOf = new Map([["existing-id", "other-folder"]]);
  const plan = planImport(rec, {
    byUrl,
    byFolderKey: new Map(),
    folderOf,
    aliveFolders: new Set(["other-folder"]),
  });
  assert.equal(plan.reused, 1, "命中即复用");
  assert.equal(plan.newBookmarks, 2, "其余两条新建");
  assert.equal(Object.keys(plan.bookmarkRefolder).length, 0, "有效归属不得被覆盖");
});

await test("T9 planImport: 现存归属为空/悬空 → 采纳 chrome 归属（补结构, 不产生副本）", () => {
  const rec = treeToRecords(tree);
  const mdBm = Object.values(rec.bookmarks).find((b) => b.url.includes("mozilla"))!;
  const byUrl = new Map([[mdBm.url, "existing-id"]]);
  const folderOf = new Map([["existing-id", "ghost"]]); // 悬空（不在 aliveFolders）
  const plan = planImport(rec, {
    byUrl,
    byFolderKey: new Map(),
    folderOf,
    aliveFolders: new Set(),
  });
  assert.equal(plan.reused, 1);
  assert.equal(Object.keys(plan.bookmarkRefolder).length, 1, "应采纳 chrome 的归属");
});

await test("T10 planImport: 深链（200 层）+ 环 → 全部解析不挂死", () => {
  const folders: Record<string, { name: string; parent: string | null; order: number }> = {};
  let parent: string | null = null;
  for (let i = 0; i < 200; i++) {
    folders[`F${i}`] = { name: `层${i}`, parent, order: i };
    parent = `F${i}`;
  }
  folders["C1"] = { name: "环1", parent: "C2", order: 300 };
  folders["C2"] = { name: "环2", parent: "C1", order: 301 };
  const plan = planImport(
    { folders, bookmarks: {} } as unknown as Parameters<typeof planImport>[0],
    { byUrl: new Map(), byFolderKey: new Map(), folderOf: new Map(), aliveFolders: new Set() }
  );
  assert.equal(Object.keys(plan.folderUseId).length, 202, "含环内夹全部要解析");
  assert.equal(plan.folderCreate.length, 202, "首次导入应全部创建");
});

await test("T11 buildFrameSrc: 带 faviconBase 且正确编码（能力块 6）", () => {
  const src = buildFrameSrc("https://s.example/", "tok", "chrome-extension://abc/_favicon/");
  const u = new URL(src);
  assert.equal(u.origin, "https://s.example");
  assert.equal(u.searchParams.get("token"), "tok");
  assert.equal(u.searchParams.get("faviconBase"), "chrome-extension://abc/_favicon/");
  assert.ok(src.includes("faviconBase=chrome-extension%3A%2F%2Fabc"), "URL 编码正确");
  // 无基址（如内核不可用）→ 不带该参数
  const noBase = buildFrameSrc("https://s.example", "tok", null);
  assert.equal(new URL(noBase).searchParams.get("faviconBase"), null);
});

// ---- 能力块 13 · ②: 扩展面板状态视图 ----
await test("T12 statusView: 成功态（计数 + 相对时间）", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");
  const v = statusView(
    { ok: true, lastSyncAt: "2026-10-12T11:57:00Z", bookmarks: 250, folders: 12, historyUploaded: 1800 },
    now
  );
  assert.equal(v.ok, true);
  assert.equal(v.lastSyncText, "3 分钟前");
  assert.ok(v.counts.includes("250 条书签"));
  assert.ok(v.counts.includes("12 个文件夹"));
  assert.ok(v.counts.includes("1800 条历史"));
  assert.equal(v.message, "");
  // 成功态也要能带回结果文案（强制同步写"成功 X 项·失败 Y 项", 原先 ok 时被抹成空串）
  const withMsg = statusView({ ok: true, message: "已用当前状态覆盖浏览器书签：成功 3 项" }, now);
  assert.equal(withMsg.ok, true);
  assert.ok(withMsg.message.includes("成功 3 项"), `成功态必须回显结果（实际 ${JSON.stringify(withMsg.message)}）`);
});

await test("T13 statusView: 失败/未配置态有可读原因", () => {
  const v = statusView({ ok: false }, Date.now());
  assert.equal(v.ok, false);
  assert.equal(v.lastSyncText, "从未同步");
  assert.equal(v.counts, "尚无数据");
  assert.ok(v.message.length > 0, "应给出失败原因");
  assert.equal(statusView({ ok: false, message: "schema 未就绪" }, Date.now()).message, "schema 未就绪");
});

await test("T14 relTime: 刚刚/分钟/小时/天 边界", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");
  assert.equal(relTime(undefined, now), "从未同步");
  assert.equal(relTime("not-a-date", now), "从未同步");
  assert.equal(relTime("2026-10-12T11:59:30Z", now), "刚刚");
  assert.equal(relTime("2026-10-12T11:30:00Z", now), "30 分钟前");
  assert.equal(relTime("2026-10-12T09:00:00Z", now), "3 小时前");
  assert.equal(relTime("2026-10-09T12:00:00Z", now), "3 天前");
});

// ---- 能力块 13 · ③: CRDT → Chrome 回写规划 ----
const snap = (
  bms: Record<string, { folder: string | null; order: number; title?: string; url?: string }>,
  fds: Record<string, { name: string; parent: string | null; order?: number }> = {}
): Snapshot => ({
  bookmarks: new Map(
    Object.entries(bms).map(([k, v]) => [
      k,
      { folder: v.folder, order: v.order, title: v.title ?? "", url: v.url ?? `https://${k}.example/` },
    ])
  ),
  folders: new Map(Object.entries(fds).map(([k, v]) => [k, { name: v.name, parent: v.parent, order: v.order ?? 0 }])),
});
const MAP = { "c1": "b1", "c2": "b2", "cf1": "f1" };

await test("T15 planWriteback: 删除 / 移动 / 改名 / 删夹 四类动作", () => {
  const prev = snap(
    { b1: { folder: "f1", order: 0 }, b2: { folder: null, order: 1 } },
    { f1: { name: "开发", parent: null } }
  );
  const next = snap({ b2: { folder: "f1", order: 3 } }, {}); // b1 被删; b2 移到 f1; f1 被删
  const acts = planWriteback(prev, next, MAP);
  const kinds = acts.map((a) => a.kind).sort();
  assert.deepEqual(kinds, ["moveBookmark", "removeBookmark", "removeFolder"]);
  const rm = acts.find((a) => a.kind === "removeBookmark")!;
  assert.equal(rm.chromeId, "c1", "删除应作用于映射到的 chrome 节点");
  const mv = acts.find((a) => a.kind === "moveBookmark")!;
  assert.equal(mv.chromeId, "c2");
  assert.equal(mv.folder, "f1");
});

await test("T16 planWriteback: 未映射节点不动 + 无变化不产动作", () => {
  const prev = snap({ b1: { folder: null, order: 0 }, b9: { folder: null, order: 1 } }, { f1: { name: "A", parent: null } });
  const next = snap({ b9: { folder: null, order: 5 } }, { f1: { name: "A", parent: null } }); // b1 删（已映射）+ b9 变（未映射）
  const acts = planWriteback(prev, next, MAP);
  assert.equal(acts.length, 1, `只应产出 1 条（b1 删除）, 实际 ${JSON.stringify(acts)}`);
  assert.equal(acts[0].kind, "removeBookmark");
  // 快照完全相同 → 无动作
  assert.equal(planWriteback(next, next, MAP).length, 0);
});

await test("T17 planWriteback: 文件夹改名 → renameFolder", () => {
  const prev = snap({}, { f1: { name: "开发", parent: null } });
  const next = snap({}, { f1: { name: "开发工具", parent: null } });
  const acts = planWriteback(prev, next, MAP);
  assert.equal(acts.length, 1);
  assert.equal(acts[0].kind, "renameFolder");
  assert.equal(acts[0].title, "开发工具");
});

// ---- 能力块 13 · ③ 适配层: 快照读取必须形状无关（真实 schema 两种形状并存）----
// 关键: **文件夹节点是普通对象**（fm.set(id, {name,parent,order})）; 书签节点是 Y.Map（ADR-009）。
// 早期版本只认"有 .get() 的值" → 文件夹全读成 name:"" → 改名永不回写（合成 Snapshot 的单测拦不住）。
// 注意: 必须用**真实的 Y.Doc**（脱离文档的 new Y.Map() 读取会报 "Invalid access" 并返回 undefined）
function makeRoot(
  bookmarks: Record<string, Record<string, unknown>>,
  folders: Record<string, Record<string, unknown>>,
  opts: { bookmarkNodesAsYMap?: boolean } = {}
) {
  const doc = new Y.Doc();
  const root = doc.getMap("");
  const bm = new Y.Map<unknown>();
  const fm = new Y.Map<unknown>();
  root.set("bookmarks", bm);
  root.set("folders", fm);
  for (const [id, fields] of Object.entries(bookmarks)) {
    if (opts.bookmarkNodesAsYMap === false) {
      bm.set(id, fields); // 旧形状: 普通对象
    } else {
      const n = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(fields)) n.set(k, v);
      bm.set(id, n);
    }
  }
  for (const [id, fields] of Object.entries(folders)) fm.set(id, fields); // 文件夹 = 普通对象（真实形状）
  return root;
}

await test("T18 snapshotFromRoot: 文件夹为普通对象时字段必须读到（回归: 改名永不回写）", () => {
  const root = makeRoot(
    { b1: { title: "A", url: "https://a", folder: "f1", order: 2 } },
    { f1: { name: "开发工具", parent: null, order: 0 } }
  );
  const snap = snapshotFromRoot(root);
  const f = snap.folders.get("f1");
  assert.ok(f, "文件夹应被读到");
  assert.equal(f!.name, "开发工具", "普通对象文件夹的 name 必须读到（不是空串）");
  assert.equal(f!.parent, null);
  assert.equal(snap.bookmarks.get("b1")!.folder, "f1");
  assert.equal(snap.bookmarks.get("b1")!.order, 2);
  assert.equal(snap.bookmarks.get("b1")!.title, "A");
});

await test("T19 snapshotFromRoot: 旧形状（普通对象书签节点）也不丢 folder/order", () => {
  const root = makeRoot(
    { b1: { title: "Legacy", folder: "f1", order: 5 } },
    { f1: { name: "F", parent: "f0", order: 1 } },
    { bookmarkNodesAsYMap: false }
  );
  const snap = snapshotFromRoot(root);
  assert.equal(snap.bookmarks.get("b1")!.folder, "f1");
  assert.equal(snap.bookmarks.get("b1")!.order, 5);
  assert.equal(snap.folders.get("f1")!.parent, "f0");
});

await test("T20 适配层 + 规划器: 文件夹改名真的产出 renameFolder", () => {
  const before = snapshotFromRoot(makeRoot({}, { f1: { name: "开发", parent: null, order: 0 } }));
  const after = snapshotFromRoot(makeRoot({}, { f1: { name: "开发工具", parent: null, order: 0 } }));
  const acts = planWriteback(before, after, { cf1: "f1" });
  assert.equal(acts.length, 1, `应产出 1 条动作, 实际 ${JSON.stringify(acts)}`);
  assert.equal(acts[0].kind, "renameFolder");
  assert.equal(acts[0].title, "开发工具");
});

await test("T21 fieldOf: Y.Map 形状 / 普通对象 / 非法值", () => {
  const doc = new Y.Doc();
  const m = new Y.Map<unknown>();
  doc.getMap("").set("m", m);
  m.set("a", 1);
  assert.equal(fieldOf(m, "a"), 1, "Y.Map 形状应走 get()");
  assert.equal(fieldOf({ a: 2 }, "a"), 2, "普通对象应走下标");
  assert.equal(fieldOf(null, "a"), undefined);
  assert.equal(fieldOf("str", "a"), undefined);
});

// ---- 能力块 13 · ③: 基线持久化决策（Review 阻塞项: 每次启动无条件覆盖基线 → 回写静默丢失）----
await test("T22 baselinePlan: 有持久化基线时必须沿用它并补一轮（不得用当前快照覆盖）", () => {
  const persisted = snapshotFromRoot(makeRoot({ b1: { folder: "f1", order: 0 } }, { f1: { name: "A", parent: null, order: 0 } }));
  const current = snapshotFromRoot(makeRoot({}, {})); // 停机期间 b1 被远端删了
  const plan = baselinePlan(persisted, current);
  assert.equal(plan.baseline, persisted, "基线必须是持久化那份（否则停机期间的变更会被吸收）");
  assert.equal(plan.persist, false, "不得覆盖已存在的基线");
  assert.equal(plan.catchUp, true, "有基线 → 必须立刻补一轮回写");
  // 顺着这个 plan 走: 规划器应产出"删除 b1"
  const acts = planWriteback(plan.baseline, current, { c1: "b1" });
  assert.equal(acts.length, 1);
  assert.equal(acts[0].kind, "removeBookmark");
});

await test("T23 baselinePlan: 无基线时用当前快照初始化（不补写）", () => {
  const current = snapshotFromRoot(makeRoot({ b1: { folder: null, order: 0 } }, {}));
  const plan = baselinePlan(null, current);
  assert.equal(plan.baseline, current);
  assert.equal(plan.persist, true);
  assert.equal(plan.catchUp, false);
});

await test("T24 基线序列化往返（含普通对象文件夹）", () => {
  const snap = snapshotFromRoot(
    makeRoot(
      { b1: { folder: "f1", order: 3, title: "A", url: "https://a.example/p" } },
      { f1: { name: "开发", parent: null, order: 1 } }
    )
  );
  const back = deserializeSnapshot(serializeSnapshot(snap))!;
  assert.deepEqual(back.bookmarks.get("b1"), {
    folder: "f1",
    order: 3,
    title: "A",
    url: "https://a.example/p",
  });
  assert.deepEqual(back.folders.get("f1"), { name: "开发", parent: null, order: 1 });
  assert.equal(deserializeSnapshot(undefined), null);
  assert.equal(deserializeSnapshot("not json"), null);
  assert.equal(deserializeSnapshot('{"b":1}'), null);
});

// ---- 能力块 13 · ③: 数据丢失级防护（Review 阻塞项: schema 未就绪时回写会清空 Chrome 书签）----
await test("T25 isSuspiciousWipe: 基线有映射节点而新快照几乎为空 → 判为可疑清空", () => {
  const bms: Record<string, { folder: string | null; order: number }> = {};
  for (let i = 0; i < 25; i++) bms[`b${i}`] = { folder: null, order: i };
  const prev = snap(bms, { f1: { name: "A", parent: null } });
  const map: Record<string, string> = { cf1: "f1" };
  for (let i = 0; i < 25; i++) map[`c${i}`] = `b${i}`;
  // 新快照全空（schema 未同步 / 服务端文档被清空）
  assert.equal(isSuspiciousWipe(prev, snap({}, {}), map), true);
  // 部分残留（服务端文档部分损坏, 只剩 1 条）→ 也必须熔断（旧实现只拦"完全为空"）
  assert.equal(isSuspiciousWipe(prev, snap({ b0: { folder: null, order: 0 } }, {}), map), true);
  // 正常删除: 还剩一半 → 不熔断（用户正常整理照常回写）
  const half: Record<string, { folder: string | null; order: number }> = {};
  for (let i = 0; i < 13; i++) half[`b${i}`] = { folder: null, order: i };
  assert.equal(isSuspiciousWipe(prev, snap(half, { f1: { name: "A", parent: null } }), map), false);
  // 基线本身很少（<20 个映射节点）→ 不熔断（避免新用户被误拦）
  const small = snap({ b0: { folder: null, order: 0 } }, {});
  assert.equal(isSuspiciousWipe(small, snap({}, {}), { c0: "b0" }), false);
});

// ---- 能力块 13 · ②: 错误文案必须可操作（不得把 "Failed to fetch" 直接给用户）----
await test("T26 friendlyError: 网络/鉴权/同步未就绪都给出可操作提示", () => {
  assert.ok(friendlyError(new Error("Failed to fetch")).includes("无法连接服务器"));
  assert.ok(friendlyError(new TypeError("NetworkError when attempting to fetch resource")).includes("无法连接服务器"));
  assert.ok(friendlyError(new Error("CRDT schema 未就绪（server bootstrap 未到达）")).includes("首次同步"));
  assert.ok(friendlyError(new Error("HTTP 401 unauthorized")).includes("token"));
  assert.ok(friendlyError(new Error("request timed out")).includes("超时"));
  const generic = friendlyError(new Error("boom"));
  assert.ok(generic.includes("同步失败"));
  assert.ok(!generic.includes("boom"), "不得把原始技术信息直接暴露给用户");
});

// ---- 能力块 13 · ②: 配置规范化（用户实测: 把服务器地址填进 token 框 → WS 鉴权失败 + 重连刷屏）----
await test("T27 normalizeConfig: 地址与 token 写反时自动交换（自愈）", () => {
  // 真实事故形态: token 字段里是服务器地址（带尾斜杠）
  const cfg = normalizeConfig("", "https://bnt.example.com/");
  assert.equal(cfg.swapped, true, "应识别为写反");
  assert.equal(cfg.serverUrl, "https://bnt.example.com");
  assert.equal(cfg.token, "", "交换后 token 为空 → 应报错而不是去连接");
  assert.ok(cfg.error && cfg.error.includes("token"), `应提示 token 缺失（实际 ${cfg.error}）`);
});

await test("T28 normalizeConfig: 正常配置 / 补 scheme / 非法 token", () => {
  const ok = normalizeConfig("bnt.example.com", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  assert.equal(ok.error, undefined);
  assert.equal(ok.serverUrl, "https://bnt.example.com", "裸 host 应自动补 https://");
  assert.equal(ok.swapped, false);
  // token 里含 :// → 明确报错（不静默去连）
  const bad = normalizeConfig("https://bnt.example.com", "https://bnt.example.com/");
  assert.ok(bad.error && bad.error.includes("token"), `应报 token 格式错（实际 ${bad.error}）`);
  // 地址非法
  assert.ok(normalizeConfig("::::", "abcd1234").error);
  // 空白
  assert.ok(normalizeConfig("", "").error);
});

await test("T29 looksLikeUrl / looksLikeToken 边界", () => {
  assert.equal(looksLikeUrl("https://a.com"), true);
  assert.equal(looksLikeUrl("a.com:8090"), true);
  assert.equal(looksLikeUrl("810132b5abcd1234"), false);
  assert.equal(looksLikeToken("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"), true);
  assert.equal(looksLikeToken("https://a.com"), false);
  assert.equal(looksLikeToken("has space"), false);
  assert.equal(looksLikeToken("short"), false);
});

// ---- 能力块 14 · ①: 全量镜像规划器（"当前状态 → 浏览器书签"）----
const chromeSnap = (nodes: Parameters<typeof chromeSnapshotFromTree>[0]) => chromeSnapshotFromTree(nodes);

await test("T30 planFullMirror: 新建 / 移动 / 改名 / 删除 全覆盖", () => {
  const crdt = snap(
    { b1: { folder: "f1", order: 0, title: "A", url: "https://a.example/" },
      b2: { folder: null, order: 1, title: "B", url: "https://b.example/" } },
    { f1: { name: "开发工具", parent: null, order: 0 }, f2: { name: "新夹", parent: null, order: 1 } }
  );
  // Chrome: c1=b1 在 f1（但标题旧、顺序 5）; cf1=f1（名字旧）; c9 已映射但 CRDT 没有 → 删
  // 注: CRDT 里 parent=null 的文件夹对应 Chrome 里"根(0)的直接子节点";
  // 顶层容器(书签栏/其他/移动设备)本身也是 CRDT 文件夹, 这里简化为 cf1 直接挂在根下
  const chrome = chromeSnap([
    { id: "cf1", parentId: "0", title: "开发", index: 0 },
    { id: "c1", parentId: "cf1", title: "A 旧标题", index: 5, url: "https://a.example/" },
    { id: "c9", parentId: "0", title: "已删", index: 1, url: "https://gone.example/" },
  ]);
  const map = { cf1: "f1", c1: "b1", c9: "b9" };
  const acts = planFullMirror(crdt, chrome, map);
  const kinds = acts.map((a) => a.kind).sort();
  assert.deepEqual(kinds, ["createBookmark", "createFolder", "move", "remove", "rename", "rename"]);
  const create = acts.find((a) => a.kind === "createBookmark")!;
  assert.equal((create as { url: string }).url, "https://b.example/", "新建应带上 URL");
  const move = acts.find((a) => a.kind === "move")!;
  assert.equal((move as { index: number }).index, 0, "顺序不同也要移动");
  assert.ok(acts.some((a) => a.kind === "remove" && (a as { chromeId: string }).chromeId === "c9"));
  // 文件夹层级变化（f2 是新建 → createFolder; 若已映射但 parent 变了 → move）
  const moved = planFullMirror(
    snap({}, { f1: { name: "F", parent: "f2", order: 0 }, f2: { name: "P", parent: null, order: 0 } }),
    chromeSnap([{ id: "cf1", parentId: "0", title: "F", index: 0 }]),
    { cf1: "f1", cf2: "f2" }
  );
  assert.ok(
    moved.some((a) => a.kind === "move" && (a as { chromeId: string }).chromeId === "cf1"),
    `文件夹层级变化应产出 move（实际 ${JSON.stringify(moved)}）`
  );
});

await test("T31 planFullMirror: 完全一致 → 无动作; 同 URL 未映射不重复创建", () => {
  const crdt = snap({ b1: { folder: "f1", order: 0, title: "A", url: "https://a.example/" } }, { f1: { name: "F", parent: null, order: 0 } });
  const same = chromeSnap([
    { id: "cf1", parentId: "0", title: "F", index: 0 },
    { id: "c1", parentId: "cf1", title: "A", index: 0, url: "https://a.example/" },
  ]);
  assert.equal(planFullMirror(crdt, same, { cf1: "f1", c1: "b1" }).length, 0, "一致时不应产动作");
  // b1 未映射, 但同 URL 已在浏览器里（c-other）→ 不重复创建
  const dup = chromeSnap([{ id: "cf1", parentId: "0", title: "F", index: 0 }, { id: "c-other", parentId: "cf1", title: "A", index: 0, url: "https://a.example/" }]);
  const acts = planFullMirror(crdt, dup, { cf1: "f1" });
  assert.equal(acts.filter((a) => a.kind === "createBookmark").length, 0, "同 URL 不应重复创建");
});

// ---- 能力块 14 · ②: 剪枝（用户实测: "用浏览器书签覆盖"后残留一堆空文件夹）----
await test("T32 planFolderPrune: 映射过但浏览器已不存在的文件夹要剪掉（含子孙）", () => {
  const crdtFolders = new Map<string, { parent: string | null }>([
    ["f1", { parent: null }], // 浏览器里还有 → 保留
    ["f2", { parent: null }], // 浏览器里已删 → 剪掉
    ["f2a", { parent: "f2" }], // f2 的子孙 → 一起剪
    ["f3", { parent: null }], // 未映射 → 不动（保守）
  ]);
  const nodeMap = { c1: "f1", c2: "f2", c2a: "f2a" }; // 键是 Chrome id, 值是 CRDT id
  const pruned = planFolderPrune(crdtFolders, nodeMap, new Set(["c1"])).sort();
  assert.deepEqual(pruned, ["f2", "f2a"], `应剪掉 f2 及其子孙 f2a（实际 ${JSON.stringify(pruned)}）`);
  // 回归: 旧实现用 `nodeMap[k]`（k 是 CRDT id）→ 恒 undefined → 永远剪不掉（空文件夹残留）
  assert.ok(pruned.length > 0, "旧实现在这里必然返回空数组");
});

await test("T33 folderSubtree: 展开子树且防环", () => {
  const folders = new Map<string, { parent: string | null }>([
    ["a", { parent: null }],
    ["b", { parent: "a" }],
    ["c", { parent: "b" }],
    ["x", { parent: null }],
  ]);
  assert.deepEqual(folderSubtree(folders, "a").sort(), ["a", "b", "c"]);
  assert.deepEqual(folderSubtree(folders, "x"), ["x"]);
  const cyc = new Map<string, { parent: string | null }>([
    ["p", { parent: "q" }],
    ["q", { parent: "p" }],
  ]);
  assert.deepEqual(folderSubtree(cyc, "p").sort(), ["p", "q"], "异常环数据不得挂死");
});

// ---- 能力块 14 · ② review 阻塞项: 文件夹映射必须建立（否则剪枝/镜像的文件夹分支永远失效）----
await test("T34 treeToRecords: 文件夹记录必须带 chromeId（原先被丢弃）", () => {
  const tree = [
    {
      id: "0",
      title: "",
      children: [
        { id: "1", title: "书签栏", children: [{ id: "10", title: "开发", children: [{ id: "11", title: "A", url: "https://a/" }] }] },
      ],
    },
  ] as unknown as Parameters<typeof treeToRecords>[0];
  const rec = treeToRecords(tree);
  const folderRecs = Object.values(rec.folders);
  assert.equal(folderRecs.length, 2, "应有两个文件夹记录（书签栏 / 开发）");
  assert.deepEqual(
    folderRecs.map((f) => f.chromeId).sort(),
    ["1", "10"],
    "文件夹记录必须保留 chromeId（旧实现没有该字段 → 无法建立映射）"
  );
});

await test("T35 planNodeMapUpdates: 新建与复用的文件夹都要写映射", () => {
  const rec: Parameters<typeof planNodeMapUpdates>[0] = {
    folders: {
      fNew: { name: "新夹", parent: null, order: 0, chromeId: "cNew" },
      fReuse: { name: "旧夹", parent: null, order: 1, chromeId: "cReuse" },
    },
    bookmarks: {
      bNew: { title: "B", url: "https://b/", folder: null, order: 0, chromeId: "cbNew" },
      bReuse: { title: "R", url: "https://r/", folder: null, order: 1, chromeId: "cbReuse" },
    },
  };
  // fixture 按 planImport 的**真实形状**: 它会把新建夹也写进 folderUseId（folderUseId[id] = id）
  const plan: Parameters<typeof planNodeMapUpdates>[1] = {
    folderUseId: { fReuse: "existingFolder", fNew: "fNew" },
    folderCreate: ["fNew"],
    bookmarkUseId: { bReuse: "existingBookmark" },
    bookmarkRefolder: {},
    newFolders: 1,
    newBookmarks: 1,
    reused: 0,
  };
  const updates = planNodeMapUpdates(rec, plan);
  assert.equal(updates.cReuse, "existingFolder", "复用夹要记映射（原实现完全没有）");
  // 复用书签也由本函数产出映射（原先注释写错成"只产出夹映射", 且 fixture 为空掩盖了这一点）
  assert.equal(updates.cbReuse, "existingBookmark", "复用书签要记映射");
  assert.equal(Object.keys(updates).length, 2, "一个复用夹 + 一个复用书签");
  // 新建项（夹与书签）的映射必须由导入循环在 crdtAdd* **成功之后**写
  // （避免"记住了但实际没写"—— folders map 缺失时 crdtAddFolder 返回 false）
  assert.equal(updates.cNew, undefined, "新建夹的映射不能在预写阶段产出（必须显式排除 folderCreate）");
  assert.equal(updates.cbNew, undefined, "新建书签的映射不能在预写阶段产出");
});

await test("T36 planFolderPrune: 未映射夹按（父级+名称）判定 —— 浏览器没有则剪掉", () => {
  const crdtFolders = new Map<string, { parent: string | null; name: string }>([
    ["fKeep", { parent: null, name: "保留" }], // 未映射, 但浏览器里有同名同父 → 保留
    ["fGone", { parent: null, name: "已删" }], // 未映射, 浏览器里没有 → 剪
  ]);
  const chromeKeys = new Set(["root|保留"]);
  assert.deepEqual(planFolderPrune(crdtFolders, {}, new Set(), chromeKeys).sort(), ["fGone"]);
  // 不给名称集 → 保守不剪
  assert.deepEqual(planFolderPrune(crdtFolders, {}, new Set()), []);
});

await test("T37 planFullMirror: 同（父,名称）的夹已存在时不重复创建", () => {
  const crdt = snap({}, { f1: { name: "开发", parent: null, order: 0 } });
  const chrome = chromeSnap([{ id: "cf1", parentId: "0", title: "开发", index: 0 }]);
  // f1 未映射, 但浏览器里已有同父同名的 cf1 → 不应 createFolder
  assert.equal(
    planFullMirror(crdt, chrome, {}).filter((a) => a.kind === "createFolder").length,
    0,
    "未映射但同名同父的夹不应重复创建（否则 force-to-chrome 会造重复夹）"
  );
});

await test("T38 chromeFolderKey: 顶层键必须归一为 root（否则未映射的顶层夹被误剪）", () => {
  // Chrome 顶层容器 parentId 是 "0"; CRDT 顶层夹 parent === null → 必须映射到同一个键
  assert.equal(chromeFolderKey("0", "书签栏"), "root|书签栏");
  assert.equal(chromeFolderKey(null, "书签栏"), "root|书签栏");
  assert.equal(chromeFolderKey("1", "开发"), "1|开发", "非顶层保持原样");

  // 回归: 未映射的顶层夹, 浏览器里有同名顶层夹 → 必须保留
  const crdtFolders = new Map<string, { parent: string | null; name: string }>([
    ["topKeep", { parent: null, name: "书签栏" }],
    ["topGone", { parent: null, name: "不存在" }],
  ]);
  const chromeKeys = new Set([chromeFolderKey("0", "书签栏")]);
  assert.deepEqual(
    planFolderPrune(crdtFolders, {}, new Set(), chromeKeys),
    ["topGone"],
    "浏览器里有同名顶层夹时必须保留（旧实现查 'root|…' 而集合里是 '0|…' → 误剪）"
  );
});

await test("T39 planNodeMapUpdates + 真实 planImport: 新建夹不得预写映射（review 第 5 轮: fixture 掩盖现实）", () => {
  // 用**真实** planImport 产出的 plan（而不是手捏），避免"fixture 与实现形状不符"的老毛病
  const tree = [
    {
      id: "0",
      title: "",
      children: [
        { id: "1", title: "书签栏", children: [{ id: "10", title: "新夹", children: [{ id: "11", title: "A", url: "https://a/" }] }] },
      ],
    },
  ] as unknown as Parameters<typeof treeToRecords>[0];
  const records = treeToRecords(tree);
  const empty = {
    byUrl: new Map<string, string>(),
    byFolderKey: new Map<string, string>(),
    folderOf: new Map<string, string | null>(),
    aliveFolders: new Set<string>(),
  };
  const plan = planImport(records, empty);
  // planImport 的真实行为: 新建夹也会出现在 folderUseId 里（folderUseId[id] = id）
  assert.ok(plan.folderCreate.length > 0, "空索引下应有新建夹");
  assert.ok(
    plan.folderCreate.every((id) => plan.folderUseId[id] === id),
    "planImport 会把新建夹写进 folderUseId（这正是必须显式排除的原因）"
  );
  const updates = planNodeMapUpdates(records, plan);
  assert.equal(
    Object.keys(updates).length,
    0,
    `新建夹不得预写映射（实际 ${JSON.stringify(updates)}）—— 旧实现会在 crdtAddFolder 之前写`
  );

  // 复用夹（浏览器里已有同名同父）→ 必须产出映射
  const reuseExisting = {
    ...empty,
    byFolderKey: new Map([["|书签栏", "existingBar"]]),
    aliveFolders: new Set(["existingBar"]),
  };
  const plan2 = planImport(records, reuseExisting);
  const updates2 = planNodeMapUpdates(records, plan2);
  assert.equal(updates2["1"], "existingBar", "复用的顶层夹要建立映射");
});

// T45 清空重建（能力块 20 · 后端覆盖浏览器）: planFullMirror 在"空快照 + 空映射"下 = 全量创建, 且父先于子
// T46 回写新建（能力块 19 增补）: prev 里没有的 CRDT 节点 → 在 Chrome 侧 create
await test("T46 回写新建: create 排在最前 + 文件夹父先于子 + 同 URL 不重复创建", () => {
  const prev = {
    bookmarks: new Map([["b1", { title: "A", url: "https://a.example/", folder: null, order: 0 }]]),
    folders: new Map(),
  };
  const next = {
    bookmarks: new Map([
      ["b1", { title: "A", url: "https://a.example/", folder: "f2", order: 0 }],
      ["b2", { title: "B", url: "https://b.example/", folder: "f2", order: 1 }],
      ["b3", { title: "浏览器已有同 URL", url: "https://exists.example/", folder: null, order: 2 }],
    ]),
    folders: new Map([
      ["f1", { name: "父", parent: null, order: 0 }],
      ["f2", { name: "子", parent: "f1", order: 0 }],
    ]),
  };
  // b1 必须**有映射**（move 只处理已映射节点）→ 用它验证"移动到本轮新建的夹"
  const acts = planWriteback(prev, next, { c1: "b1" }, new Set(["https://exists.example/"]));
  assert.deepEqual(
    acts.map((a) => a.kind),
    ["createFolder", "createFolder", "createBookmark", "moveBookmark"],
    `create 必须排在最前（否则"移动到本轮新建的夹"会因目标未映射被跳过），实际 ${JSON.stringify(acts.map((a) => a.kind))}`
  );
  assert.equal(acts[0].crdtId, "f1", "父夹先建");
  assert.equal(acts[1].crdtId, "f2", "子夹后建");
  assert.equal(acts[2].crdtId, "b2", "只创建 CRDT 侧新增的书签");
  assert.ok(!acts.some((a) => a.url === "https://exists.example/"), "浏览器已有同 URL → 不重复创建");
});

await test("T45 清空重建: 空快照 + 空映射 → 全量创建（文件夹父先于子）", () => {
  const crdt = {
    bookmarks: new Map([["b1", { title: "B", url: "https://b.example/", folder: "f2", order: 0 }]]),
    folders: new Map([
      ["f1", { name: "父", parent: null, order: 0 }],
      ["f2", { name: "子", parent: "f1", order: 0 }],
    ]),
  };
  const actions = planFullMirror(crdt, chromeSnapshotFromTree([]), {});
  assert.deepEqual(
    actions.map((a) => a.kind),
    ["createFolder", "createFolder", "createBookmark"],
    `清空后应全是创建动作，实际 ${JSON.stringify(actions.map((a) => a.kind))}`
  );
  assert.equal(actions[0].crdtId, "f1", "父夹先建");
  assert.equal(actions[1].crdtId, "f2", "子夹后建（否则父未映射, 子会落到书签栏）");
  assert.equal(actions[2].parentCrdt, "f2", "书签挂到子夹");
});

await test("T41 planFullMirror: 父夹未映射时不得因同名跳过（否则该夹永远进不了 Chrome）", () => {
  // f2 未映射, 父 f1 也未映射; 浏览器里恰好有个顶层同名 "f2"
  const crdt = snap({}, { f1: { name: "父", parent: null, order: 0 }, f2: { name: "同名", parent: "f1", order: 0 } });
  const chrome = chromeSnap([{ id: "cx", parentId: "0", title: "同名", index: 0 }]);
  const acts = planFullMirror(crdt, chrome, {});
  const created = acts.filter((a) => a.kind === "createFolder").map((a) => (a as { crdtId: string }).crdtId);
  assert.ok(created.includes("f2"), `父未映射时 f2 仍应创建（实际创建 ${JSON.stringify(created)}）`);
  // 且新建顺序必须**父先于子**（执行器靠它解析父 Chrome id）
  assert.ok(created.indexOf("f1") < created.indexOf("f2"), `新建夹要父先于子（实际 ${JSON.stringify(created)}）`);
});

// ---- 能力块 15: 事件路径归属（用户实测: 新加书签全落进"未分组"）----
await test("T42 resolveParentFolder: 映射命中 / 祖先上溯 / 兜底 null / 防环", () => {
  // Chrome 树: 1(书签栏) → 10(开发) → 11(前端); 只有 1 与 10 有 CRDT 映射
  const parents: Record<string, string | undefined> = { "10": "1", "11": "10", "1": "0" };
  const mapped: Record<string, string | undefined> = { "1": "crdtBar", "10": "crdtDev" };
  const look = { mapped: (id: string) => mapped[id], parentOf: (id: string) => parents[id] };

  assert.equal(resolveParentFolder("10", look), "crdtDev", "直接映射命中");
  // 关键回归: 新增书签落在"未映射的夹(11)"里 → 上溯到最近有映射的祖先(10), 而不是退化成 null
  assert.equal(resolveParentFolder("11", look), "crdtDev", "未映射时应沿祖先上溯（旧实现退化成未分组）");
  assert.equal(resolveParentFolder(undefined, look), null, "无父 → 未分组兜底");
  assert.equal(resolveParentFolder("99", look), null, "整条祖先链都没映射 → 未分组兜底");
  // 环安全
  const cyc = { mapped: () => undefined, parentOf: (id: string) => (id === "a" ? "b" : "a") };
  assert.equal(resolveParentFolder("a", cyc), null, "异常环不得挂死");
});

await test("T43 待办队列: 去重 / 上限 / 重放顺序（created → moved → removed）", () => {
  const t = (type: PendingEvent["type"], chromeId: string, at: string): PendingEvent => ({ type, chromeId, at });
  let q: PendingEvent[] = [];
  q = enqueuePending(q, t("created", "c1", "2026-10-15T01:00:00Z"));
  q = enqueuePending(q, t("created", "c1", "2026-10-15T02:00:00Z")); // 同 (type,id) → 只留最新
  assert.equal(q.length, 1);
  assert.equal(q[0].at, "2026-10-15T02:00:00Z");
  q = enqueuePending(q, t("removed", "c1", "2026-10-15T03:00:00Z")); // 不同类型 → 各留一条
  assert.equal(q.length, 2);

  // 上限: 丢最旧
  let big: PendingEvent[] = [];
  for (let i = 0; i < PENDING_MAX + 10; i++) big = enqueuePending(big, t("created", `c${i}`, "2026-10-15T00:00:00Z"));
  assert.equal(big.length, PENDING_MAX, "队列必须有上限（避免无限增长）");

  // 重放顺序: created 先（带来映射）, moved 次, removed 最后（避免先删后建）
  const order = planPendingReplay([
    t("removed", "c9", "2026-10-15T01:00:00Z"),
    t("moved", "c1", "2026-10-15T01:00:00Z"),
    t("created", "c5", "2026-10-15T01:00:00Z"),
  ]).map((e) => e.type);
  assert.deepEqual(order, ["created", "moved", "removed"]);

  // 载荷必须完整重建（review 阻塞项: 只传 {id} 会把书签当文件夹、把归属解析成未分组）
  const created: PendingEvent = {
    type: "created",
    chromeId: "c7",
    at: "2026-10-15T01:00:00Z",
    title: "站点",
    url: "https://s/",
    parentId: "c3",
  };
  const node = toCreatedNode(created);
  assert.equal(node.id, "c7");
  assert.equal(node.url, "https://s/", "重建的 created 载荷必须带 url（否则 handler 会当文件夹）");
  assert.equal(node.parentId, "c3", "必须带 parentId（否则归属退化成未分组）");
  assert.equal(toMovedInfo(created).parentId, "c3");
  // removed: isFolder 决定 handler 走 remove 还是 removeTree（靠"有没有 node.url"区分）
  assert.deepEqual(toRemovedInfo({ ...created, type: "removed", isFolder: true }).node, {}, "文件夹: node 不带 url");
  assert.equal(toRemovedInfo({ ...created, type: "removed", isFolder: false }).node.url, "https://s/");
});

// ---- 能力块 15 · E2E 实测 bug: Chrome 事件签名是 (id, info) ----
// 原写法 `(b ?? a)` 取第二个参数 → onRemoved/onMoved 的 id 恒 undefined → 移动/删除从未生效
await test("T44 事件参数解析: (id, info) 双参必须取第一个参数的 id", () => {
  // created: node 自带 id
  assert.deepEqual(parseCreatedArgs("c1", { title: "A", url: "https://a/", parentId: "1" }), {
    id: "c1",
    title: "A",
    url: "https://a/",
    parentId: "1",
  });
  // removed: removeInfo 没有 id（这正是 bug 所在）
  assert.deepEqual(parseRemovedArgs("c2", { parentId: "1", index: 0, node: { url: "https://b/" } }), {
    id: "c2",
    isFolder: false,
    url: "https://b/",
  });
  assert.deepEqual(parseRemovedArgs("c3", { parentId: "1", node: {} }), {
    id: "c3",
    isFolder: true,
  });
  // moved: moveInfo 没有 id
  assert.deepEqual(parseMovedArgs("c4", { parentId: "9", index: 2 }), { id: "c4", parentId: "9" });
  // 兜底: 第二个参数自带 id（旧签名/测试用）
  assert.equal(parseMovedArgs(undefined, { id: "c5", parentId: "9" })?.id, "c5");
  // 两个参数都没有 id → null（不误建节点）
  assert.equal(parseMovedArgs(undefined, { parentId: "9" }), null);
  assert.equal(parseCreatedArgs(undefined, {}), null);
});

console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);

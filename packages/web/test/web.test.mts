#!/usr/bin/env node
// web 纯逻辑测试: 搜索过滤 / URL 归一化（能力块 1）+ 层级树 / 重排 / 取色 / 偏好（能力块 2）
// node 22.18+ type stripping: 直接 import .ts 源
import assert from "node:assert";
import {
  buildGroups,
  domainOf,
  filterBookmarks,
  hueForDomain,
  normalizeUrl,
  parsePrefs,
  DEFAULT_PREFS,
  placementFromPointer,
  pruneEmptyGroups,
  reorderIds,
} from "../src/lib/logic.ts";
import type { Bookmark, Folder } from "../src/lib/logic.ts";
import { DEFAULT_FILTERS, buildQuery, hostOf, rangeForPreset, relTime, validDomain } from "../src/lib/history.ts";
import { parseTagsCsv, readSuggestion } from "../src/lib/logic.ts";
import { kernelIconUrl, planIcon } from "../src/lib/favicon.ts";
import { parseSidebar, parseView } from "../src/lib/logic.ts";
import { BREAKPOINTS, resolveSidebar } from "../src/lib/layout.ts";
import { canReparent, descendantIds, dropZoneOf, reparentSiblings, visibleIds } from "../src/lib/sidebar-tree.ts";
import {
  DEFAULT_ENGINE_ID,
  engineById,
  engineSearchUrl,
  engineShort,
  parseEngine,
} from "../src/lib/engines.ts";
import {
  GAP_DEFAULT,
  GAP_MAX,
  GAP_MIN,
  NAV_ROW_DEFAULT,
  NAV_ROW_MAX,
  NAV_ROW_MIN,
  parseGap,
  parseNavRow,
} from "../src/lib/logic.ts";
import { EMPTY_HITS, SEARCH_LIMIT, groupOf, hitId, hitSubtitle, mergeHits, moveIndex } from "../src/lib/search.ts";
import { computeInsertIndex, nextOrder } from "../src/lib/dnd-math.ts";
import { descendantFolderIds, folderParentOptions, folderSubtreeSize } from "../src/lib/logic.ts";
import { DENSITIES, LIST_MIN_COL, densityParams, listColumns, parseDensity } from "../src/lib/density.ts";

const bm = (over: Partial<Bookmark>): Bookmark => ({
  id: Math.random().toString(36).slice(2),
  title: "",
  url: "",
  folder: null,
  order: 0,
  created: "2026-10-10T00:00:00Z",
  ...over,
});
const fd = (over: Partial<Folder>): Folder => ({
  id: Math.random().toString(36).slice(2),
  name: "",
  parent: null,
  order: 0,
  ...over,
});

let failed = 0;
let total = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  total++;
  try {
    // 必须 await: 否则 async 用例会**立刻打印 PASS**, 断言失败只变成未捕获 rejection → 空断言 ✗
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}: ${(e as Error).message}`);
  }
}

// ---------- 能力块 1 回归 ----------
const list = [
  bm({ title: "GitLab", url: "https://gitlab.com", folder: "dev" }),
  bm({ title: "MDN 文档", url: "https://developer.mozilla.org", folder: "dev" }),
  bm({ title: "知乎", url: "https://zhihu.com" }),
];

await test("T1 搜索: 标题关键词", () => {
  assert.equal(filterBookmarks(list, "gitlab").length, 1);
  assert.equal(filterBookmarks(list, "gitlab")[0].title, "GitLab");
});

await test("T2 搜索: URL 关键词 + 大小写不敏感 + 空 query 不过滤", () => {
  assert.equal(filterBookmarks(list, "zhihu").length, 1);
  assert.equal(filterBookmarks(list, "MDN").length, 1);
  assert.equal(filterBookmarks(list, "").length, 3);
  assert.equal(filterBookmarks(list, "   ").length, 3);
});

await test("T3 URL 归一化", () => {
  assert.equal(normalizeUrl("example.com"), "https://example.com");
  assert.equal(normalizeUrl("http://x.io/a"), "http://x.io/a");
  assert.equal(normalizeUrl("  b.io  "), "https://b.io");
  assert.equal(normalizeUrl(""), "");
});

// ---------- 能力块 2 ----------
const fDev = fd({ id: "dev", name: "Dev", order: 0 });
const fNest = fd({ id: "nest", name: "Nested", parent: "dev", order: 0 });
const fEmpty = fd({ id: "empty", name: "空夹", order: 1 });

await test("T4 层级树: 父子关系 / depth / 归属", () => {
  const t = buildGroups(
    [fDev, fNest],
    [bm({ id: "a", title: "A", folder: "dev" }), bm({ id: "b", title: "B", folder: "nest" }), bm({ id: "c", title: "C" })]
  );
  assert.equal(t.id, null, "根组 id 为 null");
  assert.equal(t.bookmarks.map((b) => b.id).join(","), "c", "根组只放未分组");
  const dev = t.children.find((x) => x.id === "dev")!;
  assert.equal(dev.depth, 1);
  assert.equal(dev.bookmarks.length, 1);
  const nest = dev.children.find((x) => x.id === "nest")!;
  assert.equal(nest.depth, 2, "嵌套深度递增");
  assert.equal(nest.bookmarks[0].id, "b");
  assert.equal(t.total, 3, "total 含子树");
});

await test("T5 层级树: 孤儿挂根 + 环不死循环且可见", () => {
  const orphan = fd({ id: "o", name: "孤儿", parent: "不存在" });
  const c1 = fd({ id: "c1", name: "环1", parent: "c2" });
  const c2 = fd({ id: "c2", name: "环2", parent: "c1" });
  const t = buildGroups([orphan, c1, c2], []);
  const ids = t.children.map((x) => x.id);
  assert.ok(ids.includes("o"), "孤儿应挂到根");
  assert.ok(ids.includes("c1") || ids.includes("c2"), "环中的文件夹必须可见（不能凭空消失）");
});

await test("T6 层级树: 书签指向未知文件夹 → 归到根", () => {
  const t = buildGroups([fDev], [bm({ id: "x", title: "X", folder: "ghost" })]);
  assert.equal(t.bookmarks[0].id, "x");
  assert.equal(t.total, 1);
});

await test("T7 pruneEmptyGroups: 搜索态隐藏空分组", () => {
  const t = buildGroups([fDev, fEmpty], [bm({ id: "a", title: "A", folder: "dev" })]);
  const pruned = pruneEmptyGroups(t);
  assert.equal(pruned.children.length, 1, "空夹被隐藏");
  assert.equal(pruned.children[0].id, "dev");
});

await test("T8 reorderIds: 前后插入 / 无变化 / 非法目标", () => {
  const ids = ["a", "b", "c"];
  assert.deepEqual(reorderIds(ids, "c", "a", "before"), ["c", "a", "b"]);
  assert.deepEqual(reorderIds(ids, "a", "b", "after"), ["b", "a", "c"]);
  assert.equal(reorderIds(ids, "a", "a", "before"), null, "原地 = 无变化");
  assert.equal(reorderIds(ids, "a", "zz", "before"), null, "目标不存在");
  // fromId 不在序列中 = 插入（跨文件夹拖拽先插入再落库）
  assert.deepEqual(reorderIds(["a", "b"], "new", "b", "before"), ["a", "new", "b"]);
});

await test("T9 placementFromPointer: 中线上下", () => {
  assert.equal(placementFromPointer(100, 40, 110), "before");
  assert.equal(placementFromPointer(100, 40, 130), "after");
});

await test("T10 域名与取色: 去 www / 稳定 / 范围", () => {
  assert.equal(domainOf("https://www.github.com/a/b"), "github.com");
  assert.equal(domainOf("not a url"), "");
  const h1 = hueForDomain("github.com");
  assert.equal(h1, hueForDomain("github.com"), "同域名取色稳定");
  assert.ok(h1 >= 0 && h1 < 360);
  assert.notEqual(hueForDomain("github.com"), hueForDomain("zhihu.com"));
});

await test("T11 parsePrefs: 默认值 + 非法值回退", () => {
  assert.deepEqual(parsePrefs(undefined), {
    view: "list",
    sidebar: "auto",
    density: "cozy",
    searchEngine: "google",
    gapX: 14,
    gapY: 14,
    navRow: 34,
  });
  assert.deepEqual(
    parsePrefs({
      view: "grid",
      sidebar: "pinned",
      density: "compact",
      searchEngine: "bing",
    }),
    {
      view: "grid",
      sidebar: "pinned",
      density: "compact",
      searchEngine: "bing",
      gapX: 14,
      gapY: 14,
      navRow: 34,
    }
  );
  assert.deepEqual(
    // 能力块 10 · ①: 暗色/壁纸已移除;非法值一律回落默认
    parsePrefs({ view: "hacker", sidebar: "x", density: "huge", gapX: "abc", gapY: 9999, navRow: 999 }),
    {
      view: "list",
      sidebar: "auto",
      density: "cozy",
      searchEngine: "google",
      gapX: 14,
      gapY: 40,
      navRow: 48,
    }
  );
});

// ---------- 能力块 3: 历史筛选 ----------
const NOW = new Date(2026, 9, 10, 15, 30, 0); // 本地 2026-10-10 15:30

await test("T12 rangeForPreset: 本地日界与区间", () => {
  assert.deepEqual(rangeForPreset("all", NOW), {});
  const today = rangeForPreset("today", NOW);
  const d0 = new Date(today.from!);
  assert.equal(d0.getFullYear(), 2026);
  assert.equal(d0.getMonth(), 9);
  assert.equal(d0.getDate(), 10);
  assert.equal(d0.getHours(), 0, "从本地 00:00 起算");
  assert.equal(new Date(rangeForPreset("7d", NOW).from!).getDate(), 4, "近 7 天含今天");
  assert.equal(new Date(rangeForPreset("30d", NOW).from!).getDate(), 11, "跨月回退到 9/11");
});

await test("T13 buildQuery: 跳过空值 / 自定义优先 / limit 封顶", () => {
  const q1 = buildQuery({ ...DEFAULT_FILTERS, keyword: "  github ", domain: "" }, 300, NOW);
  assert.ok(q1.includes("keyword=github"), "关键词去空白");
  assert.ok(!q1.includes("domain="), "空域名不带参数");
  assert.ok(q1.includes("limit=300"));
  const q2 = buildQuery({ ...DEFAULT_FILTERS, fromDate: "2026-10-01", toDate: "2026-10-02" }, 2000, NOW);
  assert.ok(q2.includes("limit=1000"), "limit 封顶 1000");
  const from = new Date(decodeURIComponent(q2.match(/from=([^&]+)/)![1]));
  assert.equal(from.getDate(), 1);
  assert.equal(from.getHours(), 0);
});

await test("T14 validDomain: 拒非法, 收合法", () => {
  assert.ok(validDomain("example.com"));
  assert.ok(validDomain("Sub.Example.COM"));
  assert.ok(validDomain("my-site.co.uk"));
  assert.ok(!validDomain("example"));
  assert.ok(!validDomain("http://example.com"));
  assert.ok(!validDomain("example.com/path"));
  assert.ok(!validDomain("example..com"));
  assert.ok(!validDomain(""));
});

await test("T15 relTime / hostOf", () => {
  assert.equal(relTime(new Date(NOW.getTime() - 30_000).toISOString(), NOW), "刚刚");
  assert.equal(relTime(new Date(NOW.getTime() - 5 * 60_000).toISOString(), NOW), "5 分钟前");
  assert.equal(relTime(new Date(NOW.getTime() - 3 * 3600_000).toISOString(), NOW), "3 小时前");
  assert.equal(relTime(new Date(NOW.getTime() - 2 * 86400_000).toISOString(), NOW), "2 天前");
  assert.equal(hostOf("https://app.example:8443/p"), "app.example:8443", "host 含端口");
  assert.equal(hostOf("nope"), "");
});

// ---------- 能力块 5: 建议解析 ----------

await test("T16 parseTagsCsv: 逗号分隔清洗", () => {
  assert.deepEqual(parseTagsCsv("代码, 工具 ,"), ["代码", "工具"]);
  assert.deepEqual(parseTagsCsv(""), []);
  assert.deepEqual(parseTagsCsv(undefined), []);
  assert.deepEqual(parseTagsCsv(123), []);
});

await test("T17 readSuggestion: 有夹/仅标签/空 → undefined", () => {
  assert.deepEqual(readSuggestion({ suggestedFolder: "开发", tags: "代码,工具" }), {
    folder: "开发",
    tags: ["代码", "工具"],
  });
  assert.deepEqual(readSuggestion({ tags: "仅标签" }), { folder: undefined, tags: ["仅标签"] });
  assert.equal(readSuggestion({ suggestedFolder: "   ", tags: "" }), undefined, "空白不算建议");
  assert.equal(readSuggestion(undefined), undefined);
  assert.equal(readSuggestion({ suggestedFolder: 42, tags: ["x"] }), undefined, "类型不对 → 无建议");
});

// ---------- 能力块 6: 图标来源 ----------

await test("T18 planIcon: 有内核基址 → kernel + server 候选", () => {
  const plan = planIcon("https://a.example/x?y=1", "chrome-extension://abc/_favicon/", 32);
  assert.ok(plan.kernel?.startsWith("chrome-extension://abc/_favicon/"), "内核候选存在");
  assert.ok(plan.kernel?.includes("size=32"));
  assert.ok(plan.kernel?.includes("pageUrl=https%3A%2F%2Fa.example%2Fx%3Fy%3D1"), "pageUrl 需正确编码");
  assert.equal(plan.server, `/api/favicon?url=${encodeURIComponent("https://a.example/x?y=1")}`);
});

await test("T19 planIcon: 无基址（移动端）→ 只有服务端候选", () => {
  const plan = planIcon("https://a.example/", null);
  assert.equal(plan.kernel, null);
  assert.ok(plan.server.startsWith("/api/favicon?url="));
});

await test("T20 kernelIconUrl: 保留基址既有 query 并覆盖同名参数", () => {
  const u = kernelIconUrl("chrome-extension://abc/_favicon/?size=16", "https://a.example/", 64);
  assert.ok(u.includes("size=64"), "size 应被覆盖为 64");
  assert.ok(u.includes("pageUrl="));
  assert.equal(new URL(u).searchParams.getAll("size").length, 1, "不应重复 size");
});

// ---------- 能力块 7: 外壳与导览 ----------

await test("T21 parseView/parseSidebar: 新值可用, 非法值回落", () => {
  assert.equal(parseView("icons"), "icons");
  assert.equal(parseView("grid"), "grid");
  assert.equal(parseView("cards"), "list");
  assert.equal(parseSidebar("pinned"), "pinned");
  assert.equal(parseSidebar("hidden"), "hidden");
  assert.equal(parseSidebar("sticky"), "auto");
});

await test("T22 resolveSidebar: 三模式 × 四档宽度", () => {
  const W = [375, 800, BREAKPOINTS.overlay + 1, BREAKPOINTS.rail, 1600];
  // auto: 宽→expanded; 中→rail; 窄→overlay
  assert.equal(resolveSidebar("auto", 1600), "expanded");
  assert.equal(resolveSidebar("auto", BREAKPOINTS.rail), "expanded");
  assert.equal(resolveSidebar("auto", 1024), "rail");
  assert.equal(resolveSidebar("auto", 800), "rail");
  assert.equal(resolveSidebar("auto", 375), "overlay");
  // pinned: 桌面恒展开, 手机只能浮层
  assert.equal(resolveSidebar("pinned", 1600), "expanded");
  assert.equal(resolveSidebar("pinned", 800), "expanded");
  assert.equal(resolveSidebar("pinned", 375), "overlay");
  // hidden: 一律浮层
  for (const w of W) assert.equal(resolveSidebar("hidden", w), "overlay");
});

await test("T23 侧栏树: 防环 / 三区落点 / 改父+同层插入 / 折叠可见性", () => {
  const F = (id: string, name: string, parent: string | null, order: number) => ({ id, name, parent, order });
  const folders = [
    F("dev", "开发工具", null, 1),
    F("nest", "前端", "dev", 1),
    F("nest2", "状态", "nest", 1),
    F("fun", "娱乐", null, 2),
    F("bar", "书签栏", null, 3),
  ];

  // 子孙集合（不含自身）
  assert.deepEqual([...descendantIds(folders, "dev")].sort(), ["nest", "nest2"]);

  // 防环: 自身 / 直系子孙 / 间接子孙 都不允许
  assert.equal(canReparent(folders, "dev", "dev"), false);
  assert.equal(canReparent(folders, "dev", "nest"), false);
  assert.equal(canReparent(folders, "dev", "nest2"), false);
  assert.equal(canReparent(folders, "dev", "fun"), true);
  assert.equal(canReparent(folders, "nest", null), true);

  // 落点三区（行高 40）: 上 1/4 = before, 中 1/2 = inside, 下 1/4 = after
  assert.equal(dropZoneOf(100, 100, 40), "before");
  assert.equal(dropZoneOf(109, 100, 40), "before");
  assert.equal(dropZoneOf(110, 100, 40), "inside");
  assert.equal(dropZoneOf(129, 100, 40), "inside");
  assert.equal(dropZoneOf(131, 100, 40), "after");
  assert.equal(dropZoneOf(139, 100, 40), "after");

  // 放入某夹: 父级变为该夹, 追加到该夹末尾
  assert.deepEqual(reparentSiblings(folders, "fun", "dev", "inside"), {
    parent: "dev",
    orderedIds: ["nest", "fun"],
  });
  // 同层插入: 拖到 bar 之前 → 留在顶层, 插到 bar 前
  assert.deepEqual(reparentSiblings(folders, "fun", "bar", "before"), {
    parent: null,
    orderedIds: ["dev", "fun", "bar"],
  });
  // 拖到顶层夹之后
  assert.deepEqual(reparentSiblings(folders, "dev", "bar", "after"), {
    parent: null,
    orderedIds: ["fun", "bar", "dev"],
  });
  // 跨层: 把 nest 拖到 bar 之后 → 父变 null 且顺序正确
  assert.deepEqual(reparentSiblings(folders, "nest", "bar", "after"), {
    parent: null,
    orderedIds: ["dev", "fun", "bar", "nest"],
  });
  // 拖到「未分组」区（target=null）→ 提升到顶层并追加到末尾
  assert.deepEqual(reparentSiblings(folders, "nest2", null, "inside"), {
    parent: null,
    orderedIds: ["dev", "fun", "bar", "nest2"],
  });
  // 非法（拖到自身子孙）→ null, 绝不产生环
  assert.equal(reparentSiblings(folders, "dev", "nest", "inside"), null);
  assert.equal(reparentSiblings(folders, "dev", "dev", "before"), null);
  assert.equal(reparentSiblings(folders, "ghost", "fun", "inside"), null);

  // 折叠可见性: 折叠 dev 后其子孙不可见
  const tree = buildGroups(folders as never, []);
  assert.deepEqual(visibleIds([tree] as never, new Set()), [null, "dev", "nest", "nest2", "fun", "bar"]);
  assert.deepEqual(visibleIds([tree] as never, new Set(["dev"])), [null, "dev", "fun", "bar"]);
  assert.deepEqual(visibleIds([tree] as never, new Set(["dev", "nest"])), [null, "dev", "fun", "bar"]);
});

await test("T24 mergeHits: 分组/计数/上限/文件夹名回填", () => {
  const folders = [fd({ id: "dev", name: "开发" })];
  const bms = Array.from({ length: 10 }, (_, i) =>
    bm({ id: `g${i}`, title: `GitHub ${i}`, url: `https://git${i}.example`, folder: "dev", order: i })
  );
  const hist = [
    { url: "https://github.com/trending", title: "Trending", visitedAt: "2026-10-10T10:00:00Z" },
    { url: "https://other.example/", title: "Other", visitedAt: "2026-10-10T09:00:00Z" },
  ];
  const m = mergeHits(bms, folders, hist, 42, "git");
  assert.equal(m.bookmarkTotal, 10, "书签命中总数（未截断）");
  assert.equal(m.bookmarks.length, SEARCH_LIMIT, "面板内书签截断到上限");
  assert.equal(m.historyTotal, 42, "历史总数来自服务端");
  assert.equal(m.history.length, 2);
  assert.equal(m.flat.length, SEARCH_LIMIT + 2, "扁平顺序 = 书签 → 历史");
  assert.equal(m.flat[0].kind, "bookmark");
  assert.equal(m.flat[m.flat.length - 1].kind, "history");
  assert.equal(m.bookmarks[0].folderName, "开发", "文件夹名回填");
});

await test("T25 mergeHits: 无命中 → 空态", () => {
  const m = mergeHits([bm({ title: "A", url: "https://a.example" })], [], [], 0, "zzz");
  assert.equal(m.flat.length, 0);
  assert.equal(m.bookmarkTotal, 0);
});

await test("T26 moveIndex: 跨组循环与边界", () => {
  assert.equal(moveIndex(-1, 1, 5), 0, "未选中时向下 → 首项");
  assert.equal(moveIndex(-1, -1, 5), 4, "未选中时向上 → 末项");
  assert.equal(moveIndex(4, 1, 5), 0, "末尾向下回绕");
  assert.equal(moveIndex(0, -1, 5), 4, "首项向上回绕");
  assert.equal(moveIndex(2, 1, 5), 3);
  assert.equal(moveIndex(0, 1, 0), -1, "无项 → -1");
});

await test("T27 groupOf / hitId / hitSubtitle", () => {
  assert.deepEqual(groupOf(0, 3), { group: "bookmarks", indexInGroup: 0 });
  assert.deepEqual(groupOf(2, 3), { group: "bookmarks", indexInGroup: 2 });
  assert.deepEqual(groupOf(3, 3), { group: "history", indexInGroup: 0 }, "跨组边界");
  assert.equal(groupOf(-1, 3), null);
  assert.equal(hitId({ kind: "bookmark", id: "x", title: "", url: "", folderName: null }, 2), "search-hit-bookmark-2");
  assert.equal(
    hitSubtitle({ kind: "bookmark", id: "x", title: "", url: "https://a.example/x", folderName: "开发" }),
    "a.example · 开发"
  );
  assert.equal(hitSubtitle({ kind: "history", url: "https://b.example/", title: "", visitedAt: "" }), "b.example");
});

// ---------- 能力块 7 · I3: 智能拖拽落点 ----------
// 3 列网格: 每格 100x80, 间距 0; 行 1: a b c; 行 2: d e f
const grid = [
  { id: "a", x: 0, y: 0, w: 100, h: 80 },
  { id: "b", x: 100, y: 0, w: 100, h: 80 },
  { id: "c", x: 200, y: 0, w: 100, h: 80 },
  { id: "d", x: 0, y: 80, w: 100, h: 80 },
  { id: "e", x: 100, y: 80, w: 100, h: 80 },
  { id: "f", x: 200, y: 80, w: 100, h: 80 },
];

await test("T28 computeInsertIndex: 同排比左右 / 跨排比上下", () => {
  // b 的左半边 → 插到 b 前
  assert.equal(computeInsertIndex(grid, 120, 40), 1);
  // b 的右半边 → 插到 b 后
  assert.equal(computeInsertIndex(grid, 180, 40), 2);
  // 多列场景一律按左右（同排有 3 张卡）: e 的左半边 → 插到 e 前; 右半边 → 后
  assert.equal(computeInsertIndex(grid, 120, 85), 4);
  assert.equal(computeInsertIndex(grid, 190, 85), 5);
  // a 的左半边 → 0（最前）
  assert.equal(computeInsertIndex(grid, 10, 40), 0);
  // f 的右下 → 末尾
  assert.equal(computeInsertIndex(grid, 290, 150), 6);
});

await test("T29 computeInsertIndex: 单列（列表）按上下判定", () => {
  // 单列宽行: 1000x60, 纵向排列
  const list = [
    { id: "a", x: 0, y: 0, w: 1000, h: 60 },
    { id: "b", x: 0, y: 60, w: 1000, h: 60 },
    { id: "c", x: 0, y: 120, w: 1000, h: 60 },
  ];
  assert.equal(computeInsertIndex(list, 500, 20), 0, "b 上半 → 插到 b 前");
  assert.equal(computeInsertIndex(list, 500, 50), 1, "b 下半 → 插到 b 后");
  assert.equal(computeInsertIndex(list, 500, 170), 3, "c 下半 → 末尾");
});

await test("T29b computeInsertIndex: 未命中取最近 / 空数组", () => {
  // 指针在网格外(左上方) → 最近的是 a → a 左半边 → 0
  assert.equal(computeInsertIndex(grid, -50, -50), 0);
  // 指针在网格下方空白 → 最近的是 d/e/f 行; 取最近中心 → e 附近
  const idx = computeInsertIndex(grid, 150, 400);
  assert.ok(idx >= 5 && idx <= 6, `期望落在末排, 实际 ${idx}`);
  assert.equal(computeInsertIndex([], 10, 10), 0);
});

await test("T30 nextOrder: 前进 / 后退 / 原地 / 边界", () => {
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual(nextOrder(ids, 0, 2), ["b", "a", "c", "d"], "a 下移到 b 之后");
  assert.deepEqual(nextOrder(ids, 3, 1), ["a", "d", "b", "c"], "d 上移到 a 之后");
  assert.equal(nextOrder(ids, 1, 1), ids, "原地 → 原数组引用");
  assert.equal(nextOrder(ids, 1, 2), ids, "原地（插到自己后面）→ 不变");
  assert.deepEqual(nextOrder(ids, 0, 100), ["b", "c", "d", "a"], "越界 → 末尾");
  assert.deepEqual(nextOrder(ids, 3, -5), ["d", "a", "b", "c"], "越界负值 → 开头");
  assert.equal(nextOrder(ids, 9, 1), ids, "非法 fromIndex → 原样");
});

// ---------- 能力块 8: 密度 ----------

await test("T31 parseDensity: 合法值 / 非法值回落 cozy", () => {
  assert.equal(parseDensity("compact"), "compact");
  assert.equal(parseDensity("comfortable"), "comfortable");
  assert.equal(parseDensity("huge"), "cozy");
  assert.equal(parseDensity(undefined), "cozy");
  assert.equal(parseDensity(42), "cozy");
});

await test("T32 densityParams: 三档尺寸严格单调（紧凑 < 标准 < 宽松）", () => {
  const ps = DENSITIES.map(densityParams);
  for (const k of ["gap", "cardMin", "rowH", "pad", "iconCard", "iconGrid", "titlePx"]) {
    const vals = ps.map((p) => p[k]);
    assert.ok(vals[0] < vals[1] && vals[1] < vals[2], `${k} 应单调递增, 实际 ${JSON.stringify(vals)}`);
  }
  // 相对现状的改进：标准档行高 < 原实现 106px 的一半以上
  assert.ok(densityParams("cozy").rowH <= 68, `cozy 行高应 ≤68, 实际 ${densityParams("cozy").rowH}`);
});

await test("T33 listColumns: 宽屏两列 / 窄屏单列", () => {
  assert.equal(listColumns(700), 1, "窄屏单列");
  assert.equal(listColumns(LIST_MIN_COL * 2 - 1), 1, "刚好不够 → 单列");
  assert.equal(listColumns(889), 2, "889px 已可容纳 420+420+gap → 两列");
  assert.equal(listColumns(1121), 2, "1440 宽下两列（提升利用率）");
  assert.equal(listColumns(1601), 2);
});


await test("T34 引擎: 非法值回落默认 / URL 模板注入与编码", () => {
  assert.equal(parseEngine("bing"), "bing");
  assert.equal(parseEngine("nope"), DEFAULT_ENGINE_ID, "非法 id 回落默认");
  assert.equal(parseEngine(undefined), DEFAULT_ENGINE_ID);
  assert.equal(parseEngine(42), DEFAULT_ENGINE_ID, "非字符串回落默认");
  assert.equal(engineById("nope").id, DEFAULT_ENGINE_ID, "读取兜底到首个引擎");

  const bing = engineById("bing");
  assert.equal(
    engineSearchUrl(bing, "hello world"),
    "https://www.bing.com/search?q=hello%20world",
    "查询串必须编码（空格）"
  );
  // 编码红线: & # ? 等不能破坏 URL 结构
  assert.equal(engineSearchUrl(bing, "a&b#c"), "https://www.bing.com/search?q=a%26b%23c");
  assert.ok(engineSearchUrl(engineById("baidu"), "中文").includes("%E4%B8%AD%E6%96%87"), "中文按 UTF-8 编码");
  assert.equal(engineSearchUrl(engineById("google"), "  trim  "), "https://www.google.com/search?q=trim", "首尾空白剔除");
  assert.deepEqual(
    ["google", "bing", "baidu", "ddg", "yandex"].map((id) => engineShort(engineById(id))),
    ["G", "B", "百", "D", "Я"]
  );
});

await test("T35 mergeHits + 引擎行: 追加到面板末尾且可被 Enter 选中", () => {
  const folders = [fd({ id: "dev", name: "开发" })];
  const bms = [bm({ id: "b1", title: "GitHub", url: "https://github.com", folder: "dev", order: 0 })];
  const hist = [{ url: "https://github.com/x", title: "X", visitedAt: "2026-10-10T10:00:00Z" }];
  const bing = engineById("bing");

  // 不传引擎 → 行为不变（旧调用兼容）
  const plain = mergeHits(bms, folders, hist, 1, "git");
  assert.equal(plain.engine, null);
  assert.equal(plain.flat.length, 2);
  assert.equal(plain.flat[1].kind, "history");

  const m = mergeHits(bms, folders, hist, 1, "git", SEARCH_LIMIT, bing);
  // 能力块 16: 引擎搜索**不再计入 flat**（否则 ↑↓ 会停在它上面）
  assert.equal(m.flat.length, 2, "flat 只含真实候选（书签 + 历史）");
  assert.ok(!m.flat.some((h) => h.kind === "engine"), "flat 里不得有引擎行");
  assert.ok(m.engine, "engine 字段仍保留（回车默认要用它）");
  const row = m.engine!;
  assert.equal(row.engineName, "Bing");
  assert.equal(row.query, "git");
  assert.equal(row.url, "https://www.bing.com/search?q=git");
  assert.equal(hitSubtitle(row), "在 Bing 中搜索");
  // 三组归属（引擎行不能被算进历史组）
  assert.deepEqual(groupOf(0, 1, 1), { group: "bookmarks", indexInGroup: 0 });
  assert.deepEqual(groupOf(1, 1, 1), { group: "history", indexInGroup: 0 });
  assert.deepEqual(groupOf(2, 1, 1), { group: "engine", indexInGroup: 0 });
  assert.deepEqual(groupOf(1, 1), { group: "history", indexInGroup: 0 }, "不传历史数 → 旧语义");
  // 空查询不产生引擎行（避免"用引擎搜索空串"）
  assert.equal(mergeHits(bms, folders, hist, 1, "   ", SEARCH_LIMIT, bing).engine, null);

  // 无命中时: flat 为空, 但 engine 仍在 → 回车照样能搜（能力块 16 · B）
  const none = mergeHits([], [], [], 0, "zzz", SEARCH_LIMIT, bing);
  assert.equal(none.flat.length, 0, "无命中时 flat 为空");
  assert.ok(none.engine && none.engine.url.includes("bing.com"), "无命中时仍要有引擎目标");
  assert.equal(EMPTY_HITS.engine, null, "空态常量不含引擎行");
});

await test("T35b parseGap: 范围钳制与非法值回落", () => {
  assert.equal(parseGap(undefined), GAP_DEFAULT, "缺失 → 默认");
  assert.equal(parseGap("abc"), GAP_DEFAULT, "非数字 → 默认");
  assert.equal(parseGap(NaN), GAP_DEFAULT);
  assert.equal(parseGap(0), GAP_MIN, "低于下限 → 钳到下限");
  assert.equal(parseGap(-100), GAP_MIN);
  assert.equal(parseGap(9999), GAP_MAX, "高于上限 → 钳到上限");
  assert.equal(parseGap(13.6), 14, "取整");
  assert.equal(parseGap("18"), 18, "字符串数字可解析");
  assert.equal(parseGap(24), 24);
});

await test("T35c parseNavRow: 导航行高范围钳制（默认 34）", () => {
  assert.equal(parseNavRow(undefined), NAV_ROW_DEFAULT);
  assert.equal(parseNavRow("abc"), NAV_ROW_DEFAULT);
  assert.equal(parseNavRow(0), NAV_ROW_MIN, "低于下限 → 钳到下限");
  assert.equal(parseNavRow(999), NAV_ROW_MAX, "高于上限 → 钳到上限");
  assert.equal(parseNavRow(40), 40);
  assert.equal(parseNavRow("44"), 44);
  assert.equal(parseNavRow(35.6), 36, "取整");
});

await test("T36 parsePrefs: searchEngine 走白名单回落", () => {
  assert.equal(parsePrefs({ searchEngine: "ddg" }).searchEngine, "ddg");
  assert.equal(parsePrefs({ searchEngine: "hack" }).searchEngine, DEFAULT_ENGINE_ID);
  assert.equal(parsePrefs({}).searchEngine, DEFAULT_ENGINE_ID, "缺失 → 默认");
  assert.equal(DEFAULT_PREFS.searchEngine, DEFAULT_ENGINE_ID);
});

// T37 内核"取不到"判定（能力块 18 · ①）: _favicon/ 对未访问过的站点返回 200 + 默认占位图,
// 不触发 onError ✗ → 用 .invalid 取基准图逐字节比。基准**按 size 分档**（实测 350B/601B）。
await test("T37 内核取不到: 按 size 校准 + 按 URL 缓存 + 取字节失败不缓存", async () => {
  const { kernelIconMissing, sameBytes } = await import("../src/lib/favicon.ts");
  const mk = (n: number, fill: number) => new Uint8Array(n).fill(fill).buffer;
  const calls: string[] = [];
  let failNext = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: string) => {
    calls.push(String(u));
    if (failNext) {
      failNext = false;
      throw new Error("network");
    }
    const size = Number(new URL(String(u)).searchParams.get("size"));
    const placeholder = size >= 32 ? mk(601, 7) : mk(350, 3); // 实测分档: ≤28 → 350B, ≥32 → 601B
    const same = String(u).includes("probe.invalid") || String(u).includes("same.example");
    return { ok: true, arrayBuffer: async () => (same ? placeholder : mk(1301, 9)) } as unknown as Response;
  }) as typeof fetch;
  try {
    const base = "chrome-extension://abc/_favicon/";
    assert.equal(await kernelIconMissing(base, "https://same.example/", 32), true, "size=32 与基准同字节 → 取不到");
    // 真实使用还有 20（HistoryView/UnifiedSearch）与 28/40/48（密度档）→ 必须各按 size 校准
    assert.equal(
      await kernelIconMissing(base, "https://same.example/", 20),
      true,
      "size=20 也要判出取不到（用全局单例基准这里会静默失效）",
    );
    assert.equal(await kernelIconMissing(base, "https://other.example/", 20), false, "字节不同 → 有图标");
    const n = calls.length;
    assert.equal(await kernelIconMissing(base, "https://same.example/", 20), true, "缓存命中");
    assert.equal(calls.length, n, `缓存后不应再请求（实际 ${JSON.stringify(calls)}）`);
    assert.equal(calls.filter((c) => c.includes("probe.invalid") && c.includes("size=20")).length, 1, "size=20 基准只取一次");
    assert.equal(calls.filter((c) => c.includes("probe.invalid") && c.includes("size=32")).length, 1, "size=32 基准只取一次");
    // 瞬时故障: 不判 missing, 且不写缓存（否则该 URL 整个会话都拿不到服务端图标）
    failNext = true;
    assert.equal(await kernelIconMissing(base, "https://transient.example/", 32), false, "取字节失败 → 不判 missing");
    assert.equal(await kernelIconMissing(base, "https://transient.example/", 32), false, "第二次仍不判");
    assert.equal(calls.filter((c) => c.includes("transient.example")).length, 2, "失败结果不应被缓存（要能重试）");
    assert.ok(sameBytes(mk(4, 1), mk(4, 1)) && !sameBytes(mk(4, 1), mk(3, 1)), "sameBytes 逐字节比较");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// T38 文件夹编辑的纯逻辑（能力块 19）: 归属下拉防环 + 级联删除影响面
await test("T38 folderParentOptions 排除自身与子孙（防环）, folderSubtreeSize 数出子树影响面", () => {
  // a > b > c, a > d, 另有无关的 z
  const fs = [fd({ id: "a", name: "A" }), fd({ id: "b", name: "B", parent: "a" }), fd({ id: "c", name: "C", parent: "b" }), fd({ id: "d", name: "D", parent: "a" }), fd({ id: "z", name: "Z" })];
  assert.deepEqual([...descendantFolderIds(fs, "a")].sort(), ["a", "b", "c", "d"], "自身 + 全部子孙");
  assert.deepEqual([...descendantFolderIds(fs, "c")], ["c"], "叶子只有自己");
  assert.deepEqual(folderParentOptions(fs, "a").map((f) => f.id), ["z"], "不能把 A 挂到自己的子孙下");
  assert.deepEqual(folderParentOptions(fs, "b").map((f) => f.id), ["a", "d", "z"], "B 不能挂到 c");
  const bs = [bm({ folder: "a" }), bm({ folder: "b" }), bm({ folder: "c" }), bm({ folder: "z" }), bm({ folder: null })];
  assert.deepEqual(folderSubtreeSize(fs, bs, "a"), { folders: 3, bookmarks: 3 }, "级联: A 子树 3 个文件夹 / 3 条书签");
  assert.deepEqual(folderSubtreeSize(fs, bs, "c"), { folders: 0, bookmarks: 1 }, "叶子文件夹只影响自己那条");
  assert.deepEqual(folderSubtreeSize(fs, bs, "z"), { folders: 0, bookmarks: 1 }, "未分组书签(folder=null)不计入任何文件夹");
});

console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);

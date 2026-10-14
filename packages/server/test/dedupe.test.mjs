#!/usr/bin/env node
// 去重语义测试（重复导入事故的清理路径）: 纯函数 + 内存 Y.Doc, 无需起服务
import assert from "node:assert";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
// 用 CJS 侧 Yjs（与编译产物同一实例, 否则 instanceof 跨实例失效）
const require_ = createRequire(import.meta.url);
const Y = require_("yjs");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const OUT = path.join(PKG, "dist/dedupe.test.cjs");

execSync(
  `${path.join(PKG, "node_modules/.bin/esbuild")} src/dedupe.ts --bundle --platform=node --format=cjs --external:yjs --outfile=${OUT}`,
  { cwd: PKG, stdio: "inherit" }
);
const { dedupeBookmarks } = require_(OUT);

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}: ${e.message}`);
  }
}

// 构造: 3 份同 URL（一份 YMap 新形状 + 两份旧对象）+ 两份同名文件夹 + 一个 orphan 归属
function makeDoc() {
  const doc = new Y.Doc();
  const root = doc.getMap("");
  const bm = new Y.Map();
  const fm = new Y.Map();
  root.set("bookmarks", bm);
  root.set("folders", fm);

  const ynode = (title, url, folder, created) => {
    const n = new Y.Map();
    n.set("title", title);
    n.set("url", url);
    n.set("folder", folder);
    n.set("order", 0);
    n.set("created", created);
    const meta = new Y.Map();
    meta.set("auto", new Y.Map());
    n.set("meta", meta);
    return n;
  };

  doc.transact(() => {
    // 同名文件夹两份（parent 都为空）
    fm.set("f-old", { name: "开发", parent: null, order: 0, created: "2026-10-01T00:00:00Z" });
    fm.set("f-new", { name: "开发", parent: null, order: 1, created: "2026-10-02T00:00:00Z" });
    // 三份 github（旧→新→新）, 归属新夹
    bm.set("g1", { title: "GitHub", url: "https://github.com", folder: "f-new", order: 0, created: "2026-10-03T00:00:00Z" });
    bm.set("g2", { title: "GitHub2", url: "https://github.com", folder: "f-old", order: 1, created: "2026-10-02T00:00:00Z" });
    bm.set("g3", ynode("GitHub3", "https://github.com", "f-new", "2026-10-04T00:00:00Z"));
    // 第二条: 保留者无归属、被删者有 → 应采纳归属
    bm.set("z1", ynode("知乎", "https://zhihu.com", null, "2026-10-05T00:00:00Z"));
    bm.set("z2", { title: "知乎", url: "https://zhihu.com", folder: "f-old", order: 2, created: "2026-10-06T00:00:00Z" });
    // 唯一 URL 不应被动
    bm.set("u1", ynode("唯一", "https://only.example", null, "2026-10-07T00:00:00Z"));
  });
  return { doc, bm, fm };
}

test("D1 同 URL 去重: 每 URL 只留一份（优先 YMap → created 最早 → id 最小）", () => {
  const { doc, bm } = makeDoc();
  const stats = dedupeBookmarks(doc);
  assert.equal(stats.bookmarksBefore, 6);
  assert.equal(stats.bookmarksAfter, 3, `期望 3 份（github/zhihu/only）, 实际 ${bm.size}`);
  assert.equal(stats.removed, 3);
  // github 保留 g3（唯一的 YMap 节点 —— 形状优先）
  assert.ok(bm.has("g3"), "YMap 节点优先保留");
  assert.ok(!bm.has("g1") && !bm.has("g2"));
});

test("D2 同名文件夹合并 + 归属重定向（不留悬空 folder）", () => {
  const { doc, bm, fm } = makeDoc();
  const stats = dedupeBookmarks(doc);
  assert.equal(stats.foldersMerged, 1, "两份「开发」合并为一份");
  assert.equal(fm.size, 1);
  const alive = new Set([...fm.keys()]);
  for (const [id, v] of bm) {
    const folder = v instanceof Y.Map ? v.get("folder") : v.folder;
    if (folder) assert.ok(alive.has(folder), `书签 ${id} 仍指向已删除的文件夹 ${folder}`);
  }
});

test("D3 保留者无归属时采纳被删者的归属（信息不丢）", () => {
  const { doc, bm, fm } = makeDoc();
  dedupeBookmarks(doc);
  const zhihu = bm.get("z1"); // YMap 优先保留
  const folder = zhihu instanceof Y.Map ? zhihu.get("folder") : zhihu.folder;
  assert.ok(folder, "应采纳 z2 的归属");
  assert.ok([...fm.keys()].includes(folder), "归属必须是存活文件夹");
});

test("D4 幂等: 再跑一次无变化", () => {
  const { doc, bm, fm } = makeDoc();
  dedupeBookmarks(doc);
  const after1 = { b: bm.size, f: fm.size };
  const stats2 = dedupeBookmarks(doc);
  assert.deepEqual({ b: bm.size, f: fm.size }, after1);
  assert.equal(stats2.removed, 0);
  assert.equal(stats2.foldersMerged, 0);
});

test("D5 无重复时不误删", () => {
  const doc = new Y.Doc();
  const root = doc.getMap("");
  const bm = new Y.Map();
  root.set("bookmarks", bm);
  root.set("folders", new Y.Map());
  bm.set("a", { title: "A", url: "https://a.example", folder: null, order: 0, created: "2026-10-01T00:00:00Z" });
  bm.set("b", { title: "B", url: "https://b.example", folder: null, order: 1, created: "2026-10-02T00:00:00Z" });
  const stats = dedupeBookmarks(doc);
  assert.equal(stats.removed, 0);
  assert.equal(bm.size, 2);
});

test("D6 悬空归属清理: 指向不存在文件夹的书签归到未分组", () => {
  const doc = new Y.Doc();
  const root = doc.getMap("");
  const bm = new Y.Map();
  const fm = new Y.Map();
  root.set("bookmarks", bm);
  root.set("folders", fm);
  fm.set("alive", { name: "在", parent: null, order: 0, created: "2026-10-01T00:00:00Z" });
  bm.set("a", { title: "A", url: "https://a.example", folder: "ghost", order: 0, created: "2026-10-01T00:00:00Z" });
  bm.set("b", { title: "B", url: "https://b.example", folder: "alive", order: 1, created: "2026-10-02T00:00:00Z" });
  const stats = dedupeBookmarks(doc);
  assert.equal(stats.danglingFixed, 1);
  assert.equal(bm.get("a").folder, null, "悬空 → null");
  assert.equal(bm.get("b").folder, "alive", "有效归属不动");
});

test("D7 嵌套重复: 子夹随父夹合并（不留孤儿子夹/重复子夹）", () => {
  const doc = new Y.Doc();
  const root = doc.getMap("");
  const bm = new Y.Map();
  const fm = new Y.Map();
  root.set("bookmarks", bm);
  root.set("folders", fm);
  doc.transact(() => {
    // 两次导入各复制一棵子树: 开发(父) + 子夹(子)
    fm.set("f-old", { name: "开发", parent: null, order: 0, created: "2026-10-01T00:00:00Z" });
    fm.set("c-old", { name: "子夹", parent: "f-old", order: 0, created: "2026-10-01T01:00:00Z" });
    fm.set("f-new", { name: "开发", parent: null, order: 1, created: "2026-10-02T00:00:00Z" });
    fm.set("c-new", { name: "子夹", parent: "f-new", order: 1, created: "2026-10-02T01:00:00Z" });
    bm.set("b1", { title: "A", url: "https://a.example", folder: "c-old", order: 0, created: "2026-10-01T02:00:00Z" });
  });
  const stats = dedupeBookmarks(doc);
  assert.equal(stats.foldersMerged, 2, `父夹+子夹各合并一次, 实际 ${stats.foldersMerged}`);
  assert.equal(fm.size, 2, `应只剩 开发 + 子夹, 实际 ${fm.size}`);
  const alive = new Set([...fm.keys()]);
  for (const [id, v] of fm) {
    const f = v instanceof Y.Map ? v.get("parent") : v.parent;
    if (f) assert.ok(alive.has(f), `子夹 ${id} 的 parent ${f} 悬空`);
  }
  const sub = [...fm.values()].filter((v) => (v instanceof Y.Map ? v.get("name") : v.name) === "子夹");
  assert.equal(sub.length, 1, "子夹不应重复");
  // 书签归属仍在存活子夹里
  const folder = bm.get("b1") instanceof Y.Map ? bm.get("b1").get("folder") : bm.get("b1").folder;
  assert.ok(folder && alive.has(folder), "书签归属应指向存活的子夹");
});

console.log(`\n${7 - failed}/7 passed`);
process.exit(failed ? 1 : 0);

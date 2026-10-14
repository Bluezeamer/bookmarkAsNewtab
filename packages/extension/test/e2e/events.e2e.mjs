#!/usr/bin/env node
// 扩展事件路径 E2E（能力块 15 补）: 真 Chrome + 真 SW + 真 server, 验证
//   「浏览器里新建/移动/删除书签 → 自动进 CRDT（且归属正确）」
//
// 为什么必须 E2E: 用户实测的 bug（新加书签全落进"未分组"）根因是事件处理里
//   `pid === "1" ? null` 这类**只在真 Chrome 事件里才走到**的分支 —— 纯函数测试（T42/T43）测不到它。
//
// 用法: pnpm --filter @bnt/extension test:e2e   （或 node packages/extension/test/e2e/events.e2e.mjs）
//   无 Chrome 时 SKIP（CI 未装浏览器）；本地用 CHROME_BIN 指定
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../.."); // packages/extension/test/e2e → 仓库根（4 层）
const DIST = path.resolve(process.argv[2] ?? path.join(ROOT, "packages/extension/dist"));
const SERVER = path.join(ROOT, "packages/server");

function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const base = path.join(os.homedir(), ".cache/ms-playwright");
  try {
    const cands = execSync(`ls -d ${base}/chromium-*/chrome-linux64/chrome 2>/dev/null || true`)
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean)
      .sort();
    if (cands.length) return cands[cands.length - 1];
  } catch {
    /* ignore */
  }
  for (const name of ["chromium", "chromium-browser", "google-chrome"]) {
    try {
      const p = execSync(`which ${name} 2>/dev/null || true`).toString().trim();
      if (p) return p;
    } catch {
      /* ignore */
    }
  }
  return "";
}
const CHROME = findChrome();
if (!existsSync(DIST)) {
  console.error(`FAIL 找不到扩展产物: ${DIST}（先 pnpm --filter @bnt/extension build）`);
  process.exit(1);
}
if (!CHROME || !existsSync(CHROME)) {
  console.log("SKIP 未找到 Chrome（可用 CHROME_BIN 指定）");
  process.exit(0);
}

const TOKEN = "e2e-events-token";
const PORT = 24500 + (process.pid % 80);
const DEBUG_PORT = 9400 + (process.pid % 80);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "bnt-e2e-"));
const PROFILE = mkdtempSync(path.join(os.tmpdir(), "bnt-e2e-profile-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
let total = 0;
const check = async (name, fn) => {
  total++;
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}: ${e.message}`);
  }
};
const assert = (c, m) => {
  if (!c) throw new Error(m);
};

// 端口先探测空闲（AGENTS 约定: 遗留进程占端口会假失败）
const net = await import("node:net");
const freePort = async (start) => {
  for (let p = start; p < start + 40; p++) {
    const ok = await new Promise((res) => {
      const s = net.createServer();
      s.once("error", () => res(false));
      s.once("listening", () => s.close(() => res(true)));
      s.listen(p, "127.0.0.1");
    });
    if (ok) return p;
  }
  throw new Error("无空闲端口");
};

// 1) server（esbuild 单文件 bundle + 临时 DATA_DIR）
execSync(
  `${path.join(SERVER, "node_modules/.bin/esbuild")} src/index.ts --bundle --platform=node --format=cjs --outfile=dist/index.js`,
  { cwd: SERVER, stdio: "inherit" }
);
const srv = spawn("node", [path.join(SERVER, "dist/index.js")], {
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(PORT), SYNC_TOKEN: TOKEN, DATA_DIR },
  stdio: ["ignore", "pipe", "pipe"],
});
srv.stderr.on("data", () => {});
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${BASE}/health`)).ok) break;
  } catch {
    /* 未起 */
  }
  if (i > 100) {
    console.error("FAIL server 未就绪");
    srv.kill();
    process.exit(1);
  }
  await sleep(100);
}

// 2) 一个 Yjs 观察者: 直接读 server 上的 CRDT（= 扩展写入的落点）
const doc = new Y.Doc();
const peer = new WebsocketProvider(`ws://127.0.0.1:${PORT}`, `ws?token=${TOKEN}`, doc);
await new Promise((res) => {
  const chk = () => doc.getMap("").get("bookmarks") instanceof Y.Map && res();
  doc.getMap("").observeDeep(chk);
  chk();
});
const root = doc.getMap("");
const field = (v, k) => (v instanceof Y.Map ? v.get(k) : v?.[k]);
const findByUrl = (url) => {
  const bm = root.get("bookmarks");
  for (const [id, v] of bm) if (field(v, "url") === url) return { id, node: v };
  return null;
};
const folderIdByName = (name) => {
  const fm = root.get("folders");
  for (const [id, v] of fm) if (field(v, "name") === name) return id;
  return null;
};

// 3) Chrome + 扩展
const port = await freePort(DEBUG_PORT);
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-first-run",
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${port}`,
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"], detached: true }
);
const killChrome = () => {
  try {
    process.kill(-chrome.pid, "SIGKILL");
  } catch {
    chrome.kill("SIGKILL");
  }
};
let version = null;
for (let i = 0; i < 100; i++) {
  try {
    version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    break;
  } catch {
    await sleep(100);
  }
}
if (!version) {
  console.error("FAIL Chrome 未就绪");
  killChrome();
  srv.kill();
  process.exit(1);
}

let id = 0;
const pending = new Map();
const ws = new WebSocket(version.webSocketDebuggerUrl);
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  }
};
await new Promise((res) => (ws.onopen = () => res()));
const rpc = (method, params = {}, sid) => {
  const n = ++id;
  ws.send(JSON.stringify({ id: n, method, params, ...(sid ? { sessionId: sid } : {}) }));
  return new Promise((res, rej) => pending.set(n, { res, rej }));
};

// 等扩展的 service worker（拿扩展 id）
let swUrl = null;
for (let i = 0; i < 40; i++) {
  const { targetInfos } = await rpc("Target.getTargets");
  const sw = targetInfos.find((t) => t.type === "service_worker" && /\/sw\.js$/.test(t.url));
  if (sw) {
    swUrl = sw.url;
    break;
  }
  await sleep(250);
}
if (!swUrl) {
  console.error("FAIL 未找到扩展的 service worker（扩展未加载?）");
  killChrome();
  srv.kill();
  process.exit(1);
}
const extId = new URL(swUrl).host;

// 4) 打开扩展页面（有 chrome.* 权限）并写入配置 → 触发 SW 引导（首次全量导入）
const { targetId } = await rpc("Target.createTarget", { url: `chrome-extension://${extId}/newtab.html` });
const { sessionId } = await rpc("Target.attachToTarget", { targetId, flatten: true });
await rpc("Runtime.enable", {}, sessionId);
const ev = async (expr) => {
  const r = await rpc("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "页面异常");
  return r.result?.value;
};
for (let i = 0; i < 40; i++) {
  if (await ev(`typeof chrome !== "undefined" && !!chrome.bookmarks`)) break;
  await sleep(250);
}
await ev(
  `chrome.storage.local.set({ serverUrl: ${JSON.stringify(BASE)}, token: ${JSON.stringify(TOKEN)} })`
);

// 读扩展的 nodeMap（chromeId → CRDT id）: 不依赖夹名（headless 默认 en-US, 容器叫 "Bookmarks bar"）
const nodeMapOf = async () => {
  const r = await ev(`chrome.storage.local.get("nodeMap")`);
  return r?.nodeMap ?? {};
};
// 发消息给 SW（扩展页 → SW; 绕过 popup 的 confirm）
const act = (type) => ev(`chrome.runtime.sendMessage({ type: ${JSON.stringify(type)} })`);

// 能力块 20: **不再自动导入** —— 必须显式「增量注入」才会建立映射（这正是用户要的行为）
await act("inject-from-chrome");
let nodeMap = {};
for (let i = 0; i < 60; i++) {
  nodeMap = await nodeMapOf();
  if (nodeMap["1"]) break;
  await sleep(500);
}
const barFolder = nodeMap["1"];
assert(barFolder, `显式「增量注入」后 nodeMap 应含书签栏映射（实际 keys=${JSON.stringify(Object.keys(nodeMap).slice(0, 5))}）`);

await check("E1 浏览器新建书签 → 自动进 CRDT 且归属正确（不再落进未分组）", async () => {
  const url = `https://e2e-created.example/${Date.now()}`;
  const created = await ev(
    `(async () => { const n = await chrome.bookmarks.create({ parentId: "1", title: "E2E 新建", url: ${JSON.stringify(url)} }); return n.id; })()`
  );
  assert(created, "chrome.bookmarks.create 应返回节点 id");
  let hit = null;
  for (let i = 0; i < 40; i++) {
    hit = findByUrl(url);
    if (hit) break;
    await sleep(500);
  }
  assert(hit, "新建的书签应出现在 CRDT 里（事件路径生效）");
  const folder = field(hit.node, "folder");
  assert(folder === barFolder, `归属必须是书签栏（实际 ${folder === null ? "未分组(null)" : folder}）`);
});

await check("E2 浏览器移动书签 → CRDT 归属跟随", async () => {
  const url = `https://e2e-moved.example/${Date.now()}`;
  const ids = JSON.parse(
    await ev(`(async () => {
      const b = await chrome.bookmarks.create({ parentId: "1", title: "E2E 待移动", url: ${JSON.stringify(url)} });
      const f = await chrome.bookmarks.create({ parentId: "1", title: "E2E 目标夹" });
      return JSON.stringify({ b: b.id, f: f.id });
    })()`)
  );
  let folder = null;
  for (let i = 0; i < 40; i++) {
    const hit = findByUrl(url);
    if (hit) {
      folder = field(hit.node, "folder");
      if (folder && folder !== barFolder) break;
    }
    await sleep(250);
  }
  // 移动（Chrome 侧）
  await ev(`chrome.bookmarks.move(${JSON.stringify(ids.b)}, { parentId: ${JSON.stringify(ids.f)} })`);
  let after = null;
  for (let i = 0; i < 40; i++) {
    const hit = findByUrl(url);
    if (hit) {
      after = field(hit.node, "folder");
      if (after !== barFolder) break;
    }
    await sleep(500);
  }
  // 新夹的映射由事件路径建立（onBookmarkCreated 的 folder 分支）
  let target = null;
  for (let i = 0; i < 40; i++) {
    target = (await nodeMapOf())[ids.f];
    if (target) break;
    await sleep(250);
  }
  assert(target, `新建的夹应建立映射（chromeId=${ids.f}）`);
  assert(after === target, `移动后归属应指向目标夹（实际 ${after}，目标 ${target}）`);
});

await check("E3 浏览器删除书签 → CRDT 同步删除", async () => {
  const url = `https://e2e-removed.example/${Date.now()}`;
  const chromeId = await ev(
    `(async () => { const n = await chrome.bookmarks.create({ parentId: "1", title: "E2E 待删", url: ${JSON.stringify(url)} }); return n.id; })()`
  );
  for (let i = 0; i < 40; i++) {
    if (findByUrl(url)) break;
    await sleep(250);
  }
  assert(findByUrl(url), "删除前应已进 CRDT");
  await ev(`chrome.bookmarks.remove(${JSON.stringify(chromeId)})`);
  for (let i = 0; i < 40; i++) {
    if (!findByUrl(url)) break;
    await sleep(500);
  }
  assert(!findByUrl(url), "删除后 CRDT 里也应消失");
});

await check("E4 冷启动（server 不可达）事件入队 → 恢复后重放不丢", async () => {
  // ① 指向一个没人监听的端口（模拟 server 重启/断网）→ schema 到不了
  await ev(
    `chrome.storage.local.set({ serverUrl: "http://127.0.0.1:1", token: ${JSON.stringify(TOKEN)} })`
  );
  await sleep(1500);
  const url = `https://e2e-queued.example/${Date.now()}`;
  await ev(
    `chrome.bookmarks.create({ parentId: "1", title: "E2E 离线新增", url: ${JSON.stringify(url)} })`
  );
  // ② 事件不能丢: 应落进待办队列
  let queued = [];
  for (let i = 0; i < 20; i++) {
    queued = (await ev(`chrome.storage.local.get("pendingEvents")`))?.pendingEvents ?? [];
    if (queued.some((e) => e.type === "created")) break;
    await sleep(500);
  }
  assert(
    queued.some((e) => e.type === "created" && e.url === url),
    `schema 未就绪时事件必须入队（实际 ${JSON.stringify(queued).slice(0, 160)}）`
  );
  // ③ 恢复配置（指向真 server）→ bootstrap 导入 + replayPending
  await ev(`chrome.storage.local.set({ serverUrl: ${JSON.stringify(BASE)}, token: ${JSON.stringify(TOKEN)} })`);
  let hit = null;
  for (let i = 0; i < 60; i++) {
    hit = findByUrl(url);
    if (hit) break;
    await sleep(500);
  }
  assert(hit, "恢复后书签必须出现在 CRDT（导入或重放补齐）");
  const folder = field(hit.node, "folder");
  assert(folder === barFolder, `归属必须是书签栏（实际 ${folder === null ? "未分组(null)" : folder}）`);
  // ④ 队列应被排空（重放跑过；幂等跳过也算成功）
  let left = [];
  for (let i = 0; i < 20; i++) {
    left = (await ev(`chrome.storage.local.get("pendingEvents")`))?.pendingEvents ?? [];
    if (left.length === 0) break;
    await sleep(500);
  }
  assert(left.length === 0, `恢复后队列应排空（实际剩 ${left.length} 条）`);
});

// E5 增量注入（显式）: 只补不删 —— CRDT 里"未分组"的条目**不受影响**
await check("E5 增量注入只补不删（未分组条目保留）", async () => {
  const url = `https://e2e-ungrouped.example/${Date.now()}`;
  doc.transact(() => {
    const n = new Y.Map();
    n.set("title", "CRDT 独有的未分组条目");
    n.set("url", url);
    n.set("folder", null);
    n.set("order", 999);
    n.set("created", new Date().toISOString());
    const m = new Y.Map();
    m.set("auto", new Y.Map());
    n.set("meta", m);
    doc.getMap("").get("bookmarks").set("e2e-ungrouped", n);
  });
  await sleep(800);
  assert(findByUrl(url), "前置: CRDT 里应有这条未分组书签");
  await act("inject-from-chrome");
  await sleep(1500);
  assert(findByUrl(url), "增量注入**不得**删除任何内容（未分组条目要保留）");
});

// E6 浏览器覆盖后端: 改名对齐 + 未归属直接删 + 剪掉浏览器没有的
await check("E6 浏览器覆盖后端: 改名对齐 + 未归属获得归属 + 剪掉浏览器没有的", async () => {
  // ① Chrome 侧建夹后改名 —— Chrome 的改名**没有事件路径**, 只有覆盖模式能把它对齐过来
  const folderId = await ev(
    `(async () => { const f = await chrome.bookmarks.create({ parentId: "1", title: "E2E 覆盖夹-旧名" }); return f.id; })()`
  );
  await sleep(1000); // 等事件路径把新夹建进 CRDT
  await ev(`chrome.bookmarks.update(${JSON.stringify(folderId)}, { title: "E2E 覆盖夹-新名" })`);
  await sleep(500);

  // ② CRDT 侧造两条"浏览器里没有"的书签: 一条未分组、一条有归属
  const orphanUrl = `https://e2e-orphan.example/${Date.now()}`;
  const strayUrl = ""; // 见下: 用它造一个"浏览器里一定没有"的条目
  doc.transact(() => {
    const mk = (id, title, url, folder) => {
      const n = new Y.Map();
      n.set("title", title);
      n.set("url", url);
      n.set("folder", folder);
      n.set("order", 900);
      n.set("created", new Date().toISOString());
      const m = new Y.Map();
      m.set("auto", new Y.Map());
      n.set("meta", m);
      doc.getMap("").get("bookmarks").set(id, n);
    };
    mk("e2e-orphan", "未归属（应被删）", orphanUrl, null);
    // 空 URL: 写回无法把它创建到 Chrome（applyAction 会跳过）→ 真正"浏览器里没有"的条目
    mk("e2e-stray", "浏览器没有（应被剪）", "", barFolder);
  });
  await sleep(900);
  assert(findByUrl(orphanUrl) && findByUrl(strayUrl), "前置: 两条书签都应在 CRDT 里");

  await act("overwrite-from-chrome");
  await sleep(3000);
  // 注意（能力块 19 增补后）: 写回现在也会**创建**新节点 → CRDT 里的"未分组"条目会被镜像到
  // Chrome 的书签栏, 于是它**有归属**了 → 覆盖时按浏览器结构对齐（不再被判为"无归属"）。
  const orphan = findByUrl(orphanUrl);
  assert(orphan, "未分组的条目不应消失（它已被镜像到浏览器, 于是有了归属）");
  assert(orphan.folder !== null, `覆盖后应对齐到浏览器里的归属，实际 ${JSON.stringify(orphan)}`);
  // 真正"浏览器里没有"的条目（空 URL → 写回无法创建）→ 剪掉
  assert(!findByUrl(strayUrl), "浏览器里没有的书签应被剪掉");
  const names = [...doc.getMap("").get("folders").values()].map((v) => v?.name);
  assert(names.includes("E2E 覆盖夹-新名"), `Chrome 里的改名应对齐到 CRDT（实际 ${JSON.stringify(names.slice(0, 8))}）`);
  assert(!names.includes("E2E 覆盖夹-旧名"), "旧名的夹应被剪掉（结构完全对齐）");
});

// E7 后端覆盖浏览器: 清空浏览器书签 → 按 CRDT 重建（浏览器侧 = CRDT 树的精确镜像）
await check("E7 后端覆盖浏览器: 清空重建后 浏览器树 == CRDT 树", async () => {
  // 注意: 在 Chrome 里新建的书签会被**事件路径**同步进 CRDT（这是设计行为）→
  // 所以"浏览器里有、CRDT 里没有"的稳态是不存在的; 覆盖的判据应是**两边完全一致**。
  const nativeUrl = `https://e2e-native.example/${Date.now()}`;
  const nativeId = await ev(
    `(async () => { const n = await chrome.bookmarks.create({ parentId: "1", title: "E2E 原生", url: ${JSON.stringify(nativeUrl)} }); return n.id; })()`
  );
  const crdtUrl = `https://e2e-crdt-only.example/${Date.now()}`;
  doc.transact(() => {
    const n = new Y.Map();
    n.set("title", "CRDT 独有");
    n.set("url", crdtUrl);
    n.set("folder", barFolder);
    n.set("order", 950);
    n.set("created", new Date().toISOString());
    const m = new Y.Map();
    m.set("auto", new Y.Map());
    n.set("meta", m);
    doc.getMap("").get("bookmarks").set("e2e-crdt-only", n);
  });
  await sleep(1500); // 等事件路径把 nativeUrl 也同步进 CRDT

  await act("overwrite-to-chrome");
  await sleep(6000);

  const browser = await ev(
    `(async () => { const t = await chrome.bookmarks.getTree(); const out = [];
       const walk = (n) => { for (const c of n.children ?? []) { if (c.url) out.push({ id: c.id, url: c.url }); walk(c); } };
       walk(t[0]); return out; })()`
  );
  const browserUrls = browser.map((n) => n.url);
  const crdtUrls = [...doc.getMap("").get("bookmarks").values()].map((v) => v.get("url"));
  const oldStillThere = browser.some((n) => n.id === nativeId);
  const st = await ev(`chrome.storage.local.get("status")`);
  console.log(`   [诊断] ${st?.status?.message}`);
  console.log(`   [诊断] 浏览器 ${browserUrls.length} 条 / CRDT ${crdtUrls.length} 条 · 旧节点 id 还在? ${oldStillThere}`);

  // 清空 + 重建的证据: 节点是**新建**的（旧 id 消失）
  assert(!oldStillThere, "清空重建后旧节点 id 应消失（是重建的新节点, 不是原地保留）");
  // 精确镜像: 双向包含
  for (const u of crdtUrls) assert(browserUrls.includes(u), `CRDT 里的 ${u} 应被重建到浏览器`);
  for (const u of browserUrls) assert(crdtUrls.includes(u), `浏览器里的 ${u} 应在 CRDT 里（不得残留 CRDT 没有的节点）`);
  assert(browserUrls.length === crdtUrls.length, `两边条数应一致（浏览器 ${browserUrls.length} / CRDT ${crdtUrls.length}）`);
  // 根容器不得被重复创建（曾把 CRDT 里的 "Bookmarks bar" 夹再建一份 → 出现两个同名容器）
  const folderTitles = await ev(
    `(async () => { const t = await chrome.bookmarks.getTree(); const out = [];
       const walk = (n) => { for (const c of n.children ?? []) { if (!c.url) out.push(c.title); walk(c); } };
       walk(t[0]); return out; })()`
  );
  for (const t of ["Bookmarks bar", "Other bookmarks"]) {
    const n = folderTitles.filter((x) => x === t).length;
    assert(n === 1, `根容器 ${t} 不应重复（实际 ${n} 个: ${JSON.stringify(folderTitles.slice(0, 8))}）`);
  }
});

// E8 UI 新建文件夹 → 写回浏览器（能力块 19 增补）: CRDT 里新建的夹必须落到 Chrome
await check("E8 CRDT 新建文件夹 → 写回浏览器", async () => {
  const name = `E2E 写回夹-${Date.now()}`;
  doc.transact(() => {
    doc.getMap("").get("folders").set(crypto.randomUUID(), { name, parent: barFolder, order: 500 });
  });
  const foldersOf = () =>
    ev(
      `(async () => { const t = await chrome.bookmarks.getTree(); const out = [];
         const walk = (n) => { for (const c of n.children ?? []) { if (!c.url) out.push(c.title); walk(c); } };
         walk(t[0]); return out; })()`
    );
  let seen = [];
  for (let i = 0; i < 40; i++) {
    seen = await foldersOf();
    if (seen.includes(name)) break;
    await sleep(500);
  }
  assert(seen.includes(name), `UI 新建的夹应写回浏览器（实际 ${JSON.stringify(seen.slice(0, 8))}）`);
});


ws.close();
killChrome();
peer.destroy();
doc.destroy();
srv.kill();
rmSync(PROFILE, { recursive: true, force: true });
console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);

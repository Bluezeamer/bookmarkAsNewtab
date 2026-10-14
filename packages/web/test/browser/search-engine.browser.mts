#!/usr/bin/env node
// 能力块 9 · I2 验收（浏览器）: 顶栏只留搜索框 / 引擎切换落 CRDT / 混合命中含引擎行 / Enter 走引擎 / 筛选收进框内
//
// 运行: pnpm --filter web test:browser:search
//   未找到 Chrome 时自动跳过（CI 无浏览器安全）; 自举 server（esbuild + 临时 DATA_DIR + 随机端口）
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "../..");
const SERVER = path.resolve(WEB, "../server");
const CHROME =
  process.env.CHROME_BIN ??
  [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ].find(existsSync) ??
  "";
if (!existsSync(CHROME)) {
  console.log("SKIP: 未找到 Chrome（CI 无浏览器时本项跳过）");
  process.exit(0);
}

const TOKEN = "search-engine-test-token";
const PORT = 24000 + (process.pid % 90);
const BASE = `http://127.0.0.1:${PORT}`;
const DEBUG_PORT = 9700 + (process.pid % 90);
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "bnt-search-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let total = 0;
let failed = 0;
async function check(name, fn) {
  total++;
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}: ${e.message}`);
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m);
};

// 先构建被测前端（server 直接托管 packages/web/dist; 不构建会验到过期产物）
execSync(`pnpm exec vite build`, { cwd: WEB, stdio: "inherit" });
execSync(
  `${path.join(SERVER, "node_modules/.bin/esbuild")} src/index.ts --bundle --platform=node --format=cjs --outfile=dist/index.js`,
  { cwd: SERVER, stdio: "inherit" }
);
const srv = spawn("node", [path.join(SERVER, "dist/index.js")], {
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(PORT), SYNC_TOKEN: TOKEN, DATA_DIR },
  stdio: ["ignore", "pipe", "pipe"],
});
srv.stdout.on("data", () => {});
srv.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${BASE}/health`)).ok) break;
  } catch {
    /* 未起 */
  }
  if (i > 100) {
    console.error("FAIL server 未就绪");
    process.exit(1);
  }
  await sleep(100);
}

// 数据: 两条含 "git" 的书签（命中）+ 一段历史由本端直接上报不重要（面板引擎行不依赖历史）
const peerDoc = new Y.Doc();
const peer = new WebsocketProvider(`ws://127.0.0.1:${PORT}`, `ws?token=${TOKEN}`, peerDoc);
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("bootstrap 超时")), 10000);
  const chk = () => {
    if (peerDoc.getMap("").get("bookmarks") instanceof Y.Map) {
      clearTimeout(t);
      res();
    }
  };
  peerDoc.getMap("").observeDeep(chk);
  chk();
});
const root = peerDoc.getMap("");
const bm = root.get("bookmarks");
const fm = root.get("folders");
const node = (title, url, folder, order) => {
  const n = new Y.Map();
  n.set("title", title);
  n.set("url", url);
  n.set("folder", folder);
  n.set("order", order);
  n.set("created", "2026-10-10T00:00:00Z");
  const m = new Y.Map();
  m.set("auto", new Y.Map());
  n.set("meta", m);
  return n;
};
peerDoc.transact(() => {
  fm.set("dev", { name: "开发", parent: null, order: 0 });
  bm.set("g0", node("GitHub", "https://github.com", "dev", 0));
  bm.set("g1", node("GitLab 项目", "https://gitlab.example/x", "dev", 1));
  bm.set("o0", node("别的站点", "https://other.example/", "dev", 2));
});
await sleep(700);

const profile = mkdtempSync(path.join(os.tmpdir(), "bnt-search-profile-"));
const chrome = spawn(
  CHROME,
  [
    "--headless",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-first-run",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] }
);
let version = null;
for (let i = 0; i < 100; i++) {
  try {
    version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
    break;
  } catch {
    await sleep(100);
  }
}
if (!version) {
  console.error("FAIL Chrome 未就绪");
  srv.kill();
  process.exit(1);
}

let msgId = 0;
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
const rpc = (method, params = {}, sid) => {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
};
await new Promise((res) => {
  ws.onopen = () => res();
});
const { targetId } = await rpc("Target.createTarget", { url: `${BASE}/?token=${TOKEN}` });
const { sessionId } = await rpc("Target.attachToTarget", { targetId, flatten: true });
await rpc("Runtime.enable", {}, sessionId);
await rpc("Emulation.setDeviceMetricsOverride", { width: 1440, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);
const ev = async (expr) => {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await rpc("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "页面异常");
      return r.result?.value;
    } catch (e) {
      if (!/Execution context was destroyed|Cannot find context/.test(String(e.message))) throw e;
      await sleep(200);
    }
  }
  throw new Error("evaluate 重试耗尽");
};
for (let i = 0; i < 60; i++) {
  if (await ev(`!!document.querySelector("[data-sidebar]")`)) break;
  await sleep(250);
}
await sleep(500);

const key = async (k) => {
  await rpc("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k === "Enter" ? "Enter" : undefined, windowsVirtualKeyCode: k === "Enter" ? 13 : undefined }, sessionId);
  await rpc("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k === "Enter" ? "Enter" : undefined }, sessionId);
};
const typeText = (text) =>
  ev(`(() => {
    const el = document.querySelector("[data-search-input]");
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    set.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);

// E1 顶栏只留搜索框: 顶栏无 tab 按钮, 侧栏有「书签/历史」入口且点击可切视图
await check("E1 顶栏只留搜索框（tab 移入侧栏且可切换视图）", async () => {
  const info = JSON.parse(
    await ev(`(() => {
      const header = document.querySelector("header");
      const tabsOutsideSidebar = [...document.querySelectorAll("[data-tab]")].filter(
        (e) => !e.closest("[data-sidebar]")
      ).length;
      const inSidebar = [...document.querySelectorAll("[data-sidebar] [data-tab]")].map((e) =>
        e.getAttribute("data-tab")
      );
      return JSON.stringify({
        tabsOutsideSidebar,
        inSidebar,
        hasSearchInput: !!header?.querySelector("[data-search-input]"),
        hasEngineBtn: !!header?.querySelector("[data-engine-btn]"),
      });
    })()`)
  );
  assert(info.hasSearchInput && info.hasEngineBtn, "顶栏应只有搜索框（内含引擎按钮）");
  assert(info.tabsOutsideSidebar === 0, `顶栏不应再有 tab 按钮（实际 ${info.tabsOutsideSidebar} 个）`);
  assert(
    info.inSidebar.includes("bookmarks") && info.inSidebar.includes("history"),
    `侧栏应有书签/历史入口，实际 ${info.inSidebar}`
  );
  const isHistoryView = () =>
    ev(
      `(() => { const t = document.body.textContent || "";
         return !document.querySelector("[data-group]") && (!!document.querySelector("[data-hist-count]") || t.includes("没有匹配的历史")); })()`
    );
  await ev(`document.querySelector('[data-sidebar] [data-tab="history"]').click()`);
  await sleep(600);
  assert(await isHistoryView(), "点侧栏「历史」应切到历史视图");
  await ev(`document.querySelector('[data-sidebar] [data-tab="bookmarks"]').click()`);
  await sleep(400);
  assert(!(await isHistoryView()), "点回「书签」应回书签视图");
});

// E2 引擎切换: 按钮 → 菜单 → 选 Bing → 落 CRDT（多端一致）
await check("E2 搜索引擎可切换且写入 CRDT（多端一致）", async () => {
  await ev(`document.querySelector("[data-engine-btn]").click()`);
  await sleep(250);
  assert(await ev(`!!document.querySelector("[data-engine-menu]")`), "点引擎按钮应展开引擎列表");
  const options = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll("[data-engine-option]")].map((e)=>e.getAttribute("data-engine-option")))`));
  for (const id of ["google", "bing", "baidu", "ddg", "yandex"]) {
    assert(options.includes(id), `引擎列表应含 ${id}，实际 ${options}`);
  }
  await ev(`document.querySelector('[data-engine-option="bing"]').click()`);
  await sleep(600);
  assert(!(await ev(`!!document.querySelector("[data-engine-menu]")`)), "选完应收起菜单");
  assert(
    (await ev(`document.querySelector("[data-engine-btn]").textContent.trim()`)) === "B",
    "按钮短标应变为 B"
  );
  const settings = root.get("settings");
  assert(settings?.get("searchEngine") === "bing", `CRDT settings.searchEngine 应为 bing，实际 ${settings?.get("searchEngine")}`);
});

// E3 混合命中（能力块 16 新范式）: 候选只有书签/历史, **引擎搜索不再是列表项**, 底部给不可选中提示
await check("E3 混合命中: 候选分组 + 引擎搜索改为底部提示（不是列表项）", async () => {
  await typeText("git");
  await sleep(700);
  const panel = JSON.parse(
    await ev(`(() => {
      const p = document.querySelector("[data-search-panel]");
      if (!p) return "null";
      const hits = [...p.querySelectorAll("[data-search-hit]")].map((e) => e.getAttribute("data-search-hit"));
      const hint = p.querySelector("[data-engine-hint]");
      return JSON.stringify({
        hits,
        engineRows: hits.filter((h) => h === "engine").length,
        hintText: hint?.textContent ?? "",
        bookmarkGroup: !!p.querySelector('[data-search-group="bookmarks"]'),
      });
    })()`)
  );
  assert(panel !== "null", "输入后应出现搜索面板");
  assert(panel.hits.filter((h) => h === "bookmark").length === 2, `应有 2 条书签命中，实际 ${JSON.stringify(panel.hits)}`);
  assert(panel.engineRows === 0, `引擎搜索不应再作为列表项（实际 ${panel.engineRows} 行）`);
  assert(panel.bookmarkGroup, "书签分组标题应在");
  assert(
    panel.hintText.includes("回车用") && panel.hintText.includes("Bing") && panel.hintText.includes("git"),
    `底部应有不可选中的引擎提示（实际 ${panel.hintText}）`
  );
  // 没有任何候选项处于选中态（能力块 16 · A: 默认不聚焦）
  const selected = await ev(`document.querySelectorAll('[data-search-panel] [aria-selected="true"]').length`);
  assert(selected === 0, `输入后不应预选任何候选（实际选中 ${selected} 项）`);
});

// E4 Enter 走引擎（能力块 16: 无选中时回车即引擎）→ 打开模板 URL（并清空输入）
await check("E4 默认回车按引擎模板打开（含编码）", async () => {
  await ev(`window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; };`);
  await typeText("a b&c");
  await sleep(700);
  const hits = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll("[data-search-panel] [data-search-hit]")].map((e)=>e.getAttribute("data-search-hit")))`));
  assert(hits.length === 0, `"a b&c" 应无候选（实际 ${JSON.stringify(hits)}）—— 无选中时回车走引擎`);
  await key("Enter");
  await sleep(400);
  const opened = JSON.parse(await ev(`JSON.stringify(window.__opened)`));
  assert(opened.length === 1, `应只打开一次，实际 ${JSON.stringify(opened)}`);
  assert(
    opened[0] === "https://www.bing.com/search?q=a%20b%26c",
    `应按模板编码打开，实际 ${opened[0]}`
  );
  assert((await ev(`document.querySelector("[data-search-input]").value`)) === "", "打开后应清空输入");
});

// E5 筛选按钮收进搜索框内部（量尺寸: 按钮矩形在输入框矩形内）
await check("E5 ⚙ 筛选收进搜索框内部且可展开筛选条", async () => {
  const box = JSON.parse(
    await ev(`(() => {
      const i = document.querySelector("[data-search-input]").getBoundingClientRect();
      const b = document.querySelector("[data-search-filters]").getBoundingClientRect();
      const e = document.querySelector("[data-engine-btn]").getBoundingClientRect();
      return JSON.stringify({
        inside: b.left >= i.left && b.right <= i.right && b.top >= i.top && b.bottom <= i.bottom,
        engineInside: e.left >= i.left && e.right <= i.right && e.top >= i.top && e.bottom <= i.bottom,
        btnW: Math.round(b.width),
        btnH: Math.round(b.height),
      });
    })()`)
  );
  assert(box.inside, "⚙ 按钮应完全落在输入框矩形内（收进框内）");
  assert(box.engineInside, "引擎按钮也应落在输入框矩形内");
  assert(box.btnW >= 24 && box.btnH >= 24, `框内小按钮仍要有可用尺寸，实际 ${box.btnW}×${box.btnH}`);
  await ev(`document.querySelector("[data-search-filters]").click()`);
  await sleep(300);
  assert(await ev(`!!document.querySelector("[data-history-filters]")`), "点击应展开历史筛选条");
});

// E6 搜索下拉必须**不透明**（回归: 半透明会透出背后内容 —— 用户截图问题）
await check("E6 搜索下拉/引擎菜单不透明", async () => {
  await typeText("git");
  await sleep(700);
  const st = JSON.parse(
    await ev(`(() => {
      const panel = document.querySelector("[data-search-panel]");
      if (!panel) return JSON.stringify({ none: true });
      const cs = getComputedStyle(panel);
      return JSON.stringify({ bg: cs.backgroundColor, backdrop: cs.backdropFilter || cs.webkitBackdropFilter });
    })()`)
  );
  assert(!st.none, "搜索面板应已打开");
  // 允许 rgb(...) 或 alpha ≥ 0.98 的 rgba
  const opaque = /^rgb\(/.test(st.bg) || (() => {
    const m = /rgba\([^)]*,\s*([\d.]+)\)/.exec(st.bg);
    return m ? Number(m[1]) >= 0.98 : false;
  })();
  assert(opaque, `下拉应为不透明实底（实际 ${st.bg}）`);
  await ev(`document.querySelector("[data-engine-btn]").click()`);
  await sleep(500);
  const menu = JSON.parse(
    await ev(`(() => { const m = document.querySelector("[data-engine-menu]"); if (!m) return JSON.stringify({ none: true });
      return JSON.stringify({ bg: getComputedStyle(m).backgroundColor }); })()`)
  );
  assert(!menu.none, "引擎菜单应已打开");
  const menuOpaque = /^rgb\(/.test(menu.bg) || (() => {
    const m = /rgba\([^)]*,\s*([\d.]+)\)/.exec(menu.bg);
    return m ? Number(m[1]) >= 0.98 : false;
  })();
  assert(menuOpaque, `引擎菜单应为不透明实底（实际 ${menu.bg}）`);
  await ev(`document.querySelector("[data-engine-btn]").click()`);
});

// E7 能力块 16: 默认回车走引擎; ↑↓ 才进候选; 选中后回车跳候选; 任何输入变化复位
await check("E7 默认回车走引擎, ↑↓ 才进候选, 输入变化复位选中", async () => {
  await ev(`window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; };`);
  await typeText("git");
  await sleep(700);
  // ① 默认（无选中）回车 → 引擎搜索（不是第一条书签）
  await key("Enter");
  await sleep(400);
  let opened = JSON.parse(await ev("JSON.stringify(window.__opened)"));
  assert(
    opened.length === 1 && opened[0].startsWith("https://www.bing.com/search?q=git"),
    `默认回车应走引擎（实际 ${JSON.stringify(opened)}）`
  );
  // ② ↑↓ 进入候选导航（↓ 选中第一条）
  await typeText("git");
  await sleep(700);
  await key("ArrowDown");
  await sleep(300);
  let sel = JSON.parse(
    await ev(`(() => { const el = document.querySelector('[data-search-panel] [aria-selected="true"]');
      return JSON.stringify({ count: document.querySelectorAll('[data-search-panel] [aria-selected="true"]').length, kind: el?.getAttribute("data-search-hit") ?? null }); })()`)
  );
  assert(sel.count === 1 && sel.kind === "bookmark", `↓ 应选中第一条候选（实际 ${JSON.stringify(sel)}）`);
  // ③ 选中状态下回车 → 打开该候选（书签 URL, 不是引擎）
  await ev("window.__opened = []");
  await key("Enter");
  await sleep(400);
  opened = JSON.parse(await ev("JSON.stringify(window.__opened)"));
  assert(
    opened.length === 1 && !opened[0].includes("bing.com/search"),
    `选中候选后回车应打开候选本身（实际 ${JSON.stringify(opened)}）`
  );
  // ④ 任何输入变化都复位（回到无选中）
  await typeText("git");
  await sleep(600);
  await key("ArrowDown");
  await sleep(250);
  assert(
    (await ev(`document.querySelectorAll('[data-search-panel] [aria-selected="true"]').length`)) === 1,
    "↓ 后应有选中"
  );
  await typeText("gitl");
  await sleep(600);
  assert(
    (await ev(`document.querySelectorAll('[data-search-panel] [aria-selected="true"]').length`)) === 0,
    "输入变化后必须复位为无选中（能力块 16 · E）"
  );
  // ⑤ Esc 清空
  await key("Escape");
  await sleep(300);
  assert((await ev(`document.querySelector("[data-search-input]").value`)) === "", "Esc 应清空输入");
});

peer.destroy();
peerDoc.destroy();
chrome.kill();
srv.kill();
console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);

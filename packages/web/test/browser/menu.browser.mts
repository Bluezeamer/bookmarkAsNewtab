#!/usr/bin/env node
// 能力块 10 · ③ 验收（浏览器）: 整条点击打开 / 右键菜单（键盘+焦点） / 移动到子菜单 / 图标去框 / 间距滑块落 CRDT
//
// 运行: pnpm --filter web test:browser:menu
//   未找到 Chrome 时自动跳过; 自举 server（esbuild + vite build + 临时 DATA_DIR + 随机端口）
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

const TOKEN = "menu-test-token";
const PORT = 24100 + (process.pid % 80);
const BASE = `http://127.0.0.1:${PORT}`;
const DEBUG_PORT = 9600 + (process.pid % 80);
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "bnt-menu-"));
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

// 先构建被测前端（server 托管 packages/web/dist; 不构建会验到过期产物）
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
  fm.set("fun", { name: "娱乐", parent: null, order: 1 });
  fm.set("dev2", { name: "开发子级", parent: "dev", order: 0 }); // 用于验证"不能挂到自己的子孙下"
  bm.set("a", node("示例站点 A", "https://a.example/p", "dev", 0));
  bm.set("b", node("示例站点 B", "https://b.example/p", "dev", 1));
  bm.set("c", node("示例站点 C", "https://c.example/p", "fun", 0));
});
await sleep(700);

const profile = mkdtempSync(path.join(os.tmpdir(), "bnt-menu-profile-"));
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
await rpc("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
const ev = async (expr, sid = sessionId) => {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await rpc("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sid);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "页面异常");
      return r.result?.value;
    } catch (e) {
      if (!/Execution context was destroyed|Cannot find context/.test(String(e.message))) throw e;
      await sleep(200);
    }
  }
  throw new Error("evaluate 重试耗尽");
};
const mouse = (type, x, y, extra = {}, sid = sessionId) =>
  rpc("Input.dispatchMouseEvent", { type, x, y, ...extra }, sid);
const key = async (k, extra = {}) => {
  const code = { Escape: "Escape", Enter: "Enter", Tab: "Tab", ArrowDown: "ArrowDown" }[k] ?? k;
  const vk = { Escape: 27, Enter: 13, Tab: 9, ArrowDown: 40 }[k] ?? 0;
  await rpc("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, ...extra }, sessionId);
  await rpc("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, ...extra }, sessionId);
};
const rectOf = async (sel, sid = sessionId) =>
  JSON.parse(
    (await ev(
      `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return "null";
         const r = el.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }); })()`
    )) ?? "null"
  );
const menuLabels = async (sid = sessionId) =>
  JSON.parse(
    await ev(
      `JSON.stringify([...document.querySelectorAll("[data-ctx-menu] [role=menuitem]")].map((b) => b.textContent.trim()))`,
      sid
    )
  );
const clickMenuItem = async (label, sid = sessionId) =>
  ev(
    `(() => { const b = [...document.querySelectorAll("[data-ctx-menu] [role=menuitem]")].find((x) => x.textContent.includes(${JSON.stringify(label)})); if (!b) return false; b.click(); return true; })()`,
    sid
  );

for (let i = 0; i < 60; i++) {
  if (await ev(`!!document.querySelector('[data-bk="a"]')`)) break;
  await sleep(250);
}
await sleep(600);

// M1 右键菜单: 出现 + 项集合 + Esc 关闭 + 焦点回到条目
await check("M1 右键菜单: 项集合正确, Esc 关闭且焦点回到条目", async () => {
  await ev(`document.querySelector('[data-bk="a"]').focus()`);
  const r = await rectOf('[data-bk="a"]');
  const x = r.x + Math.round(r.w / 2);
  const y = r.y + Math.round(r.h / 2);
  await mouse("mouseMoved", x, y, {});
  await mouse("mousePressed", x, y, { button: "right", clickCount: 1, buttons: 2 });
  await mouse("mouseReleased", x, y, { button: "right", clickCount: 1, buttons: 0 });
  await sleep(500);
  const open = await ev(`!!document.querySelector("[data-ctx-menu]")`);
  assert(open, "右键应打开上下文菜单");
  const labels = await menuLabels();
  for (const want of ["打开", "编辑", "移动到…", "复制链接", "删除"]) {
    assert(labels.some((l) => l.includes(want)), `菜单应含「${want}」，实际 ${JSON.stringify(labels)}`);
  }
  // 键盘: Esc 关闭 + 焦点回到触发条目
  await key("Escape");
  await sleep(300);
  assert(!(await ev(`!!document.querySelector("[data-ctx-menu]")`)), "Esc 应关闭菜单");
  const back = await ev(`document.querySelector('[data-bk="a"]')?.contains(document.activeElement) ?? false`);
  assert(back, "关闭后焦点应回到条目（或其后代）");
});

// M2 键盘可操作 + 移动到子菜单改 CRDT
await check("M2 菜单键盘操作 + 「移动到…」子菜单写入 CRDT", async () => {
  const r = await rectOf('[data-bk="c"]');
  await mouse("mouseMoved", r.x + 20, r.y + Math.round(r.h / 2), {});
  await mouse("mousePressed", r.x + 20, r.y + Math.round(r.h / 2), { button: "right", clickCount: 1, buttons: 2 });
  await mouse("mouseReleased", r.x + 20, r.y + Math.round(r.h / 2), { button: "right", clickCount: 1, buttons: 0 });
  await sleep(400);
  assert(await ev(`!!document.querySelector("[data-ctx-menu]")`), "菜单应打开");
  // 键盘走到「移动到…」并展开子菜单
  const labels = await menuLabels();
  const moveIdx = labels.findIndex((l) => l.includes("移动到"));
  for (let i = 0; i < moveIdx; i++) await key("ArrowDown");
  await key("ArrowRight"); // 展开子菜单
  await sleep(350);
  const sub = JSON.parse(
    await ev(
      `JSON.stringify([...document.querySelectorAll("[data-ctx-submenu] [role=menuitem]")].map((b) => b.textContent.trim()))`
    )
  );
  assert(sub.some((s) => s.includes("开发")), `子菜单应列出文件夹，实际 ${JSON.stringify(sub)}`);
  assert(sub.some((s) => s.includes("未分组")), `子菜单应含「未分组」，实际 ${JSON.stringify(sub)}`);
  await ev(
    `(() => { const b = [...document.querySelectorAll("[data-ctx-submenu] [role=menuitem]")].find((x) => x.textContent.includes("开发")); b.click(); return true; })()`
  );
  await sleep(600);
  assert(bm.get("c").get("folder") === "dev", `c 应移动到 dev，实际 ${bm.get("c").get("folder")}`);
  assert(!(await ev(`!!document.querySelector("[data-ctx-menu]")`)), "选择后菜单应关闭");
});

// M3 图标去框: 回退态用柔和同色底 + 衬线首字母, 且**无边框**
await check("M3 图标无外框（回退态: 无边框 + 衬线首字母）", async () => {
  const st = JSON.parse(
    await ev(`(() => {
      const el = document.querySelector('[data-bk="a"] .icon-tile') ?? document.querySelector('[data-bk="a"] span[style*="hsl"]');
      if (!el) return JSON.stringify({ found: false });
      const cs = getComputedStyle(el);
      return JSON.stringify({
        found: true,
        borderWidth: cs.borderTopWidth,
        borderStyle: cs.borderTopStyle,
        fontFamily: cs.fontFamily,
        fontWeight: cs.fontWeight,
        text: el.textContent.trim(),
      });
    })()`)
  );
  assert(st.found, "应找到首字母回退块（.icon-tile）");
  assert(st.borderStyle === "none" || Number.parseFloat(st.borderWidth) === 0, `回退块不得有边框（实际 ${st.borderWidth} ${st.borderStyle}）`);
  assert(/Iowan|Palatino|Georgia|serif/i.test(st.fontFamily), `首字母应用衬线（实际 ${st.fontFamily}）`);
  assert(st.fontWeight === "700", `首字母应为 700 字重（实际 ${st.fontWeight}）`);
  // 真实图标态（img）同样不得带边框/底色容器
  const img = JSON.parse(
    await ev(`(() => {
      const el = document.querySelector('[data-bk="a"] img');
      if (!el) return JSON.stringify({ found: false });
      const cs = getComputedStyle(el);
      return JSON.stringify({ found: true, borderWidth: cs.borderTopWidth, bg: cs.backgroundColor });
    })()`)
  );
  if (img.found) {
    assert(Number.parseFloat(img.borderWidth) === 0, `真实图标不得有边框（实际 ${img.borderWidth}）`);
  }
});

// M4 间距滑块: 写入 CRDT + 实测列/行间距变化
await check("M4 间距滑块写入 CRDT 并改变实测间距", async () => {
  await ev(`document.querySelector("[data-settings-open]").click()`);
  await sleep(500);
  // 切到卡片视图: .bk-grid 才是消费 gap 变量的网格（列表视图用行内 padding/间距）
  await ev(`document.querySelector('[data-view-btn="grid"]').click()`);
  await sleep(600);
  const before = JSON.parse(
    await ev(`(() => { const g = document.querySelector(".bk-grid"); const cs = getComputedStyle(g);
      return JSON.stringify({ col: cs.columnGap, row: cs.rowGap, varX: getComputedStyle(document.documentElement).getPropertyValue("--bnt-gap-x").trim(), varY: getComputedStyle(document.documentElement).getPropertyValue("--bnt-gap-y").trim() }); })()`)
  );
  const setRange = async (key, value) =>
    ev(`(() => {
      const el = document.querySelector('[data-gap-slider="${key}"]');
      if (!el) return false;
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      set.call(el, ${JSON.stringify(String(value))});
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
  assert(await setRange("gapX", 32), "应找到横向间距滑块");
  assert(await setRange("gapY", 6), "应找到纵向间距滑块");
  await sleep(700);
  const after = JSON.parse(
    await ev(`(() => { const g = document.querySelector(".bk-grid"); const cs = getComputedStyle(g);
      return JSON.stringify({ col: cs.columnGap, row: cs.rowGap, varX: getComputedStyle(document.documentElement).getPropertyValue("--bnt-gap-x").trim(), varY: getComputedStyle(document.documentElement).getPropertyValue("--bnt-gap-y").trim() }); })()`)
  );
  const settings = root.get("settings");
  assert(Number(settings?.get("gapX")) === 32, `CRDT settings.gapX 应为 32，实际 ${settings?.get("gapX")}`);
  assert(Number(settings?.get("gapY")) === 6, `CRDT settings.gapY 应为 6，实际 ${settings?.get("gapY")}`);
  assert(after.varX === "32px" && after.varY === "6px", `CSS 变量应更新，实际 ${after.varX}/${after.varY}`);
  assert(after.col !== before.col && after.row !== before.row, `实测间距应变化: ${before.col}/${before.row} → ${after.col}/${after.row}`);
  // 关闭设置抽屉: 必须确认已关（否则后续点击会落在遮罩上, 曾导致 M5 误判）
  await ev(`document.querySelector("[data-settings-close]")?.click()`);
  await sleep(500);
  assert(
    !(await ev(`!!document.querySelector("[data-settings-overlay]")`)),
    "设置抽屉应已关闭（后续点击不能被遮罩吃掉）"
  );
});

// M5 整条可点（空白区也打开链接）+ 长按不出链接（触摸路径由 M1 的右键等价覆盖）
await check("M5 整条可点: 空白区点击也解析到条目链接", async () => {
  await ev(`(() => { window.__clicks = []; document.addEventListener("click", (e) => {
      const a = e.target?.closest?.("a"); window.__clicks.push({ href: a?.href ?? null }); if (a) e.preventDefault(); }, true); return true; })()`);
  const r = await rectOf('[data-bk="a"]');
  // 取卡片中部偏右（避开标题文字; 空白区也必须可点）
  const x = r.x + r.w - 30;
  const y = r.y + Math.round(r.h / 2);
  const hit = await ev(`(() => { const t = document.elementFromPoint(${x}, ${y}); return t ? String(t.closest("a") ? "in-anchor" : "outside") : "null"; })()`);
  assert(hit === "in-anchor", `点击点应落在条目链接内（实际 ${hit}）`);
  await mouse("mouseMoved", x, y, {});
  await mouse("mousePressed", x, y, { button: "left", clickCount: 1, buttons: 1 });
  await mouse("mouseReleased", x, y, { button: "left", clickCount: 1, buttons: 0 });
  await sleep(500);
  const clicks = JSON.parse(await ev(`JSON.stringify(window.__clicks)`));
  assert(clicks.length > 0, "没有收到 click");
  assert(
    clicks.some((c) => (c.href ?? "").includes("a.example")),
    `空白区点击也应解析到条目链接，实际 ${JSON.stringify(clicks)}`
  );
});

// 新开一个应用 target（M5 会把原页面导航走; 后续用例各自需要一个干净页面）
const openApp = async () => {
  const { targetId } = await rpc("Target.createTarget", { url: `${BASE}/?token=${TOKEN}` });
  const { sessionId } = await rpc("Target.attachToTarget", { targetId, flatten: true });
  await rpc("Runtime.enable", {}, sessionId);
  await rpc(
    "Emulation.setDeviceMetricsOverride",
    { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
    sessionId
  );
  for (let i = 0; i < 80; i++) {
    if (await ev(`!!document.querySelector('[data-folder-row="dev"]')`, sessionId)) break;
    await sleep(250);
  }
  await sleep(700);
  return sessionId;
};

// M6 右键侧栏文件夹 → 编辑弹窗（能力块 19）: 改名 + 改归属, 归属下拉排除自身与子孙（防环）
// 放在收尾清理之前; M5 点击书签会把页面导航走 → 这里新开 target 重新加载应用
await check("M6 右键侧栏文件夹 → 编辑弹窗改名/改归属（下拉排除自身与子孙）+ 级联删除", async () => {
  // M5 点击书签会把页面导航走 → 新开一个 target（复用 helper 的 sid 参数）
  const s2 = await openApp();

  const r = await rectOf('[data-folder-row="dev"]', s2);
  const x = r.x + Math.round(r.w / 2);
  const y = r.y + Math.round(r.h / 2);
  await mouse("mouseMoved", x, y, {}, s2);
  await mouse("mousePressed", x, y, { button: "right", clickCount: 1, buttons: 2 }, s2);
  await mouse("mouseReleased", x, y, { button: "right", clickCount: 1, buttons: 0 }, s2);
  await sleep(500);
  const labels = await menuLabels(s2);
  assert(labels.some((l) => l.includes("编辑文件夹")), `文件夹菜单应含「编辑文件夹…」，实际 ${JSON.stringify(labels)}`);
  // 影响面必须**如实**（按当前 CRDT 真实状态算, 前面的用例可能已移动过书签）
  const subtree = new Set(["dev", "dev2"]);
  const want = [...root.get("bookmarks").values()].filter((n) => subtree.has(n.get("folder"))).length;
  assert(
    labels.some((l) => l.includes("删除文件夹") && l.includes(`${want} 条书签`) && l.includes("1 个子文件夹")),
    `删除项应如实告知级联影响面（${want} 条书签 + 1 个子文件夹），实际 ${JSON.stringify(labels)}`
  );

  assert(await clickMenuItem("编辑文件夹", s2), "应能点开「编辑文件夹…」");
  await sleep(500);
  assert(await ev(`!!document.querySelector("[data-folder-dialog]")`, s2), "应弹出文件夹编辑弹窗");
  assert((await ev(`document.querySelector("[data-folder-name]")?.value`, s2)) === "开发", "名称应预填当前值");
  const values = JSON.parse(
    await ev(
      `JSON.stringify([...document.querySelectorAll("[data-folder-parent] option")].map((o) => o.value))`
    , s2)
  );
  assert(!values.includes("dev"), `归属下拉不应含自身 dev，实际 ${JSON.stringify(values)}`);
  assert(!values.includes("dev2"), `归属下拉不应含子孙 dev2，实际 ${JSON.stringify(values)}`);
  assert(values.includes("") && values.includes("fun"), `归属下拉应含「顶层」与「娱乐」，实际 ${JSON.stringify(values)}`);

  // 改名 + 挂到「娱乐」下 → 保存
  await ev(`(() => {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const name = document.querySelector("[data-folder-name]");
    set.call(name, "开发改名");
    name.dispatchEvent(new Event("input", { bubbles: true }));
    const sel = document.querySelector("[data-folder-parent]");
    const sset = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
    sset.call(sel, "fun");
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`, s2);
  await sleep(300);
  await ev(`document.querySelector("[data-folder-save]").click()`, s2);
  await sleep(900);
  assert(!(await ev(`!!document.querySelector("[data-folder-dialog]")`, s2)), "保存后弹窗应关闭");
  const f = root.get("folders").get("dev");
  assert(f?.name === "开发改名", `CRDT 里名称应更新，实际 ${JSON.stringify(f)}`);
  assert(f?.parent === "fun", `CRDT 里归属应更新为 fun，实际 ${JSON.stringify(f)}`);
  assert(
    (await ev(`document.querySelector('[data-folder-row="dev"]')?.textContent ?? ""`, s2)).includes("开发改名"),
    "侧栏行应显示新名称"
  );

  // 级联删除（能力块 19 · 用户要求"连书签一起删除", 不是丢到未分类）: 先往 dev2 塞一条, 再删 dev2
  peerDoc.transact(() => {
    const n = new Y.Map();
    n.set("title", "将被级联删除");
    n.set("url", "https://gone.example/");
    n.set("folder", "dev2");
    n.set("order", 9);
    n.set("created", "2026-10-15T00:00:00Z");
    const m = new Y.Map();
    m.set("auto", new Y.Map());
    n.set("meta", m);
    root.get("bookmarks").set("gone", n);
  });
  await sleep(900);
  const r2 = await rectOf('[data-folder-row="dev2"]', s2);
  assert(r2, "侧栏应有子文件夹行 dev2");
  const x2 = r2.x + 20;
  const y2 = r2.y + Math.round(r2.h / 2);
  await mouse("mouseMoved", x2, y2, {}, s2);
  await mouse("mousePressed", x2, y2, { button: "right", clickCount: 1, buttons: 2 }, s2);
  await mouse("mouseReleased", x2, y2, { button: "right", clickCount: 1, buttons: 0 }, s2);
  await sleep(500);
  assert(await clickMenuItem("删除文件夹", s2), "应能点「删除文件夹」");
  await sleep(900);
  assert(!root.get("folders").has("dev2"), "dev2 应被删除");
  assert(!root.get("bookmarks").has("gone"), "dev2 里的书签应被**一起删除**（而不是回未分组）");
  assert(
    [...root.get("bookmarks").values()].every((n) => n.get("url") !== "https://gone.example/"),
    "不得把书签挪到未分组"
  );
});

// M7 右键文件夹 → 新建子文件夹（能力块 19 增补）: 落 CRDT 且父夹正确、侧栏立即可见
await check("M7 右键文件夹 → 新建子文件夹（父夹正确 + 侧栏可见）", async () => {
  const s3 = await openApp();
  const r = await rectOf('[data-folder-row="dev"]', s3);
  assert(r, "侧栏应有文件夹行 dev");
  const x = r.x + Math.round(r.w / 2);
  const y = r.y + Math.round(r.h / 2);
  await mouse("mouseMoved", x, y, {}, s3);
  await mouse("mousePressed", x, y, { button: "right", clickCount: 1, buttons: 2 }, s3);
  await mouse("mouseReleased", x, y, { button: "right", clickCount: 1, buttons: 0 }, s3);
  await sleep(500);
  const labels = await menuLabels(s3);
  assert(labels.some((l) => l.includes("新建子文件夹")), `菜单应含「新建子文件夹…」，实际 ${JSON.stringify(labels)}`);
  assert(await clickMenuItem("新建子文件夹", s3), "应能点开「新建子文件夹…」");
  await sleep(500);
  assert(
    (await ev(`document.querySelector("[data-folder-dialog]")?.getAttribute("data-folder-dialog-mode")`, s3)) === "create",
    "应是新建模式的弹窗"
  );
  assert((await ev(`document.querySelector("[data-folder-name]")?.value`, s3)) === "", "新建时名称应为空");
  assert(
    (await ev(`document.querySelector("[data-folder-parent]")?.value`, s3)) === "dev",
    "归属应预选被右键的那个夹"
  );
  await ev(
    `(() => {
      const el = document.querySelector("[data-folder-name]");
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      set.call(el, "M7 新夹");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`,
    s3
  );
  await sleep(200);
  await ev(`document.querySelector("[data-folder-save]").click()`, s3);
  await sleep(900);
  assert(!(await ev(`!!document.querySelector("[data-folder-dialog]")`, s3)), "新建后弹窗应关闭");
  const created = [...root.get("folders").entries()].find(([, v]) => v?.name === "M7 新夹");
  assert(created, `CRDT 里应出现新夹，实际 ${JSON.stringify([...root.get("folders").values()].map((v) => v?.name))}`);
  assert(created[1].parent === "dev", `新夹的父应为 dev，实际 ${JSON.stringify(created[1])}`);
  const shown = await ev(
    `[...document.querySelectorAll("[data-folder-row]")].some((e) => (e.textContent || "").includes("M7 新夹"))`,
    s3
  );
  assert(shown, "新夹应立刻出现在侧栏树里");
});


peer.destroy();
peerDoc.destroy();
chrome.kill();
srv.kill();
console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);

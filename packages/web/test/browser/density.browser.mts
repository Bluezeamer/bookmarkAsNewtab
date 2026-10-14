#!/usr/bin/env node
// 能力块 8 验收（浏览器）: 密度三档尺寸 / 宽屏列表双列 / 图标格去空留 / 拖拽原位不留副本
//
// 运行: pnpm --filter web test:browser:density
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

const TOKEN = "density-test-token";
const PORT = 23800 + (process.pid % 150);
const BASE = `http://127.0.0.1:${PORT}`;
const DEBUG_PORT = 9800 + (process.pid % 150);
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "bnt-density-"));
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
  for (let i = 0; i < 12; i++) {
    bm.set(`b${i}`, node(`书签 ${i} 标题`, `https://site${i}.example/path/page`, "dev", i));
  }
});
await sleep(600);

const profile = mkdtempSync(path.join(os.tmpdir(), "bnt-density-profile-"));
const chrome = spawn(CHROME, ["--headless", "--no-sandbox",
    "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run",
  `--user-data-dir=${profile}`, `--remote-debugging-port=${DEBUG_PORT}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
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
const ev = async (expr) => {
  for (let i = 0; i < 25; i++) {
    try {
      const r = await rpc("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "页面异常");
      return r.result?.value;
    } catch (e) {
      if (/context was destroyed|Cannot find context|navigated/i.test(String(e))) {
        await sleep(300);
        continue;
      }
      throw e;
    }
  }
  throw new Error("页面上下文不可用");
};
const mouse = (type, x, y, extra = {}) =>
  rpc("Input.dispatchMouseEvent", { type, x, y, button: "left", ...extra }, sessionId);

await ev(`new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error("首屏超时")),15000);const iv=setInterval(()=>{if(document.querySelectorAll("[data-bk]").length>=12){clearInterval(iv);clearTimeout(t);res(1)}},200)})`);
console.log("PASS T0 首屏渲染 12 条");

// 切设置（视图/密度）
const applySettings = async (patch) => {
  await ev(`(async()=>{
    document.querySelector("[data-settings-open]").click();
    await new Promise(r=>setTimeout(r,150));
    ${Object.entries(patch)
      .map(([k, v]) => {
        const sel =
          k === "view" ? `[data-view-btn="${v}"]` : k === "density" ? `[data-density-btn="${v}"]` : "";
        return `document.querySelector('${sel}')?.click();`;
      })
      .join("")}
    await new Promise(r=>setTimeout(r,200));
    document.querySelector("[data-settings-close]").click();
    return 1;
  })()`);
  await sleep(600);
};

const rowH = async () =>
  Number(await ev(`Math.round(document.querySelector("[data-bk]").getBoundingClientRect().height)`));
const iconCellH = async () =>
  Number(await ev(`Math.round(document.querySelector("[data-bk]").getBoundingClientRect().height)`));

await check("T1 三档密度: 列表行高单调递增且显著低于原实现(106px)", async () => {
  await applySettings({ view: "list" });
  const heights = {};
  for (const d of ["compact", "cozy", "comfortable"]) {
    await applySettings({ density: d });
    heights[d] = await rowH();
  }
  assert(heights.compact < heights.cozy && heights.cozy < heights.comfortable, `应单调: ${JSON.stringify(heights)}`);
  assert(heights.cozy <= 80, `标准档行高应 ≤80（原 106）, 实际 ${heights.cozy}`);
  console.log(`   列表行高: ${JSON.stringify(heights)}`);
});

await check("T1b 触摸目标 ≥44px（手机档 + 触摸平板；长按菜单为新的操作入口）", async () => {
  try {
    await rpc("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, sessionId);
    for (const [w, h, mobile] of [
      [375, 760, true],
      [768, 900, true],
    ]) {
      await rpc("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile }, sessionId);
      await sleep(600);
      // 能力块 10 · ③: 常驻操作按钮已移除, 触摸路径 = 条目本身（可点可长按） + 长按菜单项
      const rows = JSON.parse(
        await ev(`JSON.stringify([...document.querySelectorAll("[data-bk]")].map((e) => Math.round(e.getBoundingClientRect().height)))`)
      );
      assert(rows.length > 0, `宽度 ${w} 下应能取到条目`);
      const small = rows.filter((n) => n < 44);
      assert(small.length === 0, `宽度 ${w}（触摸）下条目触摸目标应 ≥44px, 实际 ${JSON.stringify(rows.slice(0, 6))}`);

      // 长按 ≥500ms → 打开上下文菜单（触摸端唯一入口）
      const box = JSON.parse(
        await ev(`(() => { const r = document.querySelector("[data-bk]").getBoundingClientRect();
          return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); })()`)
      );
      await rpc(
        "Input.dispatchTouchEvent",
        { type: "touchStart", touchPoints: [{ x: box.x, y: box.y }] },
        sessionId
      );
      await sleep(800); // > 500ms 长按阈值
      await rpc("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, sessionId);
      await sleep(400);
      const menu = JSON.parse(
        await ev(`JSON.stringify([...document.querySelectorAll("[data-ctx-menu] [role=menuitem]")].map((b) => Math.round(b.getBoundingClientRect().height)))`)
      );
      assert(menu.length >= 5, `宽度 ${w} 长按应打开上下文菜单（实际 ${JSON.stringify(menu)}）`);
      const menuSmall = menu.filter((n) => n < 44);
      assert(menuSmall.length === 0, `宽度 ${w} 菜单项应 ≥44px, 实际 ${JSON.stringify(menu)}`);
      await rpc(
        "Input.dispatchKeyEvent",
        { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
        sessionId
      );
      await rpc(
        "Input.dispatchKeyEvent",
        { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
        sessionId
      );
      await sleep(300);
      assert(!(await ev(`!!document.querySelector("[data-ctx-menu]")`)), `宽度 ${w} Esc 应关闭菜单`);
    }
  } finally {
    // 必须恢复视口: 否则后续 check 会在手机宽度下运行（曾导致 T3/T5 级联误报）
    await rpc("Emulation.setTouchEmulationEnabled", { enabled: false }, sessionId);
    await rpc("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await sleep(500);
  }
});

await check("T2 密度写入 CRDT（多端一致）", async () => {
  await applySettings({ density: "compact" });
  await sleep(400);
  assert(peerDoc.getMap("").get("settings").get("density") === "compact", "对端应读到 density=compact");
});

await check("T3 1440px 列表两列且为 row-major", async () => {
  await applySettings({ density: "cozy", view: "list" });
  const r = JSON.parse(
    await ev(`(()=>{const els=[...document.querySelectorAll('[data-group="dev"] [data-bk]')];const a=els[0].getBoundingClientRect(),b=els[1].getBoundingClientRect();return JSON.stringify({sameRow:Math.abs(a.y-b.y)<4,secondToRight:b.x>a.x+50,cols:new Set(els.slice(0,4).map(e=>Math.round(e.getBoundingClientRect().y))).size})})()`)
  );
  assert(r.sameRow && r.secondToRight, `两列且 row-major（第 2 项应在第 1 项右侧）, 实际 ${JSON.stringify(r)}`);
});

await check("T4 仅图标视图: 单元格高度大幅下降（原 180px）", async () => {
  await applySettings({ view: "icons", density: "cozy" });
  const h = await iconCellH();
  assert(h <= 130, `图标格高度应 ≤130（原 180）, 实际 ${h}`);
  console.log(`   图标格高度: ${h}px`);
});

await check("T5 拖动中列表里不再有被拖卡片（只在插入位留占位）", async () => {
  await applySettings({ view: "grid", density: "cozy" });
  const box = async (sel) => JSON.parse(await ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});const r=el.getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height})})()`));
  const a = await box('[data-bk="b0"]');
  const c = await box('[data-bk="b2"]');
  // 按在卡片内的非交互区域（左下角图标/内边距处）: 标题是链接、右侧是操作按钮, 中心可能落在它们上
  await mouse("mousePressed", Math.round(a.x + 10), Math.round(a.y + a.h - 10), { clickCount: 1, buttons: 1 });
  await sleep(60);
  for (let i = 1; i <= 8; i++) {
    await mouse("mouseMoved", Math.round(a.x + 10 + ((c.x + c.w * 0.8 - (a.x + 10)) * i) / 8), Math.round(a.y + a.h - 10), { buttons: 1 });
    await sleep(40);
  }
  await sleep(250);
  const mid = JSON.parse(
    await ev(`JSON.stringify({
      hiddenFromLayout: document.querySelector('[data-bk="b0"]')?.offsetParent === null,
      slot: !!document.querySelector("[data-dnd-placeholder]"),
      visibleCards: [...document.querySelectorAll("[data-bk]")].filter((e)=>e.offsetParent !== null).length,
    })`)
  );
  assert(mid.hiddenFromLayout, "被拖卡片应不在布局中（不再有小尾巴/副本）");
  assert(mid.slot, "插入位应有占位槽");
  assert(mid.visibleCards === 11, `可见卡片应为 11（12-1 被拖）, 实际 ${mid.visibleCards}`);
  await mouse("mouseReleased", Math.round(c.x + c.w * 0.8), Math.round(c.y + c.h - 10), { clickCount: 1, buttons: 0 });
  await sleep(900);
  const ids = [...bm.entries()]
    .filter(([, v]) => v.get("folder") === "dev")
    .sort((x, y) => x[1].get("order") - y[1].get("order"))
    .map(([id]) => id);
  assert(ids[0] === "b1" && ids[2] === "b0", `落定顺序应把 b0 移到第 3 位, 实际 ${ids.slice(0, 4).join(",")}`);
});

peer.destroy();
peerDoc.destroy();
chrome.kill();
srv.kill();
console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);

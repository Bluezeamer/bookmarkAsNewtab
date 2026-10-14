#!/usr/bin/env node
// 能力块 7 · I3 拖拽的浏览器端验收（CDP 驱动真实 Chrome + 真实 server）
//
// 运行: pnpm --filter web test:browser
//   - 未找到 Chrome 时自动跳过（退出 0）, 因此可在无浏览器的 CI 上安全存在
//   - 自举: esbuild 编译 server 单文件 bundle → 临时 DATA_DIR + 随机端口 → 跑完清理
//
// 覆盖: 两轴落点 / 让位预览 / 浮动副本与抬起态 / Esc 取消 / 拖到分组标题移夹 /
//       跨夹落定后 **UI 与 CRDT 一致**（review 阻塞项回归） / Alt+↓ 键盘重排
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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
  console.log("SKIP: 未找到 Chrome（可用 CHROME_BIN 指定路径；CI 无浏览器时本项跳过）");
  process.exit(0);
}

const TOKEN = "browser-test-token";
const PORT = 23500 + (process.pid % 200);
const BASE = `http://127.0.0.1:${PORT}`;
const DEBUG_PORT = 9600 + (process.pid % 200);
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "bnt-dnd-"));
const SHOTS = mkdtempSync(path.join(os.tmpdir(), "bnt-dnd-shots-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let total = 0;
let failed = 0;
const ok = (m) => console.log(`PASS ${m}`);
async function check(name, fn) {
  total++;
  try {
    await fn();
    ok(name);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}: ${e.message}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// ---- 自举 server（与其它集成测试同款: esbuild 单文件 CJS bundle） ----
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
    console.error("FAIL server 未在 10s 内就绪");
    process.exit(1);
  }
  await sleep(100);
}

// ---- 种数据 ----
const peerDoc = new Y.Doc();
const peer = new WebsocketProvider(`ws://127.0.0.1:${PORT}`, `ws?token=${TOKEN}`, peerDoc);
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("对端 bootstrap 超时")), 10000);
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
const settings = root.get("settings");
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
  fm.set("life", { name: "生活", parent: null, order: 1 });
  bm.set("A", node("AAA", "https://a.example", "dev", 0));
  bm.set("B", node("BBB", "https://b.example", "dev", 1));
  bm.set("C", node("CCC", "https://c.example", "dev", 2));
  bm.set("L", node("LLL", "https://l.example", "life", 0));
  settings.set("view", "grid"); // 卡片视图（宽卡, 便于两轴落点）
});
await sleep(600);
const orderOf = () =>
  ["A", "B", "C"].map((id) => `${id}:${bm.get(id).get("order")}`).join(" ");
ok(`T0 已种入数据（卡片视图）; 初始顺序 ${orderOf()}`);

// ---- Chrome ----
const profile = mkdtempSync(path.join(os.tmpdir(), "bnt-dnd-profile-"));
const chrome = spawn(
  CHROME,
  ["--headless", "--no-sandbox",
    "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
   `--user-data-dir=${profile}`, `--remote-debugging-port=${DEBUG_PORT}`, "about:blank"],
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
  console.error("FAIL Chrome 调试端口未就绪");
  srv.kill();
  chrome.kill();
  process.exit(1);
}

let msgId = 0;
const pending = new Map();
const ws = new WebSocket(version.webSocketDebuggerUrl);
ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  }
};
const rpc = (method, params = {}, sessionId) => {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
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
const boxOf = async (sel) =>
  JSON.parse(
    await ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return "null";const r=el.getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height})})()`)
  );
const mouse = (type, x, y, extra = {}) =>
  rpc("Input.dispatchMouseEvent", { type, x, y, button: "left", ...extra }, sessionId);
const keyEvent = (type, key, code, vk, modifiers = 0) =>
  rpc("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: vk, modifiers }, sessionId);

// 按下点统一取卡片内的安全区（避开标题链接与操作按钮）
function safeGrab(b) {
  return { x: Math.round(b.x + 10), y: Math.round(b.y + b.h - 10) };
}

async function dragSteps(from, to, steps = 8) {
  await mouse("mousePressed", from.x, from.y, { clickCount: 1, buttons: 1 });
  await sleep(60);
  for (let i = 1; i <= steps; i++) {
    await mouse("mouseMoved", Math.round(from.x + ((to.x - from.x) * i) / steps), Math.round(from.y + ((to.y - from.y) * i) / steps), { buttons: 1 });
    await sleep(40);
  }
}
const shot = async (name) =>
  writeFileSync(path.join(SHOTS, name), Buffer.from((await rpc("Page.captureScreenshot", { format: "png" }, sessionId)).data, "base64"));

// UI 顺序（DOM） vs CRDT 顺序: 用于"跨夹落定后不失同步"的不变量断言
const domOrderOf = async (groupId) =>
  await ev(`[...document.querySelectorAll('[data-group="${groupId}"] [data-bk]')].map(e=>e.getAttribute("data-bk")).join(",")`);
const docOrderOf = (folderId) =>
  [...bm.entries()]
    .filter(([, v]) => v.get("folder") === folderId)
    .sort((a, b) => a[1].get("order") - b[1].get("order"))
    .map(([id]) => id)
    .join(",");

await ev(`new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error("首屏超时")),15000);const iv=setInterval(()=>{if(document.querySelectorAll("[data-bk]").length>=4){clearInterval(iv);clearTimeout(t);res(1)}},200)})`).catch((e) => {
  console.error(`FAIL T1 首屏: ${e.message}`);
  failed++;
});

await check("T1 两轴落点: 拖 A 到 C 右半边 → 落定为 B,C,A", async () => {
  const a = await boxOf('[data-bk="A"]');
  const c = await boxOf('[data-bk="C"]');
  const from = safeGrab(a);
  const to = { x: Math.round(c.x + c.w * 0.8), y: Math.round(c.y + c.h / 2) };
  await dragSteps(from, to);
  await sleep(250); // 等占位槽渲染（React 状态更新是异步的）
  const mid = JSON.parse(
    await ev(`JSON.stringify({
      ghost: !!document.querySelector("[data-dnd-ghost]"),
      dragging: document.querySelector('[data-bk="A"]')?.getAttribute("data-dragging") === "true",
      slot: !!document.querySelector("[data-dnd-placeholder]"),
      slotIndex: [...document.querySelectorAll('[data-group="dev"] > *')].findIndex((el) => el.hasAttribute("data-dnd-placeholder") || el.querySelector?.("[data-dnd-placeholder]")),
      ghostInlineTransform: (document.querySelector("[data-dnd-ghost]")?.getAttribute("style") ?? "").includes("transform"),
      domOrder: [...document.querySelectorAll('[data-group="dev"] [data-bk]')].map((e) => e.getAttribute("data-bk")).join(","),
    })`)
  );
  const ghostProbe = JSON.parse(
    await ev(`(()=>{const g=document.querySelector("[data-dnd-ghost]");if(!g)return "{}";const r=g.getBoundingClientRect();const cs=getComputedStyle(g);return JSON.stringify({x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),z:cs.zIndex,op:cs.opacity,tr:cs.transform.slice(0,40),vis:cs.visibility,disp:cs.display,})})()`)
  );
  assert(mid.ghost, "拖动中应有浮动副本（DOM 克隆）");
  assert(ghostProbe.w > 0 && ghostProbe.h > 0, `浮动副本应有尺寸, 实际 ${JSON.stringify(ghostProbe)}`);
  assert(ghostProbe.disp !== "none" && ghostProbe.vis !== "hidden", `浮动副本应可见, 实际 ${JSON.stringify(ghostProbe)}`);
  assert(
    ghostProbe.tr !== "none" && !ghostProbe.tr.startsWith("matrix(1, 0, 0, 1, 0, 0)"),
    `浮动副本应已跟随指针位移（transform 不得为单位阵/被覆盖）, 实际 ${ghostProbe.tr}`
  );
  assert(mid.dragging, "被拖卡应为抬起态");
  if (!mid.slot) {
    const dbg = await ev(`JSON.stringify({
      placeholders: document.querySelectorAll("[data-dnd-placeholder]").length,
      draggingIds: [...document.querySelectorAll("[data-dragging]")].map((e)=>e.getAttribute("data-bk")),
      groups: [...document.querySelectorAll("[data-group]")].map((e)=>e.getAttribute("data-group")),
      itemsContainers: [...document.querySelectorAll("[data-items-group]")].map((e)=>e.getAttribute("data-items-group") + "|dragFolder=" + e.getAttribute("data-drag-folder") + "|dropIndex=" + e.getAttribute("data-drop-index")),
      ghost: !!document.querySelector("[data-dnd-ghost]"),
    })`);
    throw new Error(`拖动中应有目标槽位占位; 诊断=${dbg}`);
  }
  assert(mid.domOrder === "A,B,C", `拖动中真实列表 DOM 顺序必须保持稳定（反频闪）, 实际 ${mid.domOrder}`);
  console.log(`   浮动副本: ${JSON.stringify(ghostProbe)}`);
  await shot("mid-drag.png");
  await mouse("mouseReleased", to.x, to.y, { clickCount: 1, buttons: 0 });
  await sleep(900);
  assert(orderOf() === "A:2 B:0 C:1", `落定顺序应为 A:2 B:0 C:1, 实际 ${orderOf()}`);
});

await check("T2 Esc 取消: 顺序不变", async () => {
  const before = orderOf();
  const b = await boxOf('[data-bk="B"]');
  const bGrab = safeGrab(b);
  await dragSteps(bGrab, { x: bGrab.x + 160, y: bGrab.y + 120 }, 6);
  await keyEvent("rawKeyDown", "Escape", "Escape", 27);
  await keyEvent("keyUp", "Escape", "Escape", 27);
  await mouse("mouseReleased", bGrab.x + 160, bGrab.y + 120, { clickCount: 1, buttons: 0 });
  await sleep(800);
  assert(orderOf() === before, `Esc 后应保持 ${before}, 实际 ${orderOf()}`);
});

await check("T3 跨夹 + 组内预览后落定: UI 与 CRDT 一致（review 阻塞项回归）", async () => {
  // ① 先在源组内拖动 A（改变预览顺序, 但不松手）
  const a = await boxOf('[data-bk="A"]');
  const c = await boxOf('[data-bk="C"]');
  const aGrab = safeGrab(a);
  await dragSteps(aGrab, { x: Math.round(c.x + c.w * 0.8), y: Math.round(c.y + c.h / 2) });
  await sleep(200);
  // ② 不停手, 直接移到目标分组标题并松手
  const life = await boxOf('[data-drop-group="life"]');
  const target = { x: Math.round(life.x + life.w / 2), y: Math.round(life.y + life.h / 2) };
  for (let i = 1; i <= 6; i++) {
    await mouse("mouseMoved", Math.round(c.x + c.w * 0.8 + ((target.x - (c.x + c.w * 0.8)) * i) / 6), Math.round(c.y + c.h / 2 + ((target.y - (c.y + c.h / 2)) * i) / 6), { buttons: 1 });
    await sleep(40);
  }
  await mouse("mouseReleased", target.x, target.y, { clickCount: 1, buttons: 0 });
  await sleep(1000);

  assert(bm.get("A").get("folder") === "life", `A 应移入 life, 实际 ${bm.get("A").get("folder")}`);
  const lifeOrders = [...bm.entries()].filter(([, v]) => v.get("folder") === "life").map(([, v]) => v.get("order"));
  assert(bm.get("A").get("order") === Math.max(...lifeOrders), `A 应落在目标组末尾（order=${bm.get("A").get("order")}, life=${JSON.stringify(lifeOrders)}）`);
  // 不变量: 两个分组的 DOM 顺序都要与 CRDT 顺序一致（预览若悬挂就会在这里暴露）
  const devDom = await domOrderOf("dev");
  const lifeDom = await domOrderOf("life");
  assert(devDom === docOrderOf("dev"), `源组 UI 顺序(${devDom}) 应等于 CRDT 顺序(${docOrderOf("dev")})`);
  assert(lifeDom === docOrderOf("life"), `目标组 UI 顺序(${lifeDom}) 应等于 CRDT 顺序(${docOrderOf("life")})`);
});

await check("T4 Alt+↓ 键盘重排", async () => {
  const before = [bm.get("A").get("order"), bm.get("L").get("order")].join(",");
  await ev(`document.querySelector('[data-bk="L"]').focus()`);
  await keyEvent("rawKeyDown", "ArrowDown", "ArrowDown", 40, 1);
  await keyEvent("keyUp", "ArrowDown", "ArrowDown", 40, 1);
  await sleep(700);
  const after = [bm.get("A").get("order"), bm.get("L").get("order")].join(",");
  assert(before !== after, `Alt+↓ 应改变顺序（仍是 ${after}）`);
});

// T5 点击条目任意处都必须打开链接（能力块 10 · ③: 整条 = 链接; 回归: pointerdown 捕获会把 click 重定向）
await check("T5 点击卡片标题: click 落在 <a> 上并可打开链接", async () => {
  await ev(`(() => {
    window.__clicks = [];
    document.addEventListener("click", (e) => {
      const a = e.target?.closest?.("a");
      window.__clicks.push({ tag: e.target?.tagName ?? "?", href: a?.getAttribute("href") ?? null });
      if (a) e.preventDefault(); // 不真的开新标签页, 只验证链路
    }, true);
    return true;
  })()`);
  const box = JSON.parse(
    (await ev(
      `(() => { const el = document.querySelector('[data-bk="A"]'); const r = el.getBoundingClientRect();
         // 取右下角空白区（避开标题文字与操作入口）, 验证"整条可点"而不是只有标题可点
         return JSON.stringify({ x: Math.round(r.right - 14), y: Math.round(r.bottom - 14) }); })()`
    )) ?? "null"
  );
  assert(box, "找不到条目");
  await mouse("mouseMoved", box.x, box.y, {});
  await mouse("mousePressed", box.x, box.y, { button: "left", clickCount: 1, buttons: 1 });
  await mouse("mouseReleased", box.x, box.y, { button: "left", clickCount: 1, buttons: 0 });
  await sleep(500);
  const clicks = JSON.parse(await ev("JSON.stringify(window.__clicks)"));
  assert(clicks.length > 0, "没有收到 click");
  // 整条是 <a> 时, click 目标可能是内部 SPAN —— 只要 closest("a") 能解析到链接即算通过
  assert(
    clicks.some((c) => c.href),
    `click 应解析到条目链接（closest a 带 href），实际 ${JSON.stringify(clicks)}`
  );
  const shape = JSON.parse(
    await ev(`(() => { const el = document.querySelector('[data-bk="A"]');
      return JSON.stringify({ tag: el.tagName, href: el.tagName === "A" ? el.getAttribute("href") : el.querySelector("a")?.getAttribute("href") }); })()`)
  );
  assert(shape.href, `条目自身或其后代应带 href（实际 ${JSON.stringify(shape)}）`);
});

// T6 落定动画起点 = 手松开的位置（回归: 被拖卡片 display:none → captureRects 记到 (0,0) → 从左上角飘）
await check("T6 落定动画从释放位置开始（不是左上角）", async () => {
  const a = await boxOf('[data-bk="A"]');
  const c = await boxOf('[data-bk="C"]');
  const from = safeGrab(a);
  const to = { x: Math.round(c.x + c.w * 0.8), y: Math.round(c.y + c.h / 2) };
  await mouse("mousePressed", from.x, from.y, { clickCount: 1, buttons: 1 });
  await sleep(60);
  for (let i = 1; i <= 8; i++) {
    await mouse("mouseMoved", Math.round(from.x + ((to.x - from.x) * i) / 8), Math.round(from.y + ((to.y - from.y) * i) / 8), { buttons: 1 });
    await sleep(40);
  }
  await sleep(150);
  // 释放前记录幽灵副本的位置（= 用户松手的位置）
  const ghost = JSON.parse(
    await ev(`(() => { const g = document.querySelector("[data-dnd-ghost]");
      if (!g) return "null"; const r = g.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }); })()`)
  );
  assert(ghost, "拖动中应有幽灵副本");
  await mouse("mouseReleased", to.x, to.y, { clickCount: 1, buttons: 0 });
  // 立刻读落定动画的起始位移（200ms 动画, 必须趁它还在跑）
  const anim = JSON.parse(
    await ev(`(() => {
      const el = document.querySelector('[data-bk="A"]');
      const list = el?.getAnimations?.() ?? [];
      if (!list.length) return JSON.stringify({ none: true });
      const kf = list[0].effect.getKeyframes();
      const first = String(kf[0].transform || "");
      const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(first);
      const r = el.getBoundingClientRect();
      return JSON.stringify({ none: false, startX: Math.round(r.left + (m ? Number(m[1]) : 0)), startY: Math.round(r.top + (m ? Number(m[2]) : 0)) });
    })()`)
  );
  assert(!anim.none, "落定后应有落位动画");
  const dx = Math.abs(anim.startX - ghost.x);
  const dy = Math.abs(anim.startY - ghost.y);
  assert(dx <= 24 && dy <= 24, `动画起点应≈释放点（释放 ${ghost.x},${ghost.y} vs 起点 ${anim.startX},${anim.startY}）`);
  assert(!(anim.startX <= 4 && anim.startY <= 4), "动画起点不得是页面左上角 (0,0)");
  await sleep(400);
});

// T7 书签直接拖到侧栏文件夹行 = 改归属（能力块 12 · ②）
await check("T7 拖书签到侧栏文件夹行: 行高亮 + 落定改归属", async () => {
  // 先让 A 回到 dev（前面的用例可能已改过归属）
  peerDoc.transact(() => {
    bm.get("A").set("folder", "dev");
    bm.get("A").set("order", 0);
  });
  await sleep(600);
  const a = await boxOf('[data-bk="A"]');
  const row = await boxOf('[data-folder-row="life"]');
  assert(row, "侧栏应有 life 行");
  const from = safeGrab(a);
  const to = { x: Math.round(row.x + row.w * 0.5), y: Math.round(row.y + row.h / 2) };
  await mouse("mousePressed", from.x, from.y, { clickCount: 1, buttons: 1 });
  await sleep(60);
  for (let i = 1; i <= 8; i++) {
    await mouse("mouseMoved", Math.round(from.x + ((to.x - from.x) * i) / 8), Math.round(from.y + ((to.y - from.y) * i) / 8), { buttons: 1 });
    await sleep(40);
  }
  await sleep(250);
  // 拖动中: 侧栏行应高亮（拖拽引擎直接写 DOM 属性, 无 React 状态）
  const highlighted = await ev(`document.querySelector('[data-folder-row="life"]').hasAttribute("data-bk-drop")`);
  assert(highlighted, "拖到侧栏行上方时应高亮该行");
  await mouse("mouseReleased", to.x, to.y, { clickCount: 1, buttons: 0 });
  await sleep(900);
  assert(bm.get("A").get("folder") === "life", `A 应改归属到 life（实际 ${bm.get("A").get("folder")}）`);
  const lifeOrders = [...bm.entries()].filter(([, v]) => v.get("folder") === "life").map(([, v]) => v.get("order"));
  assert(
    bm.get("A").get("order") === Math.max(...lifeOrders),
    `落到目标夹末尾（A.order=${bm.get("A").get("order")}, life=${JSON.stringify(lifeOrders)}）`
  );
  assert(
    !(await ev(`document.querySelector('[data-folder-row="life"]').hasAttribute("data-bk-drop")`)),
    "落定后应清掉行高亮"
  );
});

// T8 拖到侧栏「未分组」行 = 移出文件夹（folder = null）
await check("T8 拖书签到侧栏「未分组」行: 归属置空", async () => {
  // 能力块 15 · D: 未分组为空时该行隐藏（避免视觉噪音）→ 先放一条未分组书签让它存在
  peerDoc.transact(() => {
    const n = new Y.Map();
    n.set("title", "未分组占位");
    n.set("url", "https://unfiled.example/");
    n.set("folder", null);
    n.set("order", 99);
    n.set("created", "2026-10-15T00:00:00Z");
    bm.set("unfiled", n);
  });
  await sleep(600);
  const a = await boxOf('[data-bk="A"]');
  const row = await boxOf('[data-folder-row="root"]');
  assert(row, "侧栏应有「未分组」行");
  const from = safeGrab(a);
  const to = { x: Math.round(row.x + row.w * 0.5), y: Math.round(row.y + row.h / 2) };
  await mouse("mousePressed", from.x, from.y, { clickCount: 1, buttons: 1 });
  await sleep(60);
  for (let i = 1; i <= 8; i++) {
    await mouse("mouseMoved", Math.round(from.x + ((to.x - from.x) * i) / 8), Math.round(from.y + ((to.y - from.y) * i) / 8), { buttons: 1 });
    await sleep(40);
  }
  await sleep(200);
  await mouse("mouseReleased", to.x, to.y, { clickCount: 1, buttons: 0 });
  await sleep(900);
  assert(bm.get("A").get("folder") === null, `A 应变为未分组（实际 ${bm.get("A").get("folder")}）`);
});

peer.destroy();
peerDoc.destroy();
chrome.kill();
srv.kill();
console.log(`\n${total - failed}/${total} passed（截图: ${SHOTS}）`);
process.exit(failed ? 1 : 0);

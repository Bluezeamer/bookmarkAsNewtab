#!/usr/bin/env node
// 能力块 9 · I1 验收（浏览器）: 侧栏视口等高 / 树层级与折叠 / 文件夹拖拽改父级 / 同层排序 / 防环
//
// 运行: pnpm --filter web test:browser:sidebar
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

const TOKEN = "sidebar-test-token";
const PORT = 23900 + (process.pid % 90);
const BASE = `http://127.0.0.1:${PORT}`;
const DEBUG_PORT = 9900 + (process.pid % 90);
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "bnt-sidebar-"));
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

// 数据: 顶层 dev(开发) / fun(娱乐) / bar(书签栏); dev 下嵌 nest(前端)
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
const node = (title, folder, order) => {
  const n = new Y.Map();
  n.set("title", title);
  n.set("url", `https://${folder}${order}.example/p`);
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
  fm.set("bar", { name: "书签栏", parent: null, order: 2 });
  fm.set("nest", { name: "前端", parent: "dev", order: 0 });
  bm.set("u0", node("未分组条目 A", null, 0));
  bm.set("u1", node("未分组条目 B", null, 1));
  bm.set("d0", node("开发条目", "dev", 0));
  bm.set("n0", node("前端条目", "nest", 0));
  bm.set("f0", node("娱乐条目", "fun", 0));
  bm.set("b0", node("书签栏条目", "bar", 0));
});
// 多塞几条让主列表足够高（便于验证滚动不带走侧栏）
peerDoc.transact(() => {
  for (let i = 1; i <= 24; i++) bm.set(`x${i}`, node(`填充 ${i}`, "bar", i));
});
await sleep(700);

const profile = mkdtempSync(path.join(os.tmpdir(), "bnt-sidebar-profile-"));
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
await rpc("Emulation.setDeviceMetricsOverride", { width: 1440, height: 700, deviceScaleFactor: 1, mobile: false }, sessionId);
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
// 等应用挂载（token 门禁 → 主界面）
for (let i = 0; i < 60; i++) {
  if (await ev(`!!document.querySelector("[data-sidebar]")`)) break;
  await sleep(250);
}
await sleep(600);

const mouse = (type, x, y, extra = {}) =>
  rpc("Input.dispatchMouseEvent", { type, x, y, ...extra }, sessionId);
const rowRect = async (id) =>
  JSON.parse(
    (await ev(
      `(() => { const r = document.querySelector('[data-folder-row="${id}"]')?.getBoundingClientRect(); return JSON.stringify(r ? {x:r.x,y:r.y,w:r.width,h:r.height} : null); })()`
    )) ?? "null"
  );
// 拖拽: 行中心 → 目标 (fx 相对宽度, fy 相对高度)
async function dragTo(fromId, toId, fy) {
  const a = await rowRect(fromId);
  const b = await rowRect(toId);
  assert(a && b, `找不到行 ${fromId} → ${toId}`);
  const sx = Math.round(a.x + a.w * 0.55);
  const sy = Math.round(a.y + a.h / 2);
  const tx = Math.round(b.x + b.w * 0.55);
  const ty = Math.round(b.y + b.h * fy);
  await mouse("mouseMoved", sx, sy, {});
  await mouse("mousePressed", sx, sy, { button: "left", clickCount: 1, buttons: 1 });
  for (let i = 1; i <= 8; i++) {
    await mouse("mouseMoved", Math.round(sx + ((tx - sx) * i) / 8), Math.round(sy + ((ty - sy) * i) / 8), { buttons: 1 });
    await sleep(40);
  }
  await sleep(250);
  await mouse("mouseReleased", tx, ty, { button: "left", clickCount: 1, buttons: 0 });
  await sleep(800);
}
const crdtFolders = () =>
  [...fm.entries()].map(([id, v]) => ({
    id,
    parent: v.parent ?? null,
    order: v.order ?? 0,
  }));

// C1 视口等高固定: 页面滚动 400px 前后, 侧栏 top/height 不变
await check("C1 侧栏视口等高固定（滚动页面前后位置/高度不变）", async () => {
  const read = async () =>
    JSON.parse(
      await ev(
        `(() => { const r = document.querySelector("[data-sidebar]").getBoundingClientRect();
           return JSON.stringify({ top: Math.round(r.top), h: Math.round(r.height), scrollY: Math.round(window.scrollY) }); })()`
      )
    );
  const before = await read();
  assert(before.h >= 600 && before.h < 700, `侧栏高度应≈视口高度(700)减留白, 实际 ${before.h}`);
  await ev("window.scrollTo(0, 400)");
  await sleep(500);
  const after = await read();
  assert(after.scrollY >= 390, `页面应已滚动, 实际 scrollY=${after.scrollY}`);
  assert(after.top === before.top, `滚动后侧栏 top 应不变: ${before.top} → ${after.top}`);
  assert(after.h === before.h, `滚动后侧栏高度应不变: ${before.h} → ${after.h}`);
  await ev("window.scrollTo(0, 0)");
  await sleep(400);
});

// C2 树层级 + 折叠
await check("C2 侧栏树: nest 是 dev 的子级（缩进>0）且折叠箭头可收起子树", async () => {
  const info = JSON.parse(
    await ev(`(() => {
      const rows = [...document.querySelectorAll("[data-folder-row]")].map((e) => e.getAttribute("data-folder-row"));
      const nest = document.querySelector('[data-folder-row="nest"]');
      const dev = document.querySelector('[data-folder-row="dev"]');
      return JSON.stringify({
        rows,
        depth: nest?.getAttribute("data-depth"),
        devDepth: dev?.getAttribute("data-depth"),
        nestLeft: Math.round(nest.getBoundingClientRect().left),
        devLeft: Math.round(dev.getBoundingClientRect().left),
        toggle: !!document.querySelector('[data-folder-toggle="dev"]'),
      });
    })()`)
  );
  assert(info.rows.indexOf("nest") === info.rows.indexOf("dev") + 1, `nest 应紧跟 dev（树序）, 实际 ${info.rows}`);
  assert(
    Number(info.depth) === Number(info.devDepth) + 1,
    `nest 应比 dev 深一层（depth ${info.devDepth} → ${info.depth}）`
  );
  assert(info.nestLeft > info.devLeft, `子级应缩进（left ${info.devLeft} → ${info.nestLeft}）`);
  assert(info.toggle, "有子夹的行应有折叠箭头");
  await ev(`document.querySelector('[data-folder-toggle="dev"]').click()`);
  await sleep(300);
  const collapsed = await ev(`!document.querySelector('[data-folder-row="nest"]')`);
  assert(collapsed, "折叠后子夹行应消失");
  await ev(`document.querySelector('[data-folder-toggle="dev"]').click()`);
  await sleep(300);
  assert(await ev(`!!document.querySelector('[data-folder-row="nest"]')`), "再点应展开");
});

// C3 拖拽改父级: fun → dev 中部（放入）
await check("C3 拖拽文件夹改父级（fun 放入 dev）且主列表随之嵌套", async () => {
  await dragTo("fun", "dev", 0.5);
  const st = crdtFolders();
  const fun = st.find((f) => f.id === "fun");
  assert(fun.parent === "dev", `CRDT 中 fun.parent 应为 dev, 实际 ${fun.parent}`);
  const nested = await ev(
    `!!document.querySelector('[data-group="dev"] [data-group="fun"]')`
  );
  assert(nested, "主列表应把 fun 的分组渲染在 dev 分组内部");
  const info = JSON.parse(
    await ev(`(() => {
      const fun = document.querySelector('[data-folder-row="fun"]');
      const dev = document.querySelector('[data-folder-row="dev"]');
      return JSON.stringify({
        depth: fun?.getAttribute("data-depth"),
        devDepth: dev?.getAttribute("data-depth"),
        funLeft: Math.round(fun.getBoundingClientRect().left),
        devLeft: Math.round(dev.getBoundingClientRect().left),
      });
    })()`)
  );
  assert(
    Number(info.depth) === Number(info.devDepth) + 1 && info.funLeft > info.devLeft,
    `fun 应缩进为 dev 的子级（depth ${info.devDepth}→${info.depth}, left ${info.devLeft}→${info.funLeft}）`
  );
});

// C4 同层排序: bar → dev 上 1/4（排到前面）
await check("C4 拖拽同层排序（bar 排到 dev 之前）", async () => {
  const before = crdtFolders();
  const orderOf = (st, id) => st.find((f) => f.id === id)?.order;
  assert(orderOf(before, "dev") < orderOf(before, "bar"), "前置条件: dev 在 bar 之前");
  await dragTo("bar", "dev", 0.1);
  const after = crdtFolders();
  assert(after.find((f) => f.id === "bar").parent === null, "bar 应仍在顶层");
  assert(
    orderOf(after, "bar") < orderOf(after, "dev"),
    `bar 的 order 应小于 dev（实际 bar=${orderOf(after, "bar")} dev=${orderOf(after, "dev")}）`
  );
});

// C5 防环: dev → nest（自己的子孙）中部 → 不提交
await check("C5 防环: 拖到自己的子孙不提交（父级与顺序均不变）", async () => {
  const before = crdtFolders();
  await dragTo("dev", "nest", 0.5);
  const after = crdtFolders();
  assert(after.find((f) => f.id === "dev").parent === null, "dev 不得被拖进自己的子孙");
  assert(after.find((f) => f.id === "nest").parent === "dev", "nest 的父级不应变化");
  assert(
    JSON.stringify(before) === JSON.stringify(after),
    `结构不应有任何变化: ${JSON.stringify(before)} → ${JSON.stringify(after)}`
  );
});

// C6 真实鼠标点击侧栏条目 → 跳转（回归: pointerdown 处 setPointerCapture 会把 click 重定向到行容器）
await check("C6 真实点击侧栏条目可跳转（click 必须落在条目按钮上）", async () => {
  await ev(`window.__clicks = []; document.addEventListener("click", (e) => window.__clicks.push(e.target?.closest?.("[data-folder-row]")?.getAttribute("data-folder-row") ?? e.target?.tagName ?? "?"), true);`);
  await ev("window.scrollTo(0, 900)");
  await sleep(400);
  const r = await rowRect("bar");
  const cx = Math.round(r.x + r.w * 0.6);
  const cy = Math.round(r.y + r.h / 2);
  await mouse("mouseMoved", cx, cy, {});
  await mouse("mousePressed", cx, cy, { button: "left", clickCount: 1, buttons: 1 });
  await mouse("mouseReleased", cx, cy, { button: "left", clickCount: 1, buttons: 0 });
  await sleep(1200);
  const tags = JSON.parse(await ev("JSON.stringify(window.__clicks)"));
  // 整行可点（能力块 12 · ③）: 断言点击**落在被点行内**且真的跳转（记录的是 closest 行的 id）
  assert(tags.includes("bar"), `click 应落在 bar 行内（实际 ${JSON.stringify(tags)}）`);
  // 断言语义而非具体滚动方向: 目标分组应落在顶栏之下、视口之内, 且高亮就是它（末组被文档底部截断也成立）
  const st = JSON.parse(
    await ev(`(() => {
      const sec = document.querySelector('[data-group="bar"]');
      const h = document.querySelector("[data-bnt-header]").getBoundingClientRect();
      const marked = [...document.querySelectorAll('[data-sidebar] [data-folder-row][data-active="true"]')].map((e) => e.getAttribute("data-folder-row"));
      const r = sec.getBoundingClientRect();
      return JSON.stringify({ top: Math.round(r.top), bottom: Math.round(r.bottom), headerBottom: Math.round(h.bottom), marked, viewH: window.innerHeight });
    })()`)
  );
  // 新语义（瞬时居中）: 目标分组必须进入视口。**不能**断言 top ≥ 0 ——
  // 高分组居中后 top 天然为负（例如 24 条的分组 top=-205）, 那是正确行为。
  assert(
    st.top < st.viewH && st.bottom > 0,
    `目标分组应进入视口（top=${st.top}, bottom=${st.bottom}, viewH=${st.viewH}）`
  );
  assert(st.marked.length === 1 && st.marked[0] === "bar", `高亮应为 bar，实际 ${JSON.stringify(st.marked)}`);
});

// C7 跳转落点与高亮一致（回归: 25% 阅读线在短分组下会偏到下一个分组）
await check("C7 点击短分组: 高亮就是被点项 且目标落在视口中部", async () => {
  await ev("window.scrollTo(0, 0)");
  await sleep(400);
  const r = await rowRect("nest");
  const cx = Math.round(r.x + r.w * 0.6);
  const cy = Math.round(r.y + r.h / 2);
  await mouse("mouseMoved", cx, cy, {});
  await mouse("mousePressed", cx, cy, { button: "left", clickCount: 1, buttons: 1 });
  await mouse("mouseReleased", cx, cy, { button: "left", clickCount: 1, buttons: 0 });
  await sleep(1200); // 覆盖跳转自校正窗口（内容后加载导致的漂移）
  const st = JSON.parse(
    await ev(`(() => {
      const sec = document.querySelector('[data-group="nest"]').getBoundingClientRect();
      const marked = [...document.querySelectorAll('[data-sidebar] [data-folder-row][data-active="true"]')].map((e) => e.getAttribute("data-folder-row"));
      const de = document.scrollingElement;
      return JSON.stringify({
        top: Math.round(sec.top), bottom: Math.round(sec.bottom), viewH: window.innerHeight,
        marked, atMax: de.scrollTop + window.innerHeight >= de.scrollHeight - 2,
      });
    })()`)
  );
  assert(st.marked.length === 1 && st.marked[0] === "nest", `高亮应为 nest，实际 ${JSON.stringify(st.marked)}`);
  // 新语义（能力块 12 · ④ 顶部对齐）: 目标标题贴顶（≈56px 锚点）; 被文档末尾钳制时至少可见
  const visible = st.top >= 0 && st.top < st.viewH;
  assert(
    st.atMax ? visible : st.top >= 44 && st.top <= 80,
    `目标应贴顶（top=${st.top}, bottom=${st.bottom}, viewH=${st.viewH}, atMax=${st.atMax}）`
  );
});

// C8 滚到页底: 侧栏不动 且 无多余空白（回归: sticky 父容器不覆盖页脚 → 侧栏被推走 96px）
await check("C8 滚到页底: 侧栏位置不变 且 页面底部无多余空白", async () => {
  const before = JSON.parse(
    await ev(`(() => { const r = document.querySelector("[data-sidebar]").getBoundingClientRect();
      return JSON.stringify({ top: Math.round(r.top), h: Math.round(r.height) }); })()`)
  );
  await ev("window.scrollTo(0, document.scrollingElement.scrollHeight)");
  await sleep(800);
  const after = JSON.parse(
    await ev(`(() => {
      const r = document.querySelector("[data-sidebar]").getBoundingClientRect();
      const de = document.scrollingElement;
      const row = document.querySelector("[data-sidebar]").parentElement.getBoundingClientRect();
      return JSON.stringify({
        top: Math.round(r.top), h: Math.round(r.height),
        rowBottom: Math.round(row.bottom), viewH: window.innerHeight,
        docH: de.scrollHeight,
      });
    })()`)
  );
  assert(after.top === before.top, `页底侧栏 top 应不变: ${before.top} → ${after.top}`);
  assert(after.h === before.h, `页底侧栏高度应不变: ${before.h} → ${after.h}`);
  assert(
    after.rowBottom >= after.viewH - 1,
    `页底时侧栏父容器应延伸到视口底部（rowBottom=${after.rowBottom}, viewH=${after.viewH}）`
  );
});

// C9 深页自由滚动: 高亮必须有值（回归: 阅读线不钳非负 → 深页高亮整页为空）
await check("C9 深页滚动后高亮仍有效（阅读线非负钳制）", async () => {
  await ev("window.scrollTo(0, document.scrollingElement.scrollHeight)");
  await sleep(700);
  // 用滚动类按键的等价路径: 直接派发 wheel 释放闩锁, 让 spy 接管
  await ev(`window.dispatchEvent(new WheelEvent("wheel", { deltaY: 1 }))`);
  await sleep(400);
  const st = JSON.parse(
    await ev(`(() => {
      const margin = getComputedStyle(document.querySelector("[data-group]")).scrollMarginTop;
      const marked = [...document.querySelectorAll('[data-sidebar] [data-folder-row][data-active="true"]')].map((e) => e.getAttribute("data-folder-row"));
      const secs = [...document.querySelectorAll("[data-group]")].map((el) => el.getAttribute("data-group"));
      return JSON.stringify({ margin, marked, last: secs[secs.length - 1], groups: secs });
    })()`)
  );
  // 跳转已改为瞬时居中, 不再有锚点变量; 这里只守"深页时 spy 仍然有效"（不是整页无高亮）
  // 只断言"钳制生效 + spy 没死"（有且仅有一个高亮）:
  // 页底时最后一组可能仍整段落在阅读线之下（组很短）, 强行要求"高亮=末组"是错的
  assert(st.marked.length === 1, `深页滚动后应恰有一个高亮，实际 ${JSON.stringify(st.marked)}`);
  assert(st.groups.includes(st.marked[0]), `高亮项应是真实分组，实际 ${st.marked[0]}`);
});

// C10 手抖点击（按下后位移 9px > 阈值但原地放下）必须仍然跳转（回归: 尾随 click 被无条件抑制）
await check("C10 手抖点击（原地放下）仍能跳转", async () => {
  await ev("window.scrollTo(0, 0)");
  // 侧栏自身是滚动容器: 先确保目标行在可视区内（否则点到的是别的行 —— 上一版断言因此误判）
  await ev(`document.querySelector('[data-folder-row="bar"]').scrollIntoView({ block: "nearest" })`);
  await sleep(500);
  await ev(`window.__hit = null; document.addEventListener("click", (e) => {
    window.__hit = e.target?.closest?.("[data-folder-row]")?.getAttribute("data-folder-row") ?? null; }, true);`);
  const r = await rowRect("bar");
  const cx = Math.round(r.x + r.w * 0.6);
  const cy = Math.round(r.y + r.h / 2);
  await mouse("mouseMoved", cx, cy, {});
  await mouse("mousePressed", cx, cy, { button: "left", clickCount: 1, buttons: 1 });
  await mouse("mouseMoved", cx + 9, cy + 3, { buttons: 1 }); // > 8px 阈值 → 进入拖拽, 但没有真正改结构
  await sleep(60);
  await mouse("mouseReleased", cx + 9, cy + 3, { button: "left", clickCount: 1, buttons: 0 });
  await sleep(1400);
  const st = JSON.parse(
    await ev(`(() => { const sec = document.querySelector('[data-group="bar"]').getBoundingClientRect();
      return JSON.stringify({ hit: window.__hit, top: Math.round(sec.top), bottom: Math.round(sec.bottom),
        viewH: window.innerHeight, y: Math.round(scrollY) }); })()`)
  );
  assert(st.hit === "bar", `click 应落在 bar 条目上（实际 ${st.hit}）`);
  // 手抖点击必须真的跳转: 高亮=bar + 页面确实滚动了（bar 是高分组, 居中后 top 为负是正常的）
  assert(st.y > 0, `手抖点击仍应跳转（scrollY=${st.y}）`);
  assert(
    st.top < st.viewH && st.bottom > 0,
    `bar 应进入视口（top=${st.top}, bottom=${st.bottom}, viewH=${st.viewH}）`
  );
});

// C11 真的拖拽改了结构 → 必须抑制尾随 click（否则拖完会误跳转）
await check("C11 真拖拽（改变顺序）后抑制尾随 click", async () => {
  await ev("window.scrollTo(0, 0)");
  await ev(`document.querySelector('[data-sidebar]').scrollIntoView({ block: "nearest" })`);
  await sleep(400);
  // 先读当前顶层顺序, 保证这次拖拽**真的会改变**顺序（否则 no-op 按新语义应当算点击）
  const topRows = JSON.parse(
    await ev(`JSON.stringify([...document.querySelectorAll("[data-sidebar] [data-folder-row]")].filter((e) => e.getAttribute("data-depth") === "1").map((e) => e.getAttribute("data-folder-row")))`)
  );
  assert(topRows.length >= 2, `应有至少两个顶层条目（实际 ${JSON.stringify(topRows)}）`);
  const src = topRows[0];
  const dst = topRows[topRows.length - 1];
  const beforeY = await ev("Math.round(scrollY)");
  const a = await rowRect(src);
  const b = await rowRect(dst);
  const sx = Math.round(a.x + a.w * 0.6);
  const sy = Math.round(a.y + a.h / 2);
  const tx = Math.round(b.x + b.w * 0.6);
  const ty = Math.round(b.y + b.h * 0.85); // 目标行下 1/4 = 排到它后面
  await mouse("mouseMoved", sx, sy, {});
  await mouse("mousePressed", sx, sy, { button: "left", clickCount: 1, buttons: 1 });
  for (let i = 1; i <= 8; i++) {
    await mouse("mouseMoved", Math.round(sx + ((tx - sx) * i) / 8), Math.round(sy + ((ty - sy) * i) / 8), { buttons: 1 });
    await sleep(40);
  }
  await sleep(150);
  await mouse("mouseReleased", tx, ty, { button: "left", clickCount: 1, buttons: 0 });
  await sleep(900);
  const after = JSON.parse(
    await ev(`JSON.stringify([...document.querySelectorAll("[data-sidebar] [data-folder-row]")].filter((e) => e.getAttribute("data-depth") === "1").map((e) => e.getAttribute("data-folder-row")))`)
  );
  assert(
    after.indexOf(src) > after.indexOf(dst),
    `顺序应真的改变（${src} 应排到 ${dst} 之后; 实际 ${JSON.stringify(after)}）`
  );
  const afterY = await ev("Math.round(scrollY)");
  assert(afterY === beforeY, `真拖拽后不得跳转（scrollY ${beforeY} → ${afterY}）`);
});

// C12 同一目标连点两次: 落点必须一致（回归: 锚点随顶栏视口位置变化 → 第二次又滚一段 237 → 8）
await check("C12 同一目标连点两次落点一致（锚点稳定）", async () => {
  await ev("window.scrollTo(0, 0)");
  await ev(`document.querySelector('[data-folder-row="fun"]').scrollIntoView({ block: "nearest" })`);
  await sleep(400);
  const clickFun = async () => {
    const r = await rowRect("fun");
    const cx = Math.round(r.x + r.w * 0.6);
    const cy = Math.round(r.y + r.h / 2);
    await mouse("mouseMoved", cx, cy, {});
    await mouse("mousePressed", cx, cy, { button: "left", clickCount: 1, buttons: 1 });
    await mouse("mouseReleased", cx, cy, { button: "left", clickCount: 1, buttons: 0 });
    await sleep(900);
    return JSON.parse(
      await ev(`(() => { const sec = document.querySelector('[data-group="fun"]').getBoundingClientRect();
        return JSON.stringify({ top: Math.round(sec.top), y: Math.round(scrollY) }); })()`)
    );
  };
  const first = await clickFun();
  const second = await clickFun();
  assert(
    Math.abs(first.top - second.top) <= 2 && first.y === second.y,
    `同一目标两次点击落点应一致（第一次 top=${first.top}/y=${first.y}, 第二次 top=${second.top}/y=${second.y}）`
  );
});

// C13 跳转途中立即改目标: 必须收敛到新目标（回归: scrollIntoView(smooth) 被打断停在中间）
await check("C13 跳转途中改目标能收敛到新目标", async () => {
  await ev("window.scrollTo(0, 0)");
  await sleep(400);
  const click = async (id) => {
    const r = await rowRect(id);
    const cx = Math.round(r.x + r.w * 0.6);
    const cy = Math.round(r.y + r.h / 2);
    await mouse("mouseMoved", cx, cy, {});
    await mouse("mousePressed", cx, cy, { button: "left", clickCount: 1, buttons: 1 });
    await mouse("mouseReleased", cx, cy, { button: "left", clickCount: 1, buttons: 0 });
  };
  await click("dev");
  await sleep(120); // 瞬时跳转, 但模拟"手很快地连点两个"
  await click("fun");
  await sleep(900);
  const st = JSON.parse(
    await ev(`(() => { const sec = document.querySelector('[data-group="fun"]').getBoundingClientRect();
      const marked = [...document.querySelectorAll('[data-sidebar] [data-folder-row][data-active="true"]')].map((e) => e.getAttribute("data-folder-row"));
      const de = document.scrollingElement;
      return JSON.stringify({ top: Math.round(sec.top), marked, viewH: window.innerHeight,
        atMax: de.scrollTop + window.innerHeight >= de.scrollHeight - 2 }); })()`)
  );
  assert(st.marked[0] === "fun", `高亮应为 fun（实际 ${JSON.stringify(st.marked)}）`);
  // 顶部对齐: 目标标题应贴顶（≈56px 锚点）; 被文档末尾钳制时至少可见
  assert(
    st.atMax ? st.top >= 0 && st.top < st.viewH : st.top >= 44 && st.top <= 80,
    `目标应贴顶（top=${st.top}, viewH=${st.viewH}, atMax=${st.atMax}）`
  );
});

// C14 底部钳制: 滚到页底时高亮 = 最后一个分组（回归: 短分组顶部到不了阅读线 → 高亮停在上一组）
await check("C14 页底高亮 = 最后一个分组（底部钳制）", async () => {
  await ev("window.scrollTo(0, document.scrollingElement.scrollHeight)");
  await sleep(800);
  await ev(`window.dispatchEvent(new WheelEvent("wheel", { deltaY: 1 }))`); // 释放闩锁, 让 spy 接管
  await sleep(400);
  const st = JSON.parse(
    await ev(`(() => {
      const groups = [...document.querySelectorAll("[data-group]")].map((e) => e.getAttribute("data-group"));
      const marked = [...document.querySelectorAll('[data-sidebar] [data-folder-row][data-active="true"]')].map((e) => e.getAttribute("data-folder-row"));
      const de = document.scrollingElement;
      return JSON.stringify({ marked, last: groups[groups.length - 1], atBottom: Math.round(de.scrollTop + window.innerHeight) >= de.scrollHeight - 2 });
    })()`)
  );
  assert(st.atBottom, "应已到文档末尾");
  assert(st.marked[0] === st.last, `页底应高亮最后一个分组 ${st.last}（实际 ${JSON.stringify(st.marked)}）`);
});

// C15 快速连点不同目标: 每次点击都必须生效（回归: 平滑滚动被打断/被吞 → 需要反复点击）
await check("C15 快速连点三个不同目标: 最终落在最后一个且高亮一致", async () => {
  await ev("window.scrollTo(0, 0)");
  await sleep(400);
  const click = async (id) => {
    const r = await rowRect(id);
    const cx = Math.round(r.x + r.w * 0.6);
    const cy = Math.round(r.y + r.h / 2);
    await mouse("mouseMoved", cx, cy, {});
    await mouse("mousePressed", cx, cy, { button: "left", clickCount: 1, buttons: 1 });
    await mouse("mouseReleased", cx, cy, { button: "left", clickCount: 1, buttons: 0 });
  };
  await click("dev");
  await sleep(90);
  await click("nest");
  await sleep(90);
  await click("fun");
  await sleep(800);
  const st = JSON.parse(
    await ev(`(() => {
      const sec = document.querySelector('[data-group="fun"]').getBoundingClientRect();
      const marked = [...document.querySelectorAll('[data-sidebar] [data-folder-row][data-active="true"]')].map((e) => e.getAttribute("data-folder-row"));
      const de = document.scrollingElement;
      return JSON.stringify({ top: Math.round(sec.top), viewH: window.innerHeight, marked,
        atMax: de.scrollTop + window.innerHeight >= de.scrollHeight - 2 });
    })()`)
  );
  assert(st.marked.length === 1 && st.marked[0] === "fun", `高亮应为最后点的 fun（实际 ${JSON.stringify(st.marked)}）`);
  assert(st.atMax || (st.top >= 0 && st.top < st.viewH), `fun 应可见（top=${st.top}）`);
});

// C16 整行可点: 行的 padding 区（原死区）与行间缝隙都必须能跳转
await check("C16 行的 padding 区与行间缝隙都能跳转（整行命中）", async () => {
  const jumpTo = async (x, y, expect) => {
    await ev("window.scrollTo(0, 0)");
    await sleep(300);
    await mouse("mouseMoved", x, y, {});
    await mouse("mousePressed", x, y, { button: "left", clickCount: 1, buttons: 1 });
    await mouse("mouseReleased", x, y, { button: "left", clickCount: 1, buttons: 0 });
    await sleep(700);
    const st = JSON.parse(
      await ev(`(() => {
        const marked = [...document.querySelectorAll('[data-sidebar] [data-folder-row][data-active="true"]')].map((e) => e.getAttribute("data-folder-row"));
        return JSON.stringify({ y: Math.round(scrollY), marked });
      })()`)
    );
    assert(st.y > 0 && st.marked[0] === expect, `应跳转到 ${expect}（实际 y=${st.y}, marked=${JSON.stringify(st.marked)}）`);
  };
  const fun = await rowRect("fun");
  // ① 行的左内边距（原实现是死区: 只有内层 label 按钮可点）
  await jumpTo(Math.round(fun.x + 3), Math.round(fun.y + fun.h / 2), "fun");
  // ② 行间缝隙（取 fun 与上一行的中缝）
  const dev = await rowRect("dev");
  const gapY = Math.round((dev.y + dev.h + fun.y) / 2);
  const st = JSON.parse(
    await ev(`(() => { const el = document.elementFromPoint(${Math.round(fun.x + 60)}, ${gapY});
      return JSON.stringify({ tag: el?.tagName ?? null, row: el?.closest?.("[data-folder-row]")?.getAttribute("data-folder-row") ?? null }); })()`)
  );
  await jumpTo(Math.round(fun.x + 60), gapY, st.row ?? "fun");
});

// C17 带抖动的点击（指针位移 10px → click 目标是行 DIV）必须仍能跳转（回归本 bug 的原始路径）
await check("C17 指针位移 10px 的点击仍能跳转（click 落在行 DIV 上）", async () => {
  await ev("window.scrollTo(0, 0)");
  await sleep(300);
  const r = await rowRect("fun");
  const cx = Math.round(r.x + r.w * 0.6);
  const cy = Math.round(r.y + r.h / 2);
  await mouse("mouseMoved", cx, cy, {});
  await mouse("mousePressed", cx, cy, { button: "left", clickCount: 1, buttons: 1 });
  await mouse("mouseMoved", cx, cy + 5, { buttons: 1 });
  await sleep(20);
  await mouse("mouseMoved", cx, cy + 10, { buttons: 1 });
  await sleep(20);
  await mouse("mouseReleased", cx, cy + 10, { button: "left", clickCount: 1, buttons: 0 });
  await sleep(700);
  const st = JSON.parse(
    await ev(`(() => {
      const marked = [...document.querySelectorAll('[data-sidebar] [data-folder-row][data-active="true"]')].map((e) => e.getAttribute("data-folder-row"));
      return JSON.stringify({ y: Math.round(scrollY), marked });
    })()`)
  );
  assert(st.y > 0 && st.marked[0] === "fun", `应跳转到 fun（实际 y=${st.y}, marked=${JSON.stringify(st.marked)}）`);
});

// C18 导航行高可调（默认 34px, 设置抽屉滑块改到 44px）
await check("C18 导航行高可调: 滑块 → CRDT → 实测行高", async () => {
  const before = await ev(`Math.round(document.querySelector('[data-folder-row="fun"]').getBoundingClientRect().height)`);
  assert(before >= 32, `默认行高应比原先(~27px)大（实际 ${before}）`);
  await ev(`document.querySelector("[data-settings-open]").click()`);
  await sleep(500);
  const setRange = await ev(`(() => { const el = document.querySelector('[data-gap-slider="navRow"]');
    if (!el) return false;
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    set.call(el, "44"); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  assert(setRange, "应找到导航行高滑块");
  await sleep(600);
  const after = await ev(`Math.round(document.querySelector('[data-folder-row="fun"]').getBoundingClientRect().height)`);
  assert(after >= 44, `行高应变为 ≥44px（实际 ${after}）`);
  const settings = root.get("settings");
  assert(Number(settings?.get("navRow")) === 44, `CRDT settings.navRow 应为 44（实际 ${settings?.get("navRow")}）`);
  await ev(`document.querySelector("[data-settings-close]")?.click()`);
  await sleep(400);
});

// C19 折叠箭头只负责折叠, 不触发跳转
await check("C19 点折叠箭头不跳转（仅折叠）", async () => {
  await ev("window.scrollTo(0, 0)");
  await sleep(300);
  const tog = JSON.parse(
    await ev(`(() => { const el = document.querySelector('[data-folder-toggle="dev"]').getBoundingClientRect();
      return JSON.stringify({ x: Math.round(el.x + el.width / 2), y: Math.round(el.y + el.height / 2) }); })()`)
  );
  await mouse("mouseMoved", tog.x, tog.y, {});
  await mouse("mousePressed", tog.x, tog.y, { button: "left", clickCount: 1, buttons: 1 });
  await mouse("mouseReleased", tog.x, tog.y, { button: "left", clickCount: 1, buttons: 0 });
  await sleep(600);
  const st = JSON.parse(await ev(`JSON.stringify({ y: Math.round(scrollY), marked: [...document.querySelectorAll('[data-sidebar] [data-folder-row][data-active="true"]')].map((e) => e.getAttribute("data-folder-row")) })`));
  assert(st.y === 0, `点折叠箭头不应滚动（实际 y=${st.y}）`);
  await ev(`document.querySelector('[data-folder-toggle="dev"]').click()`); // 复原展开
  await sleep(300);
});

// C20 点「未分组」跳到自己那一段（回归: 目标是整棵树包裹元素 → 等于"全部"）
await check("C20 点「未分组」跳到未归类书签段（不是列表最顶）", async () => {
  await ev("window.scrollTo(0, 0)");
  await sleep(400);
  const row = await rowRect("root");
  const cx = Math.round(row.x + row.w * 0.6);
  const cy = Math.round(row.y + row.h / 2);
  await mouse("mouseMoved", cx, cy, {});
  await mouse("mousePressed", cx, cy, { button: "left", clickCount: 1, buttons: 1 });
  await mouse("mouseReleased", cx, cy, { button: "left", clickCount: 1, buttons: 0 });
  await sleep(1200); // 覆盖跳转自校正窗口（内容后加载导致的漂移）
  const st = JSON.parse(
    await ev(`(() => {
      const head = document.querySelector('[data-drop-group="root"]').getBoundingClientRect();
      const items = document.querySelector('[data-items-group="root"]').getBoundingClientRect();
      return JSON.stringify({ headTop: Math.round(head.top), itemsTop: Math.round(items.top), y: Math.round(scrollY) });
    })()`)
  );
  // 未分组标题应落在视口顶部附近（顶部对齐）; 且未归类书签段紧随其后可见
  // 锚点 56px = 让开顶部常驻 chrome（☰/设置 40px + 留白）
  assert(st.headTop >= 44 && st.headTop <= 80, `未分组标题应贴顶（top=${st.headTop}, 期望 ≈56）`);
  assert(st.itemsTop >= st.headTop && st.itemsTop < 300, `未归类书签段应紧随标题（itemsTop=${st.itemsTop}）`);
});

// C21 顶层文件夹跳到**最顶部**（能力块 12 · ④: 由居中改为顶部对齐）
await check("C21 顶层文件夹跳转到最顶部（顶部对齐）", async () => {
  await ev("window.scrollTo(0, 0)");
  await sleep(400);
  const row = await rowRect("bar");
  const cx = Math.round(row.x + row.w * 0.6);
  const cy = Math.round(row.y + row.h / 2);
  await mouse("mouseMoved", cx, cy, {});
  await mouse("mousePressed", cx, cy, { button: "left", clickCount: 1, buttons: 1 });
  await mouse("mouseReleased", cx, cy, { button: "left", clickCount: 1, buttons: 0 });
  await sleep(1200); // 覆盖跳转自校正窗口（内容后加载导致的漂移）
  const st = JSON.parse(
    await ev(`(() => {
      const head = document.querySelector('[data-drop-group="bar"]').getBoundingClientRect();
      const marked = [...document.querySelectorAll('[data-sidebar] [data-folder-row][data-active="true"]')].map((e) => e.getAttribute("data-folder-row"));
      const de = document.scrollingElement;
      return JSON.stringify({ top: Math.round(head.top), marked, atMax: de.scrollTop + window.innerHeight >= de.scrollHeight - 2 });
    })()`)
  );
  assert(st.marked[0] === "bar", `高亮应为 bar（实际 ${JSON.stringify(st.marked)}）`);
  assert(
    st.atMax ? st.top >= 0 && st.top < 700 : st.top >= 44 && st.top <= 80,
    `顶层文件夹标题应贴顶（top=${st.top}, atMax=${st.atMax}, 期望 ≈56）`
  );
});

// C22 侧栏隐藏（浮层形态）时, 左上角触发按钮**始终可见**（回归: 滚到下方必须回页首才能打开导航）
await check("C22 浮层形态下左上角触发按钮常驻（滚动后仍可见可点）", async () => {
  try {
    // 560px ≤ overlay 断点 → 侧栏以浮层呈现（700px 属 rail 形态, 不渲染触发按钮）
    await rpc("Emulation.setDeviceMetricsOverride", { width: 560, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await sleep(600);
    await ev("window.scrollTo(0, 1400)");
    await sleep(500);
    const st = JSON.parse(
      await ev(`(() => {
        const b = document.querySelector("[data-sidebar-toggle]");
        if (!b) return JSON.stringify({ none: true });
        const r = b.getBoundingClientRect();
        return JSON.stringify({ top: Math.round(r.top), left: Math.round(r.left), viewH: window.innerHeight,
          visible: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 });
      })()`)
    );
    assert(!st.none, "浮层形态应渲染触发按钮");
    assert(st.visible, `滚动到下方后触发按钮仍应可见（top=${st.top}, viewH=${st.viewH}）`);
    // 点它必须能打开导览浮层
    const box = JSON.parse(await ev(`(() => { const r = document.querySelector("[data-sidebar-toggle]").getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); })()`));
    await mouse("mouseMoved", box.x, box.y, {});
    await mouse("mousePressed", box.x, box.y, { button: "left", clickCount: 1, buttons: 1 });
    await mouse("mouseReleased", box.x, box.y, { button: "left", clickCount: 1, buttons: 0 });
    await sleep(500);
    const opened = await ev(`!!document.querySelector('[data-sidebar][data-shape="overlay"]')`);
    assert(opened, "点触发按钮应打开导览浮层");
    await ev(`document.querySelector("[data-sidebar-close]")?.click()`);
    await sleep(400);
  } finally {
    await rpc("Emulation.setDeviceMetricsOverride", { width: 1440, height: 700, deviceScaleFactor: 1, mobile: false }, sessionId);
    await sleep(500);
  }
});

// C23 设置按钮常驻（滚动到页面下方仍可见可点）
await check("C23 设置按钮常驻（滚动后仍可见可点）", async () => {
  await ev("window.scrollTo(0, 1400)");
  await sleep(500);
  const st = JSON.parse(
    await ev(`(() => {
      const b = document.querySelector("[data-settings-open]");
      if (!b) return JSON.stringify({ none: true });
      const r = b.getBoundingClientRect();
      return JSON.stringify({ top: Math.round(r.top), right: Math.round(r.right), viewW: window.innerWidth,
        visible: r.top >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth });
    })()`)
  );
  assert(!st.none && st.visible, `滚动后设置按钮仍应可见（${JSON.stringify(st)}）`);
  const box = JSON.parse(await ev(`(() => { const r = document.querySelector("[data-settings-open]").getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); })()`));
  await mouse("mouseMoved", box.x, box.y, {});
  await mouse("mousePressed", box.x, box.y, { button: "left", clickCount: 1, buttons: 1 });
  await mouse("mouseReleased", box.x, box.y, { button: "left", clickCount: 1, buttons: 0 });
  await sleep(500);
  assert(await ev(`!!document.querySelector("[data-settings-panel]")`), "点设置应打开抽屉");
  await ev(`document.querySelector("[data-settings-close]")?.click()`);
  await sleep(400);
  await ev("window.scrollTo(0, 0)");
});

// C24 跳转前后**侧栏内部滚动位置不变**（回归: navScrollTo 里多余的 row.scrollIntoView 会把用户滚到的位置改掉）
await check("C24 跳转前后侧栏内部滚动位置保持", async () => {
  // 先补足文件夹, 让侧栏真的能滚（原数据集内容不足一屏）
  peerDoc.transact(() => {
    for (let i = 0; i < 30; i++) fm.set(`extra${i}`, { name: `附加文件夹 ${i}`, parent: null, order: 100 + i });
  });
  await sleep(600);
  const canScroll = await ev(
    `document.querySelector("[data-sidebar]").scrollHeight > document.querySelector("[data-sidebar]").clientHeight + 20`
  );
  assert(canScroll, "侧栏内容应超过一屏（否则本用例无意义）");
  await ev(`document.querySelector("[data-sidebar]").scrollTop = 200`);
  await sleep(300);
  const before = await ev(`Math.round(document.querySelector("[data-sidebar]").scrollTop)`);
  assert(before >= 190, `侧栏应先滚到 200 附近（实际 ${before}）`);
  // 点当前可视区里的某一行（点得到 = 可见）
  const target = await ev(`(() => {
    const rows = [...document.querySelectorAll("[data-sidebar] [data-folder-row]")];
    const side = document.querySelector("[data-sidebar]").getBoundingClientRect();
    const vis = rows.find((r) => { const b = r.getBoundingClientRect(); return b.top > side.top + 40 && b.bottom < side.bottom - 40; });
    return vis ? vis.getAttribute("data-folder-row") : null;
  })()`);
  assert(target, "应能找到可视区内的条目");
  const r = await rowRect(target);
  const cx = Math.round(r.x + r.w * 0.6);
  const cy = Math.round(r.y + r.h / 2);
  await mouse("mouseMoved", cx, cy, {});
  await mouse("mousePressed", cx, cy, { button: "left", clickCount: 1, buttons: 1 });
  await mouse("mouseReleased", cx, cy, { button: "left", clickCount: 1, buttons: 0 });
  await sleep(900);
  const after = await ev(`Math.round(document.querySelector("[data-sidebar]").scrollTop)`);
  assert(Math.abs(after - before) <= 2, `侧栏滚动位置应保持（${before} → ${after}）`);
  const marked = JSON.parse(
    await ev(`JSON.stringify([...document.querySelectorAll('[data-sidebar] [data-folder-row][data-active="true"]')].map((e) => e.getAttribute("data-folder-row")))`)
  );
  assert(marked[0] === target, `高亮应为被点项 ${target}（实际 ${JSON.stringify(marked)}）`);
});

// C25 未分组为空时不显示该行（能力块 15 · D）
await check("C25 未分组为空时侧栏不显示该行", async () => {
  // 注: 行始终在 DOM 里（拖拽时要当落点）, 隐藏是 CSS 行为 → 断言**可见性**而非存在性
  const hasRow = () =>
    ev(`(() => { const el = document.querySelector('[data-sidebar] [data-folder-row="root"]');
      if (!el) return false; const r = el.getBoundingClientRect(); return r.height > 0 && getComputedStyle(el).display !== "none"; })()`);
  // 数据集里有 u0/u1 两条未分组书签 → 应显示
  assert(await hasRow(), "未分组非空时应显示该行");
  // 删掉它们 → 应隐藏
  peerDoc.transact(() => {
    for (const id of ["u0", "u1"]) if (bm.has(id)) bm.delete(id);
  });
  await sleep(600);
  assert(!(await hasRow()), "未分组为空时应隐藏该行（避免看起来像遗留物）");
  // 还原（后续断言/复跑不受影响）
  peerDoc.transact(() => {
    bm.set("u0", node("未分组条目 A", null, 0));
    bm.set("u1", node("未分组条目 B", null, 1));
  });
  await sleep(500);
  assert(await hasRow(), "还原后应重新显示");
});

peer.destroy();
peerDoc.destroy();
chrome.kill();
srv.kill();
console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);

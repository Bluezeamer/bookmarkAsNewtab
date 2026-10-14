#!/usr/bin/env node
// sync-core 全路径测试（spec req 9）
// 起临时 server 实例（随机端口 + tmp 数据目录 + 固定测试 token）, 9 类断言
// 注意: CI 的 check 阶段 job 并行, test 不能依赖 build job → 本脚本先自编译
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import * as enc0 from "lib0/encoding";
import * as dec0 from "lib0/decoding";
import * as sp from "y-protocols/sync.js";
import WebSocket from "ws";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "test-token-123";
const PORT = 18200 + (process.pid % 500);
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "bnt-sync-"));
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
    results.push(name);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}: ${e.message}`);
  }
}

// 1) 自编译（CI check 并行, 不能依赖 build job）; 与 build 脚本同源: esbuild 单文件 CJS bundle
execSync(
  "node_modules/.bin/esbuild src/index.ts --bundle --platform=node --format=cjs --outfile=dist/index.js",
  { cwd: PKG, stdio: "inherit" }
);

// 2) 起临时 server
let srv = spawn("node", [path.join(PKG, "dist/index.js")], {
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(PORT), SYNC_TOKEN: TOKEN, DATA_DIR },
  stdio: ["ignore", "pipe", "pipe"],
});
srv.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

async function waitForServer(ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {}
    if (Date.now() - t0 > ms) throw new Error("server not up in time");
    await sleep(100);
  }
}

function wsClient(d, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
    const t = setTimeout(() => reject(new Error("ws connect timeout")), 5000);
    ws.on("open", () => {
      clearTimeout(t);
      // 客户端侧同步（与 y-websocket WebsocketProvider 同协议）:
      // 发 Step1; 收 Step1→回 Step2 / Step2/Update→应用; 本地 update→发对端
      const enc1 = enc0.createEncoder();
      enc0.writeVarUint(enc1, 0);
      sp.writeSyncStep1(enc1, d);
      ws.send(enc0.toUint8Array(enc1));
      ws.on("message", (data) => {
        const dec = dec0.createDecoder(data);
        if (dec0.readVarUint(dec) !== 0) return;
        const enc = enc0.createEncoder();
        enc0.writeVarUint(enc, 0);
        sp.readSyncMessage(dec, enc, d, ws);
        const resp = enc0.toUint8Array(enc);
        if (resp.length > 1) ws.send(resp);
      });
      d.on("update", (update, origin) => {
        // Yjs 13.6: 本地编辑的默认 origin = null（非 doc!）; 远端更新 origin = ws
        if (origin == null) {
          const e = enc0.createEncoder();
          enc0.writeVarUint(e, 0);
          sp.writeUpdate(e, update);
          if (ws.readyState === WebSocket.OPEN) ws.send(enc0.toUint8Array(e));
        }
      });
      resolve(ws);
    });
    ws.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

async function wsRejected(url) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => reject(new Error("expected rejection, got silence")), 4000);
    ws.on("open", () => {
      clearTimeout(t);
      reject(new Error("unexpectedly opened"));
    });
    ws.on("error", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

const postHistory = (entries, token = TOKEN) =>
  fetch(`${BASE}/api/history`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ entries }),
  });

const getHistory = (query, token = TOKEN) =>
  fetch(`${BASE}/api/history?${query}`, { headers: { authorization: `Bearer ${token}` } });

await waitForServer();

// T1: /health 无鉴权 200
await test("T1 /health 无鉴权 200", async () => {
  const r = await fetch(`${BASE}/health`);
  assert.equal(r.status, 200);
});

// T2/T3: WS 鉴权（无 token / 错 token → 拒绝）
await test("T2 WS 无 token 拒绝", () => wsRejected(`ws://127.0.0.1:${PORT}/ws`));
await test("T3 WS 错 token 拒绝", () => wsRejected(`ws://127.0.0.1:${PORT}/ws?token=wrong`));

// T4: WS 正确 token 连接 + schema bootstrap
await test("T4 WS 正确 token 连接, schema 已 bootstrap", async () => {
  const d = new Y.Doc();
  const ws = await wsClient(d, TOKEN);
  await sleep(600);
  const root = d.getMap("");
  assert.ok(root.get("bookmarks") instanceof Y.Map, "bookmarks map");
  assert.ok(root.get("folders") instanceof Y.Map, "folders map");
  assert.ok(root.get("settings")?.get("excludeDomains") instanceof Y.Array, "excludeDomains array");
  ws.close();
});

// T5: 双 client 并发增删 → 收敛
await test("T5 双 client 并发增删收敛", async () => {
  const dA = new Y.Doc();
  const dB = new Y.Doc();
  const wsA = await wsClient(dA, TOKEN);
  const wsB = await wsClient(dB, TOKEN);
  await sleep(600);
  const now = new Date().toISOString();
  dA.getMap("").get("bookmarks").set("bm-a", {
    title: "from A", url: "https://a.example", folder: null, order: 0, created: now,
  });
  dB.getMap("").get("bookmarks").set("bm-b", {
    title: "from B", url: "https://b.example", folder: null, order: 1, created: now,
  });
  await sleep(1200);
  const bA = dA.getMap("").get("bookmarks");
  const bB = dB.getMap("").get("bookmarks");
  assert.equal(bA.size, 2, "A sees both");
  assert.equal(bB.size, 2, "B sees both");
  assert.ok(bA.get("bm-b") && bB.get("bm-a"), "cross-visibility");
  wsA.close();
  wsB.close();
});

// T6: 重启 server → 文档不丢（等防抖 2s 落盘后 SIGTERM）
await test("T6 重启 server 文档不丢", async () => {
  const d = new Y.Doc();
  const ws = await wsClient(d, TOKEN);
  await sleep(600); // 等同步完成（schema 到位）再写, 防竞态
  d.getMap("").get("bookmarks").set("bm-persist", {
    title: "persist", url: "https://p.example", folder: null, order: 9, created: "2026-10-10T00:00:00Z",
  });
  await sleep(2600); // 防抖 2s
  ws.close();
  srv.kill("SIGTERM");
  await new Promise((r) => srv.on("close", r));

  srv = spawn("node", [path.join(PKG, "dist/index.js")], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(PORT), SYNC_TOKEN: TOKEN, DATA_DIR },
    stdio: ["ignore", "pipe", "pipe"],
  });
  srv.stderr.on("data", (dd) => process.stderr.write(`[server] ${dd}`));
  await waitForServer();

  const d2 = new Y.Doc();
  const ws2 = await wsClient(d2, TOKEN);
  await sleep(800);
  assert.ok(d2.getMap("").get("bookmarks").get("bm-persist"), "bookmark survives restart");
  ws2.close();
});

// T7: 历史 POST 去重
await test("T7 历史 POST 去重", async () => {
  const r1 = await postHistory([
    { url: "https://x.example/1", title: "X1", visitedAt: "2026-10-01T10:00:00Z" },
    { url: "https://x.example/2", title: "X2", visitedAt: "2026-10-01T11:00:00Z" },
  ]);
  assert.equal(r1.status, 200);
  const j1 = await r1.json();
  assert.equal(j1.added, 2);
  const r2 = await postHistory([
    { url: "https://x.example/1", title: "dup", visitedAt: "2026-10-01T10:00:00Z" },
  ]);
  const j2 = await r2.json();
  assert.equal(j2.added, 0, "duplicate not added");
  assert.equal(j2.total, 2);
});

// T8: 历史过滤（keyword / domain / 时间区间）
await test("T8 历史过滤 keyword/domain/区间", async () => {
  await postHistory([
    { url: "https://d.example/page", title: "alpha page", visitedAt: "2026-10-02T09:00:00Z" },
    { url: "https://d.example/other", title: "beta page", visitedAt: "2026-10-03T09:00:00Z" },
    { url: "https://e.example/zeta", title: "zeta", visitedAt: "2026-10-04T09:00:00Z" },
  ]);
  let j = await (await getHistory("domain=d.example")).json();
  assert.equal(j.total, 2, "domain filter");
  j = await (await getHistory("keyword=alpha")).json();
  assert.equal(j.total, 1, "keyword filter");
  assert.equal(j.entries[0].url, "https://d.example/page");
  j = await (await getHistory("from=2026-10-03T00:00:00Z&to=2026-10-03T23:59:59Z")).json();
  assert.equal(j.total, 1, "time range filter");
  assert.equal(j.entries[0].url, "https://d.example/other");
});

// T9: 10000 裁剪
await test("T9 历史 10000 裁剪", async () => {
  const batch = 500;
  for (let i = 0; i < 10500; i += batch) {
    const entries = [];
    for (let k = 0; k < batch; k++) {
      const n = i + k;
      entries.push({
        url: `https://prune.example/${n}`,
        title: "",
        visitedAt: `2026-11-${String((n % 28) + 1).padStart(2, "0")}T${String(n % 24).padStart(2, "0")}:00:00Z`,
      });
    }
    const r = await postHistory(entries);
    assert.equal(r.status, 200, `batch ${i}`);
  }
  const j = await (await getHistory("limit=10")).json();
  assert.equal(j.total, 10000, `capped at 10000 (got ${j.total})`);
});

// T10: 排除列表经 CRDT 双端同步
await test("T10 排除列表 CRDT 双端同步", async () => {
  const dA = new Y.Doc();
  const dB = new Y.Doc();
  const wsA = await wsClient(dA, TOKEN);
  const wsB = await wsClient(dB, TOKEN);
  await sleep(600);
  dA.getMap("").get("settings").get("excludeDomains").push(["github.com"]);
  await sleep(1000);
  assert.deepEqual(dB.getMap("").get("settings").get("excludeDomains").toArray(), ["github.com"]);
  wsA.close();
  wsB.close();
});

// T11: /api 无 token → 401
await test("T11 /api 无 token 401", async () => {
  const r = await getHistory("", "");
  assert.equal(r.status, 401);
});

srv.kill("SIGTERM");
await new Promise((r) => srv.on("close", r));

console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// 回归测试: WebSocket 连接状态订阅必须跨「异步 connect」生效
// 背景: connect() 曾在 fetch 回调里异步执行, 而 App 的状态订阅在挂载时同步读 provider
//       → provider 尚为 null → 订阅永久丢失 → 横幅常显"后端不可达"(误报, 生产真实踩到)
// 自举: 同 server 测试（CI check 并行, 不能依赖 build job）——先 esbuild 编译 server 再起临时进程
import assert from "node:assert";
import { spawn, execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..");
const SERVER = path.resolve(WEB, "../server");
const TOKEN = "status-regression-token";
const PORT = 19200 + (process.pid % 500); // 与 server 测试(18200+)错开, 避免 CI 并行端口冲突
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "bnt-status-"));
const BASE_WS = `http://127.0.0.1:${PORT}`;

let total = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  total++;
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}: ${(e as Error).message}`);
  }
}

// 1) 自编译 server（与 build 脚本同源: esbuild 单文件 CJS bundle）
execSync(
  `${path.join(SERVER, "node_modules/.bin/esbuild")} src/index.ts --bundle --platform=node --format=cjs --outfile=dist/index.js`,
  { cwd: SERVER, stdio: "inherit" }
);

// 2) 起临时 server
const srv = spawn("node", [path.join(SERVER, "dist/index.js")], {
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(PORT), SYNC_TOKEN: TOKEN, DATA_DIR },
  stdio: ["ignore", "pipe", "pipe"],
});
srv.stdout.on("data", () => {});
srv.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

const t0 = Date.now();
for (;;) {
  try {
    const r = await fetch(`${BASE_WS}/health`);
    if (r.ok) break;
  } catch {
    /* 未起 */
  }
  if (Date.now() - t0 > 10000) throw new Error("server not up in time");
  await new Promise((r) => setTimeout(r, 100));
}

// 3) crdt.ts 读 location（node 无此全局）
(globalThis as any).location = { protocol: "http:", host: `127.0.0.1:${PORT}` };
const { connect, disconnect, onStatus, addBookmark, readBookmarks, resolveServerUrl, doc } = await import(
  "../src/lib/crdt.ts"
);
const Y = (await import("yjs")).default ?? (await import("yjs"));
const { WebsocketProvider } = await import("y-websocket");

const seen: string[] = [];
const off = onStatus((s) => seen.push(s)); // 等价于组件里的 useEffect(() => onStatus(setStatus), [])

// 对端: 模拟另一个浏览器, 用于校验写入确实经 relay 出去了
const peerDoc = new Y.Doc();
const peer = new WebsocketProvider(BASE_WS.replace("http", "ws"), `ws?token=${TOKEN}`, peerDoc);

await test("T1 订阅先于 connect: 立即回放当前状态(connecting —— 首连前不是 disconnected)", async () => {
  assert.deepEqual(seen, ["connecting"], `实际: ${JSON.stringify(seen)}`);
});

// 轮询等待（带超时与现场信息）
async function waitFor(cond: () => boolean, ms: number, describe: () => unknown): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`等待超时(${ms}ms), 现场: ${JSON.stringify(describe())}`);
}

// 等对端拿到 server 的 schema bootstrap（保证 CRDT 结构就绪）
await new Promise<void>((res, rej) => {
  const t = setTimeout(() => rej(new Error("peer bootstrap 超时")), 10000);
  const chk = () => {
    if (peerDoc.getMap("").get("bookmarks")) {
      clearTimeout(t);
      res();
    }
  };
  peerDoc.getMap("").observeDeep(chk);
  chk();
});

await test("T2 异步 connect 后订阅仍拿到 connected（本 bug 的核心）", async () => {
  connect(TOKEN);
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`10s 未见 connected, 序列: ${JSON.stringify(seen)}`)), 10000);
    const iv = setInterval(() => {
      if (seen.includes("connected")) {
        clearInterval(iv);
        clearTimeout(t);
        res();
      }
    }, 100);
  });
  assert.ok(seen.includes("connecting") || seen.includes("connected"));
});

await test("T3 经 crdt.ts 写入 → 对端可见（doc 确实接到了 provider）", async () => {
  addBookmark("状态回归测试书签", "https://status-regression.example", null);
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("对端 8s 未收到写入")), 8000);
    // 节点可能是 Y.Map（新形状）或普通对象（旧形状）→ 统一走 readBookmarks
    const chk = () => {
      if (readBookmarks(peerDoc).some((b) => b.title === "状态回归测试书签")) {
        clearTimeout(t);
        res();
      }
    };
    peerDoc.getMap("").observeDeep(chk);
    chk();
  });
});

await test("T4 disconnect 后不立刻广播 disconnected（宽限期抑制, 否则横幅闪现）", async () => {
  disconnect();
  assert.notEqual(seen[seen.length - 1], "disconnected", `不应立即广播: ${JSON.stringify(seen)}`);
  await new Promise((r) => setTimeout(r, 1000));
  assert.notEqual(seen[seen.length - 1], "disconnected", `1s 内仍不应广播: ${JSON.stringify(seen)}`);
  // 但真实掉线最终必须提示（不能把故障也吞掉）
  await waitFor(() => seen[seen.length - 1] === "disconnected", 5000, () => seen);
});

await test("T5 断连抖动（disconnect→立刻 connect）全程不出现 disconnected（本 bug 回归）", async () => {
  const from = seen.length;
  disconnect();
  connect(TOKEN);
  await waitFor(() => seen.slice(from).includes("connected"), 10000, () => seen.slice(from));
  assert.ok(
    !seen.slice(from).includes("disconnected"),
    `抖动窗口内不应广播 disconnected: ${JSON.stringify(seen.slice(from))}`,
  );
});

off();
peer.destroy();
peerDoc.destroy();
doc.destroy();
srv.kill();

await test("T6 resolveServerUrl: Node 环境（无 localStorage / 无 location.origin）不崩且回落同源", () => {
  // spec 能力块 14 · ③: 该模块会被 favicon/history 间接 import, 单测在 Node 下跑。
  // 注: **不**断言 localStorage 缺席（未来 Node 默认开启 webstorage 会挂）→ 显式删掉它
  delete (globalThis as { localStorage?: unknown }).localStorage;
  const loc = (globalThis as { location: { origin?: string; protocol: string; host: string } }).location;
  assert.equal(loc.origin, undefined, "stub location 故意没有 origin");
  assert.equal(resolveServerUrl(), `${loc.protocol}//${loc.host}`, "无 localStorage 时必须回落到自拼 origin");

  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  try {
    store.set("bnt.serverUrl", "https://other.example/");
    assert.equal(resolveServerUrl(), "https://other.example", "应使用配置的后端（去尾斜杠）");
    store.set("bnt.serverUrl", "not-a-url");
    assert.equal(resolveServerUrl(), `${loc.protocol}//${loc.host}`, "非法值回落同源");
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// 能力块 3 集成测试（CI 内可跑）: 自举 esbuild server → POST 历史 → 各维度筛选断言
// → 排除列表（CRDT settings.excludeDomains）写入/删除断言
// 端口与 crdt-status.test.mts(19200+) 错开, 避免 CI 并行冲突
import assert from "node:assert";
import { spawn, execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..");
const SERVER = path.resolve(WEB, "../server");
const TOKEN = "history-integration-token";
const PORT = 19700 + (process.pid % 200);
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "bnt-history-"));
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let total = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
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
    if ((await fetch(`${BASE}/health`)).ok) break;
  } catch {
    /* 未起 */
  }
  if (Date.now() - t0 > 10000) throw new Error("server not up in time");
  await sleep(100);
}

const H = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const seed = [
  { url: "https://github.com/a", title: "GitHub A", visitedAt: iso(3600_000) },
  { url: "https://github.com/b", title: "GitHub B", visitedAt: iso(7200_000) },
  { url: "https://zhihu.com/q", title: "知乎问题", visitedAt: iso(3 * 3600_000) },
  { url: "https://app.example:8443/p", title: "带端口的站", visitedAt: iso(4 * 3600_000) },
  { url: "https://old.example/x", title: "很旧的记录", visitedAt: iso(40 * 86400_000) },
];
const post = (entries: unknown[]) =>
  fetch(`${BASE}/api/history`, { method: "POST", headers: H, body: JSON.stringify({ entries }) });
const query = async (qs: string) => {
  const r = await fetch(`${BASE}/api/history?${qs}`, { headers: H });
  assert.ok(r.ok, `查询失败 HTTP ${r.status}`);
  return (await r.json()) as { total: number; entries: { url: string; title: string; visitedAt: string }[] };
};

let added = 0;
await test("H1 POST 批量写入", async () => {
  const r = await (await post(seed)).json();
  added = r.added;
  assert.equal(r.added, 5, `added=${JSON.stringify(r)}`);
});

await test("H2 重复上报去重（url|visitedAt）", async () => {
  const r = await (await post(seed)).json();
  assert.equal(r.added, 0, "重复条目不应重复计数");
  assert.equal(r.total, 5);
});

await test("H3 默认查询: 全部命中且按时间倒序", async () => {
  const { total, entries } = await query("limit=100");
  assert.equal(total, 5);
  const times = entries.map((e) => Date.parse(e.visitedAt));
  assert.deepEqual(times, [...times].sort((a, b) => b - a), "必须时间倒序");
});

await test("H4 关键词筛选（URL/标题子串）", async () => {
  assert.equal((await query("keyword=github")).total, 2);
  assert.equal((await query("keyword=%E7%9F%A5%E4%B9%8E")).total, 1, "中文标题亦可命中");
});

await test("H5 域名精确匹配（host 含端口）", async () => {
  assert.equal((await query("domain=github.com")).total, 2);
  assert.equal((await query("domain=app.example:8443")).total, 1, "带端口 host 精确匹配");
  assert.equal((await query("domain=example")).total, 0, "非精确不命中");
});

await test("H6 时间段 from（近 5 小时）", async () => {
  const from = new Date(now - 5 * 3600_000).toISOString();
  assert.equal((await query(`from=${encodeURIComponent(from)}`)).total, 4, "40 天前那条应被排除");
});

await test("H7 时间段 to（30 天前）", async () => {
  const to = new Date(now - 30 * 86400_000).toISOString();
  assert.equal((await query(`to=${encodeURIComponent(to)}`)).total, 1, "只剩 40 天前那条");
});

await test("H8 limit 截断但 total 反映命中总数", async () => {
  const { total, entries } = await query("limit=2");
  assert.equal(entries.length, 2);
  assert.equal(total, 5);
});

// 3) 排除列表: 走 CRDT（ADR-007）—— 用 web 的 crdt 模块写, 再用对端读回
(globalThis as unknown as { location: unknown }).location = { protocol: "http:", host: `127.0.0.1:${PORT}` };
const { connect, disconnect, doc } = await import("../src/lib/crdt.ts");
const { addExcludeDomain, removeExcludeDomain, readExcludeDomains } = await import("../src/lib/crdt.ts");
const Y = (await import("yjs")).default ?? (await import("yjs"));
const { WebsocketProvider } = await import("y-websocket");

const peerDoc = new Y.Doc();
const peer = new WebsocketProvider(`ws://127.0.0.1:${PORT}`, `ws?token=${TOKEN}`, peerDoc);
await new Promise<void>((res, rej) => {
  const t = setTimeout(() => rej(new Error("对端 bootstrap 超时")), 10000);
  const chk = () => {
    if (peerDoc.getMap("").get("settings") instanceof Y.Map) {
      clearTimeout(t);
      res();
    }
  };
  peerDoc.getMap("").observeDeep(chk);
  chk();
});
connect(TOKEN);
await new Promise<void>((res, rej) => {
  const t = setTimeout(() => rej(new Error("schema 同步超时")), 10000);
  const chk = () => {
    if (doc.getMap("").get("settings") instanceof Y.Map) {
      clearTimeout(t);
      res();
    }
  };
  doc.getMap("").observeDeep(chk);
  chk();
});

await test("H9 排除列表: 添加写入 CRDT 且多端可见", async () => {
  assert.ok(addExcludeDomain("ads.example"), "写入应成功");
  assert.deepEqual(readExcludeDomains(), ["ads.example"]);
  await sleep(400);
  const arr = peerDoc.getMap("").get("settings").get("excludeDomains");
  assert.ok(arr instanceof Y.Array, "对端应看到 excludeDomains 数组");
  assert.deepEqual(arr.toArray(), ["ads.example"], "对端读到同一值");
});

await test("H10 排除列表: 重复添加去重 / 删除生效", async () => {
  assert.ok(addExcludeDomain("ads.example"));
  assert.deepEqual(readExcludeDomains(), ["ads.example"], "重复添加不产生第二项");
  assert.ok(removeExcludeDomain("ads.example"));
  assert.deepEqual(readExcludeDomains(), []);
});

disconnect();
peer.destroy();
peerDoc.destroy();
doc.destroy();
srv.kill();

console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);

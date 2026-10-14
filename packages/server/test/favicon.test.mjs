#!/usr/bin/env node
// 能力块 6 测试: favicon 存储/读取/限制/淘汰（自举 server, 极小上限以便验证边界）
import assert from "node:assert";
import { spawn, execSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const TOKEN = "favicon-test-token";
const PORT = 21200 + (process.pid % 200);
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "bnt-favicon-"));
const BASE = `http://127.0.0.1:${PORT}`;
const MAX_BYTES = 2048; // 小上限: 验证超限拒绝
const MAX_FILES = 3; // 小上限: 验证 LRU 淘汰
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}: ${e.message}`);
  }
}

execSync(
  `${path.join(PKG, "node_modules/.bin/esbuild")} src/index.ts --bundle --platform=node --format=cjs --outfile=dist/index.js`,
  { cwd: PKG, stdio: "inherit" }
);
const srv = spawn("node", [path.join(PKG, "dist/index.js")], {
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(PORT),
    SYNC_TOKEN: TOKEN,
    DATA_DIR,
    FAVICON_MAX_BYTES: String(MAX_BYTES),
    FAVICON_MAX_FILES: String(MAX_FILES),
  },
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
  if (Date.now() - t0 > 10000) throw new Error("server not up");
  await sleep(100);
}

// 1×1 透明 PNG（仅需 magic 与体积正确）
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);
const H = (extra = {}) => ({ authorization: `Bearer ${TOKEN}`, ...extra });
const upload = (url, body, headers = {}) =>
  fetch(`${BASE}/api/favicon?url=${encodeURIComponent(url)}`, {
    method: "POST",
    headers: H({ "content-type": "image/png", ...headers }),
    body,
  });
const get = (url, headers = {}) =>
  fetch(`${BASE}/api/favicon?url=${encodeURIComponent(url)}`, { headers: H(headers) });
const missing = (urls) =>
  fetch(`${BASE}/api/favicon/missing`, {
    method: "POST",
    headers: H({ "content-type": "application/json" }),
    body: JSON.stringify({ urls }),
  }).then((r) => r.json());

await test("F1 上传 → 读取（字节与 content-type 一致 + ETag）", async () => {
  const r = await upload("https://a.example/x", PNG);
  assert.equal(r.status, 200, `status=${r.status}`);
  assert.equal((await r.json()).stored, true);
  const g = await get("https://a.example/y"); // 同源不同路径
  assert.equal(g.status, 200);
  assert.equal(g.headers.get("content-type"), "image/png");
  assert.equal(g.headers.get("content-security-policy"), "default-src 'none'");
  const bytes = Buffer.from(await g.arrayBuffer());
  assert.ok(bytes.equals(PNG), "字节应完全一致");
  const etag = g.headers.get("etag");
  assert.ok(etag, "应有 ETag");
  const g2 = await get("https://a.example/y", { "if-none-match": etag });
  assert.equal(g2.status, 304, "ETag 命中应 304");
});

await test("F2 同源归键: 不同路径同一图标（favicon 是站点级）", async () => {
  const r1 = await missing(["https://a.example/foo"]);
  assert.deepEqual(r1.missing, [], "已缓存（同源）→ 不算缺失");
});

await test("F3 缺失查询语义", async () => {
  const r = await missing(["https://a.example/x", "https://b.example/x", "https://b.example/y"]);
  assert.deepEqual(r.missing, ["https://b.example/x"], "同源去重 + 只报未缓存");
});

await test("F4 超限拒绝（store 上限 400 / 读体上限 413）", async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_BYTES)]); // 超过 store 上限但小于读体上限
  const r = await upload("https://big.example/x", big);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).reason, "too_large");
  const huge = Buffer.alloc(MAX_BYTES + 4096, 1);
  const r2 = await upload("https://huge.example/x", huge);
  assert.equal(r2.status, 413, "读体上限应 413");
});

await test("F5 非光栅内容拒绝", async () => {
  const junk = Buffer.from("GIF89a-but-actually-not-an-image-payload-" + "x".repeat(32));
  // GIF magic 正确 → 换个真正非图片的
  const notImage = Buffer.from("<svg><script>alert(1)</script></svg>");
  const r = await upload("https://svg.example/x", notImage);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).reason, "not_image");
  assert.ok(junk.length > 0);
});

await test("F6 非法 URL 拒绝", async () => {
  const r = await upload("not-a-url", PNG);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).reason, "bad_url");
});

await test("F7 鉴权: 无 token → 401", async () => {
  const r = await fetch(`${BASE}/api/favicon?url=${encodeURIComponent("https://a.example/")}`);
  assert.equal(r.status, 401);
});

await test("F8 LRU 淘汰（上限 3）", async () => {
  // 已有 a.example; 再传 3 个不同源 → 总数 4 > 3 → 淘汰最旧（a.example）
  for (const host of ["c.example", "d.example", "e.example"]) {
    await sleep(20); // 拉开 mtime
    const r = await upload(`https://${host}/`, PNG);
    assert.equal(r.status, 200);
  }
  const files = readdirSync(path.join(DATA_DIR, "favicons")).filter((f) => f.endsWith(".bin"));
  assert.equal(files.length, MAX_FILES, `应淘汰到 ${MAX_FILES}, 实际 ${files.length}`);
  const gone = await get("https://a.example/x");
  assert.equal(gone.status, 404, "最旧的应被淘汰");
  const kept = await get("https://e.example/");
  assert.equal(kept.status, 200, "最新的应保留");
});

srv.kill();
console.log(`\n${8 - failed}/8 passed`);
process.exit(failed ? 1 : 0);

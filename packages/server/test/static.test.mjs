#!/usr/bin/env node
// 静态产物服务（能力块 13 · ①）: 缺失资源必须 404（不得 HTML 冒充）、.zip 类型正确、存在时原样返回
import assert from "node:assert";
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, "..");
const PORT = 18900 + (process.pid % 90);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "static-test-token";
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "bnt-static-"));

// 端口必须空闲（AGENTS.md 坑点: 遗留进程占端口 → EADDRINUSE, 客户端连到旧实例 → "数据没到"假象）
const net = await import("node:net");
await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", (e) =>
    reject(new Error(`端口 ${PORT} 已被占用（${e.code}）—— 请先清理遗留进程, 否则测试会连到旧实例`))
  );
  probe.once("listening", () => probe.close(() => resolve()));
  probe.listen(PORT, "127.0.0.1");
});

// 自造一份最小 web 产物（含 extension.zip 的假字节）。
// 注意: 全新 checkout 时 web/dist 可能不存在 → 记录"目录是否由本测试创建", 结束后清理干净
// （否则会留下假 index.html/extension.zip, 让后续手动跑 server 时看到假页面）
const WEB_DIST = path.resolve(SERVER, "../web/dist");
const dirExisted = existsSync(WEB_DIST);
const realIndex = path.join(WEB_DIST, "index.html");
const realZip = path.join(WEB_DIST, "extension.zip");
const backup = {};
for (const f of [realIndex, realZip]) {
  backup[f] = existsSync(f) ? readFileSync(f).toString("base64") : null;
}
mkdirSync(WEB_DIST, { recursive: true });
// 还原钩子必须在**写入假产物之后立刻注册**: 否则 setup 阶段崩溃（esbuild 缺失/端口占用/server 起不来）
// 会留下假 index.html / 8 字节假 zip, 在开发者本机还会把真实产物覆盖掉且不还原
function restoreArtifacts() {
  for (const [f, b64] of Object.entries(backup)) {
    if (b64) writeFileSync(f, Buffer.from(b64, "base64"));
    else if (existsSync(f)) rmSync(f, { force: true });
  }
  if (!dirExisted && existsSync(WEB_DIST)) rmSync(WEB_DIST, { recursive: true, force: true });
}
process.on("exit", restoreArtifacts);
process.on("SIGINT", () => {
  restoreArtifacts();
  process.exit(130);
});
writeFileSync(realIndex, "<!doctype html><title>test</title>");
writeFileSync(realZip, Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]));

execSync(
  `${path.join(SERVER, "node_modules/.bin/esbuild")} src/index.ts --bundle --platform=node --format=cjs --outfile=dist/index.js`,
  { cwd: SERVER, stdio: "inherit" }
);
const srv = spawn("node", [path.join(SERVER, "dist/index.js")], {
  env: { ...process.env, HOST: "127.0.0.1", PORT: String(PORT), SYNC_TOKEN: TOKEN, DATA_DIR },
  stdio: ["ignore", "pipe", "pipe"],
});
srv.stderr.on("data", (d) => {
  const t = String(d);
  if (!t.includes("[warn]")) process.stderr.write(`[server] ${t}`);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

let failed = 0;
let total = 0;
const test = async (name, fn) => {
  total++;
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}: ${e.message}`);
  }
};
const assertOk = (c, m) => assert.ok(c, m);

await test("S1 存在的 extension.zip: 200 + application/zip + 字节原样", async () => {
  const r = await fetch(`${BASE}/extension.zip`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/zip", "MIME 必须是 application/zip");
  const buf = Buffer.from(await r.arrayBuffer());
  assert.deepEqual([...buf.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], "字节应原样返回（PK 头）");
});

await test("S2 缺失的带扩展名资源: 404（不得回落 HTML 兜底页）", async () => {
  const r = await fetch(`${BASE}/not-exist.zip`);
  assert.equal(r.status, 404, `缺失资源应 404（实际 ${r.status}）`);
  const ct = r.headers.get("content-type") ?? "";
  assertOk(!ct.includes("text/html"), `不得返回 HTML（实际 ${ct}）`);
  const body = await r.text();
  assertOk(!body.includes("<!doctype html"), "响应体不得是 HTML 文档");
});

await test("S3 无扩展名的未知路径: 仍回落兜底页（SPA 路由语义不变）", async () => {
  const r = await fetch(`${BASE}/some/spa/route`);
  assert.equal(r.status, 200);
  assertOk((r.headers.get("content-type") ?? "").includes("text/html"), "无扩展名路径应回落 HTML");
});

await test("S4 index.html: text/html 正常返回", async () => {
  const r = await fetch(`${BASE}/`);
  assert.equal(r.status, 200);
  assertOk((r.headers.get("content-type") ?? "").includes("text/html"));
});

await test("S5 缺失的 assets/*.js: 404（前端资源缺失不应静默返回 HTML）", async () => {
  const r = await fetch(`${BASE}/assets/index-missing.js`);
  assert.equal(r.status, 404, `实际 ${r.status}`);
});

restoreArtifacts();
srv.kill();
console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);

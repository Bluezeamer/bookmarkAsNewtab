#!/usr/bin/env node
// 扩展**真实加载**自检（能力块 13 · ②，第 7 轮 review）: 用 headless Chrome 装载 dist 目录,
// 断言 service worker 注册成功且无未捕获错误。
// 背景: 新增 popup 入口后 vite 做了代码分割 → sw.js 变成 ESM, 而 manifest 没声明 type:module
// → Chrome 报 "Cannot use import statement outside a module" / SW registration failed (Status code 15)
// → 书签导入/历史采集/CRDT 同步全部静默失效（页面还能开, 所以很难发现）。
// 用法: node scripts/check-ext-load.mjs [dist 目录] [chrome 路径]
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dist = path.resolve(process.argv[2] ?? "packages/extension/dist");

// Chrome 路径: argv/CHROME_BIN 优先; 否则扫 playwright 的 chromium-*（版本目录会变, 不能钉死）, 再退回 which
function findChrome() {
  if (process.argv[3]) return process.argv[3];
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const base = path.join(os.homedir(), ".cache/ms-playwright");
  try {
    const cands = readdirSync(base)
      .filter((n) => n.startsWith("chromium-"))
      .sort((a, b) => Number(b.split("-")[1] ?? 0) - Number(a.split("-")[1] ?? 0))
      .map((n) => path.join(base, n, "chrome-linux64/chrome"))
      .filter((p) => existsSync(p));
    if (cands.length > 0) return cands[0];
  } catch {
    /* 目录不存在 */
  }
  for (const name of ["chromium", "google-chrome", "chromium-browser", "chrome"]) {
    try {
      const p = execFileSync("which", [name], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      if (p && existsSync(p)) return p;
    } catch {
      /* 没装 */
    }
  }
  return "";
}
const chrome = findChrome();
if (!existsSync(dist)) {
  console.error(`FAIL 找不到扩展产物目录: ${dist}（先 pnpm --filter @bnt/extension build）`);
  process.exit(1);
}
if (!chrome || !existsSync(chrome)) {
  console.log("SKIP 未找到 Chrome（可用 CHROME_BIN 或 argv[3] 指定）—— 本项需本地/带浏览器环境");
  process.exit(0);
}

const profile = mkdtempSync(path.join(os.tmpdir(), "bnt-extload-"));

// 端口必须**先探测空闲**（AGENTS.md 约定）: 遗留进程占端口 → Chrome 绑定调试端口失败 →
// 脚本报 "Chrome 未就绪" = 假阴性（扩展其实没问题却被判挂）。占用则换端口重试。
const net = await import("node:net");
async function freePort(start) {
  for (let p = start; p < start + 40; p++) {
    const ok = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.once("listening", () => srv.close(() => resolve(true)));
      srv.listen(p, "127.0.0.1");
    });
    if (ok) return p;
  }
  throw new Error("找不到空闲调试端口（9333-9373 都被占用）");
}
const port = await freePort(9333 + (process.pid % 100));
const proc = spawn(
  chrome,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-first-run",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    "about:blank",
  ],
  // detached: 便于按**进程组**回收（headless Chrome 会派生 zygote/renderer, 只 kill 顶层会残留占住 profile）
  { stdio: ["ignore", "ignore", "pipe"], detached: true }
);
const killChrome = () => {
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let version = null;
for (let i = 0; i < 100; i++) {
  try {
    version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    break;
  } catch {
    await sleep(100);
  }
}
if (!version) {
  console.error("FAIL Chrome 未就绪");
  killChrome();
  process.exit(1);
}

// 稳定性: 任何未捕获的拒绝/异常都不应让门"随机失败"或"随机通过" —— 统一记为问题项
const problemsEarly = [];
process.on("unhandledRejection", (e) => problemsEarly.push(`unhandledRejection: ${e}`));
process.on("uncaughtException", (e) => problemsEarly.push(`uncaughtException: ${e}`));

const ws = new WebSocket(version.webSocketDebuggerUrl);
ws.onerror = () => problemsEarly.push("CDP websocket 出错");
let id = 0;
const pending = new Map();
const swLogs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  }
  if (m.method === "Runtime.exceptionThrown") {
    swLogs.push(m.params.exceptionDetails?.exception?.description ?? "exception");
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    swLogs.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  }
};
await new Promise((res) => (ws.onopen = () => res()));
const rpc = (method, params = {}, sessionId) => {
  const n = ++id;
  ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((res, rej) => pending.set(n, { res, rej }));
};

// 等 service worker 目标出现（MV3 的 SW 在扩展加载后会被拉起）
// 注意: 必须按**我们自己的文件名**过滤 —— Chrome 自带扩展也有 service_worker 目标
// （实测 headless 下能匹配到内置扩展的 thunk.js, 会让负例误判为通过）
let sw = null;
let seen = [];
for (let i = 0; i < 40; i++) {
  const { targetInfos } = await rpc("Target.getTargets");
  seen = targetInfos
    .filter((t) => t.type === "service_worker")
    .map((t) => t.url)
    .slice(0, 5);
  sw = targetInfos.find((t) => t.type === "service_worker" && /\/sw\.js$/.test(t.url));
  if (sw) break;
  await sleep(250);
}

const problems = [...problemsEarly];
if (!sw) {
  problems.push(
    `未发现我们自己的 service worker（sw.js）—— SW 注册失败 → 书签/历史/同步全部不工作; 已见 SW 目标: ${JSON.stringify(seen)}`
  );
}
else {
  // 挂上 SW 的 console/异常监听, 再等一会看有没有报错
  try {
    const { sessionId } = await rpc("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
    await rpc("Runtime.enable", {}, sessionId);
    await sleep(1500);
  } catch (e) {
    // SW 可能在 attach 前就被回收（MV3 正常行为）→ 不作为失败, 但记录以便排查
    console.log(`注: 未能附加到 SW 会话（${e instanceof Error ? e.message : String(e)}）`);
  }
}
if (swLogs.some((l) => /import statement|SyntaxError|registration failed/i.test(l))) {
  problems.push(...swLogs.filter((l) => /import statement|SyntaxError|registration failed/i.test(l)));
}

ws.close();
killChrome();
rmSync(profile, { recursive: true, force: true });

if (problems.length > 0) {
  console.error("FAIL 扩展加载自检未通过:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`PASS 扩展加载自检: service worker 已注册（${sw.url}）, 无语法/注册错误`);

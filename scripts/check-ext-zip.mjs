#!/usr/bin/env node
// 扩展 zip 自检（能力块 13 · ①，第 6 轮 review 阻塞项）
//
// 为什么需要: `zip -j`（去路径）会丢掉 dist 的子目录。本 MR 新增 popup 入口后, vite 产物
// 多了 `assets/`（modulepreload-polyfill、共享 chunk）, 两个 HTML 以 `/assets/...` 引用、
// newtab.js/popup.js 以 `./assets/...` 导入 → 用 -j 打包后这些引用全部解析失败,
// 装进 Chrome 就是**两个空白页**（sw.js 正常, 所以不容易发现）。
// 只检查 manifest 引用是不够的 —— 这里把 zip 解开, 逐个校验**所有**模块/资源引用可解析。
//
// 用法: node scripts/check-ext-zip.mjs <zip 路径>
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const zip = process.argv[2];
if (!zip || !existsSync(zip)) {
  console.error(`FAIL 找不到 zip: ${zip}`);
  process.exit(1);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "bnt-extzip-"));
function extract() {
  // 优先 unzip; 没有则退回 python3 的 zipfile（本地/CI 至少有一个）
  try {
    execFileSync("unzip", ["-q", "-o", zip, "-d", tmp], { stdio: "pipe" });
    return "unzip";
  } catch {
    /* 试 python3 */
  }
  try {
    execFileSync("python3", ["-m", "zipfile", "-e", zip, tmp], { stdio: "pipe" });
    return "python3";
  } catch (e) {
    console.error("FAIL 需要 unzip 或 python3 才能校验 zip 内容（CI 请 apk add unzip）");
    console.error(String(e));
    process.exit(1);
  }
}
const tool = extract();

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
const files = walk(tmp);
const rel = (p) => path.relative(tmp, p).split(path.sep).join("/");
const present = new Set(files.map(rel));

const problems = [];
// 1) manifest 直接引用的文件必须存在
const manifestPath = files.find((f) => rel(f) === "manifest.json");
const manifest = manifestPath ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
if (!manifestPath || !manifest) problems.push("manifest.json 不在 zip 顶层（Chrome 无法加载）");
else {
  const m = manifest;
  const refs = [
    m.chrome_url_overrides?.newtab,
    m.background?.service_worker,
    m.action?.default_popup,
    ...(m.web_accessible_resources ?? []).flatMap((r) => r.resources ?? []),
  ].filter((x) => typeof x === "string" && !x.includes("*"));
  for (const r of refs) if (!present.has(r)) problems.push(`manifest 引用缺失: ${r}`);
}

// 2) ESM 语法必须被正确声明 —— 否则 Chrome 按经典脚本加载 → "Cannot use import statement outside a module"
//    （真实事故: 新增 popup 入口后 vite 代码分割, sw.js 出现 import, 而 manifest 没声明 type:module
//     → SW 注册失败 Status code 15 → 书签导入/历史采集/CRDT 同步全部不工作）
// 注: 这是**启发式**（要求行首/分号/换行后紧跟 import|export + 空格/{/*/引号）,
// 已验证 "import statement failed" / "important" 这类字符串不会误报; vite 产物里出现同形字符串的概率极低。
const ESM_RE = /(^|[;}\n])\s*(import|export)[\s{*("'`]/;
if (manifest) {
  const m = manifest;
  const swRel = m.background?.service_worker;
  if (typeof swRel === "string" && present.has(swRel)) {
    const sw = readFileSync(path.join(tmp, swRel), "utf8");
    if (ESM_RE.test(sw) && m.background?.type !== "module") {
      problems.push(
        `${swRel} 含 ESM import/export, 但 manifest 的 background.type 不是 "module" → SW 注册会失败（Status code 15）`
      );
    }
  }
}
for (const f of files) {
  if (!f.endsWith(".html")) continue;
  const html = readFileSync(f, "utf8");
  for (const tag of html.matchAll(/<script([^>]*)>/g)) {
    const attrs = tag[1];
    const srcMatch = /src="([^"]+)"/.exec(attrs);
    if (!srcMatch) continue;
    const target = srcMatch[1].startsWith("/") ? srcMatch[1].slice(1) : srcMatch[1];
    if (!present.has(target)) continue;
    const js = readFileSync(path.join(tmp, target), "utf8");
    if (ESM_RE.test(js) && !/type="module"/.test(attrs)) {
      problems.push(`${rel(f)} 以经典脚本加载 ${target}, 但该文件含 ESM 语法 → 必须加 type="module"`);
    }
  }
}

// 3) HTML 与 JS 里的资源引用必须存在（这正是 -j 打包会破坏的部分）
const RE = /(?:src|href)="(\/[^"]+)"|(?:import|from)\s*\(?\s*["'](\.\.?\/[^"']+)["']/g;
for (const f of files) {
  if (!/\.(html|js|css)$/.test(f)) continue;
  const dir = path.posix.dirname(rel(f));
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(RE)) {
    const raw = m[1] ?? m[2];
    if (!raw || raw.startsWith("data:") || raw.startsWith("http")) continue;
    const target = raw.startsWith("/")
      ? raw.slice(1)
      : path.posix.normalize(path.posix.join(dir === "." ? "" : dir, raw));
    if (!present.has(target)) problems.push(`${rel(f)} 引用缺失: ${raw} → ${target}`);
  }
}

rmSync(tmp, { recursive: true, force: true });

if (problems.length > 0) {
  console.error(`FAIL zip 自检未通过（${tool} 解包）:`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error("提示: 打包必须保留目录结构（cd packages/extension/dist && zip -qr <out> .），不能用 zip -j");
  process.exit(1);
}
console.log(`PASS zip 自检: ${files.length} 个文件, manifest 与全部模块/资源引用可解析（${tool} 解包）`);

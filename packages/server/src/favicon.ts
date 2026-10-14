// 书签图标（favicon）: 按 origin 归键的本地缓存（能力块 6）
// 参考文档原则: 图标由浏览器内核算（extension 端 _favicon/）, 服务端只做**持久化副本**
// （服务端不主动外联抓取）; 无副本时前端退回域名首字母色块
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const MAGIC: [string, number[]][] = [
  ["image/png", [0x89, 0x50, 0x4e, 0x47]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/gif", [0x47, 0x49, 0x46, 0x38]],
  ["image/bmp", [0x42, 0x4d]],
  ["image/x-icon", [0x00, 0x00, 0x01, 0x00]],
];

// 只收光栅图: svg 可携带脚本, 服务端不自证安全 → 一律拒绝
export function sniffImageType(buf: Buffer): string | null {
  for (const [type, magic] of MAGIC) {
    if (buf.length >= magic.length && magic.every((b, i) => buf[i] === b)) return type;
  }
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

// favicon 是站点级资源 → 按 origin 归键（同源不同路径同键）
export function faviconOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return null;
  }
}

export function faviconKey(raw: string): string | null {
  const origin = faviconOrigin(raw);
  return origin ? createHash("sha1").update(origin).digest("hex") : null;
}

export const maxBytes = (): number => Number(process.env.FAVICON_MAX_BYTES ?? 262144);
export const maxFiles = (): number => Number(process.env.FAVICON_MAX_FILES ?? 5000);

function dir(dataDir: string): string {
  const d = path.join(dataDir, "favicons");
  mkdirSync(d, { recursive: true });
  return d;
}
const fileOf = (dataDir: string, key: string): string => path.join(dir(dataDir), `${key}.bin`);
const etagOf = (bytes: Buffer): string => `"${createHash("sha1").update(bytes).digest("hex").slice(0, 16)}"`;

export interface StoreResult {
  stored: boolean;
  key?: string;
  reason?: string;
}

export function saveFavicon(dataDir: string, rawUrl: string, bytes: Buffer): StoreResult {
  const key = faviconKey(rawUrl);
  if (!key) return { stored: false, reason: "bad_url" };
  if (bytes.length === 0) return { stored: false, reason: "empty" };
  if (bytes.length > maxBytes()) return { stored: false, reason: "too_large" };
  if (!sniffImageType(bytes)) return { stored: false, reason: "not_image" };
  const file = fileOf(dataDir, key);
  if (existsSync(file)) {
    // 内容相同 → 幂等短路（避免反复写盘）
    try {
      if (readFileSync(file).equals(bytes)) return { stored: true, key };
    } catch {
      /* 损坏文件按覆盖处理 */
    }
  }
  writeFileSync(file, bytes);
  pruneFavicons(dataDir);
  return { stored: true, key };
}

export function readFavicon(
  dataDir: string,
  rawUrl: string
): { bytes: Buffer; contentType: string; etag: string } | null {
  const key = faviconKey(rawUrl);
  if (!key) return null;
  const file = fileOf(dataDir, key);
  if (!existsSync(file)) return null;
  try {
    const bytes = readFileSync(file);
    const contentType = sniffImageType(bytes);
    if (!contentType) return null;
    return { bytes, contentType, etag: etagOf(bytes) };
  } catch {
    return null;
  }
}

// 供扩展只上传缺失项（避免无谓流量）
export function missingFavicons(dataDir: string, urls: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const u of urls) {
    const key = faviconKey(u);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!existsSync(fileOf(dataDir, key))) out.push(u);
  }
  return out;
}

// 总量超限 → 按 mtime 淘汰最旧（LRU 近似）
export function pruneFavicons(dataDir: string): number {
  const cap = maxFiles();
  let files: { f: string; mtime: number }[] = [];
  try {
    const d = dir(dataDir);
    files = readdirSync(d)
      .filter((f) => f.endsWith(".bin"))
      .map((f) => ({ f, mtime: statSync(path.join(d, f)).mtimeMs }));
  } catch {
    return 0;
  }
  if (files.length <= cap) return 0;
  files.sort((a, b) => a.mtime - b.mtime);
  let removed = 0;
  for (const { f } of files.slice(0, files.length - cap)) {
    try {
      unlinkSync(path.join(dir(dataDir), f));
      removed++;
    } catch {
      /* 忽略单个失败 */
    }
  }
  return removed;
}

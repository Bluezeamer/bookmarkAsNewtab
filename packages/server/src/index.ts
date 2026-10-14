import http from "node:http";
import { mkdirSync, existsSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import path from "node:path";
import { WebSocketServer } from "ws";
import { doc, loadOrCreate, scheduleSave, saveNow } from "./doc.js";
import { createRelay } from "./sync.js";
import { history, type HistoryEntry } from "./history.js";
import { checkToken } from "./auth.js";
import { classifyPending, createClassifier } from "./classifier.js";
import { dedupeBookmarks } from "./dedupe.js";
import { faviconKey, maxBytes as faviconMaxBytes, missingFavicons, readFavicon, saveFavicon } from "./favicon.js";

// 只绑回环：公网入口交给反向代理（如 Nginx Proxy Manager → 127.0.0.1:8090）
const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8090);

// ADR-006: 单 Bearer token（.env 注入）; 未配置 = fail-closed（/api 与 /ws 全拒）
const TOKEN = process.env.SYNC_TOKEN ?? "";

// 部署方显示名（可选）: 仅用于页首问候语, 未配置则问候语不带名字
const OWNER_NAME = process.env.OWNER_NAME ?? "";

// ADR-005: 自动分类器（未配置 CLASSIFIER_URL/MODEL → null = no-op, 行为与启用前一致）
const classifier = createClassifier(process.env);

// 数据目录（spec req 7）: 生产 systemd 应指向 current/ 之外的持久路径
// （release 目录每次部署被替换, 数据必须在外）
// esbuild 产物是 CJS（唯一运行形态: build/投产/测试都跑 dist/index.js）, 直接用 __dirname
const HERE = __dirname;
const DATA_DIR = process.env.DATA_DIR ?? path.resolve(HERE, "../data");
mkdirSync(DATA_DIR, { recursive: true });
loadOrCreate(DATA_DIR);
history.load(DATA_DIR);
doc.on("update", () => scheduleSave(DATA_DIR));

// web 静态产物候选路径（启动时取第一个存在的）:
//   部署布局  current/{server,web}      → ../web
//   仓库/生产布局一致: server/src|dist → ../../web/dist（构建产物）
const WEB_DIST = path.resolve(HERE, "../../web/dist");

// 启动自检（能力块 13 · ①）: 产物缺失必须**在日志里可见**, 而不是等用户下载到 HTML 才发现
for (const rel of ["index.html", "extension.zip"]) {
  const p = path.join(WEB_DIST, rel);
  if (!existsSync(p)) {
    console.warn(`[warn] web 产物缺失: ${p} —— 该资源将返回 404（/extension.zip 缺失会导致"插件下载损坏"）`);
  }
}

// 按扩展名给最小 MIME 映射（intent ③ Vite 产物: js/css 必须正确 MIME, 否则浏览器拒载 module）
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  // 扩展包: 必须给对类型, 否则浏览器可能按兜底类型处理（能力块 13 · ①）
  ".zip": "application/zip",
  ".map": "application/json; charset=utf-8",
};

// web 产物缺失时的兜底页（server 可独立运行）
const FALLBACK_PAGE = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>bookmarkAsNewtab server</title>
  </head>
  <body>
    <h1>bookmarkAsNewtab server is running</h1>
  </body>
</html>`;

// CORS: extension 的 service worker 跨源 fetch /api（MV3 SW 受 CORS 约束）;
// 单用户自托管 + Bearer 鉴权, 放开 origin 可接受
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

// 二进制读体（图标上传等）: 超限 → 停止读取并抛错, 由路由回 413 后关连接
// （不能直接 destroy: 客户端会只看到 fetch failed, 拿不到状态码）
function readBinary(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        req.pause();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", ...CORS });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage, maxBytes = 1_000_000): Promise<string> {  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c: Buffer) => {
      data += c.toString();
      if (data.length > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// --- /api/history（ADR-007）: POST 批量写入（去重+裁剪）/ GET 过滤查询 ---
async function handleHistory(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  u: URL
): Promise<void> {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  if (req.method === "POST") {
    let payload: { entries?: unknown };
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: "invalid json" });
      return;
    }
    const entries = Array.isArray(payload.entries)
      ? (payload.entries as HistoryEntry[]).filter((e) => e && typeof e.url === "string" && typeof e.visitedAt === "string")
      : [];
    if (entries.length > 500) {
      json(res, 400, { error: "batch too large (max 500)" });
      return;
    }
    json(res, 200, history.append(DATA_DIR, entries));
    return;
  }
  if (req.method === "GET") {
    const q = u.searchParams;
    const limit = Number(q.get("limit") ?? 100);
    json(
      res,
      200,
      history.query({
        keyword: q.get("keyword") ?? undefined,
        domain: q.get("domain") ?? undefined,
        from: q.get("from") ?? undefined,
        to: q.get("to") ?? undefined,
        limit: Number.isFinite(limit) ? limit : 100,
      })
    );
    return;
  }
  json(res, 405, { error: "method not allowed" });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", "http://localhost");
  const url = u.pathname;

  // 健康检查: 部署签收点与外部监控的挂钩对象（不鉴权）
  if (req.method === "GET" && url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "bookmarkasnewtab" }));
    return;
  }

  // 公开配置（不鉴权）: 只含非敏感展示信息, 供前端启动时读取
  if (req.method === "GET" && url === "/api/config") {
    json(res, 200, { ownerName: OWNER_NAME });
    return;
  }

  // /api/*: Bearer 鉴权（ADR-006）
  if (url.startsWith("/api/")) {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!checkToken(TOKEN, token)) {
      json(res, 401, { error: "unauthorized" });
      return;
    }
    if (url === "/api/history") {
      await handleHistory(req, res, u);
      return;
    }
    // /api/classify（ADR-005）: 按需批量分类未建议书签（不做后台自动跑）
    if (url === "/api/classify") {
      if (req.method !== "POST") {
        json(res, 405, { error: "method not allowed" });
        return;
      }
      if (!classifier) {
        json(res, 200, { enabled: false, classified: 0, skipped: 0, failed: 0 });
        return;
      }
      const limit = Number(u.searchParams.get("limit") ?? 20);
      const force = u.searchParams.get("force") === "1";
      const stats = await classifyPending(doc, classifier, {
        limit: Number.isFinite(limit) ? limit : 20,
        force,
      });
      json(res, 200, { enabled: true, ...stats });
      return;
    }
    // /api/dedupe: 同 URL 书签去重 + 同名文件夹合并（重复导入事故的清理）
    if (url === "/api/dedupe") {
      if (req.method !== "POST") {
        json(res, 405, { error: "method not allowed" });
        return;
      }
      json(res, 200, dedupeBookmarks(doc));
      return;
    }
    // /api/favicon（能力块 6）: 客户端回传的图标持久化副本
    // 服务端**不主动**外联抓取图标（参考文档）; 无副本时前端退回首字母色块
    if (url === "/api/favicon") {
      if (req.method === "POST") {
        const target = u.searchParams.get("url") ?? "";
        if (!faviconKey(target)) {
          json(res, 400, { stored: false, reason: "bad_url" });
          return;
        }
        let body: Buffer;
        try {
          body = await readBinary(req, faviconMaxBytes() + 1024);
        } catch {
          res.writeHead(413, { ...CORS, "content-type": "application/json", connection: "close" });
          res.end(JSON.stringify({ stored: false, reason: "too_large" }));
          return;
        }
        const r = saveFavicon(DATA_DIR, target, body);
        json(res, r.stored ? 200 : 400, r);
        return;
      }
      if (req.method === "GET") {
        const target = u.searchParams.get("url") ?? "";
        const hit = readFavicon(DATA_DIR, target);
        if (!hit) {
          json(res, 404, { error: "not found" });
          return;
        }
        if (req.headers["if-none-match"] === hit.etag) {
          res.writeHead(304, { ...CORS, etag: hit.etag });
          res.end();
          return;
        }
        res.writeHead(200, {
          ...CORS,
          "content-type": hit.contentType,
          "content-length": hit.bytes.length,
          etag: hit.etag,
          "cache-control": "private, max-age=604800",
          // 图标是我们代为存储的第三方字节: 明确不可作为文档执行
          "content-security-policy": "default-src 'none'",
          "x-content-type-options": "nosniff",
        });
        res.end(hit.bytes);
        return;
      }
      json(res, 405, { error: "method not allowed" });
      return;
    }
    // 缺失查询: 供扩展只上传未缓存项
    if (url === "/api/favicon/missing") {
      if (req.method !== "POST") {
        json(res, 405, { error: "method not allowed" });
        return;
      }
      let payload: { urls?: unknown };
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "invalid json" });
        return;
      }
      const urls = Array.isArray(payload.urls)
        ? payload.urls.filter((x): x is string => typeof x === "string").slice(0, 2000)
        : [];
      json(res, 200, { missing: missingFavicons(DATA_DIR, urls) });
      return;
    }
    json(res, 404, { error: "not found" });
    return;
  }

  // 静态文件: / → index.html; /<file> → web 产物（防路径穿越）
  if (req.method === "GET" && WEB_DIST) {
    const file = url === "/" ? "index.html" : url.slice(1);
    const target = path.resolve(WEB_DIST, file);
    // 防穿越: 必须等于 WEB_DIST 或是其子路径（加 path.sep, 防 web-evil/ 兄弟目录前缀绕过）
    if (target === WEB_DIST || target.startsWith(WEB_DIST + path.sep)) {
      try {
        const body = await readFileAsync(target);
        res.writeHead(200, {
          "content-type": MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream",
        });
        res.end(body);
        return;
      } catch {
        // 文件不存在: **带扩展名的路径直接 404** —— 否则会把兜底 HTML 当资源返回
        // （能力块 13 · ①: 其他机器部署缺 extension.zip 时, 浏览器把 HTML 当 zip 保存 = "格式损坏"）
        if (path.extname(file)) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("not found");
          return;
        }
        // 无扩展名 → 可能是前端路由, 落回兜底页
      }
    }
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(FALLBACK_PAGE);
});

// --- /ws: Yjs 同步（ADR-001, 星型中继见 sync.ts）; upgrade 时 token 鉴权（ADR-006） ---
const wss = new WebSocketServer({ noServer: true });
const relay = createRelay(doc);
wss.on("connection", (ws) => {
  relay.attach(ws);
});

server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url ?? "/", "http://localhost");
  if (u.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  if (!checkToken(TOKEN, u.searchParams.get("token"))) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// 优雅退出: 同步落盘快照（防抖窗口内的更新不丢）
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    saveNow(DATA_DIR);
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

server.listen(PORT, HOST, () => {
  console.log(`bookmarkAsNewtab server listening on ${HOST}:${PORT} (data: ${DATA_DIR})`);
});

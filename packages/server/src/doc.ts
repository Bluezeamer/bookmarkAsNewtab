// ADR-001: CRDT 文档单例（Yjs）+ 文件快照持久化（spec: 选型=文件快照, 零依赖）
// schema（root map 三命名空间）:
//   bookmarks: Y.Map<id, node>  node={title,url,folder,order,created,meta{auto:Y.Map}}（ADR-005）
//   folders:   Y.Map<id, {name,parent,order}>  扁平+引用表达树（避免 CRDT 结构共享问题）
//   settings:  Y.Map{excludeDomains: Y.Array<string>}（ADR-007 排除列表, 多端同步）
import * as Y from "yjs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const doc = new Y.Doc();
const SNAPSHOT_NAME = "bookmarks.ydoc";

export function ensureSchema(d: Y.Doc): void {
  const root = d.getMap("");
  if (!root.get("bookmarks")) root.set("bookmarks", new Y.Map<unknown>());
  if (!root.get("folders")) root.set("folders", new Y.Map<unknown>());
  let settings = root.get("settings") as Y.Map<unknown> | undefined;
  if (!settings) {
    settings = new Y.Map<unknown>();
    root.set("settings", settings);
  }
  if (!settings.get("excludeDomains")) settings.set("excludeDomains", new Y.Array<string>());
}

export function loadOrCreate(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, SNAPSHOT_NAME);
  if (existsSync(file)) {
    Y.applyUpdate(doc, readFileSync(file));
  }
  ensureSchema(doc);
}

let saveTimer: NodeJS.Timeout | null = null;

// 防抖 2s 落盘（spec req 4: update 触发; 崩溃最多丢 2s, 各客户端持完整状态可回填）
export function scheduleSave(dataDir: string): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveNow(dataDir), 2000);
  saveTimer.unref();
}

export function saveNow(dataDir: string): void {
  const file = path.join(dataDir, SNAPSHOT_NAME);
  writeFileSync(file, Y.encodeStateAsUpdate(doc));
}

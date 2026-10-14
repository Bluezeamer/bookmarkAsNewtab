// ADR-005 落地: 自动分类服务（OpenAI 兼容 chat completions）
// 未配置 CLASSIFIER_URL/MODEL → 工厂返回 null（no-op, 行为与启用前完全一致）
// 服务端是唯一写入 meta.auto 的地方; 建议必须校验后才落 CRDT（不信任模型）
import * as Y from "yjs";

export interface ClassifyInput {
  title: string;
  url: string;
  folders: string[];
}

export interface ClassifySuggestion {
  folder?: string;
  tags: string[];
}

export interface ClassifierService {
  classify(input: ClassifyInput): Promise<ClassifySuggestion | null>;
}

// ---------- 纯函数（可单测） ----------

// 取第一个平衡的 JSON 对象（容忍 markdown 围栏与前后废话）
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// 标签清洗: ≤5 个, 每个 ≤24 字符, 去控制字符/空白/去重
export function sanitizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== "string") continue;
    const s = t.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 24);
    if (!s || out.includes(s)) continue;
    out.push(s);
    if (out.length >= 5) break;
  }
  return out;
}

// 解析模型输出 → 建议（非法/空 → null）; folders 用于把建议夹名归一化到现有夹
export function parseSuggestion(text: string, folders: string[]): ClassifySuggestion | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  let folder: string | undefined;
  if (typeof obj.folder === "string") {
    const f = obj.folder.trim().slice(0, 40);
    if (f) {
      const existing = folders.find((x) => x.toLowerCase() === f.toLowerCase());
      folder = existing ?? f; // 命中现有夹则复用其规范名（避免产生重复夹）
    }
  }
  const tags = sanitizeTags(obj.tags);
  if (!folder && tags.length === 0) return null;
  return { folder, tags };
}

// ---------- 服务实现 ----------

interface ClassifierEnv {
  CLASSIFIER_URL?: string;
  CLASSIFIER_MODEL?: string;
  CLASSIFIER_API_KEY?: string;
  CLASSIFIER_TIMEOUT_MS?: string;
  CLASSIFIER_MAX_TOKENS?: string;
}

const PROMPT_SYSTEM = [
  "你是书签分类助手。给定书签的标题与网址, 以及用户已有的文件夹列表,",
  "输出严格 JSON: {\"folder\": \"<从已有文件夹中挑最合适的一个; 都不合适时给一个简短新名>\", \"tags\": [\"最多5个, 每个不超过24字符\"]}",
  "只输出 JSON, 不要解释、不要 markdown 围栏。",
].join("\n");

export function createClassifier(env: ClassifierEnv = process.env): ClassifierService | null {
  const base = env.CLASSIFIER_URL?.trim().replace(/\/$/, "");
  const model = env.CLASSIFIER_MODEL?.trim();
  if (!base || !model) return null; // no-op（ADR-005 原语义）
  const timeoutMs = Number(env.CLASSIFIER_TIMEOUT_MS ?? 30000);
  const maxTokens = Number(env.CLASSIFIER_MAX_TOKENS ?? 512); // reasoning 模型预算给小了会只剩推理没有答案

  return {
    async classify(input: ClassifyInput): Promise<ClassifySuggestion | null> {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(env.CLASSIFIER_API_KEY ? { authorization: `Bearer ${env.CLASSIFIER_API_KEY}` } : {}),
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: PROMPT_SYSTEM },
              {
                role: "user",
                content: [
                  `已有文件夹: ${input.folders.length ? input.folders.join(", ") : "(无)"}`,
                  `书签标题: ${input.title || "(无标题)"}`,
                  `网址: ${input.url}`,
                  "只输出 JSON。",
                ].join("\n"),
              },
            ],
            max_tokens: maxTokens,
            temperature: 0,
          }),
          signal: ctrl.signal,
        });
        if (!r.ok) throw new Error(`模型 HTTP ${r.status}`);
        const j = (await r.json()) as {
          choices?: { message?: { content?: string | null; reasoning_content?: string | null } }[];
        };
        const msg = j.choices?.[0]?.message;
        // 兼容 reasoning 模型: content 为空时退到 reasoning_content（仍要过同一套校验）
        const text = (msg?.content ?? "").trim() || (msg?.reasoning_content ?? "").trim();
        if (!text) return null;
        return parseSuggestion(text, input.folders);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// ---------- 批量分类并写入 CRDT（meta.auto, ADR-005） ----------

export interface ClassifyStats {
  classified: number;
  skipped: number;
  failed: number;
}

// 节点字段读取（兼容 Y.Map 新形状与旧普通对象节点）
function nodeFields(v: unknown): Record<string, unknown> | undefined {
  if (v instanceof Y.Map) {
    const o: Record<string, unknown> = {};
    for (const k of ["title", "url", "folder", "order", "created"]) o[k] = v.get(k);
    return o;
  }
  if (v && typeof v === "object") return v as Record<string, unknown>;
  return undefined;
}

// 取/建 meta.auto。书签节点必须是 Y.Map（普通对象承载不了嵌套共享类型 ——
// 旧形状下 meta.auto 会退化为普通对象而失效）; 旧普通对象节点在此升级为 Y.Map。
function ensureAuto(
  bookmarks: Y.Map<unknown>,
  id: string,
  value: unknown
): Y.Map<unknown> | null {
  if (value instanceof Y.Map) {
    let meta = value.get("meta");
    if (!(meta instanceof Y.Map)) {
      const m = new Y.Map<unknown>();
      m.set("auto", new Y.Map<unknown>());
      value.set("meta", m);
      meta = m;
    }
    let auto = (meta as Y.Map<unknown>).get("auto");
    if (!(auto instanceof Y.Map)) {
      const a = new Y.Map<unknown>();
      (meta as Y.Map<unknown>).set("auto", a);
      auto = a;
    }
    return auto as Y.Map<unknown>;
  }
  const fields = nodeFields(value);
  if (!fields) return null;
  const migrated = new Y.Map<unknown>();
  for (const k of ["title", "url", "folder", "order", "created"]) migrated.set(k, fields[k]);
  const meta = new Y.Map<unknown>();
  meta.set("auto", new Y.Map<unknown>());
  migrated.set("meta", meta);
  bookmarks.set(id, migrated);
  return meta.get("auto") as Y.Map<unknown>;
}

export async function classifyPending(
  doc: Y.Doc,
  service: ClassifierService,
  opts: { limit?: number; force?: boolean } = {}
): Promise<ClassifyStats> {
  const root = doc.getMap("");
  const bookmarks = root.get("bookmarks");
  if (!(bookmarks instanceof Y.Map)) return { classified: 0, skipped: 0, failed: 0 };

  const folderMap = root.get("folders");
  const folders: string[] = [];
  if (folderMap instanceof Y.Map) {
    for (const f of folderMap.values()) {
      if (f && typeof f === "object" && !(f instanceof Y.Map)) {
        const name = String((f as { name?: unknown }).name ?? "").trim();
        if (name) folders.push(name);
      }
    }
  }

  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const stats: ClassifyStats = { classified: 0, skipped: 0, failed: 0 };

  for (const [id, value] of bookmarks as Y.Map<unknown>) {
    if (stats.classified + stats.skipped + stats.failed >= limit) break;
    const fields = nodeFields(value);
    if (!fields) continue;
    const auto = ensureAuto(bookmarks, id, value);
    if (!auto) {
      stats.failed++;
      continue;
    }
    const hasSuggestion = Boolean(auto.get("suggestedFolder") ?? auto.get("tags"));
    if (hasSuggestion && !opts.force) {
      stats.skipped++;
      continue;
    }
    try {
      // 只发送标题与 URL（隐私: 不发浏览历史）
      const s = await service.classify({
        title: String(fields.title ?? ""),
        url: String(fields.url ?? ""),
        folders,
      });
      if (!s) {
        stats.failed++;
        continue;
      }
      doc.transact(() => {
        if (s.folder) auto.set("suggestedFolder", s.folder);
        else auto.delete("suggestedFolder");
        if (s.tags.length) auto.set("tags", s.tags.join(","));
        else auto.delete("tags");
        auto.set("suggestedAt", new Date().toISOString());
        if (opts.force) auto.delete("acceptedAt");
      });
      stats.classified++;
    } catch {
      stats.failed++; // 单条失败不影响其它条目, 也不写 CRDT
    }
  }
  return stats;
}

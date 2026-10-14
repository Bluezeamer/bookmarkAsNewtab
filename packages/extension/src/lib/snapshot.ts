// CRDT 快照读取（能力块 13 · ③）—— 纯函数, 形状无关, 便于单测
//
// **为什么单独成文件**: 真实 schema 里两种形状并存 ——
//   · 书签节点必须是 Y.Map（ADR-009; 普通对象里的嵌套 Y.Map 不会被集成）
//   · **文件夹节点是普通对象**（crdtAddFolder / web crdt 都是 `fm.set(id, { name, parent, order })`）
// 早期版本的回写快照读取只认"有 .get() 的值", 于是文件夹全被读成 name:"" →
// 「改名 → renameFolder」永不触发（且旧形状普通对象书签节点也会丢 folder/order）。
// 这个适配层必须显式测两种形状（合成 Snapshot 的单测拦不住它）。
import type { Snapshot } from "./writeback.ts";

// Y.Map 判定用**鸭子类型**而不是 instanceof:
//   · 测试里 `.mts`(ESM) 与 `.ts`(CJS) 会各拿到一份 yjs → instanceof 跨实例为 false（实测 T21 失败）
//   · 鸭子类型对"另一个 realm/另一份 bundle 的 Y.Map"同样成立
// Y.Map 有 get() 与 toJSON(), 普通对象没有 toJSON ✓
export function isYMapLike(v: unknown): v is { get(key: string): unknown } {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as { get?: unknown }).get === "function" &&
    typeof (v as { toJSON?: unknown }).toJSON === "function"
  );
}

// 形状无关取字段: Y.Map 形状 → get(); 普通对象 → 下标
export function fieldOf(v: unknown, key: string): unknown {
  if (isYMapLike(v)) return v.get(key);
  if (v && typeof v === "object") return (v as Record<string, unknown>)[key];
  return undefined;
}

interface MapLike {
  forEach(cb: (value: unknown, key: string) => void): void;
}

export function snapshotFromRoot(root: { get(key: string): unknown }): Snapshot {
  const bookmarks = new Map<string, { folder: string | null; order: number; title: string; url: string }>();
  const folders = new Map<string, { name: string; parent: string | null; order: number }>();

  const bm = root.get("bookmarks") as MapLike | undefined;
  bm?.forEach?.((v, k) => {
    const folder = fieldOf(v, "folder");
    const order = fieldOf(v, "order");
    const title = fieldOf(v, "title");
    const url = fieldOf(v, "url");
    bookmarks.set(k, {
      folder: typeof folder === "string" ? folder : null,
      order: typeof order === "number" ? order : 0,
      title: typeof title === "string" ? title : "",
      url: typeof url === "string" ? url : "",
    });
  });

  const fm = root.get("folders") as MapLike | undefined;
  fm?.forEach?.((v, k) => {
    const name = fieldOf(v, "name");
    const parent = fieldOf(v, "parent");
    const order = fieldOf(v, "order");
    folders.set(k, {
      name: typeof name === "string" ? name : "",
      parent: typeof parent === "string" ? parent : null,
      order: typeof order === "number" ? order : 0,
    });
  });

  return { bookmarks, folders };
}

// 快照序列化（持久化基线用）: Map → 数组
export function serializeSnapshot(snap: Snapshot): string {
  return JSON.stringify({
    b: [...snap.bookmarks.entries()],
    f: [...snap.folders.entries()],
  });
}

export function deserializeSnapshot(raw: unknown): Snapshot | null {
  if (typeof raw !== "string") return null;
  try {
    const o = JSON.parse(raw) as { b: [string, never][]; f: [string, never][] };
    if (!Array.isArray(o?.b) || !Array.isArray(o?.f)) return null;
    return { bookmarks: new Map(o.b), folders: new Map(o.f) };
  } catch {
    return null;
  }
}

export interface BaselinePlan {
  baseline: Snapshot;
  persist: boolean; // 是否要把 baseline 写回存储
  catchUp: boolean; // 是否要立刻跑一轮回写（覆盖停机期间到达的变更）
}

// 基线决策（能力块 13 · ③, 纯函数: 让"SW 重启后必须先用持久化基线"这条规则可被单测锁住）
// 背景: MV3 的 SW 空闲 ~30s 就被回收, 而用户多在 WebUI 里操作（那时 SW 在休眠）。
// 若每次启动都无条件用"当前快照"覆盖基线, 停机期间到达的远端变更会被直接吸收 → 回写静默丢失。
export function baselinePlan(persisted: Snapshot | null, current: Snapshot): BaselinePlan {
  if (persisted) return { baseline: persisted, persist: false, catchUp: true };
  return { baseline: current, persist: true, catchUp: false };
}

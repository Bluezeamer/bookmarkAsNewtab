// SW 运行时状态（内存缓存 + chrome.storage 落盘）
// 存在理由: MV3 要求事件监听器在**顶层同步**注册, 但配置必须 await 才能读到 ——
// 于是把「配置 + chrome 节点映射」放进可懒加载的模块级状态, 监听器内 await ensureState() 取用
import { getSettings, saveNodeMap, saveLastBackfill } from "./settings.ts";
import { normalizeConfig } from "../lib/config.ts";

export interface SwState {
  token: string;
  serverUrl: string;
  // chrome 书签节点 id → CRDT 条目 id
  nodeMap: Record<string, string>;
  lastBackfill?: string;
}

let state: SwState | null = null;

// 未配置（无 token / serverUrl）返回 null; force=true 强制重读（配置变更后）
export async function ensureState(force = false): Promise<SwState | null> {
  if (state && !force) return state;
  const s = await getSettings();
  // 配置规范化（能力块 13 · ②）: 两个字段明显写反时自动交换并写回存储（自愈）;
  // 配置不可用（如把地址填进 token）→ 视为未配置（不再每 2 秒重连刷屏）。
  const cfg = normalizeConfig(s.serverUrl, s.token);
  if (cfg.error) {
    state = null;
    return null;
  }
  if (cfg.swapped) {
    console.warn("[bnt] 检测到服务器地址与 token 写反, 已自动交换");
    await chrome.storage.local.set({ serverUrl: cfg.serverUrl, token: cfg.token });
  }
  state = {
    token: cfg.token,
    serverUrl: cfg.serverUrl,
    nodeMap: s.nodeMap ?? {},
    lastBackfill: s.lastBackfill,
  };
  return state;
}

export function resetState(): void {
  state = null;
}

export async function rememberNode(chromeId: string, crdtId: string): Promise<void> {
  if (!state) return;
  state.nodeMap[chromeId] = crdtId;
  await saveNodeMap(state.nodeMap);
}

export async function forgetNode(chromeId: string): Promise<void> {
  if (!state) return;
  delete state.nodeMap[chromeId];
  await saveNodeMap(state.nodeMap);
}

export async function setLastBackfill(iso: string): Promise<void> {
  if (state) state.lastBackfill = iso;
  await saveLastBackfill(iso);
}

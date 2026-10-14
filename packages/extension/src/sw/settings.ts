// chrome.storage.local 封装: token / serverUrl / 节点映射 / 补漏时间戳
const KEYS: (keyof Settings)[] = ["token", "serverUrl", "nodeMap", "lastBackfill"];

export interface Settings {
  token?: string;
  serverUrl?: string;
  // chrome 书签节点 id → CRDT 条目 id
  nodeMap?: Record<string, string>;
  lastBackfill?: string; // ISO
}

export async function getSettings(): Promise<Settings> {
  return chrome.storage.local.get(KEYS) as Promise<Settings>;
}

export async function setToken(token: string, serverUrl?: string): Promise<void> {
  const obj: Record<string, string> = { token };
  if (serverUrl !== undefined) obj.serverUrl = serverUrl;
  await chrome.storage.local.set(obj);
}

export async function saveNodeMap(nodeMap: Record<string, string>): Promise<void> {
  await chrome.storage.local.set({ nodeMap });
}

export async function saveLastBackfill(iso: string): Promise<void> {
  await chrome.storage.local.set({ lastBackfill: iso });
}

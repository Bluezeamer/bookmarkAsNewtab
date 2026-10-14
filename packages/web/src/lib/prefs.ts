// 偏好（视图/主题/壁纸）: 读写 CRDT settings 区 → 多端一致（ADR-001）
// 注意: schema 由 server bootstrap, 未同步到时读默认值、写明确失败（不得静默丢弃）
import * as Y from "yjs";
import { doc } from "./crdt";
import { parsePrefs, type Prefs } from "./logic.ts";

function settingsMap(): Y.Map<unknown> | undefined {
  const s = doc.getMap("").get("settings");
  return s instanceof Y.Map ? s : undefined;
}

export function readPrefs(): Prefs {
  const s = settingsMap();
  if (!s) return parsePrefs(undefined);
  return parsePrefs({
    view: s.get("view"),

    sidebar: s.get("sidebar"),
    density: s.get("density"),
    searchEngine: s.get("searchEngine"),
    gapX: s.get("gapX"),
    gapY: s.get("gapY"),
    navRow: s.get("navRow"),
  });
}

// false = schema 未就绪（调用方回退本地状态, 不假装成功）
// 间距是数字（其他偏好是字符串）→ 保留原始类型写入, 读取时由 parseGap 归一
export function setPref(key: keyof Prefs, value: string | number): boolean {
  const s = settingsMap();
  if (!s) return false;
  s.set(key, value);
  return true;
}

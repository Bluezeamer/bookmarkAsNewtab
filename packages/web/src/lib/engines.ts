// 搜索引擎（能力块 9 · I2）: 名称 + 含 %s 的 URL 模板（行为对齐 xiaoshu 插件的做法）
// 纯函数集中在此, 便于单测; 完全本地, 不调用任何第三方 API
export interface SearchEngine {
  id: string;
  name: string;
  url: string; // 含 %s 占位符
}

export const ENGINES: SearchEngine[] = [
  { id: "google", name: "Google", url: "https://www.google.com/search?q=%s" },
  { id: "bing", name: "Bing", url: "https://www.bing.com/search?q=%s" },
  { id: "baidu", name: "百度", url: "https://www.baidu.com/s?wd=%s" },
  { id: "ddg", name: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s" },
  { id: "yandex", name: "Yandex", url: "https://yandex.com/search/?text=%s" },
];

export const DEFAULT_ENGINE_ID = "google";

// 非法/缺失一律回退默认（不信任远端写入）
export function parseEngine(id: unknown): string {
  return ENGINES.some((e) => e.id === id) ? (id as string) : DEFAULT_ENGINE_ID;
}

export function engineById(id: string): SearchEngine {
  return ENGINES.find((e) => e.id === parseEngine(id)) ?? ENGINES[0];
}

// 查询串按 %s 注入（必须编码: 否则 & # 会破坏 URL 结构）
export function engineSearchUrl(engine: SearchEngine, query: string): string {
  return engine.url.replace("%s", encodeURIComponent(query.trim()));
}

// 引擎按钮上的短标（窄屏/图标位）
export function engineShort(engine: SearchEngine): string {
  return { google: "G", bing: "B", baidu: "百", ddg: "D", yandex: "Я" }[engine.id] ?? engine.name.slice(0, 1);
}

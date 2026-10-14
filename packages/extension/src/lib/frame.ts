// iframe 地址构造（纯函数, 可单测）
// 一次性把 token 与「内核图标端点基址」传给 web 应用:
//   faviconBase = chrome.runtime.getURL("/_favicon/")
// 依据 ext-references/favicon-implementation-guide.md —— 桌面图标直接走内核端点, 零网络请求
export function buildFrameSrc(serverUrl: string, token: string, faviconBase: string | null): string {
  const base = serverUrl.replace(/\/+$/, "");
  const q = new URLSearchParams({ token });
  if (faviconBase) q.set("faviconBase", faviconBase);
  return `${base}/?${q.toString()}`;
}

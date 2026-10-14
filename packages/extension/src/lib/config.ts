// 配置规范化（能力块 13 · ②，第 8 轮）—— 纯函数, 便于单测
//
// 真实事故: 用户把**服务器地址填进了 token 框**（或早期状态残留）→
// WebSocket 连 `wss://host/ws?token=https%3A%2F%2Fhost%2F` → 鉴权失败 → schema 永远到不了 →
// `importTree` 反复失败 + 每 2 秒重连刷屏（用户实测日志）。
// 这里做三件事: ① 明显写反时自动交换（自愈）② 地址规范化（补 scheme/去尾斜杠）③ 给出可操作错误。

export interface NormalizedConfig {
  serverUrl: string;
  token: string;
  /** 两个字段明显写反 → 已自动交换（调用方应把修正后的值写回存储） */
  swapped: boolean;
  /** 非空 = 配置不可用（调用方应停止连接并把它显示给用户） */
  error?: string;
}

export const looksLikeUrl = (v: string): boolean =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(v) || /^[\w.-]+\.[a-z]{2,}(:\d+)?(\/|$)/i.test(v);

// token 形态: 不含 :// 与空白, 长度 ≥ 8（本项目的 SYNC_TOKEN 是 64 位十六进制, 但不写死形态）
export const looksLikeToken = (v: string): boolean =>
  v.length >= 8 && !/:\/\//.test(v) && !/\s/.test(v);

// 服务器地址规范化: 补 https:// / 去尾斜杠 / 只保留 origin+path
export function normalizeServerUrl(raw: string): { url?: string; error?: string } {
  const t = raw.trim().replace(/\/+$/, "");
  if (!t) return { error: "请填写服务器地址" };
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(withScheme);
    if (!u.hostname) return { error: "地址缺少主机名（示例：https://bnt.example.com）" };
    return { url: `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, "")}` };
  } catch {
    return { error: "地址格式不正确：请填写形如 https://bnt.example.com 的地址" };
  }
}

export function normalizeConfig(rawServerUrl: unknown, rawToken: unknown): NormalizedConfig {
  let serverUrl = typeof rawServerUrl === "string" ? rawServerUrl.trim() : "";
  let token = typeof rawToken === "string" ? rawToken.trim() : "";
  let swapped = false;

  // ① 明显写反 → 自动交换（自愈; 用户实测踩过这个坑）
  if (looksLikeUrl(token) && !looksLikeUrl(serverUrl)) {
    [serverUrl, token] = [token, serverUrl];
    swapped = true;
  }

  const norm = normalizeServerUrl(serverUrl);
  if (norm.error) return { serverUrl, token, swapped, error: norm.error };
  if (!token) return { serverUrl: norm.url!, token, swapped, error: "请填写访问 token" };
  if (!looksLikeToken(token)) {
    return {
      serverUrl: norm.url!,
      token,
      swapped,
      error: "访问 token 格式不正确：它应是一串密钥（不含 “://” 与空格）—— 请确认没有把服务器地址填进 token",
    };
  }
  return { serverUrl: norm.url!, token, swapped };
}

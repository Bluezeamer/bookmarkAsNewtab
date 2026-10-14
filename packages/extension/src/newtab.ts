// newtab 页: 薄壳 —— 门禁(storage.local) → 全屏 iframe 到 web 应用
// 能力块 13 · ②: 支持 `?edit=1` 从扩展面板进入"修改配置"（此前首次配置后再无入口）
const $ = (id: string) => document.getElementById(id)!;
const gate = $("gate");
const wrap = $("frame-wrap");
const frame = $("frame") as HTMLIFrameElement;
const serverInput = $("server") as HTMLInputElement;
const tokenInput = $("token") as HTMLInputElement;
const goBtn = $("go") as HTMLButtonElement;
const gateTitle = $("gate-title");
const err = $("err");
const hint = $("hint");

import { buildFrameSrc } from "./lib/frame.ts";
import { normalizeConfig } from "./lib/config.ts";

const wantsEdit = new URLSearchParams(location.search).get("edit") === "1";

function showIframe(serverUrl: string, token: string) {
  gate.classList.add("hidden");
  wrap.classList.remove("hidden");
  // 一次性引导: token 收进 web 自己的 localStorage; faviconBase = 内核图标端点（零网络取图标）
  frame.src = buildFrameSrc(serverUrl, token, chrome.runtime.getURL("/_favicon/"));
}

function showGate(serverUrl = "", token = "") {
  wrap.classList.add("hidden");
  gate.classList.remove("hidden");
  serverInput.value = serverUrl;
  tokenInput.value = token;
  if (wantsEdit) {
    gateTitle.textContent = "修改配置";
    hint.textContent = "保存后会立即按新配置重新同步。";
  }
  updateBtn();
}

function updateBtn() {
  goBtn.disabled = !(serverInput.value.trim() && tokenInput.value.trim());
}

serverInput.addEventListener("input", updateBtn);
tokenInput.addEventListener("input", updateBtn);

// 配置规范化: 与 SW 共用同一纯函数（自动补 https:// / 去尾斜杠 / 检测"地址与 token 写反"）
goBtn.addEventListener("click", async () => {
  const cfg = normalizeConfig(serverInput.value, tokenInput.value);
  if (cfg.error) {
    err.textContent = cfg.error;
    err.classList.remove("hidden");
    return;
  }
  err.classList.add("hidden");
  if (cfg.swapped) {
    // 明确提示: 用户实测踩过"把地址填进 token 框"的坑
    hint.textContent = "检测到服务器地址与 token 填反了，已自动交换。";
  }
  serverInput.value = cfg.serverUrl; // 回显规范化结果
  tokenInput.value = cfg.token;
  await chrome.storage.local.set({ serverUrl: cfg.serverUrl, token: cfg.token });
  showIframe(cfg.serverUrl, cfg.token);
});

// 启动: 带 ?edit=1 一律进门禁（改配置）; 否则有配置直接进 iframe
chrome.storage.local.get<{ serverUrl?: string; token?: string }>(["serverUrl", "token"], (s) => {
  if (wantsEdit) {
    showGate(s.serverUrl ?? "", s.token ?? "");
    return;
  }
  if (s.serverUrl && s.token) showIframe(s.serverUrl, s.token);
  else showGate();
});

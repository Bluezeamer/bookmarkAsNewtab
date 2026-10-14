// 扩展面板（能力块 13 · ②; 能力块 20 改为**三种显式同步**）
// 背景: 安装/启动/改配置都曾自动把浏览器书签注入后端 —— 用户要求"主动点击后再同步" ✗ 自动注入。
// 三种动作: ① 增量注入（只补不删）② 浏览器覆盖后端（完全覆盖）③ 后端覆盖浏览器（清空重建）
import { statusView, type StatusSnapshot } from "./lib/status.ts";

const $ = (id: string) => document.getElementById(id)!;
const dot = $("dot");
const state = $("state");
const meta = $("meta");
const msg = $("msg");

type Preview = {
  chromeBookmarks: number;
  crdtBookmarks: number;
  crdtFolders: number;
  ungrouped: number;
  willDelete: number;
};

async function send<T>(m: unknown): Promise<T | null> {
  try {
    return (await chrome.runtime.sendMessage(m)) as T;
  } catch {
    return null; // SW 未就绪
  }
}

async function render(): Promise<void> {
  const s = (await chrome.storage.local.get(["status", "serverUrl"])) as {
    status?: StatusSnapshot;
    serverUrl?: string;
  };
  const view = statusView(s.status);
  dot.classList.toggle("bad", !view.ok);
  state.textContent = view.ok ? "已连接" : "未连接";
  meta.textContent = [s.serverUrl ?? "未配置服务器", `上次同步：${view.lastSyncText}`, view.counts].join(" · ");
  msg.textContent = view.message;
  msg.classList.toggle("hidden", !view.message); // 成功时也显示（结果条数）; 无内容才隐藏
  msg.classList.toggle("ok", view.ok); // 成功态用中性色, 失败态用告警色
}

$("open").addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("newtab.html") });
  window.close();
});

$("edit").addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("newtab.html?edit=1") });
  window.close();
});

// 三种同步动作: 先取**真实数量**再确认（只读预览, 不动数据）
async function act(type: string, title: string, text: (p: Preview) => string, busy: string): Promise<void> {
  const p = (await send<Preview>({ type: "sync-preview" })) ?? {
    chromeBookmarks: 0,
    crdtBookmarks: 0,
    crdtFolders: 0,
    ungrouped: 0,
    willDelete: 0,
  };
  if (!confirm(`${title}\n\n${text(p)}`)) return;
  msg.classList.remove("hidden");
  msg.textContent = busy;
  await send({ type });
  await render();
}

$("inject").addEventListener("click", () =>
  void act(
    "inject-from-chrome",
    "增量注入：把浏览器书签补进当前状态？",
    (p) =>
      `· 只新增缺失项, **不删除任何内容**\n· 浏览器书签 ${p.chromeBookmarks} 条 → 当前状态 ${p.crdtBookmarks} 条书签 / ${p.crdtFolders} 个文件夹`,
    "增量注入中…"
  )
);

$("overwrite-from").addEventListener("click", () =>
  void act(
    "overwrite-from-chrome",
    "用浏览器书签完全覆盖当前状态？",
    (p) =>
      `· 层级 / 名称 / 标题会**对齐浏览器**\n· 删除当前状态里浏览器已不存在的 ${p.willDelete} 条书签\n· 删除没有归属（未分组）的 ${p.ungrouped} 条书签\n· 浏览器侧共 ${p.chromeBookmarks} 条书签`,
    "覆盖中…"
  )
);

$("overwrite-to").addEventListener("click", () =>
  void act(
    "overwrite-to-chrome",
    "用当前状态完全覆盖浏览器书签？",
    (p) =>
      `⚠️ 会**先删除浏览器里全部 ${p.chromeBookmarks} 条书签**（含 Chrome 原生书签, 不可撤销）,\n再按当前状态重建 ${p.crdtBookmarks} 条书签 / ${p.crdtFolders} 个文件夹。`,
    "重建浏览器书签中…"
  )
);

chrome.storage.onChanged.addListener(() => void render());
void render();

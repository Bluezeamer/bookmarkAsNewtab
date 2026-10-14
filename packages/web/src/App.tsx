import { useEffect, useMemo, useRef, useState } from "react";
import {
  SERVER_URL_KEY,
  apiUrl,
  connect,
  disconnect,
  onStatus,
  readBookmarks,
  readFolders,
  resolveServerUrl,
  doc,
  type ConnStatus,
} from "./lib/crdt";
import {
  buildGroups,
  filterBookmarks,
  DEFAULT_PREFS,
  type Bookmark,
  type Folder,
  type Prefs,
} from "./lib/logic";
import { resolveSidebar } from "./lib/layout";
import Background from "./components/Background";
import Greeting, { Clock } from "./components/Greeting";
import { readPrefs, setPref } from "./lib/prefs";
import { DEFAULT_FILTERS, type HistoryFilters } from "./lib/history";
import { setFaviconContext } from "./lib/favicon";
import TokenGate from "./components/TokenGate";
import StatusBanner from "./components/StatusBanner";
import UnifiedSearch from "./components/UnifiedSearch";
import BookmarkList from "./components/BookmarkList";
import ViewSwitch from "./components/ViewSwitch";
import HistoryView from "./components/HistoryView";
import Sidebar from "./components/Sidebar";
import SettingsDrawer from "./components/SettingsDrawer";
import EditDialog from "./components/EditDialog";
import FolderEditDialog, { type FolderDialogTarget } from "./components/FolderEditDialog";
import ExcludeEditor from "./components/ExcludeEditor";

const TOKEN_KEY = "bnt.token";


// 一次性引导: 扩展 newtab iframe 带 ?token=*** 与 ?faviconBase=***（内核图标端点基址）
// 两者都仅存内存: 扩展 ID/地址都可能变, 不落 localStorage（token 仍需存, 见 TokenGate 路径）
function bootstrapFromQuery(): void {
  const q = new URLSearchParams(location.search);
  const base = q.get("faviconBase");
  if (base) setFaviconContext({ base });
  if (localStorage.getItem(TOKEN_KEY)) return;
  const t = q.get("token");
  if (t) localStorage.setItem(TOKEN_KEY, t);
}
bootstrapFromQuery();

export default function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  // 设置抽屉「连接」区的受控输入（与其余设置项风格一致; 非受控 + querySelector 曾被 review 指出）
  const [connServer, setConnServer] = useState(() => localStorage.getItem(SERVER_URL_KEY) ?? "");
  const [connToken, setConnToken] = useState(() => localStorage.getItem(TOKEN_KEY) ?? "");
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<HistoryFilters>(DEFAULT_FILTERS);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [tab, setTab] = useState<"bookmarks" | "history">("bookmarks");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [ownerName, setOwnerName] = useState("");
  // 单一来源: 401 清 token / 门禁页改 token 后, 抽屉里的输入不能陈旧 → 每次打开抽屉时同步一次
  useEffect(() => {
    if (!settingsOpen) return;
    setConnToken(token ?? "");
    setConnServer(localStorage.getItem(SERVER_URL_KEY) ?? "");
  }, [settingsOpen, token]);

  const [editing, setEditing] = useState<Bookmark | null>(null);
  // 能力块 19: 文件夹弹窗（编辑已有夹 / 在某个夹下新建）
  const [folderDialog, setFolderDialog] = useState<FolderDialogTarget | null>(null);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  // 点击跳转的闩锁: 程序化跳转（含被文档底部截断的情况）期间高亮锁定为被点项,
  // 用户真的自己滚动/按键时才交还 scroll spy（否则"点 api 高亮成下一个"仍会复现）
  const spyLatchRef = useRef<string | null>(null);
  // 跳转: **瞬时 + 居中**（对齐 xiaoshu 的实现 —— 它用 scrollIntoView({block:"center"}) 且不带 smooth）。
  // 教训: 350ms 平滑滚动会被后续点击/滚轮/惯性滚动打断而不收敛（实测停在中间态 183px）,
  // 观感就是"点了没到位, 要再点一次"。瞬时跳转没有可被打断的中间态, 也天然规避文档末尾的钳制。
  const navScrollTo = (el: HTMLElement | null, groupId: string | null) => {
    if (!el) return;
    // 对齐**顶部**（能力块 12 · ④, 用户要求）: 顶层文件夹跳到最顶部更符合直觉。
    el.scrollIntoView({ block: "start" });
    // 自校正（CI 抓到）: 跳转后 favicon 等资源后加载会让内容**漂移**（实测 CI 里偏了 61px,
    // 落点从 56px 变成 -5px）→ 只要**闩锁仍有效**（用户没自己滚动）就再校 1~2 次。
    // 锚点常量与 index.css 的 [data-group] scroll-margin-top 一致。
    const ANCHOR = 56;
    const correct = (attempt: number) => {
      if (spyLatchRef.current !== groupId) return; // 用户已接管 → 不抢
      const de = document.scrollingElement;
      if (!de) return;
      const atMax = de.scrollTop + window.innerHeight >= de.scrollHeight - 2;
      if (atMax) return; // 被文档末尾钳制 → 无法再对齐, 交给高亮闩锁
      const top = el.getBoundingClientRect().top;
      if (Math.abs(top - ANCHOR) > 4 && attempt < 3) {
        el.scrollIntoView({ block: "start" });
        window.setTimeout(() => correct(attempt + 1), 200);
      }
    };
    window.setTimeout(() => correct(0), 250);
  };  const [overlayOpen, setOverlayOpen] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [actionMsg, setActionMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const settingsBtn = useRef<HTMLButtonElement | null>(null);

  // 连接生命周期: token → HTTP 预检（401 回门禁）→ WS
  useEffect(() => {
    if (!token) return;
    setFaviconContext({ token }); // 图标走服务端缓存时需 Bearer
    let alive = true;
    fetch(apiUrl("/api/history?limit=1"), { headers: { authorization: `Bearer ${token}` } })
      .then((r) => {
        if (!alive) return;
        if (r.status === 401) {
          localStorage.removeItem(TOKEN_KEY);
          disconnect();
          setToken(null);
          return;
        }
        connect(token);
      })
      .catch(() => {
        // 后端不可达: 也尝试连（WS 可能走通）, 横幅提示状态
        if (alive) connect(token);
      });
    return () => {
      alive = false;
      disconnect();
    };
  }, [token]);

  // doc 变更 → React state（observeDeep 覆盖 schema bootstrap 与所有嵌套变更）
  useEffect(() => {
    const root = doc.getMap("");
    const sync = () => {
      setBookmarks(readBookmarks(doc));
      setFolders(readFolders(doc));
      setPrefs(readPrefs()); // 偏好也在 settings 区, 多端一致
    };
    sync();
    root.observeDeep(sync);
    return () => root.unobserveDeep(sync);
  }, []);

  // 连接状态 → 横幅（订阅由 crdt.ts 负责, 跨 provider 重建依然有效）
  useEffect(() => onStatus(setStatus), []);

  // 部署方显示名（server 的 OWNER_NAME）: 仅用于页首问候, 缺失时退化为无名字问候
  useEffect(() => {
    fetch(apiUrl("/api/config"))
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => {
        if (c?.ownerName) setOwnerName(String(c.ownerName));
      })
      .catch(() => {});
  }, []);

  // 书签间距偏好 → CSS 变量（网格/仅图标网格统一消费; 能力块 10 · ③）
  useEffect(() => {
    document.documentElement.style.setProperty("--bnt-gap-x", `${prefs.gapX}px`);
    document.documentElement.style.setProperty("--bnt-gap-y", `${prefs.gapY}px`);
  }, [prefs.gapX, prefs.gapY]);

  // 导航行高（能力块 12 · ③）: 侧栏每行的**点击目标高度**, 默认比原先大, 用户可调
  useEffect(() => {
    document.documentElement.style.setProperty("--bnt-nav-row", `${prefs.navRow}px`);
  }, [prefs.navRow]);

  // 视口宽度 → 侧边栏形态（三档）
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 侧边栏条目（全量树, 与搜索无关）+ 当前区块联动
  const tree = useMemo(() => buildGroups(folders, bookmarks), [folders, bookmarks]);

  // 滚动联动（scroll spy）: 取「最后一条越过阅读线」的分组 —— 嵌套分组下也正确
  // 历史: 曾用"内容区顶部（顶栏之下）"作阅读线, 但顶栏非 sticky → 锚点随滚动漂移。现改为视口中心。
  //   短分组（如只有 1 条书签, 高 ~140px）在 25% 线下方时会被判成"下一个分组",
  //   用户点击 api 却高亮成 api 的下一个（实测: 跳转后 api 在 16..156, 而 25% 线 = 175 已落进下一组）。
  //   阅读线同时写入 --bnt-anchor, 供 CSS scroll-margin-top 使用 → 跳转落点与高亮一致。
  // 注: 不用 IntersectionObserver —— 它只上报状态变化的条目, 无法稳定得到"当前区块"
  useEffect(() => {
    if (tab !== "bookmarks") return;
    const compute = () => {
      const latched = spyLatchRef.current;
      if (latched !== null) {
        setActiveGroup(latched === "root" ? null : latched);
        return;
      }
      // 阅读线 = 常量 64px（与"顶部对齐跳转 + 顶部常驻 chrome"配套:
      // 跳转后目标标题顶部在 56px, 恰在阅读线之上; 用视口中心会让顶部对齐的跳转指向上一组）
      const line = 64;
      const groups = [...document.querySelectorAll<HTMLElement>("[data-group]")];
      // 底部钳制（能力块 12 · ①C）: 已到文档末尾时, 当前分组 = **最后一个分组**
      // 仅在**可滚动**时生效 —— 内容不足一屏时不存在"当前区块"语义, 保持无高亮（旧行为）
      const de = document.scrollingElement;
      const scrollable = de ? de.scrollHeight > de.clientHeight + 4 : false;
      if (scrollable && de && de.scrollTop + window.innerHeight >= de.scrollHeight - 2 && groups.length > 0) {
        const last = groups[groups.length - 1].getAttribute("data-group");
        setActiveGroup(last === "root" ? null : last);
        return;
      }
      let current: string | null = null;
      for (const s of groups) {
        if (s.getBoundingClientRect().top <= line) current = s.getAttribute("data-group");
      }
      setActiveGroup(current === "root" ? null : current);
    };
    // 用户自己滚动/按键 → 释放闩锁（程序化跳转不释放）。
    // 刻意**不含 mousedown**: 点侧栏时先释放会闪一下 spy 的猜测再切到目标（多余抖动）,
    // 而点击本身会立刻重设闩锁, 不需要先释放。
    const release = () => {
      if (spyLatchRef.current === null) return;
      spyLatchRef.current = null;
      compute();
    };
    // 仅**滚动类按键**释放闩锁; Tab/字母键刻意不释放（否则在搜索框里打字会解除点击后的锁定）
    const releaseKeys = /^(Arrow|Page|Home|End| )/;
    const onKey = (e: KeyboardEvent) => {
      if (releaseKeys.test(e.key)) release();
    };
    compute();
    window.addEventListener("scroll", compute, { passive: true });
    window.addEventListener("resize", compute, { passive: true });
    window.addEventListener("wheel", release, { passive: true });
    window.addEventListener("touchstart", release, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", compute);
      window.removeEventListener("resize", compute);
      window.removeEventListener("wheel", release);
      window.removeEventListener("touchstart", release);
      window.removeEventListener("keydown", onKey);
    };
    // 依赖里不含 filters: filters 只影响历史视图, 本 effect 在非书签视图直接 return
  }, [tab, bookmarks, folders, prefs.view]);

  function patchPrefs(patch: Partial<Prefs>) {
    setPrefs((p) => ({ ...p, ...patch })); // 乐观更新
    for (const [k, v] of Object.entries(patch)) setPref(k as keyof Prefs, v);
  }

  function jumpTo(groupId: string | null) {
    setOverlayOpen(false);
    if ((groupId as unknown as string) === "__top__") {
      spyLatchRef.current = null;
      setActiveGroup(null);
      window.scroll({ top: 0 }); // 瞬时（xiaoshu 同款: window.scroll({top:0})）
      return;
    }
    // 目标是**分组标题**（能力块 12 · ④）: [data-group] 是整段（含子分组）, 而
    // 根分组的 [data-group="root"] 包裹**整棵树** → 点"未分组"会跳到列表最顶（等于"全部"）。
    // 标题元素 [data-drop-group] 才是用户直觉上的"这一项的位置"（未分组标题 = 未归类书签区起点）。
    const id = CSS.escape(groupId ?? "root");
    const el =
      document.querySelector<HTMLElement>(`[data-drop-group="${id}"]`) ??
      document.querySelector<HTMLElement>(`[data-group="${id}"]`);
    if (!el) return;
    spyLatchRef.current = groupId === null ? "root" : groupId;
    setActiveGroup(groupId);
    navScrollTo(el, groupId);
  }

  async function runAction(kind: "classify" | "dedupe") {
    if (!token || busy) return;
    setBusy(true);
    setActionMsg("");
    try {
      const r = await fetch(apiUrl(`/api/${kind}`), { method: "POST", headers: { authorization: `Bearer ${token}` } });
      const j = (await r.json()) as Record<string, number | boolean>;
      if (kind === "classify") {
        setActionMsg(
          j.enabled === false
            ? "服务端未配置分类模型（CLASSIFIER_URL / CLASSIFIER_MODEL）"
            : `已分类 ${j.classified ?? 0} 条（跳过 ${j.skipped ?? 0}，失败 ${j.failed ?? 0}）`
        );
      } else {
        setActionMsg(`去重完成：移除 ${j.removed ?? 0} 条（${j.bookmarksBefore ?? 0} → ${j.bookmarksAfter ?? 0}）`);
      }
    } catch {
      setActionMsg("请求失败（后端可达性）");
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <TokenGate
        defaultServerUrl={localStorage.getItem(SERVER_URL_KEY) ?? ""}
        onSubmit={(t, serverUrl) => {
          localStorage.setItem(TOKEN_KEY, t);
          if (serverUrl) {
            const norm = /^https?:\/\//i.test(serverUrl) ? serverUrl : `https://${serverUrl}`;
            localStorage.setItem(SERVER_URL_KEY, norm.replace(/\/+$/, ""));
          } else {
            localStorage.removeItem(SERVER_URL_KEY);
          }
          location.reload(); // 连接层在模块初始化时建立 → 保存后重载最干净
        }}
      />
    );
  }

  const shape = resolveSidebar(prefs.sidebar, viewportWidth);
  const visible = filterBookmarks(bookmarks, query);

  return (
    <div className="relative min-h-screen text-ink">
      <Background />
      {/* 常驻 chrome（能力块 12 · ⑤）: 侧栏触发按钮与设置按钮**始终可见** ——
          否则滚到页面下方必须回到页首才能打开导航/设置（用户反馈）。
          用 fixed + 实底浮层（.popover）保证浮在内容之上; z-40 在 console(z-30) 之上、抽屉(z-50) 之下。 */}
      {shape === "overlay" && (
        <div className="fixed top-4 left-4 z-40 sm:top-5 sm:left-5">
          <button
            data-sidebar-toggle
            onClick={() => setOverlayOpen(true)}
            title="打开导览"
            aria-label="打开导览"
            className="popover grid h-10 w-10 place-items-center text-ink-2 transition-colors hover:text-ink"
          >
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
              <path d="M4 7h16M4 12h10M4 17h16" />
            </svg>
          </button>
        </div>
      )}
      <div className="fixed top-4 right-4 z-40 sm:top-5 sm:right-5">
        <button
          ref={settingsBtn}
          data-settings-open
          onClick={() => setSettingsOpen(true)}
          title="设置"
          className="popover flex h-10 items-center gap-1.5 px-3 text-[13.5px] font-medium text-ink-2 transition-colors hover:text-ink"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="3.2" />
            <path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" />
          </svg>
          设置
        </button>
      </div>
      {/* pt-5 必须与侧栏的 sticky top-5 一致: 否则未滚动时侧栏静态位置与粘住后的位置差 N px
          （实测差 4px 就会被 C1 抓到） */}
      {/* 满宽（能力块 11 · ①B）: 去掉 1160px 上限 —— 2316px 视口下原本左右各空 571px（实测 shell 1160） */}
      <div className="app-shell relative z-10 mx-auto pt-5">
        <div className="flex items-start gap-4">
          {shape !== "overlay" && (
            <Sidebar
              tree={tree}
              folders={folders}
              tab={tab}
              onTabChange={setTab}
              shape={shape}
              mode={prefs.sidebar}
              activeGroupId={activeGroup}
              bookmarks={bookmarks}
              onEditFolder={(f) => setFolderDialog({ kind: "edit", folder: f })}
              onNewFolder={(parent) => setFolderDialog({ kind: "create", parent })}
              onJump={jumpTo}
              onCycleMode={() =>
                patchPrefs({
                  sidebar: prefs.sidebar === "auto" ? "pinned" : prefs.sidebar === "pinned" ? "hidden" : "auto",
                })
              }
            />
          )}

          {/* 底部留白放进 main: 若留在 .app-shell（flex 行之外）侧栏 sticky 会被"推走"（实测页底 sideTop -56） */}
          <main className="min-w-0 flex-1 pb-24">
            <header data-bnt-header className="mb-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-serif text-[19px] font-semibold tracking-[-0.01em] text-ink">
                  bookmarkAsNewtab
                  <span aria-hidden className="ml-1 inline-block h-[5px] w-[5px] -translate-y-1.5 rounded-full bg-accent" />
                </h1>
                <Clock />
              </div>

              {/* Dawn console: 问候 + 搜索在**同一块玻璃**里 —— 这是本设计的签名元素 */}
              {/* 层级显式化（能力块 11 · ①C）: .glass 的 backdrop-filter 会形成层叠上下文,
                  不给 z-index 时其内部弹层（z-40）会被 DOM 顺序更晚的列表压住 */}
              <section data-console className="glass relative z-30 mb-1 px-5 py-5 sm:px-7 sm:py-6">
                <div className="mb-4">
                  <Greeting ownerName={ownerName} />
                </div>
                <UnifiedSearch
                  token={token}
                  bookmarks={bookmarks}
                  folders={folders}
                  query={query}
                  onQueryChange={setQuery}
                  filters={filters}
                  onFiltersChange={setFilters}
                  onOpenExclude={() => setSettingsOpen(true)}
                  engineId={prefs.searchEngine}
                  onEngineChange={(id) => patchPrefs({ searchEngine: id })}
                />
              </section>

            </header>

            <StatusBanner status={status} />
            {tab === "bookmarks" ? (
              <>
                <BookmarkList
                  bookmarks={visible}
                  folders={folders}
                  query={query}
                  view={prefs.view}
                  density={prefs.density}
                  onEdit={setEditing}
                  onEditFolder={(f) => setFolderDialog({ kind: "edit", folder: f })}
              onNewFolder={(parent) => setFolderDialog({ kind: "create", parent })}
                />
              </>
            ) : (
              <HistoryView token={token} query={query} filters={filters} />
            )}

            {/* 页脚: 安静的边缘信息（顶栏与页脚是 column 边缘的 quiet chrome） */}
            <footer className="mt-10 flex flex-col gap-2 text-[12.5px] text-ink-3 sm:flex-row sm:items-center sm:justify-between">
              <span>
                自托管 · {bookmarks.length} 条书签 · {folders.length} 个文件夹
              </span>
              <span className="flex items-center gap-1.5">
                按 <kbd className="kbd">/</kbd> 搜索 · <kbd className="kbd">⌘K</kbd> 聚焦
              </span>
            </footer>
          </main>
        </div>
      </div>

      {/* 移动端: 侧边栏以浮层呈现（不占主页面空间） */}
      {shape === "overlay" && overlayOpen && (
        <div className="fixed inset-0 z-40 flex">
          <Sidebar
            tree={tree}
            folders={folders}
            tab={tab}
            onTabChange={setTab}
            shape="overlay"
            mode={prefs.sidebar}
            activeGroupId={activeGroup}
            bookmarks={bookmarks}
            onEditFolder={(f) => setFolderDialog({ kind: "edit", folder: f })}
              onNewFolder={(parent) => setFolderDialog({ kind: "create", parent })}
            onJump={jumpTo}
            onCycleMode={() =>
              patchPrefs({
                sidebar: prefs.sidebar === "auto" ? "pinned" : prefs.sidebar === "pinned" ? "hidden" : "auto",
              })
            }
            onClose={() => setOverlayOpen(false)}
          />
          <button
            aria-label="收起导览"
            onClick={() => setOverlayOpen(false)}
            className="flex-1 bg-ink/30"
            tabIndex={-1}
          />
        </div>
      )}

      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        returnFocusTo={settingsBtn.current}
      >
        <section className="mb-5">
          <h3 className="mb-2.5 text-[11.5px] font-medium text-ink-3">连接</h3>
          <label className="block text-[11.5px] font-medium text-ink-3">
            服务器地址
            <input
              data-server-input
              type="text"
              value={connServer}
              onChange={(e) => setConnServer(e.target.value)}
              placeholder={`留空 = 当前站点（${resolveServerUrl()}）`}
              className="field mt-1 w-full px-3 py-2 text-[13.5px] text-ink-2"
            />
          </label>
          <label className="mt-2 block text-[11.5px] font-medium text-ink-3">
            访问 token
            <input
              data-token-input
              type="password"
              value={connToken}
              onChange={(e) => setConnToken(e.target.value)}
              placeholder="SYNC_TOKEN"
              className="field mt-1 w-full px-3 py-2 text-[13.5px] text-ink-2"
            />
          </label>
          <button
            data-conn-save
            disabled={!connToken.trim()}
            onClick={() => {
              const srv = connServer.trim();
              if (srv) {
                const norm = /^https?:\/\//i.test(srv) ? srv : `https://${srv}`;
                localStorage.setItem(SERVER_URL_KEY, norm.replace(/\/+$/, ""));
              } else {
                localStorage.removeItem(SERVER_URL_KEY);
              }
              localStorage.setItem(TOKEN_KEY, connToken.trim());
              location.reload();
            }}
            className="btn-quiet mt-3 w-full justify-center disabled:opacity-40"
          >
            保存并重新连接
          </button>
          {!connToken.trim() && (
            <p className="mt-2 text-[11.5px] text-ink-3">token 不能为空（保存会重连到该后端）</p>
          )}
          <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">
            当前后端：<span className="font-mono">{resolveServerUrl()}</span>
          </p>
        </section>

        <section className="mb-5">
          <h3 className="mb-2.5 text-[11.5px] font-medium text-ink-3">外观</h3>
          <ViewSwitch prefs={prefs} onChange={patchPrefs} />
          <label className="mt-3 block text-xs font-bold text-ink/70">
            侧边栏
            <select
              data-sidebar-select
              value={prefs.sidebar}
              onChange={(e) => patchPrefs({ sidebar: e.target.value as Prefs["sidebar"] })}
              className="field mt-1 w-full px-3 py-2 text-[13.5px] text-ink-2"
            >
              <option value="auto">自动（按屏幕宽度）</option>
              <option value="pinned">固定展开</option>
              <option value="hidden">隐藏（按钮唤出）</option>
            </select>
          </label>
        </section>

        <section className="mb-5">
          <h3 className="mb-2.5 text-[11.5px] font-medium text-ink-3">历史</h3>
          <ExcludeEditor />
        </section>

        <section className="mb-5">
          <h3 className="mb-2.5 text-[11.5px] font-medium text-ink-3">动作</h3>
          <div className="flex flex-wrap gap-2">
            <button
              data-action-classify
              onClick={() => runAction("classify")}
              disabled={busy}
              className="btn-quiet disabled:opacity-50"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 3.5 13.6 9l5.4 1.6-5.4 1.6L12 17.5 10.4 12.2 5 10.6 10.4 9 12 3.5Z" />
              </svg>
              自动分类
            </button>
            <button
              data-action-dedupe
              onClick={() => runAction("dedupe")}
              disabled={busy}
              className="btn-quiet disabled:opacity-50"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M4 7h11M4 12h11M4 17h7" />
                <path d="M17.5 14.5 20 17l-3 3" />
              </svg>
              书签去重
            </button>
          </div>
          {actionMsg && <p className="mt-2 text-[12.5px] text-ink-2">{actionMsg}</p>}
        </section>

        <section>
          <h3 className="mb-2.5 text-[11.5px] font-medium text-ink-3">关于</h3>
          <a
            href="/extension.zip"
            download
            className="btn-accent !text-[13px]"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 4v10M7.5 10.5 12 15l4.5-4.5M5 19h14" />
            </svg>
            下载浏览器扩展
          </a>
        </section>
      </SettingsDrawer>

      <EditDialog bookmark={editing} folders={folders} onClose={() => setEditing(null)} />
      <FolderEditDialog target={folderDialog} folders={folders} onClose={() => setFolderDialog(null)} />
    </div>
  );
}

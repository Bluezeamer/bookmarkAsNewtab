// 剪枝规划（能力块 14 · ②）—— 纯函数, 便于单测
//
// 用途: 「用浏览器书签覆盖当前状态」时, 把 CRDT 里**浏览器已不存在**的文件夹也清掉。
// 背景（用户实测 bug）: 原先只剪书签、文件夹那段是死代码
//   （`const chromeId = s.nodeMap[k]` 里 k 是 CRDT id, 而 nodeMap 的键是 Chrome id → 恒 undefined;
//    且 liveFolderIds 由同一个 fm 构建 → has(k) 恒真）→ 结果"覆盖"后留下一堆空文件夹 ✗

// 文件夹身份键: `${父ChromeId|"root"}|${名称}`。
// 归一规则（review 重要项）: Chrome 顶层容器（书签栏/其他/移动设备）的 parentId 是 "0",
// 而 CRDT 顶层夹的 parent 是 null → 统一记作 "root"; 不归一会让 "0|名称" 永远匹配不上 "root|名称"
// → **未映射的顶层夹被误剪**。
export function chromeFolderKey(parentId: string | null | undefined, title: string): string {
  return `${!parentId || parentId === "0" ? "root" : parentId}|${title}`;
}

export interface FolderNode {
  parent: string | null;
  name?: string; // 未映射夹按"父级+名称"判定时需要
}

// 某个文件夹及其全部子孙（用于整棵子树删除; 防环）
export function folderSubtree(folders: Map<string, FolderNode>, rootId: string): string[] {
  const childrenOf = new Map<string | null, string[]>();
  for (const [id, f] of folders) {
    const list = childrenOf.get(f.parent) ?? [];
    list.push(id);
    childrenOf.set(f.parent, list);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
    for (const c of childrenOf.get(id) ?? []) walk(c);
  };
  walk(rootId);
  return out;
}

/**
 * 要剪掉的 CRDT 文件夹 id（含其子孙）。判据 = **浏览器里不存在对应夹**:
 *   ① 映射过（nodeMap 里有它的 Chrome id）但该 Chrome 节点已消失 → 剪;
 *   ② 未映射（如首次导入时未记录映射的历史数据）→ 用 **父级+名称** 在浏览器里找; 找不到 → 剪。
 * 两者与书签的"按 URL 判定"口径一致（都回答"浏览器里还有没有这一项"）。
 * `chromeFolderKeys` = `${父ChromeId|"root"}|${名称}` 集合; 省略时退化为只按映射判定（保守）。
 */
export function planFolderPrune(
  crdtFolders: Map<string, FolderNode>,
  nodeMap: Record<string, string>,
  chromeFolderIds: Set<string>,
  chromeFolderKeys?: Set<string>
): string[] {
  const crdtToChrome = new Map<string, string>();
  for (const [chromeId, crdtId] of Object.entries(nodeMap)) crdtToChrome.set(crdtId, chromeId);
  const gone: string[] = [];
  for (const [crdtId, f] of crdtFolders) {
    const chromeId = crdtToChrome.get(crdtId);
    if (chromeId) {
      if (!chromeFolderIds.has(chromeId)) gone.push(crdtId); // ① 映射过但已消失
      continue;
    }
    if (!chromeFolderKeys) continue; // 未提供名称集 → 保守不剪
    // ② 未映射 → 按 (父ChromeId|名称) 找; 父级未映射时无法定位 → 保守保留
    const parentChrome = f.parent ? crdtToChrome.get(f.parent) : "root";
    if (!parentChrome) continue;
    const name = f.name ?? "";
    // 与镜像侧共用同一键构造（review 第 6 轮建议: 别各自裸拼, 防未来分叉）
    if (!chromeFolderKeys.has(chromeFolderKey(parentChrome, name))) gone.push(crdtId);
  }
  // 展开为子树并去重（父夹已删时子孙也要删）
  const out = new Set<string>();
  for (const id of gone) for (const sub of folderSubtree(crdtFolders, id)) out.add(sub);
  return [...out];
}

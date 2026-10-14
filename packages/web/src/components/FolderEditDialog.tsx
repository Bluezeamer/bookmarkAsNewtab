import { useEffect, useRef, useState } from "react";
import type { Folder } from "../lib/logic";
import { folderParentOptions } from "../lib/logic";
import { addFolder, renameFolder, setFolderParent } from "../lib/crdt";

// 弹窗目标（能力块 19 增补）: 编辑已有夹 / 在某个夹下新建（parent=null 表示顶层）
export type FolderDialogTarget =
  | { kind: "edit"; folder: Folder }
  | { kind: "create"; parent: string | null };

// 文件夹弹窗: 名称 + 归属。
//   · 编辑: 归属下拉排除**自身与子孙**（否则成环）
//   · 新建: 归属下拉 = 全部文件夹（新建不会成环）, 默认预选右键的那个夹
// 外壳与交互对齐 EditDialog（Esc 取消 / Enter 保存 / 玻璃弹窗 + .field）
export default function FolderEditDialog({
  target,
  folders,
  onClose,
}: {
  target: FolderDialogTarget | null;
  folders: Folder[];
  onClose: () => void;
}) {
  const editing = target?.kind === "edit" ? target.folder : null;
  const [name, setName] = useState("");
  const [parent, setParent] = useState<string | null>(null);
  const first = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setName(editing?.name ?? "");
    setParent(target?.kind === "create" ? target.parent : (editing?.parent ?? null));
    if (target) first.current?.focus();
  }, [target, editing]);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [target, onClose]);

  if (!target) return null;
  const creating = target.kind === "create";

  function save() {
    if (!target) return;
    const next = name.trim();
    if (!next) return;
    if (target.kind === "create") addFolder(next, parent);
    else {
      if (next !== target.folder.name) renameFolder(target.folder.id, next);
      if (parent !== target.folder.parent) setFolderParent(target.folder.id, parent);
    }
    onClose();
  }

  const options = creating ? folders : folderParentOptions(folders, editing!.id);
  const label = "mb-2.5 block text-[11.5px] font-medium text-ink-2";
  const input = "field mt-1 h-11 w-full px-3.5 text-[13.5px] text-ink";

  return (
    <div data-folder-dialog data-folder-dialog-mode={target.kind} className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        aria-label={creating ? "取消新建文件夹" : "取消编辑文件夹"}
        onClick={onClose}
        className="absolute inset-0 bg-ink/25 backdrop-blur-[1px]"
        tabIndex={-1}
      />
      <form
        role="dialog"
        aria-modal="true"
        aria-label={creating ? "新建文件夹" : "编辑文件夹"}
        className="drawer-in glass relative z-10 w-full max-w-md p-5"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <h2 className="mb-4 text-[15px] font-semibold text-ink">{creating ? "新建文件夹" : "编辑文件夹"}</h2>
        <label className={label}>
          名称
          <input
            ref={first}
            data-folder-name
            value={name}
            placeholder={creating ? "新文件夹名称" : undefined}
            onChange={(e) => setName(e.target.value)}
            className={input}
          />
        </label>
        <label className="mb-4 block text-[11.5px] font-medium text-ink-2">
          归属
          <select
            data-folder-parent
            value={parent ?? ""}
            onChange={(e) => setParent(e.target.value === "" ? null : e.target.value)}
            className="field mt-1 h-11 w-full px-2.5 text-[13.5px] text-ink"
          >
            <option value="">顶层</option>
            {options.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button data-folder-save type="submit" className="btn-accent">
            {creating ? "新建" : "保存"}
          </button>
          <button type="button" onClick={onClose} className="btn-quiet">
            取消
          </button>
        </div>
      </form>
    </div>
  );
}

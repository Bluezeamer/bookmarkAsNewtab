import { useEffect, useRef, useState } from "react";
import type { Bookmark, Folder } from "../lib/logic";
import { normalizeUrl } from "../lib/logic";
import { deleteBookmark, updateBookmark } from "../lib/crdt";

// 编辑弹窗（替换行内编辑: 不撑开卡片、不挤压邻位）; Esc 取消 / Enter 保存 / 可删除
// Dawn 重绘: 玻璃弹窗 + .field 输入 + pill 按钮; data-edit-* 锚点与焦点/键盘行为不变
export default function EditDialog({
  bookmark,
  folders,
  onClose,
}: {
  bookmark: Bookmark | null;
  folders: Folder[];
  onClose: () => void;
}) {
  const [title, setTitle] = useState(bookmark?.title ?? "");
  const [url, setUrl] = useState(bookmark?.url ?? "");
  const [folder, setFolder] = useState<string | null>(bookmark?.folder ?? null);
  const first = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setTitle(bookmark?.title ?? "");
    setUrl(bookmark?.url ?? "");
    setFolder(bookmark?.folder ?? null);
    if (bookmark) first.current?.focus();
  }, [bookmark]);

  useEffect(() => {
    if (!bookmark) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [bookmark, onClose]);

  if (!bookmark) return null;

  function save() {
    if (!bookmark) return;
    if (title.trim()) {
      updateBookmark(bookmark.id, {
        title: title.trim(),
        url: normalizeUrl(url),
        folder,
      });
    }
    onClose();
  }

  const label = "mb-2.5 block text-[11.5px] font-medium text-ink-2";
  const input = "field mt-1 h-11 w-full px-3.5 text-[13.5px] text-ink";

  return (
    <div data-edit-dialog className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        aria-label="取消编辑"
        onClick={onClose}
        className="absolute inset-0 bg-ink/25 backdrop-blur-[1px]"
        tabIndex={-1}
      />
      <form
        role="dialog"
        aria-modal="true"
        aria-label="编辑书签"
        className="drawer-in glass relative z-10 w-full max-w-lg p-5"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <h2 className="mb-4 text-[15px] font-semibold text-ink">编辑书签</h2>
        <label className={label}>
          标题
          <input
            ref={first}
            data-edit-title
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={input}
          />
        </label>
        <label className={label}>
          URL
          <input
            data-edit-url
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className={`${input} font-mono text-[13px]`}
          />
        </label>
        <label className="mb-4 block text-[11.5px] font-medium text-ink-2">
          文件夹
          <select
            data-edit-folder
            value={folder ?? ""}
            onChange={(e) => setFolder(e.target.value === "" ? null : e.target.value)}
            className="field mt-1 h-11 w-full px-2.5 text-[13.5px] text-ink"
          >
            <option value="">未分组</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button data-edit-save type="submit" className="btn-accent">
            保存
          </button>
          <button type="button" onClick={onClose} className="btn-quiet">
            取消
          </button>
          <button
            type="button"
            data-edit-delete
            onClick={() => {
              deleteBookmark(bookmark.id);
              onClose();
            }}
            className="ml-auto rounded-full px-3.5 py-2 text-[13px] font-medium text-ink-2 transition-colors hover:bg-[rgba(251,191,163,0.35)] hover:text-ink"
          >
            删除
          </button>
        </div>
      </form>
    </div>
  );
}

// FLIP 动画助手（能力块 7 · I3）: 让"重排让位"看起来自然
// 用法: before = captureRects(root) → 触发重排 → useLayoutEffect 里 playFlip(root, before)
const reduceMotion = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// 记录容器内所有卡片（[data-bk]）的矩形
// 注意: **跳过隐藏/零尺寸元素** —— 拖动中被拖卡片是 display:none, getBoundingClientRect 返回 (0,0),
// 若照记就会让落定动画以左上角为起点（能力块 11 · ① 实测的"从最左上角飘过去"）
export function captureRects(root: HTMLElement | null): Map<string, DOMRect> {
  const out = new Map<string, DOMRect>();
  if (!root) return out;
  for (const el of root.querySelectorAll<HTMLElement>("[data-bk]")) {
    const id = el.getAttribute("data-bk");
    if (!id) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue; // 隐藏（display:none）→ 不参与 FLIP
    out.set(id, r);
  }
  return out;
}

// 单元素 FLIP: 从指定矩形动画到其当前位置（落定动画用"幽灵释放矩形"作起点）
export function flipFrom(el: HTMLElement | null, from: DOMRect, duration = 180): void {
  if (!el || reduceMotion()) return;
  const now = el.getBoundingClientRect();
  const dx = from.left - now.left;
  const dy = from.top - now.top;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
  el.animate(
    [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0px, 0px)" }],
    { duration, easing: "ease-out" }
  );
}

// 把"位置变化"用反向位移 → 归零的过渡表现出来（Web Animations API, 无 CSS 依赖）
export function playFlip(root: HTMLElement | null, before: Map<string, DOMRect>, duration = 160): void {
  if (!root || before.size === 0) return;
  if (reduceMotion()) return; // 尊重系统"减少动态效果"
  for (const el of root.querySelectorAll<HTMLElement>("[data-bk]")) {
    const id = el.getAttribute("data-bk");
    if (!id) continue;
    const prev = before.get(id);
    if (!prev) continue;
    const now = el.getBoundingClientRect();
    const dx = prev.left - now.left;
    const dy = prev.top - now.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    el.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0px, 0px)" }],
      { duration, easing: "ease-out" }
    );
  }
}

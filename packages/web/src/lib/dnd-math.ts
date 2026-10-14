// 智能拖拽落点计算（能力块 7 · I3）: 纯函数, 便于单测
// 目标: 以指针**两轴**坐标判定插入位, 网格多列下也符合直觉
// 位移超过该像素才进入拖拽（否则算点击）。8px 是 click/drag 区分的常用阈值:
// 5px 太敏感 —— 手抖 5~8px 会被判成拖拽, 随后的 click 被抑制 → 用户感觉"要点两次"
export const DRAG_THRESHOLD = 8;

export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

// 插入前后判定（布局感知）:
//   同一排有多张卡（网格）→ 比左右; 单列（列表）→ 比上下
// 不能用「指针是否在盒内」判断同排 —— 对盒内任意点 |dy| ≤ h/2 恒成立, 会把单列也误判为多列
function beforeAt(boxes: Box[], i: number, px: number, py: number): boolean {
  const b = boxes[i];
  const cy = b.y + b.h / 2;
  const sameRowCount = boxes.filter((o) => Math.abs(o.y + o.h / 2 - cy) < b.h / 2).length;
  return sameRowCount > 1 ? px < b.x + b.w / 2 : py < cy;
}

// 返回当前序列中的插入位（0..boxes.length）
export function computeInsertIndex(boxes: Box[], px: number, py: number): number {
  if (boxes.length === 0) return 0;

  // 1) 指针落在某张卡内 → 用最靠后的命中项（重叠/嵌套时取最具体）
  let hit = -1;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) hit = i;
  }
  if (hit >= 0) return beforeAt(boxes, hit, px, py) ? hit : hit + 1;

  // 2) 未命中任何卡 → 取中心最近的卡, 按同一规则
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const d = Math.hypot(px - (b.x + b.w / 2), py - (b.y + b.h / 2));
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return beforeAt(boxes, best, px, py) ? best : best + 1;
}

// 把 fromIndex 处的元素移动到 insertIndex（插入语义, 基于"含被拖项"的当前序列）
// 返回新顺序; 非法输入原样返回; 结果与输入相同则返回同一数组引用（便于调用方跳过更新）
export function nextOrder(ids: string[], fromIndex: number, insertIndex: number): string[] {
  if (fromIndex < 0 || fromIndex >= ids.length) return ids;
  const moving = ids[fromIndex];
  const without = ids.filter((_, i) => i !== fromIndex);
  // 移除被拖项后, 原本"在它之后"的位置要左移一位
  const at = Math.max(0, Math.min(insertIndex > fromIndex ? insertIndex - 1 : insertIndex, without.length));
  const next = [...without.slice(0, at), moving, ...without.slice(at)];
  return next.every((id, i) => id === ids[i]) ? ids : next;
}

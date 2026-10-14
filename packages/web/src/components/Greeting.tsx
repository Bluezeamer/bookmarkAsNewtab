import { useEffect, useState } from "react";

// 页首两个"语气件"（能力块 10 · ①, 对齐 topbar 与 console）:
//   Clock   → 顶栏右端（与 wordmark 同排）
//   Greeting→ console 内的衬线问候
// 衬线使用纪律（The Serif Speaks Rule）: 只出现在问候、空态标题、图标首字母
function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function Clock() {
  const now = useNow();
  const date = now.toLocaleDateString(undefined, { month: "long", day: "numeric", weekday: "long" });
  const time = now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return (
    <span data-clock className="text-[13px] tabular-nums text-ink-3">
      {date} · {time}
    </span>
  );
}

export default function Greeting({ ownerName = "" }: { ownerName?: string }) {
  const h = useNow().getHours();
  const part = h < 12 ? "早上好" : h < 18 ? "下午好" : "晚上好";
  return (
    <h2
      data-greeting
      className="font-serif text-[26px] font-medium leading-tight tracking-[-0.015em] text-ink sm:text-[31px]"
    >
      {ownerName ? `${part}，${ownerName}。` : `${part}。`}
    </h2>
  );
}

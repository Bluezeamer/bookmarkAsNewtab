import { useEffect, useRef, useState } from "react";
import { domainOf, hueForDomain } from "../lib/logic";
import { fetchServerIcon, getFaviconBase, kernelIconMissing, planIcon } from "../lib/favicon";

type Phase = "kernel" | "server" | "letter";

// 书签图标: 内核（零网络）→ 服务端缓存（Bearer 取字节）→ 首字母色块
// 能力块 10 · ③: 真实图标**不加外框/底色容器**（原来的 border-2 border-ink bg-paper 已移除）;
// 回退态才用 .icon-tile（柔和同色底 + 衬线首字母, 12px 圆角 + 白内描边）
export default function BookmarkIcon({
  url,
  title,
  size = 32,
}: {
  url: string;
  title: string;
  size?: number;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("kernel");
  const objectUrl = useRef<string | null>(null);
  const domain = domainOf(url);

  const letter = (
    <span
      aria-hidden
      style={{
        background: `hsl(${hueForDomain(domain)} 78% 78%)`,
        width: size,
        height: size,
        fontSize: Math.round(size * 0.44),
        lineHeight: 1,
      }}
      className="icon-tile shrink-0 text-ink"
    >
      {(title.trim() || domain || "?").charAt(0).toUpperCase()}
    </span>
  );

  // 起始: 有内核基址走内核, 否则直接进服务端阶段
  useEffect(() => {
    const plan = planIcon(url, getFaviconBase(), size);
    setPhase(plan.kernel ? "kernel" : "server");
    setSrc(plan.kernel);
    return () => {
      if (objectUrl.current) {
        URL.revokeObjectURL(objectUrl.current);
        objectUrl.current = null;
      }
    };
  }, [url, size]);

  // 内核阶段: <img> 已即时绘制（零网络）; 但内核可能返回的是**默认占位图** ✗
  // （HTTP 200, 不触发 onError）→ 异步校验, 命中占位图就换服务端（能力块 18 · ①）
  useEffect(() => {
    if (phase !== "kernel") return;
    const base = getFaviconBase();
    if (!base) return;
    let alive = true;
    void kernelIconMissing(base, url, size).then((missing) => {
      if (!alive || !missing) return;
      setSrc(null);
      setPhase("server");
    });
    return () => {
      alive = false;
    };
  }, [phase, url, size]);

  // 服务端阶段: 取字节 → object URL
  useEffect(() => {
    if (phase !== "server") return;
    let alive = true;
    void fetchServerIcon(url).then((objUrl) => {
      if (!alive) {
        if (objUrl) URL.revokeObjectURL(objUrl);
        return;
      }
      if (objUrl) {
        objectUrl.current = objUrl;
        setSrc(objUrl);
      } else {
        setPhase("letter");
      }
    });
    return () => {
      alive = false;
    };
  }, [phase, url]);

  if (!src) return letter; // 含 letter 阶段与"服务端取图中"的占位
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt=""
      loading="lazy"
      className="shrink-0 object-contain"
      onError={() => {
        if (phase === "kernel") {
          // 内核端点无图标（未访问过的站点）→ 退服务端
          setSrc(null);
          setPhase("server");
        } else {
          setPhase("letter");
        }
      }}
    />
  );
}

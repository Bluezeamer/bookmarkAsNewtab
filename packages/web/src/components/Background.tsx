// 晨光背景（能力块 10 · ①）: 三个大辉光缓慢漂移 + 淡天光渐变（渐变在 body 上）
// 玻璃面板靠它才有"磨砂"可看 —— 背景是场景，不是装饰（One Frost Rule）
export default function Background() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <div className="dawn-glow dawn-glow-peri" />
      <div className="dawn-glow dawn-glow-aqua" />
      <div className="dawn-glow dawn-glow-apricot" />
    </div>
  );
}

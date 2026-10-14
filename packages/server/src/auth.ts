// ADR-006: 单 Bearer token。WS query / HTTP Authorization 两种载体共用同一校验。
// 常量时间比较（单用户场景风险低, 但做对是零成本）
export function checkToken(expected: string, actual: string | undefined | null): boolean {
  if (!expected || !actual) return false; // 未配置 token = fail-closed（拒绝服务 /api 与 /ws）
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

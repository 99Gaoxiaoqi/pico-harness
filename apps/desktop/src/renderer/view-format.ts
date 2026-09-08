export function isTerminalRun(status: string): boolean {
  return ["cancelled", "failed", "succeeded", "completed"].includes(status);
}

export function formatCompact(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

export function formatRelative(value: number): string {
  const delta = Math.max(0, Date.now() - value);
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
}

export function formatElapsed(value: number): string {
  const minutes = Math.max(1, Math.floor((Date.now() - value) / 60_000));
  return `已运行 ${minutes} 分钟`;
}

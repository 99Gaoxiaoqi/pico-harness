/** Preserve the task scope when native navigation opens its review. */
export function scopedMenuHash(currentUrl: string, destination: string): string {
  if (destination !== "/review") return destination;
  const hash = new URL(currentUrl).hash.slice(1);
  const current = new URL(hash || "/", "https://pico.invalid");
  const workspace = current.searchParams.get("workspace");
  if (!workspace) return destination;
  const params = new URLSearchParams({ workspace });
  const match = /^\/session\/([^/]+)$/u.exec(current.pathname);
  const sessionId = match ? decodeURIComponent(match[1]!) : current.searchParams.get("sessionId");
  if (sessionId) params.set("sessionId", sessionId);
  return `${destination}?${params}`;
}

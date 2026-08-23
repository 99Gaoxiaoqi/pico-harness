import type { DesktopBrowserRect } from "../preload/contract.js";

export function normalizeBrowserAddress(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z\d+.-]*:/iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function normalizePersistedBrowserNavigation(
  input: string,
  isMainFrame: boolean,
): string | null {
  return isMainFrame ? normalizeBrowserAddress(input) : null;
}

export function normalizeViewport(rect: DesktopBrowserRect | null): DesktopBrowserRect | null {
  if (!rect) return null;
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null;
  const width = Math.max(0, Math.round(rect.width));
  const height = Math.max(0, Math.round(rect.height));
  if (width === 0 || height === 0) return null;
  return {
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    width,
    height,
  };
}

export function normalizeActiveBrowserViewport(
  rect: DesktopBrowserRect | null,
  active: boolean,
): DesktopBrowserRect | null {
  return active ? normalizeViewport(rect) : null;
}

export function guardBrowserNavigation(event: { preventDefault(): void }, url: string): boolean {
  if (normalizeBrowserAddress(url)) return true;
  event.preventDefault();
  return false;
}

export class BrowserViewportGenerationAuthority {
  readonly #generations = new Map<string, number>();

  acquire(sessionId: string): number {
    const current = this.current(sessionId);
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw new Error(`浏览器会话 ${sessionId} 的视口代际已经耗尽`);
    }
    const generation = current + 1;
    this.#generations.set(sessionId, generation);
    return generation;
  }

  current(sessionId: string): number {
    return this.#generations.get(sessionId) ?? 0;
  }

  accept(sessionId: string, generation: number): boolean {
    if (generation < this.current(sessionId)) return false;
    this.#generations.set(sessionId, generation);
    return true;
  }

  clear(): void {
    this.#generations.clear();
  }
}

export function replaceVisibleBrowserEntry<Entry, Bounds>(options: {
  readonly current: Entry;
  readonly generation: (entry: Entry) => number;
  readonly bounds: (entry: Entry) => Bounds;
  readonly destroy: (entry: Entry) => void;
  readonly create: () => Entry;
  readonly show: (entry: Entry, bounds: Bounds, generation: number) => void;
}): Entry {
  const generation = options.generation(options.current);
  const bounds = options.bounds(options.current);
  options.destroy(options.current);
  const replacement = options.create();
  options.show(replacement, bounds, generation);
  return replacement;
}

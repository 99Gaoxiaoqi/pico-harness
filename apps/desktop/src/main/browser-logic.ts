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
  readonly #generations = new Map<
    string,
    { readonly generation: number; readonly issued: boolean }
  >();

  acquire(sessionId: string): number {
    const current = this.current(sessionId);
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw new Error(`浏览器会话 ${sessionId} 的视口代际已经耗尽`);
    }
    const generation = current + 1;
    this.#generations.set(sessionId, { generation, issued: true });
    return generation;
  }

  current(sessionId: string): number {
    return this.#generations.get(sessionId)?.generation ?? 0;
  }

  seed(sessionId: string, generationFloor: number): void {
    const current = this.#generations.get(sessionId);
    if (current && current.generation >= generationFloor) return;
    this.#generations.set(sessionId, { generation: generationFloor, issued: false });
  }

  accept(sessionId: string, generation: number): boolean {
    const current = this.#generations.get(sessionId);
    return Boolean(current?.issued && current.generation === generation);
  }

  revoke(sessionId: string): number {
    const current = this.#generations.get(sessionId);
    if (current && !current.issued) return current.generation;
    const generation = Math.min((current?.generation ?? 0) + 1, Number.MAX_SAFE_INTEGER);
    this.#generations.set(sessionId, { generation, issued: false });
    return generation;
  }

  revokeAll(): readonly { readonly sessionId: string; readonly generation: number }[] {
    const revoked: { sessionId: string; generation: number }[] = [];
    for (const sessionId of this.#generations.keys()) {
      revoked.push({ sessionId, generation: this.revoke(sessionId) });
    }
    return revoked;
  }

  clear(): void {
    this.#generations.clear();
  }
}

export interface BrowserGenerationFloorStore {
  getGenerationFloor(sessionId: string): number;
  setGenerationFloor(sessionId: string, generationFloor: number): number | undefined;
  mutateSession(
    sessionId: string,
    mutation: { readonly generationFloor: number; readonly deleteUrl?: boolean },
  ): number;
  flush(): Promise<void>;
  flushThrough(revision: number): Promise<void>;
}

export class PersistentBrowserViewportGenerationAuthority {
  readonly #authority = new BrowserViewportGenerationAuthority();
  readonly #seeded = new Set<string>();

  constructor(private readonly store: BrowserGenerationFloorStore) {}

  async acquire(sessionId: string): Promise<number> {
    this.#seed(sessionId);
    const generation = this.#authority.acquire(sessionId);
    await this.#persist(sessionId, generation);
    return generation;
  }

  current(sessionId: string): number {
    this.#seed(sessionId);
    return this.#authority.current(sessionId);
  }

  accept(sessionId: string, generation: number): boolean {
    this.#seed(sessionId);
    return this.#authority.accept(sessionId, generation);
  }

  revoke(
    sessionId: string,
    options: { readonly deleteUrl?: boolean } = {},
  ): {
    readonly generation: number;
    readonly persistence: Promise<void>;
  } {
    this.#seed(sessionId);
    const generation = this.#authority.revoke(sessionId);
    if (options.deleteUrl) {
      const revision = this.store.mutateSession(sessionId, {
        generationFloor: generation,
        deleteUrl: true,
      });
      return { generation, persistence: this.store.flushThrough(revision) };
    }
    return { generation, persistence: this.#persist(sessionId, generation) };
  }

  revokeAll(): {
    readonly revocations: readonly { readonly sessionId: string; readonly generation: number }[];
    readonly persistence: Promise<void>;
  } {
    const revocations = this.#authority.revokeAll();
    let revision: number | undefined;
    for (const { sessionId, generation } of revocations) {
      revision = this.store.setGenerationFloor(sessionId, generation) ?? revision;
    }
    return {
      revocations,
      persistence: revision === undefined ? this.store.flush() : this.store.flushThrough(revision),
    };
  }

  clear(): void {
    this.#authority.clear();
    this.#seeded.clear();
  }

  #seed(sessionId: string): void {
    if (this.#seeded.has(sessionId)) return;
    this.#authority.seed(sessionId, this.store.getGenerationFloor(sessionId));
    this.#seeded.add(sessionId);
  }

  async #persist(sessionId: string, generation: number): Promise<void> {
    const revision = this.store.setGenerationFloor(sessionId, generation);
    if (revision === undefined) {
      await this.store.flush();
      return;
    }
    await this.store.flushThrough(revision);
  }
}

export async function commitBrowserRevocations(
  persistence: Promise<void>,
  revocations: readonly { readonly sessionId: string; readonly generation: number }[],
  notify: ((sessionId: string, generation: number) => Promise<void>) | undefined,
): Promise<void> {
  await persistence;
  if (notify) {
    await Promise.all(
      revocations.map(({ sessionId, generation }) => notify(sessionId, generation)),
    );
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

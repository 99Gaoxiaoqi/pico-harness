import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../../../../src/storage/atomic-json.js";
import { normalizeBrowserAddress } from "./browser-logic.js";

const BROWSER_URL_STATE_VERSION = 2;
const BROWSER_URL_STATE_FILE = "browser-urls.json";
const DEFAULT_WRITE_DEBOUNCE_MS = 250;
const DEFAULT_RETRY_DELAY_MS = 1_000;

interface StoredBrowserUrlStateV1 {
  readonly version: 1;
  readonly sessions: readonly {
    readonly sessionId: string;
    readonly url: string;
  }[];
}

interface StoredBrowserUrlState {
  readonly version: typeof BROWSER_URL_STATE_VERSION;
  readonly sessions: readonly {
    readonly sessionId: string;
    readonly url?: string;
    readonly generationFloor: number;
  }[];
}

type BrowserUrlWriter = (path: string, state: StoredBrowserUrlState) => Promise<void>;

export class BrowserUrlStore {
  readonly filePath: string;
  readonly #urls: Map<string, string>;
  readonly #generationFloors: Map<string, number>;
  readonly #generationStateSafe: boolean;
  readonly #writeDebounceMs: number;
  readonly #retryDelayMs: number;
  readonly #onError: (error: unknown) => void;
  readonly #writeState: BrowserUrlWriter;
  #revision = 0;
  #persistedRevision = 0;
  #writeTimer: ReturnType<typeof setTimeout> | undefined;
  #writeFlight: Promise<void> | undefined;

  constructor(
    userDataPath: string,
    options: {
      readonly writeDebounceMs?: number;
      readonly retryDelayMs?: number;
      readonly onError?: (error: unknown) => void;
      readonly write?: BrowserUrlWriter;
    } = {},
  ) {
    this.filePath = join(userDataPath, BROWSER_URL_STATE_FILE);
    this.#writeDebounceMs = options.writeDebounceMs ?? DEFAULT_WRITE_DEBOUNCE_MS;
    this.#retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.#onError = options.onError ?? (() => undefined);
    this.#writeState =
      options.write ??
      ((path, state) => writeJsonAtomic(path, state, { fileMode: 0o600, directoryMode: 0o700 }));
    const loaded = readState(this.filePath);
    this.#urls = loaded.urls;
    this.#generationFloors = loaded.generationFloors;
    this.#generationStateSafe = loaded.safe;
    if (!loaded.safe) {
      this.#onError(new Error(`浏览器状态损坏，已拒绝签发新的视口代际: ${this.filePath}`));
    } else if (loaded.needsMigration) {
      this.#revision = 1;
      this.#schedule(this.#writeDebounceMs);
    }
  }

  get(sessionId: string): string | undefined {
    return this.#urls.get(sessionId);
  }

  set(sessionId: string, url: string): void {
    if (!this.#generationStateSafe) return;
    const normalized = normalizeBrowserAddress(url);
    if (!normalized || this.#urls.get(sessionId) === normalized) return;
    this.#urls.set(sessionId, normalized);
    this.#revision++;
    this.#schedule(this.#writeDebounceMs);
  }

  delete(sessionId: string): number | undefined {
    if (!this.#generationStateSafe) return undefined;
    if (!this.#urls.delete(sessionId)) return undefined;
    this.#revision++;
    this.#schedule(this.#writeDebounceMs);
    return this.#revision;
  }

  getGenerationFloor(sessionId: string): number {
    this.#requireSafeGenerationState();
    return this.#generationFloors.get(sessionId) ?? 0;
  }

  setGenerationFloor(sessionId: string, generationFloor: number): number | undefined {
    this.#requireSafeGenerationState();
    if (!Number.isSafeInteger(generationFloor) || generationFloor < 0) {
      throw new RangeError("浏览器视口代际必须是非负安全整数");
    }
    if (generationFloor <= (this.#generationFloors.get(sessionId) ?? 0)) return undefined;
    this.#generationFloors.set(sessionId, generationFloor);
    this.#revision++;
    this.#schedule(this.#writeDebounceMs);
    return this.#revision;
  }

  async flush(): Promise<void> {
    await this.flushThrough(this.#revision);
  }

  async flushThrough(revision: number): Promise<void> {
    this.#cancelScheduledWrite();
    try {
      while (this.#persistedRevision < revision) await this.#persistOnce();
    } catch (error) {
      this.#schedule(this.#retryDelayMs);
      throw error;
    }
  }

  async #persistOnce(): Promise<void> {
    if (this.#persistedRevision === this.#revision) return;
    if (!this.#writeFlight) {
      const revision = this.#revision;
      const state = {
        version: BROWSER_URL_STATE_VERSION,
        sessions: [...new Set([...this.#urls.keys(), ...this.#generationFloors.keys()])]
          .sort((left, right) => left.localeCompare(right))
          .map((sessionId) => ({
            sessionId,
            generationFloor: this.#generationFloors.get(sessionId) ?? 0,
            ...(this.#urls.get(sessionId) ? { url: this.#urls.get(sessionId) } : {}),
          })),
      } satisfies StoredBrowserUrlState;
      this.#writeFlight = this.#writeState(this.filePath, state)
        .then(() => {
          this.#persistedRevision = revision;
        })
        .finally(() => {
          this.#writeFlight = undefined;
        });
    }
    await this.#writeFlight;
  }

  #schedule(delayMs: number): void {
    if (this.#writeTimer) return;
    this.#writeTimer = setTimeout(() => {
      this.#writeTimer = undefined;
      void this.#persistOnce().then(
        () => {
          if (this.#persistedRevision !== this.#revision) this.#schedule(this.#writeDebounceMs);
        },
        (error: unknown) => {
          this.#onError(error);
          this.#schedule(this.#retryDelayMs);
        },
      );
    }, delayMs);
    this.#writeTimer.unref?.();
  }

  #cancelScheduledWrite(): void {
    if (!this.#writeTimer) return;
    clearTimeout(this.#writeTimer);
    this.#writeTimer = undefined;
  }

  #requireSafeGenerationState(): void {
    if (!this.#generationStateSafe) {
      throw new Error("浏览器持久状态损坏；为避免代际回退，已拒绝当前操作");
    }
  }
}

function readState(path: string): {
  readonly urls: Map<string, string>;
  readonly generationFloors: Map<string, number>;
  readonly safe: boolean;
  readonly needsMigration: boolean;
} {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isStoredBrowserUrlState(parsed)) {
      const urls = new Map<string, string>();
      const generationFloors = new Map<string, number>();
      for (const { sessionId, url, generationFloor } of parsed.sessions) {
        if (url) urls.set(sessionId, url);
        generationFloors.set(
          sessionId,
          Math.max(generationFloor, generationFloors.get(sessionId) ?? 0),
        );
      }
      return { urls, generationFloors, safe: true, needsMigration: false };
    }
    if (isStoredBrowserUrlStateV1(parsed)) {
      return {
        urls: new Map(parsed.sessions.map(({ sessionId, url }) => [sessionId, url])),
        generationFloors: new Map(),
        safe: true,
        needsMigration: true,
      };
    }
    return { urls: new Map(), generationFloors: new Map(), safe: false, needsMigration: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { urls: new Map(), generationFloors: new Map(), safe: true, needsMigration: false };
    }
    return { urls: new Map(), generationFloors: new Map(), safe: false, needsMigration: false };
  }
}

function isStoredBrowserUrlState(value: unknown): value is StoredBrowserUrlState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<StoredBrowserUrlState>;
  return (
    state.version === BROWSER_URL_STATE_VERSION &&
    Array.isArray(state.sessions) &&
    state.sessions.every((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const candidate = entry as { readonly sessionId?: unknown; readonly url?: unknown };
      return (
        typeof candidate.sessionId === "string" &&
        candidate.sessionId.length > 0 &&
        (candidate.url === undefined ||
          (typeof candidate.url === "string" &&
            normalizeBrowserAddress(candidate.url) === candidate.url)) &&
        Number.isSafeInteger((candidate as { generationFloor?: unknown }).generationFloor) &&
        ((candidate as { generationFloor: number }).generationFloor ?? -1) >= 0
      );
    })
  );
}

function isStoredBrowserUrlStateV1(value: unknown): value is StoredBrowserUrlStateV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<StoredBrowserUrlStateV1>;
  return (
    state.version === 1 &&
    Array.isArray(state.sessions) &&
    state.sessions.every(
      (entry) =>
        Boolean(entry) &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        typeof entry.sessionId === "string" &&
        entry.sessionId.length > 0 &&
        typeof entry.url === "string" &&
        normalizeBrowserAddress(entry.url) === entry.url,
    )
  );
}

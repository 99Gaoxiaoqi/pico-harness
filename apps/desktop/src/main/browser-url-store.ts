import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../../../../src/storage/atomic-json.js";
import { normalizeBrowserAddress } from "./browser-logic.js";

const BROWSER_URL_STATE_VERSION = 1;
const BROWSER_URL_STATE_FILE = "browser-urls.json";
const DEFAULT_WRITE_DEBOUNCE_MS = 250;
const DEFAULT_RETRY_DELAY_MS = 1_000;

interface StoredBrowserUrlState {
  readonly version: typeof BROWSER_URL_STATE_VERSION;
  readonly sessions: readonly {
    readonly sessionId: string;
    readonly url: string;
  }[];
}

type BrowserUrlWriter = (path: string, state: StoredBrowserUrlState) => Promise<void>;

export class BrowserUrlStore {
  readonly filePath: string;
  readonly #urls: Map<string, string>;
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
    this.#urls = readState(this.filePath);
    this.#writeDebounceMs = options.writeDebounceMs ?? DEFAULT_WRITE_DEBOUNCE_MS;
    this.#retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.#onError = options.onError ?? (() => undefined);
    this.#writeState =
      options.write ??
      ((path, state) => writeJsonAtomic(path, state, { fileMode: 0o600, directoryMode: 0o700 }));
  }

  get(sessionId: string): string | undefined {
    return this.#urls.get(sessionId);
  }

  set(sessionId: string, url: string): void {
    const normalized = normalizeBrowserAddress(url);
    if (!normalized || this.#urls.get(sessionId) === normalized) return;
    this.#urls.set(sessionId, normalized);
    this.#revision++;
    this.#schedule(this.#writeDebounceMs);
  }

  delete(sessionId: string): number | undefined {
    if (!this.#urls.delete(sessionId)) return undefined;
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
        sessions: [...this.#urls]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([sessionId, url]) => ({ sessionId, url })),
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
}

function readState(path: string): Map<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isStoredBrowserUrlState(parsed)) return new Map();
    return new Map(parsed.sessions.map(({ sessionId, url }) => [sessionId, url]));
  } catch {
    return new Map();
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
        typeof candidate.url === "string" &&
        normalizeBrowserAddress(candidate.url) === candidate.url
      );
    })
  );
}

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolvePicoHome } from "../paths/pico-paths.js";
import { writeJsonAtomic } from "../storage/atomic-json.js";

const DESKTOP_SESSION_STATE_VERSION = 1 as const;

export interface DesktopSessionMetadata {
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly title?: string;
  readonly archivedAt?: number;
  readonly updatedAt: number;
}

interface DesktopSessionStateFile {
  readonly version: typeof DESKTOP_SESSION_STATE_VERSION;
  readonly sessions: readonly DesktopSessionMetadata[];
}

export interface DesktopSessionStateStoreOptions {
  readonly filePath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly picoHome?: string;
  readonly now?: () => number;
}

/**
 * Desktop-only presentation metadata. Conversation content remains in the existing
 * workspace RuntimeEvent history; this store never moves, truncates, or deletes a CLI session.
 */
export class DesktopSessionStateStore {
  readonly filePath: string;
  private readonly now: () => number;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: DesktopSessionStateStoreOptions = {}) {
    this.filePath =
      options.filePath ??
      join(
        resolvePicoHome({ env: options.env, picoHome: options.picoHome }),
        "desktop",
        "session-state.json",
      );
    this.now = options.now ?? Date.now;
  }

  async list(workspacePath: string): Promise<readonly DesktopSessionMetadata[]> {
    const canonical = normalizeWorkspacePath(workspacePath);
    return (await this.read()).sessions.filter((entry) => entry.workspacePath === canonical);
  }

  async get(workspacePath: string, sessionId: string): Promise<DesktopSessionMetadata | undefined> {
    const canonical = normalizeWorkspacePath(workspacePath);
    return (await this.read()).sessions.find(
      (entry) => entry.workspacePath === canonical && entry.sessionId === sessionId,
    );
  }

  async update(
    workspacePath: string,
    sessionId: string,
    patch: { readonly title?: string; readonly archived?: boolean },
  ): Promise<DesktopSessionMetadata> {
    const canonical = normalizeWorkspacePath(workspacePath);
    const normalizedId = requireNonEmpty(sessionId, "sessionId");
    const title = normalizeTitle(patch.title);
    let result: DesktopSessionMetadata | undefined;
    await this.mutate(async (state) => {
      const current = state.sessions.find(
        (entry) => entry.workspacePath === canonical && entry.sessionId === normalizedId,
      );
      const now = this.now();
      result = {
        workspacePath: canonical,
        sessionId: normalizedId,
        ...((title ?? current?.title) ? { title: title ?? current?.title } : {}),
        ...(patch.archived === true
          ? { archivedAt: current?.archivedAt ?? now }
          : patch.archived === false
            ? {}
            : current?.archivedAt !== undefined
              ? { archivedAt: current.archivedAt }
              : {}),
        updatedAt: now,
      };
      return {
        version: DESKTOP_SESSION_STATE_VERSION,
        sessions: [
          ...state.sessions.filter(
            (entry) => entry.workspacePath !== canonical || entry.sessionId !== normalizedId,
          ),
          result,
        ].sort(compareMetadata),
      };
    });
    if (!result) throw new Error("Desktop session metadata update did not produce a result");
    return result;
  }

  private async mutate(
    operation: (state: DesktopSessionStateFile) => Promise<DesktopSessionStateFile>,
  ): Promise<void> {
    const execute = async () => {
      const next = await operation(await this.read());
      await writeJsonAtomic(this.filePath, next);
    };
    const queued = this.mutationQueue.then(execute, execute);
    this.mutationQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    await queued;
  }

  private async read(): Promise<DesktopSessionStateFile> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      return parseState(parsed, this.filePath);
    } catch (error) {
      if (isNodeCode(error, "ENOENT")) {
        return { version: DESKTOP_SESSION_STATE_VERSION, sessions: [] };
      }
      throw error;
    }
  }
}

function parseState(value: unknown, filePath: string): DesktopSessionStateFile {
  if (!isRecord(value) || value["version"] !== DESKTOP_SESSION_STATE_VERSION) {
    throw new Error(`Desktop session state format is invalid: ${filePath}`);
  }
  const sessions = value["sessions"];
  if (!Array.isArray(sessions)) {
    throw new Error(`Desktop session state is missing sessions: ${filePath}`);
  }
  return {
    version: DESKTOP_SESSION_STATE_VERSION,
    sessions: sessions.map((entry) => parseMetadata(entry, filePath)),
  };
}

function parseMetadata(value: unknown, filePath: string): DesktopSessionMetadata {
  if (
    !isRecord(value) ||
    typeof value["workspacePath"] !== "string" ||
    typeof value["sessionId"] !== "string" ||
    typeof value["updatedAt"] !== "number" ||
    !Number.isFinite(value["updatedAt"]) ||
    (value["title"] !== undefined && typeof value["title"] !== "string") ||
    (value["archivedAt"] !== undefined &&
      (typeof value["archivedAt"] !== "number" || !Number.isFinite(value["archivedAt"])))
  ) {
    throw new Error(`Desktop session state contains an invalid entry: ${filePath}`);
  }
  return {
    workspacePath: normalizeWorkspacePath(value["workspacePath"]),
    sessionId: requireNonEmpty(value["sessionId"], "sessionId"),
    ...(value["title"] !== undefined ? { title: normalizeTitle(value["title"]) } : {}),
    ...(value["archivedAt"] !== undefined ? { archivedAt: value["archivedAt"] } : {}),
    updatedAt: value["updatedAt"],
  };
}

function normalizeWorkspacePath(workspacePath: string): string {
  return resolve(requireNonEmpty(workspacePath, "workspacePath")).normalize("NFC");
}

function normalizeTitle(title: string | undefined): string | undefined {
  if (title === undefined) return undefined;
  const normalized = title.replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > 120) {
    throw new Error("title must contain 1 to 120 characters");
  }
  return normalized;
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must be a non-empty string`);
  return normalized;
}

function compareMetadata(left: DesktopSessionMetadata, right: DesktopSessionMetadata): number {
  return (
    left.workspacePath.localeCompare(right.workspacePath) ||
    left.sessionId.localeCompare(right.sessionId)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolvePicoHome } from "../paths/pico-paths.js";
import { writeJsonAtomic } from "../storage/atomic-json.js";

const DESKTOP_SESSION_STATE_VERSION = 2 as const;
const LEGACY_DESKTOP_SESSION_STATE_VERSION = 1 as const;

export interface DesktopSessionMetadata {
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly archivedAt?: number;
  readonly updatedAt: number;
}

interface DesktopSessionStateFile {
  readonly version: typeof DESKTOP_SESSION_STATE_VERSION;
  readonly sessions: readonly DesktopSessionMetadata[];
}

interface LegacyDesktopSessionStateFile {
  readonly version: typeof LEGACY_DESKTOP_SESSION_STATE_VERSION;
  readonly sessions: readonly LegacyDesktopSessionMetadata[];
}

export interface LegacyDesktopSessionMetadata extends DesktopSessionMetadata {
  readonly title?: string;
}

export interface LegacyDesktopSessionTitleMetadata extends DesktopSessionMetadata {
  readonly title: string;
}

export interface DesktopSessionStateStoreOptions {
  readonly filePath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly picoHome?: string;
  readonly now?: () => number;
  readonly migrateLegacyTitle?: (metadata: LegacyDesktopSessionTitleMetadata) => Promise<void>;
}

/**
 * Desktop-only archive and UI metadata. Session identity and title remain in the workspace
 * RuntimeEvent history; this store never moves, truncates, or deletes a CLI session.
 */
export class DesktopSessionStateStore {
  readonly filePath: string;
  private readonly now: () => number;
  private readonly migrateLegacyTitle?: DesktopSessionStateStoreOptions["migrateLegacyTitle"];
  private legacyMigration?: Promise<DesktopSessionStateFile>;
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
    this.migrateLegacyTitle = options.migrateLegacyTitle;
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
    patch: { readonly archived?: boolean },
  ): Promise<DesktopSessionMetadata> {
    const canonical = normalizeWorkspacePath(workspacePath);
    const normalizedId = requireNonEmpty(sessionId, "sessionId");
    let result: DesktopSessionMetadata | undefined;
    await this.mutate(async (state) => {
      const current = state.sessions.find(
        (entry) => entry.workspacePath === canonical && entry.sessionId === normalizedId,
      );
      const now = this.now();
      result = {
        workspacePath: canonical,
        sessionId: normalizedId,
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
      if (isRecord(parsed) && parsed["version"] === LEGACY_DESKTOP_SESSION_STATE_VERSION) {
        return this.runLegacyMigration(parseLegacyState(parsed, this.filePath));
      }
      return parseState(parsed, this.filePath);
    } catch (error) {
      if (isNodeCode(error, "ENOENT")) {
        return { version: DESKTOP_SESSION_STATE_VERSION, sessions: [] };
      }
      throw error;
    }
  }

  private runLegacyMigration(legacy: LegacyDesktopSessionStateFile): Promise<DesktopSessionStateFile> {
    if (this.legacyMigration) return this.legacyMigration;
    const migration = this.migrateLegacyState(legacy);
    this.legacyMigration = migration;
    const clear = () => {
      if (this.legacyMigration === migration) this.legacyMigration = undefined;
    };
    void migration.then(clear, clear);
    return migration;
  }

  private async migrateLegacyState(
    legacy: LegacyDesktopSessionStateFile,
  ): Promise<DesktopSessionStateFile> {
    for (const metadata of legacy.sessions) {
      const title = metadata.title;
      if (title === undefined) continue;
      if (!this.migrateLegacyTitle) {
        throw new Error(`Desktop session state v1 title migration is unavailable: ${this.filePath}`);
      }
      await this.migrateLegacyTitle({ ...metadata, title });
    }

    const migrated: DesktopSessionStateFile = {
      version: DESKTOP_SESSION_STATE_VERSION,
      sessions: legacy.sessions.map(({ title: _title, ...metadata }) => metadata),
    };
    await writeJsonAtomic(this.filePath, migrated);
    return migrated;
  }
}

function parseLegacyState(value: unknown, filePath: string): LegacyDesktopSessionStateFile {
  if (!isRecord(value) || value["version"] !== LEGACY_DESKTOP_SESSION_STATE_VERSION) {
    throw new Error(`Desktop session state v1 format is invalid: ${filePath}`);
  }
  const sessions = value["sessions"];
  if (!Array.isArray(sessions)) {
    throw new Error(`Desktop session state v1 is missing sessions: ${filePath}`);
  }
  return {
    version: LEGACY_DESKTOP_SESSION_STATE_VERSION,
    sessions: sessions.map((entry) => parseLegacyMetadata(entry, filePath)),
  };
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
    value["title"] !== undefined ||
    (value["archivedAt"] !== undefined &&
      (typeof value["archivedAt"] !== "number" || !Number.isFinite(value["archivedAt"])))
  ) {
    throw new Error(`Desktop session state contains an invalid entry: ${filePath}`);
  }
  return {
    workspacePath: normalizeWorkspacePath(value["workspacePath"]),
    sessionId: requireNonEmpty(value["sessionId"], "sessionId"),
    ...(value["archivedAt"] !== undefined ? { archivedAt: value["archivedAt"] } : {}),
    updatedAt: value["updatedAt"],
  };
}

function parseLegacyMetadata(value: unknown, filePath: string): LegacyDesktopSessionMetadata {
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
    throw new Error(`Desktop session state v1 contains an invalid entry: ${filePath}`);
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

function normalizeTitle(title: string): string {
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

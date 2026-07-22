import { createHash, randomUUID } from "node:crypto";
import { lstat, open, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import {
  assertRegularNonSymlink,
  ensurePrivateDirectory,
  writePrivateFileAtomic,
} from "../hooks/trust/secure-file.js";
import { resolvePicoHome } from "../paths/pico-paths.js";
import { parseMcpConfig } from "./config-parser.js";
import type { McpConfig, McpServerConfig } from "./types.js";

const LOCK_RETRY_MS = 10;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const MAX_IDEMPOTENCY_RECORDS = 128;

export const EMPTY_USER_MCP_REVISION = configRevision({ mcpServers: {} });

export interface UserMcpConfigSnapshot {
  readonly config: McpConfig;
  /** Stable SHA-256 of the semantic MCP config; internal operation metadata is excluded. */
  readonly revision: string;
}

export interface UserMcpMutationOptions {
  readonly expectedRevision: string;
  readonly idempotencyKey: string;
}

export interface UserMcpMutationResult {
  /** Current durable snapshot. On replay it may contain later mutations. */
  readonly snapshot: UserMcpConfigSnapshot;
  /** Revision produced by the original committed request. */
  readonly resultRevision: string;
  readonly replayed: boolean;
}

export interface UserMcpConfigStoreOptions {
  readonly picoHome?: string;
  readonly lockTimeoutMs?: number;
  readonly staleLockMs?: number;
}

export class UserMcpRevisionConflictError extends Error {
  readonly code = "MCP_CONFIG_REVISION_CONFLICT" as const;

  constructor(
    readonly expectedRevision: string,
    readonly actualRevision: string,
  ) {
    super(`用户 MCP 配置已更改: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = "UserMcpRevisionConflictError";
  }
}

export class UserMcpIdempotencyConflictError extends Error {
  readonly code = "MCP_IDEMPOTENCY_CONFLICT" as const;

  constructor() {
    super("MCP 幂等键已用于不同请求");
    this.name = "UserMcpIdempotencyConflictError";
  }
}

interface StoredOperation {
  readonly keyHash: string;
  readonly requestHash: string;
  readonly resultRevision: string;
}

interface LockLease {
  readonly handle: FileHandle;
  readonly dev: number;
  readonly ino: number;
}

/**
 * User-level MCP definitions. This store only parses and mutates JSON; it never creates an MCP
 * client. Idempotency records live in the same atomic file so a committed mutation and its key
 * cannot be torn apart by a crash.
 */
export class UserMcpConfigStore {
  readonly directoryPath: string;
  readonly filePath: string;
  readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;

  constructor(options: UserMcpConfigStoreOptions = {}) {
    this.directoryPath = options.picoHome ?? resolvePicoHome();
    this.filePath = join(this.directoryPath, "mcp.json");
    this.lockPath = join(this.directoryPath, ".mcp.json.lock");
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  }

  async read(): Promise<UserMcpConfigSnapshot> {
    await ensurePrivateDirectory(this.directoryPath);
    return (await this.readStored()).snapshot;
  }

  async upsert(
    server: McpServerConfig,
    options: UserMcpMutationOptions,
  ): Promise<UserMcpMutationResult> {
    const normalized = parseMcpConfig(
      { mcpServers: { [server.name]: server } },
      `MCP server ${server.name}`,
    ).mcpServers[server.name]!;
    return this.mutate({ kind: "upsert", server: normalized }, options, (config) => ({
      ...config,
      mcpServers: { ...config.mcpServers, [server.name]: normalized },
    }));
  }

  async delete(
    serverName: string,
    options: UserMcpMutationOptions,
  ): Promise<UserMcpMutationResult> {
    const name = requireServerName(serverName);
    return this.mutate({ kind: "delete", serverName: name }, options, (config) => {
      const mcpServers = { ...config.mcpServers };
      delete mcpServers[name];
      return { ...config, mcpServers };
    });
  }

  private async mutate(
    request: unknown,
    options: UserMcpMutationOptions,
    apply: (config: McpConfig) => McpConfig,
  ): Promise<UserMcpMutationResult> {
    const idempotencyKey = requireIdempotencyKey(options.idempotencyKey);
    const keyHash = sha256(idempotencyKey);
    const requestHash = sha256(stableJson(request));
    return this.withLock(async (lease) => {
      const current = await this.readStored();
      const replay = current.operations.find((operation) => operation.keyHash === keyHash);
      if (replay) {
        if (replay.requestHash !== requestHash) throw new UserMcpIdempotencyConflictError();
        return {
          snapshot: current.snapshot,
          resultRevision: replay.resultRevision,
          replayed: true,
        };
      }
      if (options.expectedRevision !== current.snapshot.revision) {
        throw new UserMcpRevisionConflictError(options.expectedRevision, current.snapshot.revision);
      }
      const nextConfig = parseMcpConfig(apply(current.snapshot.config), this.filePath);
      const resultRevision = configRevision(nextConfig);
      const operations = [
        ...current.operations.slice(-(MAX_IDEMPOTENCY_RECORDS - 1)),
        { keyHash, requestHash, resultRevision },
      ];
      const content = `${JSON.stringify({ ...nextConfig, _pico: { operations } }, null, 2)}\n`;
      await this.assertOwnedLock(lease);
      await writePrivateFileAtomic(this.filePath, content);
      return {
        snapshot: { config: nextConfig, revision: resultRevision },
        resultRevision,
        replayed: false,
      };
    });
  }

  private async readStored(): Promise<{
    readonly snapshot: UserMcpConfigSnapshot;
    readonly operations: readonly StoredOperation[];
  }> {
    if ((await assertRegularNonSymlink(this.filePath)) === "missing") {
      return {
        snapshot: { config: { mcpServers: {} }, revision: EMPTY_USER_MCP_REVISION },
        operations: [],
      };
    }
    const handle = await open(this.filePath, "r");
    try {
      const before = await lstat(this.filePath);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error(`读取用户 MCP 配置时文件已被替换: ${this.filePath}`);
      }
      await handle.chmod(0o600);
      const raw = await handle.readFile("utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch (error) {
        throw new Error(`用户 MCP 配置 JSON 已损坏: ${this.filePath}`, { cause: error });
      }
      const config = parseMcpConfig(parsed, this.filePath);
      return {
        snapshot: { config, revision: configRevision(config) },
        operations: parseOperations(parsed),
      };
    } finally {
      await handle.close();
    }
  }

  private async withLock<T>(operation: (lease: LockLease) => Promise<T>): Promise<T> {
    await ensurePrivateDirectory(this.directoryPath);
    const deadline = Date.now() + this.lockTimeoutMs;
    let lease: LockLease | undefined;
    while (!lease) {
      let pendingHandle: FileHandle | undefined;
      let pendingIdentity: { readonly dev: number; readonly ino: number } | undefined;
      try {
        pendingHandle = await open(this.lockPath, "wx", 0o600);
        const stat = await pendingHandle.stat();
        pendingIdentity = { dev: stat.dev, ino: stat.ino };
        await pendingHandle.writeFile(`${process.pid}:${randomUUID()}\n`, "utf8");
        await pendingHandle.sync();
        lease = { handle: pendingHandle, dev: stat.dev, ino: stat.ino };
        pendingHandle = undefined;
      } catch (error) {
        await pendingHandle?.close().catch(() => undefined);
        if (pendingIdentity) {
          const current = await lstat(this.lockPath).catch(() => undefined);
          if (current?.dev === pendingIdentity.dev && current.ino === pendingIdentity.ino) {
            await unlink(this.lockPath).catch(() => undefined);
          }
        }
        if (!isErrno(error, "EEXIST")) throw error;
        await this.removeStaleLock();
        if (Date.now() >= deadline) {
          throw new Error(`等待用户 MCP 配置写锁超时: ${this.lockPath}`, { cause: error });
        }
        await delay(LOCK_RETRY_MS);
      }
    }
    try {
      return await operation(lease);
    } finally {
      await lease.handle.close().catch(() => undefined);
      const current = await lstat(this.lockPath).catch(() => undefined);
      if (current?.dev === lease.dev && current.ino === lease.ino) {
        await unlink(this.lockPath).catch(() => undefined);
      }
    }
  }

  private async assertOwnedLock(lease: LockLease): Promise<void> {
    const current = await lstat(this.lockPath).catch(() => undefined);
    if (current?.dev !== lease.dev || current.ino !== lease.ino) {
      throw new Error(`用户 MCP 配置写锁所有权已丢失: ${this.lockPath}`);
    }
  }

  private async removeStaleLock(): Promise<void> {
    const before = await lstat(this.lockPath).catch(() => undefined);
    if (!before) return;
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new Error(`用户 MCP 配置写锁必须是普通文件: ${this.lockPath}`);
    }
    if (Date.now() - before.mtimeMs < this.staleLockMs) return;
    const current = await lstat(this.lockPath).catch(() => undefined);
    if (current?.dev === before.dev && current.ino === before.ino) {
      await unlink(this.lockPath).catch((error: unknown) => {
        if (!isErrno(error, "ENOENT")) throw error;
      });
    }
  }
}

function parseOperations(value: unknown): readonly StoredOperation[] {
  if (
    !isRecord(value) ||
    !isRecord(value["_pico"]) ||
    !Array.isArray(value["_pico"]["operations"])
  ) {
    return [];
  }
  return value["_pico"]["operations"].flatMap((item) =>
    isRecord(item) &&
    typeof item["keyHash"] === "string" &&
    typeof item["requestHash"] === "string" &&
    typeof item["resultRevision"] === "string" &&
    /^[a-f0-9]{64}$/u.test(item["resultRevision"])
      ? [
          {
            keyHash: item["keyHash"],
            requestHash: item["requestHash"],
            resultRevision: item["resultRevision"],
          },
        ]
      : [],
  );
}

function requireServerName(value: string): string {
  const name = value.trim();
  if (!name || name !== value) throw new Error("MCP serverName 必须是非空且无首尾空格的字符串");
  return name;
}

function requireIdempotencyKey(value: string): string {
  const key = value.trim();
  if (!key || key.length > 512) throw new Error("MCP idempotencyKey 必须是 1-512 字符");
  return key;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function configRevision(config: McpConfig): string {
  return sha256(stableJson(config));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { resolvePicoHome } from "../../paths/pico-paths.js";
import {
  resolveCommandHookExecution,
  type HookShell,
  type ResolvedCommandHookInvocation,
} from "../config/command-shell.js";
import type { HookHandler, HookSource, ResolvedHookHandler } from "../types.js";
import {
  assertRegularNonSymlink,
  ensurePrivateDirectory,
  writePrivateFileAtomic,
} from "./secure-file.js";

const STORE_VERSION = 2;
const HOOK_SOURCE_KINDS: ReadonlySet<string> = new Set([
  "user",
  "project",
  "local",
  "skill",
  "agent",
  "managed",
  "plugin",
]);

export type HookTrustStatus = "active" | "pending";

export interface HookTrustSubject {
  workspace: string;
  source: HookSource;
  handler: HookHandler;
}

/**
 * 可插拔的 Hook 可执行信任权威。
 *
 * 默认实现是 HookTrustStore；宿主可以为已经完成独立签名/指纹校验的资源快照提供
 * 更窄的 authority。实现必须在 status 与 authorizeCommandExecution 中保持同一绑定，
 * 并在快照失效后返回 pending/undefined。shell 由宿主按运行边界选择，不进入配置
 * 指纹；authority 必须用 authorize 时收到的 shell 生成最终 invocation。
 */
export interface HookTrustAuthority {
  readonly filePath?: string;
  /** Optional host-owned identity (for example a plugin id + immutable resource digest). */
  readonly identity?: Readonly<Record<string, string>>;
  status(subject: HookTrustSubject): Promise<HookTrustStatus>;
  authorizeCommandExecution(
    subject: HookTrustSubject,
    shell?: HookShell,
  ): Promise<ResolvedCommandHookInvocation | undefined>;
}

export interface HookTrustFingerprint {
  id: string;
  workspace: string;
  source: { kind: HookSource["kind"]; path: string; componentId?: string };
  definitionHash: string;
}

export interface HookTrustRecord extends HookTrustFingerprint {
  trustedAt: string;
}

interface HookTrustFile {
  version: number;
  records: readonly HookTrustRecord[];
}

export interface HookTrustStoreOptions {
  /** Host-owned Pico state root. */
  picoHome?: string;
  filePath?: string;
  /** Host environment shared by trust resolution and command execution. */
  env?: Readonly<NodeJS.ProcessEnv>;
}

/** executable handler 信任库；来源或规范化定义改变即匹配不上既有记录。 */
export class HookTrustStore {
  readonly filePath: string;
  private readonly environment: Readonly<NodeJS.ProcessEnv>;

  constructor(options: HookTrustStoreOptions = {}) {
    const picoHome = options.picoHome ?? resolvePicoHome();
    this.filePath = options.filePath ?? join(picoHome, "trusted-hooks.json");
    this.environment = options.env ?? process.env;
  }

  async status(subject: HookTrustSubject): Promise<HookTrustStatus> {
    const { fingerprint } = await this.resolveFingerprint(subject);
    const records = await this.readRecords();
    return records.some((record) => record.id === fingerprint.id) ? "active" : "pending";
  }

  async trust(subject: HookTrustSubject): Promise<HookTrustRecord> {
    const { fingerprint } = await this.resolveFingerprint(subject);
    const records = await this.readRecords();
    const record: HookTrustRecord = { ...fingerprint, trustedAt: new Date().toISOString() };
    const next = [...records.filter((item) => item.id !== record.id), record];
    await this.writeRecords(next);
    return record;
  }

  async revoke(subject: HookTrustSubject): Promise<void> {
    const { fingerprint } = await this.resolveFingerprint(subject);
    const records = await this.readRecords();
    await this.writeRecords(records.filter((record) => record.id !== fingerprint.id));
  }

  async trustResolved(
    workspace: string,
    resolvedHandler: ResolvedHookHandler,
  ): Promise<HookTrustRecord> {
    return await this.trust({
      workspace,
      source: resolvedHandler.source,
      handler: resolvedHandler.handler,
    });
  }

  async fingerprint(subject: HookTrustSubject): Promise<HookTrustFingerprint> {
    return (await this.resolveFingerprint(subject)).fingerprint;
  }

  /**
   * Return the exact command resolution whose fingerprint still has an active trust record.
   * The executor must use this invocation directly instead of resolving the logical alias again.
   */
  async authorizeCommandExecution(
    subject: HookTrustSubject,
    shell?: HookShell,
  ): Promise<ResolvedCommandHookInvocation | undefined> {
    if (subject.handler.type !== "command") return undefined;
    const { fingerprint, commandExecution } = await this.resolveFingerprint(subject, shell);
    const records = await this.readRecords();
    return records.some((record) => record.id === fingerprint.id) ? commandExecution : undefined;
  }

  async list(): Promise<readonly HookTrustRecord[]> {
    return await this.readRecords();
  }

  private async resolveFingerprint(
    subject: HookTrustSubject,
    shell?: HookShell,
  ): Promise<{
    fingerprint: HookTrustFingerprint;
    commandExecution?: ResolvedCommandHookInvocation;
  }> {
    const workspace = await canonicalExistingDirectory(subject.workspace);
    const sourcePath = await canonicalMaybeExisting(subject.source.path);
    const definitionHash = hash(stableStringify(trustedDefinition(subject.handler)));
    const commandExecution =
      subject.handler.type === "command"
        ? await resolveCommandHookExecution(subject.handler, workspace, this.environment, shell)
        : undefined;
    const source = {
      kind: subject.source.kind,
      path: sourcePath,
      ...(subject.source.componentId === undefined
        ? {}
        : { componentId: subject.source.componentId }),
    };
    const id = hash(stableStringify({ workspace, source, definitionHash }));
    return {
      fingerprint: { id, workspace, source, definitionHash },
      ...(commandExecution ? { commandExecution } : {}),
    };
  }

  private async readRecords(): Promise<readonly HookTrustRecord[]> {
    await ensurePrivateDirectory(dirname(this.filePath));
    if ((await assertRegularNonSymlink(this.filePath)) === "missing") return [];
    const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
    if (
      !isRecord(parsed) ||
      !hasOnlyKeys(parsed, ["version", "records"]) ||
      parsed.version !== STORE_VERSION ||
      !Array.isArray(parsed.records)
    ) {
      throw new Error(
        `trusted-hooks.json schema 无效：仅支持 v${STORE_VERSION}，旧格式不会自动迁移`,
      );
    }
    return parsed.records.map(parseRecord);
  }

  private async writeRecords(records: readonly HookTrustRecord[]): Promise<void> {
    const body: HookTrustFile = { version: STORE_VERSION, records };
    await writePrivateFileAtomic(this.filePath, `${JSON.stringify(body, null, 2)}\n`);
  }
}

function parseRecord(input: unknown): HookTrustRecord {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, ["id", "workspace", "source", "definitionHash", "trustedAt"]) ||
    typeof input.id !== "string" ||
    typeof input.workspace !== "string" ||
    !isRecord(input.source) ||
    !hasOnlyKeys(input.source, ["kind", "path", "componentId"]) ||
    !isHookSourceKind(input.source.kind) ||
    typeof input.source.path !== "string" ||
    (input.source.componentId !== undefined && typeof input.source.componentId !== "string") ||
    typeof input.definitionHash !== "string" ||
    typeof input.trustedAt !== "string"
  ) {
    throw new Error(`trusted-hooks.json v${STORE_VERSION} record 无效`);
  }
  return input as unknown as HookTrustRecord;
}

async function canonicalExistingDirectory(path: string): Promise<string> {
  const canonical = await realpath(resolve(path));
  const stat = await lstat(canonical);
  if (!stat.isDirectory()) throw new Error(`工作区不是目录: ${canonical}`);
  return canonical;
}

async function canonicalMaybeExisting(path: string): Promise<string> {
  try {
    return await realpath(resolve(path));
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
    return normalize(resolve(path));
  }
}

function hash(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

function trustedDefinition(handler: HookHandler): unknown {
  const { enabled: _localState, ...definition } = handler;
  return definition;
}

function stableStringify(input: unknown): string {
  return JSON.stringify(sort(input));
}

function sort(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(sort);
  if (!isRecord(input)) return input;
  return Object.fromEntries(
    Object.keys(input)
      .sort()
      .map((key) => [key, sort(input[key])]),
  );
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function hasOnlyKeys(input: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(input).every((key) => allowed.includes(key));
}

function isHookSourceKind(input: unknown): input is HookSource["kind"] {
  return typeof input === "string" && HOOK_SOURCE_KINDS.has(input);
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

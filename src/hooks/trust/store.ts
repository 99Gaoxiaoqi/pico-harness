import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { resolvePicoHome } from "../../paths/pico-paths.js";
import { resolveReferencedScripts } from "../config/referenced-scripts.js";
import type { HookHandler, HookSource, ResolvedHookHandler } from "../types.js";
import {
  assertRegularNonSymlink,
  ensurePrivateDirectory,
  writePrivateFileAtomic,
} from "./secure-file.js";

const STORE_VERSION = 1;

export type HookTrustStatus = "active" | "pending";

export interface HookTrustSubject {
  workspace: string;
  source: HookSource;
  handler: HookHandler;
}

export interface HookTrustFingerprint {
  id: string;
  workspace: string;
  source: { kind: HookSource["kind"]; path: string; componentId?: string };
  definitionHash: string;
  scriptHashes: Readonly<Record<string, string>>;
}

export interface HookTrustRecord extends HookTrustFingerprint {
  trustedAt: string;
}

interface HookTrustFile {
  version: number;
  records: readonly HookTrustRecord[];
}

export interface HookTrustStoreOptions {
  userHome?: string;
  /** Host-owned Pico state root. Takes precedence over the legacy userHome seam. */
  picoHome?: string;
  filePath?: string;
  /** Environment inherited by command Hooks; package target selectors are fail-closed. */
  env?: Readonly<NodeJS.ProcessEnv>;
}

/** executable handler 信任库；定义或脚本字节改变即匹配不上旧记录。 */
export class HookTrustStore {
  readonly filePath: string;
  private readonly environment: Readonly<NodeJS.ProcessEnv>;

  constructor(options: HookTrustStoreOptions = {}) {
    const picoHome =
      options.picoHome ?? (options.userHome ? join(options.userHome, ".pico") : resolvePicoHome());
    this.filePath = options.filePath ?? join(picoHome, "trusted-hooks.json");
    this.environment = options.env ?? process.env;
  }

  async status(subject: HookTrustSubject): Promise<HookTrustStatus> {
    const fingerprint = await this.fingerprint(subject);
    const records = await this.readRecords();
    return records.some((record) => record.id === fingerprint.id) ? "active" : "pending";
  }

  async trust(subject: HookTrustSubject): Promise<HookTrustRecord> {
    const fingerprint = await this.fingerprint(subject);
    const records = await this.readRecords();
    const record: HookTrustRecord = { ...fingerprint, trustedAt: new Date().toISOString() };
    const next = [...records.filter((item) => item.id !== record.id), record];
    await this.writeRecords(next);
    return record;
  }

  async revoke(subject: HookTrustSubject): Promise<void> {
    const fingerprint = await this.fingerprint(subject);
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
    const workspace = await canonicalExistingDirectory(subject.workspace);
    const sourcePath = await canonicalMaybeExisting(subject.source.path);
    const definitionHash = hash(stableStringify(trustedDefinition(subject.handler)));
    const scriptHashes = await hashReferencedScripts(subject.handler, workspace, this.environment);
    const source = {
      kind: subject.source.kind,
      path: sourcePath,
      ...(subject.source.componentId === undefined
        ? {}
        : { componentId: subject.source.componentId }),
    };
    const id = hash(stableStringify({ workspace, source, definitionHash, scriptHashes }));
    return { id, workspace, source, definitionHash, scriptHashes };
  }

  async list(): Promise<readonly HookTrustRecord[]> {
    return await this.readRecords();
  }

  private async readRecords(): Promise<readonly HookTrustRecord[]> {
    await ensurePrivateDirectory(dirname(this.filePath));
    if ((await assertRegularNonSymlink(this.filePath)) === "missing") return [];
    const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
    if (!isRecord(parsed) || parsed.version !== STORE_VERSION || !Array.isArray(parsed.records)) {
      throw new Error("trusted-hooks.json schema 无效");
    }
    return parsed.records.map(parseRecord);
  }

  private async writeRecords(records: readonly HookTrustRecord[]): Promise<void> {
    const body: HookTrustFile = { version: STORE_VERSION, records };
    await writePrivateFileAtomic(this.filePath, `${JSON.stringify(body, null, 2)}\n`);
  }
}

async function hashReferencedScripts(
  handler: HookHandler,
  workspace: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<Readonly<Record<string, string>>> {
  if (handler.type !== "command") return {};
  const references = await resolveReferencedScripts(handler, workspace, environment);
  const hashes: Record<string, string> = {};
  for (const packageScript of references.packageScripts) {
    const key = `package-script:${packageScript.canonicalManifestPath}#${encodeURIComponent(
      packageScript.manager,
    )}:${encodeURIComponent(packageScript.scriptName)}`;
    hashes[key] = hash(
      stableStringify({
        state: packageScript.state,
        definitions: packageScript.definitions,
      }),
    );
  }
  for (const candidate of references.paths) {
    try {
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) {
        const target = await realpath(candidate);
        hashes[target] = hash(await readFile(target));
      } else if (stat.isFile()) {
        const target = await realpath(candidate);
        hashes[target] = hash(await readFile(target));
      }
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }
  return Object.fromEntries(
    Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function parseRecord(input: unknown): HookTrustRecord {
  if (
    !isRecord(input) ||
    typeof input.id !== "string" ||
    typeof input.workspace !== "string" ||
    !isRecord(input.source) ||
    typeof input.source.kind !== "string" ||
    typeof input.source.path !== "string" ||
    typeof input.definitionHash !== "string" ||
    !isStringRecord(input.scriptHashes) ||
    typeof input.trustedAt !== "string"
  ) {
    throw new Error("trusted-hooks.json record 无效");
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

function isStringRecord(input: unknown): input is Record<string, string> {
  return isRecord(input) && Object.values(input).every((value) => typeof value === "string");
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

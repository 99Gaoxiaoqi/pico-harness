import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assertRegularNonSymlink,
  ensurePrivateDirectory,
  writePrivateFileAtomic,
} from "../hooks/trust/secure-file.js";
import { resolvePicoPaths, type WorkspaceId } from "../paths/pico-paths.js";
import type { InstalledPlugin } from "./plugin-manager.js";
import type { PluginScope } from "./plugin-types.js";

const TRUST_STORE_VERSION = 1 as const;

export type PluginTrustStatus = "active" | "pending";

export interface PluginTrustProposal {
  readonly id: string;
  readonly pluginId: string;
  readonly scope: PluginScope;
  readonly workspaceId: WorkspaceId;
  readonly workspacePath: string;
  readonly pluginRoot: string;
  readonly resourceDigest: string;
}

export interface PluginTrustRecord extends PluginTrustProposal {
  readonly trustedAt: string;
}

interface PluginTrustFile {
  readonly version: typeof TRUST_STORE_VERSION;
  readonly records: readonly PluginTrustRecord[];
}

export interface PluginTrustStoreOptions {
  readonly workDir: string;
  readonly filePath?: string;
  readonly picoHome?: string;
  readonly homeDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Plugin trust is bound to workspace, canonical root, scope and complete resource bytes. */
export class PluginTrustStore {
  readonly filePath: string;
  private readonly workDir: string;
  private readonly workspaceId: WorkspaceId;

  constructor(options: PluginTrustStoreOptions) {
    const paths = resolvePicoPaths(options.workDir, options);
    this.workDir = paths.canonicalWorkDir;
    this.workspaceId = paths.workspace.id;
    this.filePath = options.filePath ?? join(paths.home.root, "trusted-plugins.json");
  }

  async prepare(plugin: InstalledPlugin): Promise<PluginTrustProposal> {
    const pluginRoot = await realpath(plugin.installPath);
    const subject = {
      pluginId: plugin.id,
      scope: plugin.scope,
      workspaceId: this.workspaceId,
      workspacePath: this.workDir,
      pluginRoot,
      resourceDigest: plugin.resourceFingerprint.digest,
    } satisfies Omit<PluginTrustProposal, "id">;
    return Object.freeze({ id: proposalId(subject), ...subject });
  }

  async status(plugin: InstalledPlugin): Promise<PluginTrustStatus> {
    const proposal = await this.prepare(plugin);
    const records = await this.readRecords();
    return records.some((record) => record.id === proposal.id) ? "active" : "pending";
  }

  async trust(proposal: PluginTrustProposal): Promise<PluginTrustRecord> {
    const expectedId = proposalId(proposal);
    if (proposal.id !== expectedId) throw new Error("Plugin trust proposal 校验失败");
    if (proposal.workspaceId !== this.workspaceId || proposal.workspacePath !== this.workDir) {
      throw new Error("Plugin trust proposal 不属于当前工作区");
    }
    const records = await this.readRecords();
    const record = { ...proposal, trustedAt: new Date().toISOString() } satisfies PluginTrustRecord;
    await this.writeRecords([
      ...records.filter(
        (item) => !(item.pluginId === record.pluginId && item.scope === record.scope),
      ),
      record,
    ]);
    return record;
  }

  async list(): Promise<readonly PluginTrustRecord[]> {
    return await this.readRecords();
  }

  private async readRecords(): Promise<readonly PluginTrustRecord[]> {
    await ensurePrivateDirectory(dirname(this.filePath));
    if ((await assertRegularNonSymlink(this.filePath)) === "missing") return [];
    const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
    if (!isRecord(parsed) || parsed.version !== TRUST_STORE_VERSION || !Array.isArray(parsed.records)) {
      throw new Error("trusted-plugins.json schema 无效");
    }
    return parsed.records.map(parseRecord);
  }

  private async writeRecords(records: readonly PluginTrustRecord[]): Promise<void> {
    const file = { version: TRUST_STORE_VERSION, records } satisfies PluginTrustFile;
    await writePrivateFileAtomic(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
  }
}

function proposalId(proposal: Omit<PluginTrustProposal, "id"> | PluginTrustProposal): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        pluginId: proposal.pluginId,
        scope: proposal.scope,
        workspaceId: proposal.workspaceId,
        workspacePath: proposal.workspacePath,
        pluginRoot: proposal.pluginRoot,
        resourceDigest: proposal.resourceDigest,
      }),
    )
    .digest("hex");
}

function parseRecord(value: unknown): PluginTrustRecord {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.pluginId !== "string" ||
    !isPluginScope(value.scope) ||
    typeof value.workspaceId !== "string" ||
    typeof value.workspacePath !== "string" ||
    typeof value.pluginRoot !== "string" ||
    typeof value.resourceDigest !== "string" ||
    typeof value.trustedAt !== "string"
  ) {
    throw new Error("trusted-plugins.json record 无效");
  }
  return value as unknown as PluginTrustRecord;
}

function isPluginScope(value: unknown): value is PluginScope {
  return value === "user" || value === "project" || value === "local";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

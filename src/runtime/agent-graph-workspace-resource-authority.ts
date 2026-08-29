import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import type { AgentGraphOperatorProvision } from "../agent-graph/core/contracts.js";
import type { ResolvedAgentGraphOperatorWorkspace } from "../agent-graph/runtime-adapter-bridge.js";
import type { SqliteAgentGraphControlStore } from "../storage/sqlite/sqlite-agent-graph-control-store.js";
import type { AgentGraphWorkspaceResourceRecord } from "../storage/sqlite/agent-graph-store-types.js";
import {
  buildSafeGitEnvironment,
  createDisabledHooksPath,
  hardenGitArgs,
} from "../tasks/git-safety.js";

const execFileAsync = promisify(execFile);

export interface AgentGraphWorkspaceGitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type AgentGraphWorkspaceGitExecutor = (
  args: readonly string[],
  options: { readonly cwd: string; readonly allowExitCodes?: readonly number[] },
) => Promise<AgentGraphWorkspaceGitResult>;

export interface AgentGraphWorkspaceResourceAuthorityOptions {
  readonly repoRoot: string;
  readonly storageRoot: string;
  readonly store: SqliteAgentGraphControlStore;
  readonly worktreeRoot?: string;
  readonly gitExecutor?: AgentGraphWorkspaceGitExecutor;
  readonly afterGitSideEffect?: (operation: "add" | "remove", resourceId: string) => Promise<void>;
}

/** Durable owner for Graph-managed isolated Git worktrees. */
export class AgentGraphWorkspaceResourceAuthority {
  private readonly repoRoot: string;
  private readonly storageRoot: string;
  private readonly worktreeRoot: string;
  private readonly git: AgentGraphWorkspaceGitExecutor;
  private readonly acquisitions = new Map<string, Promise<ResolvedAgentGraphOperatorWorkspace>>();

  constructor(private readonly options: AgentGraphWorkspaceResourceAuthorityOptions) {
    this.repoRoot = requireAbsolute(options.repoRoot, "repoRoot");
    this.storageRoot = requireAbsolute(options.storageRoot, "storageRoot");
    this.worktreeRoot = requireContained(
      this.repoRoot,
      resolve(options.worktreeRoot ?? resolve(this.repoRoot, ".worktrees", "graph")),
      "worktreeRoot",
    );
    const disabledHooks = createDisabledHooksPath();
    const raw = options.gitExecutor ?? executeGit;
    this.git = (args, gitOptions) => raw(hardenGitArgs(args, disabledHooks), gitOptions);
  }

  async resolve(
    provision: AgentGraphOperatorProvision,
  ): Promise<ResolvedAgentGraphOperatorWorkspace> {
    const binding = isolatedBinding(provision.workspaceBinding);
    if (!binding) {
      return { workDir: this.repoRoot, sessionOptions: { runtimeStorageRoot: this.storageRoot } };
    }
    const pending = this.acquisitions.get(provision.provisionId);
    if (pending) return pending;
    const acquisition = this.resolveIsolated(provision, binding.baseRef ?? "HEAD").finally(() => {
      if (this.acquisitions.get(provision.provisionId) === acquisition) {
        this.acquisitions.delete(provision.provisionId);
      }
    });
    this.acquisitions.set(provision.provisionId, acquisition);
    return acquisition;
  }

  async recover(): Promise<void> {
    for (const resource of this.options.store.listWorkspaceResources()) {
      const provision = this.options.store
        .listOperatorProvisions(resource.graphId)
        .find((candidate) => candidate.provisionId === resource.provisionId);
      if (!provision) throw new Error(`Workspace resource lost provision ${resource.provisionId}`);
      if (provision.state === "stopped") await this.cleanup(resource.resourceId);
      else if (resource.state === "requested" || resource.state === "active") {
        await this.adopt(resource);
      }
    }
  }

  async cleanupProvision(provisionId: string): Promise<void> {
    const resource = this.options.store.getWorkspaceResourceByProvision(provisionId);
    if (resource) await this.cleanup(resource.resourceId);
  }

  resourceForSession(sessionId: string): AgentGraphWorkspaceResourceRecord | undefined {
    return this.options.store.getWorkspaceResourceBySession(sessionId);
  }

  private async resolveIsolated(
    provision: AgentGraphOperatorProvision,
    baseRef: string,
  ): Promise<ResolvedAgentGraphOperatorWorkspace> {
    await this.assertRepository();
    const suffix = createHash("sha256").update(provision.provisionId).digest("hex").slice(0, 24);
    const resourceId = `graph-worktree-${suffix}`;
    const branch = `pico/graph-${suffix}`;
    const worktreePath = requireContained(
      this.worktreeRoot,
      resolve(this.worktreeRoot, suffix),
      "worktreePath",
    );
    const baseCommit = await this.gitOutput(
      ["rev-parse", "--verify", `${baseRef}^{commit}`],
      this.repoRoot,
    );
    const ensured = this.options.store.ensureWorkspaceResource({
      resourceId,
      graphId: provision.graphId,
      provisionId: provision.provisionId,
      childSessionId: provision.childSessionId,
      repoRoot: this.repoRoot,
      worktreePath,
      branch,
      baseRef,
      baseCommit,
    }).record;
    const active = await this.adopt(ensured);
    return {
      workDir: active.worktreePath,
      sessionOptions: { runtimeStorageRoot: this.storageRoot },
      release: async (reason) => {
        if (reason === "provision-stopped") await this.cleanup(active.resourceId);
      },
    };
  }

  private async adopt(
    resource: AgentGraphWorkspaceResourceRecord,
  ): Promise<AgentGraphWorkspaceResourceRecord> {
    if (resource.state === "cleaned")
      throw new Error(`Workspace resource is already cleaned: ${resource.resourceId}`);
    if (resource.state === "retained") {
      await this.assertExactWorktree(resource);
      return resource;
    }
    if (!(await pathExists(resource.worktreePath))) {
      await mkdir(this.worktreeRoot, { recursive: true });
      await this.gitRun(
        [
          "worktree",
          "add",
          "--quiet",
          "-b",
          resource.branch,
          resource.worktreePath,
          resource.baseCommit,
        ],
        this.repoRoot,
      );
      await this.options.afterGitSideEffect?.("add", resource.resourceId);
    }
    await this.assertExactWorktree(resource);
    if (resource.state === "active") return resource;
    return this.options.store.transitionWorkspaceResource({
      resourceId: resource.resourceId,
      expectedVersion: resource.version,
      from: "requested",
      to: "active",
      baseCommit: resource.baseCommit,
    });
  }

  private async cleanup(resourceId: string): Promise<void> {
    let resource = this.options.store.getWorkspaceResource(resourceId);
    if (!resource || resource.state === "cleaned") return;
    if (resource.state === "requested") {
      resource = await this.adopt(resource);
    }
    if (!(await pathExists(resource.worktreePath))) {
      await this.deleteBranchIfSafe(resource);
      this.options.store.transitionWorkspaceResource({
        resourceId,
        expectedVersion: resource.version,
        from: resource.state,
        to: "cleaned",
      });
      return;
    }
    await this.assertExactWorktree(resource);
    const dirty =
      (await this.gitOutput(["status", "--porcelain"], resource.worktreePath)).length > 0;
    const head = await this.gitOutput(["rev-parse", "HEAD"], resource.worktreePath);
    const merged =
      head === resource.baseCommit ||
      (await this.gitRun(["merge-base", "--is-ancestor", head, "HEAD"], this.repoRoot, [0, 1]))
        .exitCode === 0;
    if (dirty || !merged) {
      if (resource.state === "active") {
        this.options.store.transitionWorkspaceResource({
          resourceId,
          expectedVersion: resource.version,
          from: "active",
          to: "retained",
          retainReason: dirty ? "worktree has uncommitted changes" : "branch has unmerged commits",
        });
      }
      return;
    }
    await this.gitRun(["worktree", "remove", resource.worktreePath], this.repoRoot);
    await this.options.afterGitSideEffect?.("remove", resource.resourceId);
    await this.deleteBranchIfSafe(resource);
    this.options.store.transitionWorkspaceResource({
      resourceId,
      expectedVersion: resource.version,
      from: resource.state,
      to: "cleaned",
    });
  }

  private async deleteBranchIfSafe(resource: AgentGraphWorkspaceResourceRecord): Promise<void> {
    const ref = `refs/heads/${resource.branch}`;
    const exists = await this.gitRun(["show-ref", "--verify", ref], this.repoRoot, [0, 1]);
    if (exists.exitCode === 1) return;
    const branchHead = await this.gitOutput(
      ["rev-parse", "--verify", `${ref}^{commit}`],
      this.repoRoot,
    );
    const merged =
      branchHead === resource.baseCommit ||
      (
        await this.gitRun(
          ["merge-base", "--is-ancestor", branchHead, "HEAD"],
          this.repoRoot,
          [0, 1],
        )
      ).exitCode === 0;
    if (!merged) throw new Error(`Graph worktree branch is not safe to delete: ${resource.branch}`);
    await this.gitRun(["update-ref", "-d", ref, branchHead], this.repoRoot);
  }

  private async assertRepository(): Promise<void> {
    const actual = await this.gitOutput(["rev-parse", "--show-toplevel"], this.repoRoot);
    if ((await realpath(actual)) !== (await realpath(this.repoRoot))) {
      throw new Error(`Graph worktree repo root mismatch: ${actual}`);
    }
  }

  private async assertExactWorktree(resource: AgentGraphWorkspaceResourceRecord): Promise<void> {
    if ((await realpath(resource.repoRoot)) !== (await realpath(this.repoRoot))) {
      throw new Error(`Graph worktree repository mismatch: ${resource.resourceId}`);
    }
    requireContained(this.worktreeRoot, resource.worktreePath, "stored worktreePath");
    const metadata = await lstat(resource.worktreePath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Graph worktree path is not a physical directory: ${resource.worktreePath}`);
    }
    const [actualRoot, actualBranch, actualHead, repoCommonDir, worktreeCommonDir] =
      await Promise.all([
        this.gitOutput(["rev-parse", "--show-toplevel"], resource.worktreePath),
        this.gitOutput(["branch", "--show-current"], resource.worktreePath),
        this.gitOutput(["rev-parse", "HEAD"], resource.worktreePath),
        this.gitOutput(["rev-parse", "--git-common-dir"], this.repoRoot),
        this.gitOutput(["rev-parse", "--git-common-dir"], resource.worktreePath),
      ]);
    const expectedCommonDir = await realpath(resolve(this.repoRoot, repoCommonDir));
    const actualCommonDir = await realpath(resolve(resource.worktreePath, worktreeCommonDir));
    if (
      (await realpath(actualRoot)) !== (await realpath(resource.worktreePath)) ||
      actualBranch !== resource.branch ||
      actualCommonDir !== expectedCommonDir ||
      (resource.state === "requested" && actualHead !== resource.baseCommit)
    ) {
      throw new Error(`Graph worktree identity mismatch: ${resource.resourceId}`);
    }
  }

  private gitOutput(args: readonly string[], cwd: string): Promise<string> {
    return this.gitRun(args, cwd).then(({ stdout }) => stdout.trim());
  }

  private gitRun(
    args: readonly string[],
    cwd: string,
    allowExitCodes: readonly number[] = [0],
  ): Promise<AgentGraphWorkspaceGitResult> {
    return this.git(args, { cwd, allowExitCodes });
  }
}

async function executeGit(
  args: readonly string[],
  options: { readonly cwd: string; readonly allowExitCodes?: readonly number[] },
): Promise<AgentGraphWorkspaceGitResult> {
  try {
    const result = await execFileAsync("git", [...args], {
      cwd: options.cwd,
      env: buildSafeGitEnvironment(),
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const value = error as Error & { stdout?: string; stderr?: string; code?: number };
    const exitCode = typeof value.code === "number" ? value.code : -1;
    if (options.allowExitCodes?.includes(exitCode)) {
      return { stdout: value.stdout ?? "", stderr: value.stderr ?? "", exitCode };
    }
    throw error;
  }
}

function isolatedBinding(value: unknown): { readonly baseRef?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record["kind"] !== "isolated-worktree") return undefined;
  return typeof record["baseRef"] === "string" ? { baseRef: record["baseRef"] } : {};
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function requireAbsolute(path: string, name: string): string {
  if (!isAbsolute(path)) throw new Error(`${name} must be absolute`);
  return resolve(path);
}

function requireContained(root: string, candidate: string, name: string): string {
  const normalizedRoot = resolve(root);
  const normalized = resolve(candidate);
  const offset = relative(normalizedRoot, normalized);
  if (!offset || offset.startsWith("..") || isAbsolute(offset)) {
    if (normalized !== normalizedRoot) throw new Error(`${name} escapes its managed root`);
    if (!offset) throw new Error(`${name} must not equal its managed root`);
  }
  return normalized;
}

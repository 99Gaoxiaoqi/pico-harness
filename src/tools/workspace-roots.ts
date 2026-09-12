import { realpathSync, statSync } from "node:fs";
import { realpath as realpathAsync, stat as statAsync } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolCall } from "../schema/message.js";
import type { RequestMiddleware } from "./registry.js";
import { bashCommandFromArgs, extractBashWritePaths } from "../approval/bash-paths.js";
import {
  canReadPath,
  canWritePath,
  isDeniedPath,
  isProtectedWritePath,
  type ManagedPermissionProfile,
} from "../safety/permission-profile.js";

const OUTSIDE_WORKSPACE_MESSAGE = "路径不在当前工作区。请先运行 /add-dir <directory> 授权该目录。";

export interface AddDirectoryResult {
  added: boolean;
  path: string;
  reason?: string;
}

export interface WorkspaceAccess {
  path: string;
  access: "read" | "write";
}

export interface AssertAllowedOptions {
  /**
   * 是否消耗一次性授权。写工具可先不消耗地校验父目录，
   * 完成 mkdir 后再校验并消耗，缩小符号链接竞态窗口。
   */
  consumeAuthorization?: boolean;
  /** Defaults to read; callers that can mutate must opt into write authority. */
  access?: WorkspaceAccess["access"];
}

export interface WorkspaceBoundaryEntry extends WorkspaceAccess {
  scope: "exact" | "subtree";
}

export class WorkspaceRoots {
  private readonly oneCallPaths = new Map<string, number>();
  private boundaryEntries: readonly WorkspaceBoundaryEntry[] = [];
  private boundaryProfile: ManagedPermissionProfile | undefined;
  private policyGeneration = 0;

  private constructor(
    private readonly primaryRoot: string,
    private readonly roots: string[],
  ) {}

  static async create(
    primaryRoot: string,
    additionalRoots: readonly string[] = [],
  ): Promise<WorkspaceRoots> {
    const normalizedPrimary = await normalizeDirectory(primaryRoot, process.cwd());
    const roots = new WorkspaceRoots(normalizedPrimary, [normalizedPrimary]);
    for (const additionalRoot of additionalRoots) {
      await roots.addDirectory(additionalRoot);
    }
    return roots;
  }

  /** 同步装配入口，供保持同步签名的默认工具注册表使用。 */
  static createSync(primaryRoot: string): WorkspaceRoots {
    const absolutePath = resolve(primaryRoot);
    let info;
    try {
      info = statSync(absolutePath);
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        throw new Error(`工作区目录不存在: ${absolutePath}`, { cause: error });
      }
      throw error;
    }
    if (!info.isDirectory()) {
      throw new Error(`工作区路径不是目录: ${absolutePath}`);
    }
    const normalizedPrimary = realpathSync.native(absolutePath);
    return new WorkspaceRoots(normalizedPrimary, [normalizedPrimary]);
  }

  /** Keep paths relative to the workspace while physically limiting access to branch roots. */
  static createScopedSync(primaryRoot: string, allowedRoots: readonly string[]): WorkspaceRoots {
    const workspace = WorkspaceRoots.createSync(primaryRoot);
    const scoped = [...new Set(allowedRoots.map((root) => workspace.resolveUnchecked(root)))];
    if (scoped.length === 0) throw new Error("子代理检索根不能为空");
    for (const root of scoped) {
      let info;
      try {
        info = statSync(root);
      } catch (error) {
        throw new Error(`子代理检索根不存在: ${root}`, { cause: error });
      }
      if ((!info.isDirectory() && !info.isFile()) || !workspace.isAllowed(root)) {
        throw new Error(`子代理检索根不在当前工作区: ${root}`);
      }
    }
    return new WorkspaceRoots(
      workspace.primaryRoot,
      scoped.map((root) => realpathSync.native(root)),
    );
  }

  list(): readonly string[] {
    return Object.freeze([...this.roots]);
  }

  processRoots(): readonly string[] {
    return Object.freeze([...new Set([...this.roots, ...this.oneCallPaths.keys()])]);
  }

  /** Replace the durable ExecutionBoundary projection without mutating configured roots. */
  replaceBoundaryEntries(entries: readonly WorkspaceBoundaryEntry[]): void {
    const next = Object.freeze(
      entries.map((entry) =>
        Object.freeze({
          path: this.resolveUnchecked(entry.path),
          access: entry.access,
          scope: entry.scope,
        }),
      ),
    );
    if (
      this.boundaryProfile === undefined &&
      JSON.stringify(next) === JSON.stringify(this.boundaryEntries)
    ) {
      return;
    }
    this.boundaryProfile = undefined;
    this.boundaryEntries = next;
    this.policyGeneration++;
  }

  /** Apply the complete managed profile to direct file tools without treating process tmp as workspace. */
  replaceBoundaryProfile(profile: ManagedPermissionProfile | undefined): void {
    const cloned = profile ? structuredClone(profile) : undefined;
    const next = cloned
      ? {
          ...cloned,
          fileSystem: {
            ...cloned.fileSystem,
            entries: cloned.fileSystem.entries.map((entry) =>
              entry.kind === "path" ? { ...entry, path: this.resolveUnchecked(entry.path) } : entry,
            ),
          },
        }
      : undefined;
    if (
      JSON.stringify(next) === JSON.stringify(this.boundaryProfile) &&
      (next !== undefined || this.boundaryEntries.length === 0)
    ) {
      return;
    }
    this.boundaryProfile = next;
    this.boundaryEntries = Object.freeze(
      (next?.fileSystem.entries ?? []).flatMap((entry) =>
        entry.kind === "path" && entry.access !== "deny"
          ? [
              Object.freeze({
                path: this.resolveUnchecked(entry.path),
                access: entry.access,
                scope: entry.match ?? "subtree",
              }),
            ]
          : [],
      ),
    );
    this.policyGeneration++;
  }

  boundarySnapshot(): readonly WorkspaceBoundaryEntry[] {
    return Object.freeze(this.boundaryEntries.map((entry) => Object.freeze({ ...entry })));
  }

  generation(): number {
    return this.policyGeneration;
  }

  async addDirectory(path: string): Promise<AddDirectoryResult> {
    const canonicalPath = await normalizeDirectory(path, this.primaryRoot);
    if (this.roots.includes(canonicalPath)) {
      return { added: false, path: canonicalPath };
    }
    if (this.roots.some((root) => isWithin(root, canonicalPath))) {
      return {
        added: false,
        path: canonicalPath,
        reason: "Directory is already covered by an authorized workspace root.",
      };
    }
    this.roots.push(canonicalPath);
    this.policyGeneration++;
    return { added: true, path: canonicalPath };
  }

  resolve(path: string, access: WorkspaceAccess["access"] = "read"): string {
    const target = this.resolveUnchecked(path);
    if (!this.isAllowed(target, access)) {
      throw outsideWorkspaceError(path);
    }
    return target;
  }

  resolveUnchecked(path: string): string {
    const lexicalTarget = isAbsolute(path) ? resolve(path) : resolve(this.primaryRoot, path);
    return canonicalizeTargetSync(lexicalTarget);
  }

  isAllowedPath(path: string, access: WorkspaceAccess["access"] = "read"): boolean {
    return this.isAllowed(this.resolveUnchecked(path), access);
  }

  directoryForPath(path: string): string {
    return dirname(this.resolveUnchecked(path));
  }

  async authorizationDirectoryForPath(path: string): Promise<string> {
    const target = this.resolveUnchecked(path);
    try {
      const info = await statAsync(target);
      return info.isDirectory() ? realpathAsync(target) : realpathAsync(dirname(target));
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT") && !hasErrnoCode(error, "ENOTDIR")) throw error;
      return realpathAsync(await nearestExistingAncestor(dirname(target)));
    }
  }

  async assertAllowed(path: string, options: AssertAllowedOptions = {}): Promise<string> {
    const target = this.resolveUnchecked(path);
    const requestedAccess = options.access ?? "read";
    if (this.isPolicyDenied(target, requestedAccess)) throw outsideWorkspaceError(path);
    let usedOneCallPermission = false;
    if (!this.isAllowed(target, requestedAccess)) {
      const authorization = [...this.oneCallPaths.keys()].find((root) => isWithin(root, target));
      const remaining = authorization ? (this.oneCallPaths.get(authorization) ?? 0) : 0;
      if (remaining <= 0) throw outsideWorkspaceError(path);
      usedOneCallPermission = true;
      if (options.consumeAuthorization !== false) {
        if (remaining === 1) this.oneCallPaths.delete(authorization!);
        else this.oneCallPaths.set(authorization!, remaining - 1);
      }
    }
    const existingAncestor = await nearestExistingAncestor(target);
    const canonicalAncestor = await realpathAsync(existingAncestor);
    const canonicalTarget = resolve(canonicalAncestor, relative(existingAncestor, target));
    if (!this.isAllowed(canonicalTarget, requestedAccess) && !usedOneCallPermission) {
      throw outsideWorkspaceError(path);
    }
    return canonicalTarget;
  }

  authorizeOnce(path: string): string {
    const target = this.resolveUnchecked(path);
    this.oneCallPaths.set(target, (this.oneCallPaths.get(target) ?? 0) + 1);
    return target;
  }

  consumeAllProcessAuthorizations(): void {
    for (const [root, count] of [...this.oneCallPaths]) {
      if (count <= 1) this.oneCallPaths.delete(root);
      else this.oneCallPaths.set(root, count - 1);
    }
  }

  private isAllowed(path: string, access: WorkspaceAccess["access"] = "read"): boolean {
    if (this.boundaryProfile) {
      const directFileProfile = directFilePermissionProfile(this.boundaryProfile);
      const context = this.boundaryMatchContext();
      return access === "write"
        ? canWritePath(directFileProfile, path, context)
        : canReadPath(directFileProfile, path, context);
    }
    if (this.roots.some((root) => isWithin(root, path))) return true;
    return this.boundaryEntries.some(
      (entry) =>
        (access === "read" || entry.access === "write") &&
        (entry.scope === "exact" ? entry.path === path : isWithin(entry.path, path)),
    );
  }

  private isPolicyDenied(path: string, access: WorkspaceAccess["access"]): boolean {
    if (!this.boundaryProfile) return false;
    const context = this.boundaryMatchContext();
    return (
      isDeniedPath(this.boundaryProfile, path, context) ||
      (access === "write" && isProtectedWritePath(this.boundaryProfile, path, context))
    );
  }

  private boundaryMatchContext() {
    return { root: this.primaryRoot, workspaceRoots: this.roots };
  }
}

/** tmp/minimal are process-runtime support paths, not implicit direct-file authority. */
function directFilePermissionProfile(profile: ManagedPermissionProfile): ManagedPermissionProfile {
  if (profile.fileSystem.kind === "unrestricted") return profile;
  return {
    ...profile,
    fileSystem: {
      ...profile.fileSystem,
      entries: profile.fileSystem.entries.filter(
        (entry) =>
          entry.kind === "path" ||
          entry.special === ":workspace_roots" ||
          entry.special === ":root",
      ),
    },
  };
}

export function buildWorkspaceBoundaryMiddleware(roots: WorkspaceRoots): RequestMiddleware {
  return async (call) => {
    for (const access of workspaceAccessesFromCall(call)) {
      try {
        await roots.assertAllowed(access.path, { access: access.access });
      } catch (error) {
        return {
          allowed: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return { allowed: true };
  };
}

async function normalizeDirectory(path: string, relativeTo: string): Promise<string> {
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(relativeTo, path);
  let info;
  try {
    info = await statAsync(absolutePath);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      throw new Error(`工作区目录不存在: ${absolutePath}`, { cause: error });
    }
    throw error;
  }
  if (!info.isDirectory()) {
    throw new Error(`工作区路径不是目录: ${absolutePath}`);
  }
  return realpathAsync(absolutePath);
}

async function nearestExistingAncestor(path: string): Promise<string> {
  let candidate = path;
  while (true) {
    try {
      await statAsync(candidate);
      return candidate;
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT") && !hasErrnoCode(error, "ENOTDIR")) {
        throw error;
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw error;
      }
      candidate = parent;
    }
  }
}

export function workspaceAccessesFromCall(call: ToolCall): WorkspaceAccess[] {
  if (call.name === "bash") {
    const command = bashCommandFromArgs(call.arguments);
    return command
      ? extractBashWritePaths(command).map((path) => ({ path, access: "write" as const }))
      : [];
  }
  if (!WORKSPACE_PATH_TOOLS.has(call.name)) return [];
  let input: unknown;
  try {
    input = JSON.parse(call.arguments) as unknown;
  } catch {
    return [];
  }
  if (typeof input !== "object" || input === null) {
    return [];
  }
  const path = (input as Record<string, unknown>)["path"];
  if (typeof path === "string") {
    return [{ path: path || ".", access: READ_ONLY_PATH_TOOLS.has(call.name) ? "read" : "write" }];
  }
  return call.name === "glob" || call.name === "grep" ? [{ path: ".", access: "read" }] : [];
}

const WORKSPACE_PATH_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "glob",
  "grep",
]);

const READ_ONLY_PATH_TOOLS: ReadonlySet<string> = new Set(["read_file", "glob", "grep"]);

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function canonicalizeTargetSync(path: string): string {
  let candidate = path;
  while (true) {
    try {
      statSync(candidate);
      // promises.realpath 使用原生解析；同步入口也必须使用 native，避免 Windows
      // 的 8.3、subst 与长路径别名在两次安全校验中得到不同表示。
      const canonicalAncestor = realpathSync.native(candidate);
      return resolve(canonicalAncestor, relative(candidate, path));
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT") && !hasErrnoCode(error, "ENOTDIR")) {
        throw error;
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw error;
      }
      candidate = parent;
    }
  }
}

function outsideWorkspaceError(path: string): Error {
  return new Error(`路径越界: ${OUTSIDE_WORKSPACE_MESSAGE} 请求路径: ${path}`);
}

function hasErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

import { realpathSync, statSync } from "node:fs";
import { realpath as realpathAsync, stat as statAsync } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolCall } from "../schema/message.js";
import type { RequestMiddleware } from "./registry.js";
import { bashCommandFromArgs, extractBashWritePaths } from "../approval/bash-paths.js";

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

export class WorkspaceRoots {
  private readonly oneCallPaths = new Map<string, number>();

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
    const normalizedPrimary = realpathSync(absolutePath);
    return new WorkspaceRoots(normalizedPrimary, [normalizedPrimary]);
  }

  list(): readonly string[] {
    return Object.freeze([...this.roots]);
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
    return { added: true, path: canonicalPath };
  }

  resolve(path: string): string {
    const target = this.resolveUnchecked(path);
    if (!this.isAllowed(target)) {
      throw outsideWorkspaceError(path);
    }
    return target;
  }

  resolveUnchecked(path: string): string {
    const lexicalTarget = isAbsolute(path) ? resolve(path) : resolve(this.primaryRoot, path);
    return canonicalizeTargetSync(lexicalTarget);
  }

  isAllowedPath(path: string): boolean {
    return this.isAllowed(this.resolveUnchecked(path));
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

  async assertAllowed(path: string): Promise<string> {
    const target = this.resolveUnchecked(path);
    let usedOneCallPermission = false;
    if (!this.isAllowed(target)) {
      const remaining = this.oneCallPaths.get(target) ?? 0;
      if (remaining <= 0) throw outsideWorkspaceError(path);
      usedOneCallPermission = true;
      if (remaining === 1) this.oneCallPaths.delete(target);
      else this.oneCallPaths.set(target, remaining - 1);
    }
    const existingAncestor = await nearestExistingAncestor(target);
    const canonicalAncestor = await realpathAsync(existingAncestor);
    if (!this.isAllowed(canonicalAncestor) && !usedOneCallPermission) {
      throw outsideWorkspaceError(path);
    }
    return target;
  }

  authorizeOnce(path: string): string {
    const target = this.resolveUnchecked(path);
    this.oneCallPaths.set(target, (this.oneCallPaths.get(target) ?? 0) + 1);
    return target;
  }

  private isAllowed(path: string): boolean {
    return this.roots.some((root) => isWithin(root, path));
  }
}

export function buildWorkspaceBoundaryMiddleware(roots: WorkspaceRoots): RequestMiddleware {
  return async (call) => {
    for (const access of workspaceAccessesFromCall(call)) {
      try {
        await roots.assertAllowed(access.path);
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
      const canonicalAncestor = realpathSync(candidate);
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

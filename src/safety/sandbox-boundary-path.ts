import { realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  compactSandboxBoundaryFilesystemEntries,
  validateSandboxBoundaryExpansion,
  type SandboxBoundaryExpansion,
  type SandboxBoundaryFilesystemEntry,
} from "./permission-profile.js";

/**
 * Canonicalize a model-declared expansion before it becomes authority.
 * Subtrees must already be directories. An exact missing file is allowed only
 * when its immediate parent exists, so authorization cannot implicitly create
 * an otherwise unauthorized directory tree.
 */
export async function canonicalizeSandboxBoundaryExpansion(
  input: unknown,
): Promise<SandboxBoundaryExpansion> {
  const validated = validateSandboxBoundaryExpansion(input);
  if (!validated.ok) throw new Error(validated.message);

  const entries = await Promise.all(
    (validated.expansion.filesystem?.entries ?? []).map(canonicalizeEntry),
  );
  return {
    ...(entries.length > 0
      ? { filesystem: { entries: compactSandboxBoundaryFilesystemEntries(entries) } }
      : {}),
    ...(validated.expansion.network ? { network: { enabled: true as const } } : {}),
  };
}

async function canonicalizeEntry(
  entry: SandboxBoundaryFilesystemEntry,
): Promise<SandboxBoundaryFilesystemEntry> {
  if (entry.scope === "subtree") {
    const info = await stat(entry.path).catch((error: unknown) => {
      throw new Error(`Sandbox boundary subtree does not exist: ${entry.path}`, { cause: error });
    });
    if (!info.isDirectory()) {
      throw new Error(`Sandbox boundary subtree must be a directory: ${entry.path}`);
    }
    return { ...entry, path: await realpath(entry.path) };
  }

  try {
    return { ...entry, path: await realpath(entry.path) };
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT") && !hasErrnoCode(error, "ENOTDIR")) throw error;
    const parent = dirname(entry.path);
    const parentInfo = await stat(parent).catch((parentError: unknown) => {
      throw new Error(`Sandbox boundary exact-path parent does not exist: ${parent}`, {
        cause: parentError,
      });
    });
    if (!parentInfo.isDirectory()) {
      throw new Error(`Sandbox boundary exact-path parent must be a directory: ${parent}`, {
        cause: error,
      });
    }
    return { ...entry, path: resolve(await realpath(parent), basename(entry.path)) };
  }
}

function hasErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

import { access, lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, normalize, resolve } from "node:path";
import type { HookHandler } from "../types.js";

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface ReferencedPackageScript {
  readonly manager: PackageManager;
  readonly scriptName: string;
  readonly manifestPath: string;
  readonly canonicalManifestPath: string;
  readonly state: "missing" | "unreadable" | "invalid" | "resolved";
  readonly definitions: Readonly<Record<string, string | null>>;
}

export interface ReferencedScriptResolution {
  readonly paths: readonly string[];
  readonly watchPaths: readonly string[];
  readonly packageScripts: readonly ReferencedPackageScript[];
}

/**
 * Resolve only explicit script references. Package-manager commands are read, never executed,
 * and resolution is deliberately limited to the workspace package.json and its direct files.
 */
export async function resolveReferencedScripts(
  handler: HookHandler,
  workspace: string,
): Promise<ReferencedScriptResolution> {
  if (handler.type !== "command") return { paths: [], watchPaths: [], packageScripts: [] };
  const paths = [...resolveReferencedScriptCandidates(handler, workspace)];
  const invocation = packageRunInvocation(commandTokens(handler));
  const packageScripts: ReferencedPackageScript[] = [];
  if (invocation) {
    const resolved = await resolvePackageScript(invocation, workspace);
    packageScripts.push(resolved.reference);
    paths.push(...resolved.paths);
  }
  const uniquePaths = sortedUnique(paths);
  const canonicalPaths = await canonicalExistingPaths(uniquePaths);
  return {
    paths: uniquePaths,
    watchPaths: sortedUnique([
      ...uniquePaths,
      ...canonicalPaths,
      ...packageScripts.flatMap((entry) => [entry.manifestPath, entry.canonicalManifestPath]),
    ]),
    packageScripts,
  };
}

/** Preserve the original direct-path behavior for callers that only need lexical candidates. */
export function resolveReferencedScriptCandidates(
  handler: HookHandler,
  workspace: string,
): readonly string[] {
  if (handler.type !== "command") return [];
  return referencedPathCandidates(commandTokens(handler), workspace);
}

export async function existingReferencedScripts(
  handler: HookHandler,
  workspace: string,
): Promise<readonly string[]> {
  const { paths } = await resolveReferencedScripts(handler, workspace);
  const existing: string[] = [];
  for (const path of paths) {
    if (
      await access(path).then(
        () => true,
        () => false,
      )
    ) {
      existing.push(await realpath(path));
    }
  }
  return sortedUnique(existing);
}

interface PackageRunInvocation {
  readonly manager: PackageManager;
  readonly scriptName: string;
}

async function resolvePackageScript(
  invocation: PackageRunInvocation,
  workspace: string,
): Promise<{ reference: ReferencedPackageScript; paths: readonly string[] }> {
  const manifestPath = normalize(resolve(workspace, "package.json"));
  let canonicalManifestPath = manifestPath;
  let raw: string;
  try {
    const stat = await lstat(manifestPath);
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      return packageResolution(invocation, manifestPath, canonicalManifestPath, "invalid");
    }
    canonicalManifestPath = await realpath(manifestPath);
    raw = await readFile(canonicalManifestPath, "utf8");
  } catch (error) {
    return packageResolution(
      invocation,
      manifestPath,
      canonicalManifestPath,
      isErrno(error, "ENOENT") ? "missing" : "unreadable",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return packageResolution(invocation, manifestPath, canonicalManifestPath, "invalid");
  }
  if (!isRecord(parsed)) {
    return packageResolution(invocation, manifestPath, canonicalManifestPath, "resolved");
  }
  const scripts = parsed.scripts;
  if (!isRecord(scripts)) {
    return packageResolution(invocation, manifestPath, canonicalManifestPath, "resolved");
  }

  const lifecycleNames = [
    `pre${invocation.scriptName}`,
    invocation.scriptName,
    `post${invocation.scriptName}`,
  ];
  const definitions = Object.fromEntries(
    lifecycleNames.map((name) => {
      const definition = scripts[name];
      return [name, typeof definition === "string" ? definition : null];
    }),
  );
  const paths = Object.values(definitions).flatMap((definition) =>
    definition === null
      ? []
      : referencedPathCandidates(shellWords(definition), dirname(manifestPath)),
  );
  return {
    reference: {
      ...invocation,
      manifestPath,
      canonicalManifestPath,
      state: "resolved",
      definitions,
    },
    paths: sortedUnique(paths),
  };
}

function packageResolution(
  invocation: PackageRunInvocation,
  manifestPath: string,
  canonicalManifestPath: string,
  state: ReferencedPackageScript["state"],
): { reference: ReferencedPackageScript; paths: readonly string[] } {
  return {
    reference: {
      ...invocation,
      manifestPath,
      canonicalManifestPath,
      state,
      definitions: {},
    },
    paths: [],
  };
}

function packageRunInvocation(tokens: readonly string[]): PackageRunInvocation | undefined {
  const executable = tokens[0];
  const action = tokens[1];
  const scriptName = tokens[2];
  if (!executable || !action || !scriptName || scriptName.startsWith("-")) return undefined;
  const manager = packageManager(executable);
  if (!manager) return undefined;
  if (manager === "npm") {
    if (action !== "run" && action !== "run-script") return undefined;
  } else if (action !== "run") {
    return undefined;
  }
  return { manager, scriptName };
}

function packageManager(executable: string): PackageManager | undefined {
  const name = basename(executable)
    .toLowerCase()
    .replace(/\.cmd$/u, "");
  return name === "npm" || name === "pnpm" || name === "yarn" || name === "bun" ? name : undefined;
}

function commandTokens(handler: Extract<HookHandler, { type: "command" }>): readonly string[] {
  return handler.args ? [handler.command, ...handler.args] : shellWords(handler.command);
}

function referencedPathCandidates(tokens: readonly string[], basePath: string): readonly string[] {
  return sortedUnique(tokens.filter(looksLikePath).map((token) => resolve(basePath, token)));
}

function shellWords(command: string): string[] {
  return (
    command
      .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
      ?.map((part) => part.replace(/^(['"])(.*)\1$/u, "$2")) ?? []
  );
}

function looksLikePath(value: string): boolean {
  return (
    isAbsolute(value) ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    /\.(?:sh|bash|zsh|js|mjs|cjs|ts|py|rb|pl)$/u.test(value)
  );
}

async function canonicalExistingPaths(paths: readonly string[]): Promise<readonly string[]> {
  const canonical: string[] = [];
  for (const path of paths) {
    try {
      canonical.push(await realpath(path));
    } catch {
      // The logical path is still watched. Trust hashing handles unreadable files fail-closed.
    }
  }
  return sortedUnique(canonical);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

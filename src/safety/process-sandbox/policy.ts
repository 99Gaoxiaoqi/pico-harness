import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  SandboxConfig,
  SandboxNetworkPolicy,
  SandboxPolicy,
  SandboxProfile,
} from "./types.js";
import { DEFAULT_SANDBOX_CONFIG } from "./types.js";

export interface CreateSandboxPolicyOptions {
  profile: SandboxProfile;
  workspaceRoots: readonly string[];
  scratchRoot: string;
  readRoots?: readonly string[];
  writeRoots?: readonly string[];
  readFiles?: readonly string[];
  writeFiles?: readonly string[];
  config?: Partial<SandboxConfig>;
  generation?: number;
}

export function createSandboxPolicy(options: CreateSandboxPolicyOptions): SandboxPolicy {
  const profile = options.profile;
  const config = { ...DEFAULT_SANDBOX_CONFIG, ...options.config };
  let scratchRoot = resolve(options.scratchRoot);
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  scratchRoot = canonicalize(scratchRoot);
  const workspaceRoots = normalizeRoots(options.workspaceRoots);
  const explicitReadRoots = normalizeRoots(options.readRoots ?? []);
  const explicitWriteRoots = normalizeRoots(options.writeRoots ?? []);
  const writeRoots = normalizeRoots([
    ...(profile === "workspace-write" ? workspaceRoots : []),
    ...explicitWriteRoots,
    scratchRoot,
  ]);
  const readRoots = normalizeRoots([...explicitReadRoots, ...workspaceRoots, ...writeRoots]);
  const writeFiles = normalizeExactPaths(options.writeFiles ?? []).filter(
    (path) => !writeRoots.some((root) => isWithinRoot(root, path)),
  );
  const writeFileSet = new Set(writeFiles);
  const readFiles = normalizeExactPaths(options.readFiles ?? []).filter(
    (path) => !writeFileSet.has(path) && !readRoots.some((root) => isWithinRoot(root, path)),
  );
  const network: SandboxNetworkPolicy =
    profile === "danger-full-access"
      ? "allow"
      : profile === "read-only"
        ? (options.config?.network ?? "deny")
        : config.network;
  return Object.freeze({
    profile,
    network,
    readRoots: Object.freeze(readRoots),
    writeRoots: Object.freeze(writeRoots),
    ...(readFiles.length > 0 ? { readFiles: Object.freeze(readFiles) } : {}),
    ...(writeFiles.length > 0 ? { writeFiles: Object.freeze(writeFiles) } : {}),
    scratchRoot,
    generation: options.generation ?? 0,
  });
}

function normalizeExactPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map(canonicalize))].sort();
}

export function defaultSandboxScratchRoot(cwd: string): string {
  const scope = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
  return resolve(tmpdir(), "pico-process-sandbox", scope);
}

export function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function normalizeRoots(roots: readonly string[]): string[] {
  const normalized = [...new Set(roots.map(canonicalize))].sort(
    (left, right) => left.length - right.length,
  );
  return normalized.filter(
    (root, index) => !normalized.slice(0, index).some((parent) => isWithinRoot(parent, root)),
  );
}

function canonicalize(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

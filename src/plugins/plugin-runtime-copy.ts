import { cp, chmod, mkdir, mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { resolvePluginContributions } from "./plugin-resolver.js";
import type { PluginContributionSet, PluginResourceFingerprint } from "./plugin-types.js";

export interface VerifiedPluginRuntimeCopyOptions {
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly expectedPluginId: string;
  readonly expectedFingerprint: PluginResourceFingerprint;
}

/**
 * Copy an installed plugin into a host-private tree and verify the complete copied tree before use.
 * Runtime consumers only receive paths resolved from this detached copy.
 */
export async function createVerifiedPluginRuntimeCopy(
  options: VerifiedPluginRuntimeCopyOptions,
): Promise<PluginContributionSet> {
  const sourceRoot = await realpath(resolve(options.sourceRoot));
  await cp(sourceRoot, options.destinationRoot, {
    recursive: true,
    dereference: true,
    errorOnExist: true,
    force: false,
    filter(source) {
      const logical = relative(sourceRoot, source);
      return !logical.split(sep).includes(".git");
    },
  });

  const contributions = await resolvePluginContributions(options.destinationRoot);
  if (contributions.plugin.id !== options.expectedPluginId) {
    throw new Error(
      `Plugin identity changed while creating runtime snapshot: expected ${options.expectedPluginId}, got ${contributions.plugin.id}`,
    );
  }
  if (contributions.compatibility === "blocked" || !contributions.fingerprint) {
    throw new Error(
      contributions.diagnostics.find((item) => item.compatibility === "blocked")?.message ??
        "Copied Plugin runtime resources are invalid",
    );
  }
  if (!sameFingerprint(contributions.fingerprint, options.expectedFingerprint)) {
    throw new Error("Plugin content changed while creating runtime snapshot");
  }

  await sealTree(options.destinationRoot);
  return contributions;
}

export async function createPluginRuntimeHostRoot(parent: string): Promise<string> {
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(parent, "host-"));
  await chmod(root, 0o700);
  return root;
}

export async function removePluginRuntimeHostRoot(root: string): Promise<void> {
  await makeTreeRemovable(root).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

export function runtimeCopyDirectoryName(pluginId: string, scope: string): string {
  const safeId = pluginId
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return `${scope}-${safeId || basename(pluginId) || "plugin"}`;
}

function sameFingerprint(
  actual: PluginResourceFingerprint,
  expected: PluginResourceFingerprint,
): boolean {
  return (
    actual.algorithm === expected.algorithm &&
    actual.digest === expected.digest &&
    actual.fileCount === expected.fileCount &&
    actual.totalBytes === expected.totalBytes
  );
}

async function sealTree(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await sealTree(child);
    else {
      const info = await stat(child);
      await chmod(child, info.mode & 0o111 ? 0o500 : 0o400);
    }
  }
  await chmod(path, 0o500);
}

async function makeTreeRemovable(path: string): Promise<void> {
  await chmod(path, 0o700).catch(() => undefined);
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await makeTreeRemovable(child);
    else await chmod(child, 0o600).catch(() => undefined);
  }
}

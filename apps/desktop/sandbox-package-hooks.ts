import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ForgeHookMap } from "@electron-forge/shared-types";

/** Validate both the build inputs and the actual copied resources; never publish a partial sandbox. */
export function sandboxPackageHooks(sourceRoot: string, outputRoot: string) {
  return {
    prePackage: async (_config, platform, arch) => {
      await verifySandbox(sourceRoot, platform, arch);
      await verifyFileWorker(join(dirname(sourceRoot), "file-worker"));
      if (platform === "darwin")
        await verifyComputerUse(join(dirname(sourceRoot), "computer-use"), arch);
    },
    postPackage: async (_config, { platform, arch, outputPaths }) => {
      for (const outputPath of outputPaths) {
        const resourceRoot =
          platform === "darwin"
            ? join(outputPath, "Pico.app", "Contents", "Resources")
            : join(outputPath, "resources");
        await verifySandbox(join(resourceRoot, "sandbox"), platform, arch);
        await verifyFileWorker(join(resourceRoot, "file-worker"));
        if (platform === "darwin") {
          await verifyComputerUse(join(resourceRoot, "computer-use"), arch);
        }
      }
    },
    preMake: async () => {
      // Forge's --skip-package path does not run postPackage. Recheck existing inputs too.
      const entries = await readdir(outputRoot, { withFileTypes: true });
      for (const entry of entries) {
        const target = /^Pico-(win32|linux)-(.+)$/u.exec(entry.name);
        if (!entry.isDirectory() || !target) continue;
        await verifySandbox(
          join(outputRoot, entry.name, "resources", "sandbox"),
          target[1]!,
          target[2]!,
        );
        await verifyFileWorker(join(outputRoot, entry.name, "resources", "file-worker"));
      }
    },
  } satisfies ForgeHookMap;
}

async function verifyFileWorker(root: string): Promise<void> {
  for (const filename of ["file-worker.mjs", "windows-file-commit-entry.mjs"]) {
    const entry = join(root, filename);
    await access(entry, constants.F_OK);
    const expected = (await readFile(`${entry}.sha256`, "utf8")).trim().split(/\s/u)[0];
    const actual = createHash("sha256")
      .update(await readFile(entry))
      .digest("hex");
    if (!expected || expected !== actual) {
      throw new Error(`Desktop File Worker resource SHA-256 mismatch: ${entry}`);
    }
  }
}

async function verifyComputerUse(root: string, arch: string): Promise<void> {
  if (arch !== "arm64" && arch !== "x64")
    throw new Error(`Unsupported macOS Computer Use target: ${arch}`);
  const executable = join(root, `darwin-${arch}`, "pico-computer-use");
  await access(executable, constants.X_OK);
  const expected = (await readFile(`${executable}.sha256`, "utf8")).trim().split(/\s/u)[0];
  const actual = createHash("sha256")
    .update(await readFile(executable))
    .digest("hex");
  if (!expected || expected !== actual)
    throw new Error("macOS Computer Use resource SHA-256 mismatch");
}

async function verifySandbox(root: string, platform: string, arch: string): Promise<void> {
  // macOS uses the system sandbox rather than a bundled executable.
  if (platform === "darwin" || platform === "mas") return;
  const targets =
    platform === "win32"
      ? ["pico-appcontainer-broker.exe", "pico-appcontainer-host-prep.exe"]
      : platform === "linux"
        ? ["bwrap"]
        : [];
  if (!targets.length || arch === "all")
    throw new Error(`Unsupported sandbox target: ${platform}-${arch}`);
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as {
    version?: number;
    windows?: { broker?: string; hostPrep?: string; architectures?: string[] };
    linux?: { architectures?: string[] };
  };
  if (
    manifest.version !== 1 ||
    !(platform === "win32" ? manifest.windows : manifest.linux)?.architectures?.includes(arch)
  ) {
    throw new Error(`Unsupported sandbox manifest target: ${platform}-${arch}`);
  }
  if (
    platform === "win32" &&
    (manifest.windows?.broker !== targets[0] || manifest.windows?.hostPrep !== targets[1])
  ) {
    throw new Error("Invalid Windows sandbox manifest");
  }
  for (const name of targets) {
    const executable = join(root, `${platform}-${arch}`, name);
    try {
      await access(executable, platform === "win32" ? constants.F_OK : constants.X_OK);
      const expected = (await readFile(`${executable}.sha256`, "utf8")).trim().split(/\s/u)[0];
      const actual = createHash("sha256")
        .update(await readFile(executable))
        .digest("hex");
      if (!expected || actual !== expected) throw new Error("SHA-256 mismatch");
    } catch (cause) {
      throw new Error(
        `Desktop sandbox resource missing or invalid: ${executable}. Build and verify the target sandbox before packaging.`,
        { cause },
      );
    }
  }
}

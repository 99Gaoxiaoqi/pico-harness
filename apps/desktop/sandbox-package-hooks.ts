import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ForgeHookMap } from "@electron-forge/shared-types";

/** Validate both the build inputs and the actual copied resources; never publish a partial sandbox. */
export function sandboxPackageHooks(sourceRoot: string, outputRoot: string) {
  return {
    prePackage: async (_config, platform, arch) => {
      await verifySandbox(sourceRoot, platform, arch);
    },
    postPackage: async (_config, { platform, arch, outputPaths }) => {
      for (const outputPath of outputPaths) {
        await verifySandbox(join(outputPath, "resources", "sandbox"), platform, arch);
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
      }
    },
  } satisfies ForgeHookMap;
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

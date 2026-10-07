import { chmodSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const runtimePackages = [
  "fs-native-extensions",
  "require-addon",
  "which-runtime",
  "bare-addon-resolve",
  "bare-module-resolve",
  "bare-semver",
  "node-pty",
  "node-addon-api",
  "web-tree-sitter",
] as const;

export function copyDesktopRuntimeResources(
  desktopRoot: string,
  buildRoot = resolve(desktopRoot, ".vite/build"),
): void {
  const targetRoot = resolve(buildRoot, "node_modules");
  mkdirSync(targetRoot, { recursive: true });
  for (const packageName of runtimePackages) {
    const source = resolve(desktopRoot, "../../node_modules", packageName);
    const target = resolve(targetRoot, packageName);
    rmSync(target, { recursive: true, force: true });
    cpSync(source, target, { recursive: true, dereference: true });
  }
  if (process.platform !== "win32") {
    for (const helper of [
      resolve(
        targetRoot,
        "node-pty/prebuilds",
        `${process.platform}-${process.arch}`,
        "spawn-helper",
      ),
      resolve(targetRoot, "node-pty/build/Release/spawn-helper"),
    ]) {
      try {
        chmodSync(helper, 0o755);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  // Both desktop CJS entries resolve ../assets/bash during development.
  const grammarTarget = resolve(buildRoot, "../assets/bash");
  rmSync(grammarTarget, { recursive: true, force: true });
  cpSync(resolve(desktopRoot, "../../packages/runtime/assets/bash"), grammarTarget, {
    recursive: true,
    dereference: true,
  });
}

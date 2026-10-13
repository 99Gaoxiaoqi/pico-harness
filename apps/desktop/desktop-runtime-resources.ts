import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { buildSync } from "esbuild";

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
  copyDocumentAttachmentWorker(desktopRoot, buildRoot);
  copyExecutionLearningReporter(desktopRoot, buildRoot);
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

/** The bundled Host resolves this fixed ESM reporter beside main.cjs/daemon.cjs. */
export function copyExecutionLearningReporter(
  desktopRoot: string,
  buildRoot = resolve(desktopRoot, ".vite/build"),
): void {
  mkdirSync(buildRoot, { recursive: true });
  buildSync({
    entryPoints: [
      resolve(desktopRoot, "../../packages/pico-host/src/execution-learning-reporter.ts"),
    ],
    outfile: resolve(buildRoot, "execution-learning-reporter.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "warning",
  });
  cpSync(
    resolve(buildRoot, "execution-learning-reporter.js"),
    resolve(buildRoot, "execution-learning-reporter.mjs"),
  );
}

/** Keep the parse worker independently terminable after the daemon is bundled as CommonJS. */
export function copyDocumentAttachmentWorker(
  desktopRoot: string,
  buildRoot = resolve(desktopRoot, ".vite/build"),
): void {
  mkdirSync(buildRoot, { recursive: true });
  buildSync({
    entryPoints: [
      resolve(desktopRoot, "../../packages/pico-host/src/input/document-attachment-worker.ts"),
    ],
    outfile: resolve(buildRoot, "document-attachment-worker.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["pdfjs-dist"],
    define: { "import.meta.url": "__picoDocumentWorkerUrl" },
    banner: {
      js: 'const __picoDocumentWorkerUrl = require("node:url").pathToFileURL(__filename).href;',
    },
    logLevel: "warning",
  });
  // PDF.js locates its own pdf.worker.mjs and optional native canvas by package-relative paths.
  const dependencies = resolve(desktopRoot, "../../node_modules");
  const packages = ["pdfjs-dist"];
  const napiRoot = resolve(dependencies, "@napi-rs");
  if (existsSync(napiRoot))
    packages.push(
      ...readdirSync(napiRoot)
        .filter((name) => name === "canvas" || name.startsWith("canvas-"))
        .map((name) => `@napi-rs/${name}`),
    );
  for (const packageName of packages) {
    const target = resolve(buildRoot, "node_modules", packageName);
    rmSync(target, { recursive: true, force: true });
    cpSync(resolve(dependencies, packageName), target, { recursive: true, dereference: true });
  }
}

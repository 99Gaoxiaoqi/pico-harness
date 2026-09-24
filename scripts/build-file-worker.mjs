import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const repositoryRoot = resolve(import.meta.dirname, "..");
const outputDirectory = join(repositoryRoot, "resources", "file-worker");
const outputPath = join(outputDirectory, "file-worker.mjs");

await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [join(repositoryRoot, "packages", "pico-host", "src", "file-worker-main.ts")],
  outfile: outputPath,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "bundle",
  legalComments: "none",
  logLevel: "warning",
});
const digest = createHash("sha256")
  .update(await readFile(outputPath))
  .digest("hex");
await writeFile(`${outputPath}.sha256`, `${digest}  file-worker.mjs\n`, { mode: 0o644 });
console.log(`Built File Worker: ${outputPath} (${digest})`);

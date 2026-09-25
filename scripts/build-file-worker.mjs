import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const repositoryRoot = resolve(import.meta.dirname, "..");
const outputDirectory = join(repositoryRoot, "resources", "file-worker");

await mkdir(outputDirectory, { recursive: true });
for (const [source, filename] of [
  ["file-worker-main.ts", "file-worker.mjs"],
  ["process-sandbox/windows-file-commit-entry.ts", "windows-file-commit-entry.mjs"],
]) {
  const outputPath = join(outputDirectory, filename);
  await build({
    entryPoints: [join(repositoryRoot, "packages", "pico-host", "src", source)],
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
  await writeFile(`${outputPath}.sha256`, `${digest}  ${filename}\n`, { mode: 0o644 });
  console.log(`Built ${filename}: ${outputPath} (${digest})`);
}

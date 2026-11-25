import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const listOnly = args.includes("--list");
const windowsOnly = args.includes("--windows");
let shard;
const filters = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--list" || arg === "--windows") continue;
  const value =
    arg === "--shard" ? args[++index] : arg.startsWith("--shard=") ? arg.slice(8) : undefined;
  if (value !== undefined) {
    const match = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(value ?? "");
    const indexNumber = Number(match?.[1]);
    const total = Number(match?.[2]);
    if (!match || indexNumber > total) {
      console.error("Invalid --shard value; expected i/N with 1 <= i <= N.");
      process.exit(2);
    }
    shard = { index: indexNumber, total };
    continue;
  }
  if (arg.startsWith("--")) {
    console.error(
      "Usage: node scripts/run-integration-tests.mjs [--list] [--windows] [--shard i/N] [path-or-name ...]",
    );
    process.exit(2);
  }
  filters.push(arg);
}

function discover(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return discover(path);
    return entry.isFile() && /\.test\.tsx?$/.test(entry.name)
      ? [relative(root, path).replaceAll("\\", "/")]
      : [];
  });
}

/** Static test() count balances shards better than file count alone. */
function testWeight(file) {
  try {
    return (readFileSync(join(root, file), "utf8").match(/\btest\s*\(/gu)?.length ?? 0) + 1;
  } catch {
    return 1;
  }
}

function selectShard(files, { index, total }) {
  const weighted = files
    .map((file) => ({ file, weight: testWeight(file) }))
    .sort((left, right) => right.weight - left.weight || left.file.localeCompare(right.file));
  const buckets = Array.from({ length: total }, () => ({ files: [], weight: 0 }));
  for (const item of weighted) {
    let target = buckets[0];
    for (const bucket of buckets) if (bucket.weight < target.weight) target = bucket;
    target.files.push(item.file);
    target.weight += item.weight;
  }
  const selected = buckets[index - 1];
  return {
    files: selected.files.sort(),
    weight: selected.weight,
    totalWeight: weighted.reduce((sum, item) => sum + item.weight, 0),
  };
}

const files = discover(join(root, "tests/integration"))
  .filter((path) => path.startsWith("tests/integration/windows/") === windowsOnly)
  .filter((filter) => filters.length === 0 || filters.some((name) => filter.includes(name)))
  .sort();
if (files.length === 0) {
  console.error("No integration tests matched.");
  process.exit(1);
}

const selected = shard ? selectShard(files, shard) : undefined;
if (shard) {
  console.log(
    `[integration shard ${shard.index}/${shard.total}] ${selected.files.length} files, weight ${selected.weight}/${selected.totalWeight}`,
  );
}
const selectedFiles = selected?.files ?? files;
if (selectedFiles.length === 0) {
  console.log("No integration tests assigned to this shard.");
  process.exit(0);
}
if (listOnly) {
  console.log(selectedFiles.join("\n"));
} else {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "@pico/cli/tui/preload-env",
      "--test",
      "--test-concurrency=1",
      // A failed production-graph test can leave timers behind; the runner must
      // still report and terminate instead of stalling the CI job.
      "--test-force-exit",
      ...selectedFiles,
    ],
    { cwd: root, stdio: "inherit" },
  );
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
  });
}

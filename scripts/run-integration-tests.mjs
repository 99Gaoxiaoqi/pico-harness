import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const listOnly = args.includes("--list");
const windowsOnly = args.includes("--windows");
const filters = args.filter((arg) => !["--list", "--windows"].includes(arg));
if (filters.some((arg) => arg.startsWith("--"))) {
  console.error(
    "Usage: node scripts/run-integration-tests.mjs [--list] [--windows] [path-or-name ...]",
  );
  process.exit(2);
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

const files = discover(join(root, "tests/integration"))
  .filter((path) => path.startsWith("tests/integration/windows/") === windowsOnly)
  .filter((path) => filters.length === 0 || filters.some((filter) => path.includes(filter)))
  .sort();
if (files.length === 0) {
  console.error("No integration tests matched.");
  process.exit(1);
}
if (listOnly) {
  console.log(files.join("\n"));
} else {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./src/tui/preload-env.ts",
      "--test",
      "--test-concurrency=1",
      ...files,
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

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);

test("Terminal-Bench validates its runtime control configuration", async () => {
  await execFileAsync("python3", ["scripts/terminal-bench/check-trial-network-lifecycle.py"], {
    cwd: process.cwd(),
    timeout: 30_000,
  });
});

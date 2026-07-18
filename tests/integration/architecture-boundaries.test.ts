import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const checker = resolve(repositoryRoot, "scripts/check-architecture-boundaries.mjs");

test("architecture boundary gate passes when only registered legacy edges remain", async () => {
  const result = await execFileAsync(process.execPath, [checker], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

  assert.match(result.stdout, /没有新增逆依赖/);
  assert.match(result.stdout, /发现 \d+ 条受控边界记录/);
  assert.doesNotMatch(
    result.stderr,
    /src\/engine\/loop\.ts -> src\/runtime\/runtime-run\.ts/,
    "AgentEngine must consume the engine-owned Runtime port instead of RuntimeRun directly",
  );
});

test("architecture boundary strict gate passes after legacy edges are migrated", async () => {
  const result = await execFileAsync(process.execPath, [checker, "--strict"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.match(result.stdout, /通过：没有新增逆依赖/);
  assert.match(result.stdout, /发现 0 条受控边界记录/);
});

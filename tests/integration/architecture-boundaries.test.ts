import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { join, resolve } from "node:path";
import { scanArchitectureBoundaries } from "../../scripts/check-architecture-boundaries.mjs";

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

test("architecture boundary gate rejects Engine type-only imports from Runtime", async (context) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "pico-architecture-type-edge-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  await Promise.all(
    ["src/engine", "src/runtime", "apps", "packages"].map((path) =>
      mkdir(join(fixtureRoot, path), { recursive: true }),
    ),
  );
  await writeFile(
    join(fixtureRoot, "src/engine/consumer.ts"),
    'import type { RuntimePrivateType } from "../runtime/private.js";\n',
    "utf8",
  );
  await writeFile(
    join(fixtureRoot, "src/runtime/private.ts"),
    "export interface RuntimePrivateType { readonly value: string }\n",
    "utf8",
  );

  const violations = scanArchitectureBoundaries({ repositoryRoot: fixtureRoot });
  assert.deepEqual(
    violations.map(({ rule, specifier }) => ({ rule, specifier })),
    [
      {
        rule: "engine-to-runtime-implementation",
        specifier: "../runtime/private.js",
      },
    ],
  );
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { scanRootSourceLayout } from "../../../scripts/check-architecture-boundaries.mjs";

test("root src contains only process entrypoints and consumers use package boundaries", async (t) => {
  assert.deepEqual(scanRootSourceLayout(), []);
  const root = await mkdtemp(join(tmpdir(), "pico-source-layout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, source] of Object.entries({
    "src/cli/main.ts": 'import "@pico/cli/main";',
    "src/engine/legacy.ts": 'export * from "@pico/runtime";',
    "tests/consumer.ts": 'export type T = import("../src/engine/legacy.js").T;',
    "scripts/consumer.mjs": 'await import("../src/engine/legacy.js");',
    "tests/worker.ts": 'const worker = join(process.cwd(), "src", "engine", "legacy.ts");',
    "tests/entry.ts": 'const entry = new URL("../src/cli/main.ts", import.meta.url);',
    "packages/runtime/src/consumer.ts": 'import "../../../tests/support.js";',
  })) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, source);
  }
  const violations = scanRootSourceLayout({ repositoryRoot: root }) as { rule: string }[];
  assert.deepEqual(violations.map(({ rule }) => rule).sort(), [
    "production-imports-test-support",
    "root-source-import",
    "root-source-import",
    "root-source-not-entrypoint",
    "root-source-path-reference",
  ]);
});

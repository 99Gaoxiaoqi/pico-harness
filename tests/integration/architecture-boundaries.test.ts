import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { join, resolve } from "node:path";
import {
  scanArchitectureBoundaries,
  scanCanonicalPrimitiveRedefinitions,
  scanCrossCuttingDefinitions,
  scanHandwrittenTimeoutPrimitives,
  scanTypeScriptValueImportCycles,
} from "../../scripts/check-architecture-boundaries.mjs";

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

test("architecture cycle gate rejects direct TypeScript value import cycles", async (context) => {
  const fixtureRoot = await createArchitectureFixture(context, "pico-value-cycle-direct-", {
    "src/engine/a.ts": 'import { b } from "./b.js"; export const a = b;\n',
    "src/engine/b.ts": 'export { a } from "./a.js"; export const b = 1;\n',
  });

  assert.deepEqual(scanTypeScriptValueImportCycles({ repositoryRoot: fixtureRoot }), [
    {
      rule: "typescript-value-import-cycle",
      source: "src/engine/a.ts",
      target: "src/engine/a.ts -> src/engine/b.ts -> src/engine/a.ts",
    },
  ]);
});

test("architecture cycle gate treats literal dynamic import as a value edge", async (context) => {
  const fixtureRoot = await createArchitectureFixture(context, "pico-value-cycle-dynamic-", {
    "src/engine/a.ts": 'export async function load() { return import("./b.js"); }\n',
    "src/engine/b.ts": 'import { load } from "./a.js"; export { load };\n',
  });

  assert.equal(scanTypeScriptValueImportCycles({ repositoryRoot: fixtureRoot }).length, 1);
});

test("architecture cycle gate ignores erased TypeScript type edges", async (context) => {
  const fixtureRoot = await createArchitectureFixture(context, "pico-value-cycle-types-", {
    "src/engine/a.ts": 'import type { B } from "./b.js"; export interface A { readonly b: B }\n',
    "src/engine/b.ts":
      'import { type A } from "./a.js"; export type { A as OtherA } from "./a.js"; export interface B { readonly a: A }\n',
  });

  assert.deepEqual(scanTypeScriptValueImportCycles({ repositoryRoot: fixtureRoot }), []);
});

test("architecture cycle gate finds no TypeScript value import cycle in this repository", () => {
  assert.deepEqual(scanTypeScriptValueImportCycles({ repositoryRoot }), []);
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

test("architecture gate flags locally-defined cross-cutting primitives", async (context) => {
  // 横切超时原语必须统一用 src/util/race-with-deadline.ts，不得本地重定义。
  const fixtureRoot = await mkdtemp(join(tmpdir(), "pico-cross-cutting-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  await Promise.all(
    ["src/runtime", "apps", "packages"].map((path) =>
      mkdir(join(fixtureRoot, path), { recursive: true }),
    ),
  );
  await writeFile(
    join(fixtureRoot, "src/runtime/custom.ts"),
    "async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> { return p; }\n" +
      "function settleWithinDeadline(p: Promise<unknown>, ms: number): Promise<boolean> { return Promise.resolve(true); }\n",
    "utf8",
  );

  const violations = scanCrossCuttingDefinitions({ repositoryRoot: fixtureRoot });
  assert.deepEqual(
    violations
      .map(({ rule, target }) => ({ rule, target }))
      .sort((a, b) => a.target.localeCompare(b.target)),
    [
      { rule: "cross-cutting-duplicate-definition", target: "settleWithinDeadline" },
      { rule: "cross-cutting-duplicate-definition", target: "withTimeout" },
    ],
  );
});

test("architecture gate flags dynamic import() of Runtime from Engine", async (context) => {
  // 动态 import() 与静态 import 同权：engine 不得在运行时加载 runtime 实现。
  const fixtureRoot = await mkdtemp(join(tmpdir(), "pico-architecture-dynamic-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  await Promise.all(
    ["src/engine", "src/runtime", "apps", "packages"].map((path) =>
      mkdir(join(fixtureRoot, path), { recursive: true }),
    ),
  );
  await writeFile(
    join(fixtureRoot, "src/runtime/private.ts"),
    "export const secret = 42;\n",
    "utf8",
  );
  await writeFile(
    join(fixtureRoot, "src/engine/consumer.ts"),
    'async function go() { await import("../runtime/private.js"); }\n',
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

test("architecture gate sees through neutral-zone re-export bridges", async (context) => {
  // src/util/bridge.ts re-export runtime 内容后，engine import bridge 等价于直连 runtime。
  const fixtureRoot = await mkdtemp(join(tmpdir(), "pico-architecture-bridge-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  await Promise.all(
    ["src/engine", "src/runtime", "src/util", "apps", "packages"].map((path) =>
      mkdir(join(fixtureRoot, path), { recursive: true }),
    ),
  );
  await writeFile(
    join(fixtureRoot, "src/runtime/private.ts"),
    "export const secret = 42;\n",
    "utf8",
  );
  await writeFile(
    join(fixtureRoot, "src/util/bridge.ts"),
    'export * from "../runtime/private.js";\n',
    "utf8",
  );
  await writeFile(
    join(fixtureRoot, "src/engine/consumer.ts"),
    'import { secret } from "../util/bridge.js";\n',
    "utf8",
  );

  const violations = scanArchitectureBoundaries({ repositoryRoot: fixtureRoot });
  assert.deepEqual(
    violations.map(({ rule, specifier }) => ({ rule, specifier })),
    [
      {
        rule: "engine-to-runtime-implementation",
        specifier: "../util/bridge.js",
      },
    ],
  );
});

test("architecture gate does not mistake string literals for imports", async (context) => {
  // `export const notes = "../runtime/private.js"` 是字符串字面量，不是 import。
  const fixtureRoot = await mkdtemp(join(tmpdir(), "pico-architecture-literal-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  await Promise.all(
    ["src/engine", "src/runtime", "apps", "packages"].map((path) =>
      mkdir(join(fixtureRoot, path), { recursive: true }),
    ),
  );
  await writeFile(
    join(fixtureRoot, "src/runtime/private.ts"),
    "export const secret = 42;\n",
    "utf8",
  );
  await writeFile(
    join(fixtureRoot, "src/engine/consumer.ts"),
    'export const notes = "../runtime/private.js";\n',
    "utf8",
  );

  const violations = scanArchitectureBoundaries({ repositoryRoot: fixtureRoot });
  assert.deepEqual(violations, []);
});

test("architecture gate flags handwritten new Promise + setTimeout primitives", async (context) => {
  // 语义化横切原语规则：同文件 new Promise + setTimeout 共现 = 手写超时原语。
  // canonical 文件（src/util/race-with-deadline.ts）白名单豁免。
  const fixtureRoot = await mkdtemp(join(tmpdir(), "pico-timeout-primitive-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  await Promise.all(
    ["src/engine", "src/util", "apps", "packages"].map((path) =>
      mkdir(join(fixtureRoot, path), { recursive: true }),
    ),
  );
  const primitive = "const p = new Promise((r) => setTimeout(r, 100));\n";
  await writeFile(join(fixtureRoot, "src/engine/custom.ts"), primitive, "utf8");
  await writeFile(join(fixtureRoot, "src/util/race-with-deadline.ts"), primitive, "utf8");

  const violations = scanHandwrittenTimeoutPrimitives({ repositoryRoot: fixtureRoot });
  assert.deepEqual(violations, [
    {
      rule: "handwritten-timeout-primitive",
      source: "src/engine/custom.ts",
      target: "new Promise + setTimeout",
    },
  ]);
});

test("architecture gate flags canonical primitive redefinition outside the canonical file", async (context) => {
  // canonical 原语名 raceWithDeadline 只能在 src/util/race-with-deadline.ts 定义；
  // import 是引用不是定义，不算违规。
  const fixtureRoot = await mkdtemp(join(tmpdir(), "pico-canonical-redefinition-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  await Promise.all(
    ["src/engine", "src/util", "apps", "packages"].map((path) =>
      mkdir(join(fixtureRoot, path), { recursive: true }),
    ),
  );
  await writeFile(
    join(fixtureRoot, "src/engine/custom.ts"),
    "function raceWithDeadline(p: Promise<unknown>, ms: number) { return p; }\n",
    "utf8",
  );
  await writeFile(
    join(fixtureRoot, "src/engine/consumer.ts"),
    'import { raceWithDeadline } from "../util/race-with-deadline.js";\n',
    "utf8",
  );
  await writeFile(
    join(fixtureRoot, "src/util/race-with-deadline.ts"),
    "export async function raceWithDeadline(p: Promise<unknown>, ms: number): Promise<boolean> { return true; }\n",
    "utf8",
  );

  const violations = scanCanonicalPrimitiveRedefinitions({ repositoryRoot: fixtureRoot });
  assert.deepEqual(violations, [
    {
      rule: "canonical-primitive-redefinition",
      source: "src/engine/custom.ts",
      target: "raceWithDeadline",
    },
  ]);
});

test("architecture gate blocks delegation-manager from importing graph/runtime, single-file only", async (context) => {
  // DelegationManager 只负责普通委派与 plan settle，不得 import graph/runtime。
  const fixtureRoot = await mkdtemp(join(tmpdir(), "pico-delegation-leak-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  await Promise.all(
    ["src/tools", "src/graph", "apps", "packages"].map((path) =>
      mkdir(join(fixtureRoot, path), { recursive: true }),
    ),
  );
  await writeFile(
    join(fixtureRoot, "src/graph/contract.ts"),
    "export interface GraphWork { readonly id: string }\n",
    "utf8",
  );
  await writeFile(
    join(fixtureRoot, "src/tools/delegation-manager.ts"),
    ['import type { GraphWork } from "../graph/contract.js";', ""].join("\n"),
    "utf8",
  );
  await writeFile(
    join(fixtureRoot, "src/tools/other.ts"),
    'import type { GraphWork } from "../graph/contract.js";\n',
    "utf8",
  );

  const violations = scanArchitectureBoundaries({ repositoryRoot: fixtureRoot });
  assert.deepEqual(
    violations.map(({ rule, source, target }) => ({ rule, source, target })),
    [
      {
        rule: "delegation-manager-scheduling-leak",
        source: "src/tools/delegation-manager.ts",
        target: "src/graph/contract.ts",
      },
    ],
    "DelegationManager 的 Graph import 必须被拒绝",
  );
});

async function createArchitectureFixture(
  context: TestContext,
  prefix: string,
  files: Readonly<Record<string, string>>,
) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), prefix));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  await Promise.all(
    ["src", "apps", "packages"].map((path) => mkdir(join(fixtureRoot, path), { recursive: true })),
  );
  for (const [path, source] of Object.entries(files)) {
    const target = join(fixtureRoot, path);
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, source, "utf8");
  }
  return fixtureRoot;
}

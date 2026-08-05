import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  observeRepoMapScans,
  RepoMapService,
  type RepoMapScanReport,
} from "../../src/code-intelligence/repo-map.js";
import { RepoMapTool } from "../../src/tools/code-intelligence.js";
import { createSubagentRegistryFactory } from "../../src/tools/delegation-registry.js";
import { DelegationManager } from "../../src/tools/delegation-manager.js";
import {
  observeWorkspaceFileScans,
  reportWorkspaceFileScans,
} from "../../src/tools/file-scan-observer.js";
import { createDiscoveryLargeRepoFixture } from "../fixtures/discovery-large-repo.js";

test("Discovery Repo Map continues across the default scan batch before resolving a late target", async (context) => {
  const workDir = await mkdtemp(join(tmpdir(), "pico-discovery-repo-map-"));
  const fixture = await createDiscoveryLargeRepoFixture(workDir);
  const service = new RepoMapService(workDir);
  const tool = new RepoMapTool(workDir, service);
  context.after(async () => {
    await service.close();
    await rm(workDir, { recursive: true, force: true });
  });

  const scans: RepoMapScanReport[] = [];
  const firstReportIndex = scans.length;
  const first = await observeRepoMapScans(
    (report) => scans.push(report),
    () => tool.execute(JSON.stringify({ query: fixture.targetSymbol, max_files: 200 })),
  );
  assert.match(first, /backend=repo-map indexed=200\/206 cursor=200 complete=false/u);
  assert.equal(scans.slice(firstReportIndex).flatMap((report) => report.scannedFiles).length, 200);
  assert.doesNotMatch(first, new RegExp(escapeRegExp(fixture.targetSymbol), "u"));
  assert.doesNotMatch(first, new RegExp(escapeRegExp(fixture.targetPath), "u"));

  const secondReportIndex = scans.length;
  const second = await observeRepoMapScans(
    (report) => scans.push(report),
    () => tool.execute(JSON.stringify({ query: fixture.targetSymbol, max_files: 200 })),
  );
  assert.match(second, /backend=repo-map indexed=206\/206 cursor=206 complete=true/u);
  assert.equal(scans.slice(secondReportIndex).flatMap((report) => report.scannedFiles).length, 6);
  assert.equal(new Set(scans.flatMap(({ scannedFiles }) => scannedFiles)).size, 206);
  assert.match(second, new RegExp(escapeRegExp(fixture.targetSymbol), "u"));
  assert.match(second, new RegExp(escapeRegExp(fixture.targetPath), "u"));
});

test("Repo Map max_files counts failed indexing attempts instead of scanning past the budget", async (context) => {
  const workDir = await mkdtemp(join(tmpdir(), "pico-discovery-repo-map-attempts-"));
  const oversized = "x".repeat(600 * 1024);
  await writeFile(join(workDir, "a-oversized-0.ts"), oversized, "utf8");
  await writeFile(join(workDir, "a-oversized-1.ts"), oversized, "utf8");
  await writeFile(join(workDir, "z-target.ts"), "export const boundedTarget = true;\n", "utf8");
  const service = new RepoMapService(workDir);
  const tool = new RepoMapTool(workDir, service);
  context.after(async () => {
    await service.close();
    await rm(workDir, { recursive: true, force: true });
  });

  const scans: RepoMapScanReport[] = [];
  const first = await observeRepoMapScans(
    (report) => scans.push(report),
    () => tool.execute(JSON.stringify({ query: "boundedTarget", max_files: 2 })),
  );
  assert.equal(scans.flatMap((report) => report.scannedFiles).length, 2);
  assert.match(first, /cursor=2 complete=false/u);
  assert.doesNotMatch(first, /z-target\.ts/u);

  const secondReportIndex = scans.length;
  const second = await observeRepoMapScans(
    (report) => scans.push(report),
    () => tool.execute(JSON.stringify({ query: "boundedTarget", max_files: 1 })),
  );
  assert.equal(scans.slice(secondReportIndex).flatMap((report) => report.scannedFiles).length, 1);
  assert.match(second, /z-target\.ts/u);
});

test("bounded Explore branches enforce roots and account Grep files in one shared budget", async (context) => {
  const workDir = await mkdtemp(join(tmpdir(), "pico-discovery-branch-boundary-"));
  await mkdir(join(workDir, "src"));
  await mkdir(join(workDir, "tests"));
  await writeFile(join(workDir, "src", "a.ts"), "export const needle = 1;\n", "utf8");
  await writeFile(join(workDir, "src", "b.ts"), "export const needle = 2;\n", "utf8");
  await writeFile(join(workDir, "tests", "outside.ts"), "export const needle = 3;\n", "utf8");
  context.after(() => rm(workDir, { recursive: true, force: true }));

  let usage = { toolCallsUsed: 0, inspectedFiles: [] as readonly string[] };
  const registry = createSubagentRegistryFactory({
    workDir,
    runner: {
      async runSub() {
        return { status: "completed", summary: "unused", evidenceRefs: [] };
      },
    },
    manager: new DelegationManager(),
    codeIntelligence: new RepoMapService(workDir),
  })({
    mode: "explore",
    role: "leaf",
    depth: 1,
    maxSpawnDepth: 1,
    roots: ["src"],
    maxFiles: 1,
    maxToolCalls: 4,
    onBudgetUsage(value) {
      usage = value;
    },
  });

  assert.ok(!registry.getAvailableTools().some((tool) => tool.name === "bash"));
  const outside = await registry.execute({
    id: "outside-root",
    name: "read_file",
    arguments: JSON.stringify({ path: "tests/outside.ts" }),
  });
  assert.equal(outside.isError, true);
  assert.deepEqual(usage, { toolCallsUsed: 0, inspectedFiles: [] });

  const grep = await registry.execute({
    id: "bounded-grep",
    name: "grep",
    arguments: JSON.stringify({ pattern: "needle", path: "src", max_results: 50 }),
  });
  assert.equal(grep.isError, false);
  assert.match(grep.output, /a\.ts:1:/u);
  assert.doesNotMatch(grep.output, /b\.ts|outside\.ts/u);
  assert.deepEqual(usage, { toolCallsUsed: 1, inspectedFiles: ["src/a.ts"] });

  const exhausted = await registry.execute({
    id: "exhausted-read",
    name: "read_file",
    arguments: JSON.stringify({ path: "src/b.ts" }),
  });
  assert.equal(exhausted.isError, true);
  assert.match(exhausted.output, /文件检查预算已耗尽/u);
  assert.deepEqual(usage, { toolCallsUsed: 2, inspectedFiles: ["src/a.ts"] });

  let concurrentUsage = { toolCallsUsed: 0, inspectedFiles: [] as readonly string[] };
  const concurrentRegistry = createSubagentRegistryFactory({
    workDir,
    runner: {
      async runSub() {
        return { status: "completed", summary: "unused", evidenceRefs: [] };
      },
    },
    manager: new DelegationManager(),
  })({
    mode: "explore",
    role: "leaf",
    depth: 1,
    maxSpawnDepth: 1,
    roots: ["src"],
    maxFiles: 1,
    maxToolCalls: 4,
    onBudgetUsage(value) {
      concurrentUsage = value;
    },
  });
  const concurrent = await Promise.all([
    concurrentRegistry.execute({
      id: "parallel-grep-a",
      name: "grep",
      arguments: JSON.stringify({ pattern: "needle", path: "src", glob: "a.ts" }),
    }),
    concurrentRegistry.execute({
      id: "parallel-grep-b",
      name: "grep",
      arguments: JSON.stringify({ pattern: "needle", path: "src", glob: "b.ts" }),
    }),
  ]);
  assert.equal(concurrent.filter((result) => result.isError).length, 1);
  assert.equal(concurrentUsage.toolCallsUsed, 2);
  assert.equal(concurrentUsage.inspectedFiles.length, 1);

  const fileRootRegistry = createSubagentRegistryFactory({
    workDir,
    runner: {
      async runSub() {
        return { status: "completed", summary: "unused", evidenceRefs: [] };
      },
    },
    manager: new DelegationManager(),
  })({
    mode: "explore",
    role: "leaf",
    depth: 1,
    maxSpawnDepth: 1,
    roots: ["src/a.ts"],
    maxFiles: 1,
    maxToolCalls: 1,
  });
  const fileRoot = await fileRootRegistry.execute({
    id: "file-root-read",
    name: "read_file",
    arguments: JSON.stringify({ path: "src/a.ts" }),
  });
  assert.equal(fileRoot.isError, false);

  const abortController = new AbortController();
  let abortedUsage = { toolCallsUsed: 0, inspectedFiles: [] as readonly string[] };
  const abortRegistry = createSubagentRegistryFactory({
    workDir,
    runner: {
      async runSub() {
        return { status: "completed", summary: "unused", evidenceRefs: [] };
      },
    },
    manager: new DelegationManager(),
  })({
    mode: "explore",
    role: "leaf",
    depth: 1,
    maxSpawnDepth: 1,
    roots: ["src"],
    maxFiles: 10,
    maxToolCalls: 2,
    onBudgetUsage(value) {
      abortedUsage = value;
      if (value.inspectedFiles.length === 1) abortController.abort("stop bounded grep");
    },
  });
  await assert.rejects(
    abortRegistry.execute(
      {
        id: "abort-grep",
        name: "grep",
        arguments: JSON.stringify({ pattern: "needle", path: "src" }),
      },
      { signal: abortController.signal },
    ),
    /abort/u,
  );
  assert.deepEqual(abortedUsage, { toolCallsUsed: 1, inspectedFiles: ["src/a.ts"] });

  const repoAbortController = new AbortController();
  let repoAbortedUsage = { toolCallsUsed: 0, inspectedFiles: [] as readonly string[] };
  const repoAbortRegistry = createSubagentRegistryFactory({
    workDir,
    runner: {
      async runSub() {
        return { status: "completed", summary: "unused", evidenceRefs: [] };
      },
    },
    manager: new DelegationManager(),
  })({
    mode: "explore",
    role: "leaf",
    depth: 1,
    maxSpawnDepth: 1,
    roots: ["src/a.ts"],
    maxFiles: 10,
    maxToolCalls: 2,
    onBudgetUsage(value) {
      repoAbortedUsage = value;
      if (value.inspectedFiles.length === 1) repoAbortController.abort("stop repo map");
    },
  });
  await assert.rejects(
    repoAbortRegistry.execute(
      {
        id: "abort-repo-map",
        name: "repo_map",
        arguments: JSON.stringify({ query: "needle", max_files: 10 }),
      },
      { signal: repoAbortController.signal },
    ),
    /abort/u,
  );
  assert.equal(repoAbortedUsage.toolCallsUsed, 1);
  assert.equal(repoAbortedUsage.inspectedFiles.length, 1);
});

test("workspace file scan observers preserve nested host and branch accounting", async () => {
  const outer: string[] = [];
  const inner: string[] = [];
  await observeWorkspaceFileScans(
    (report) => outer.push(...report.scannedFiles),
    () =>
      observeWorkspaceFileScans(
        (report) => inner.push(...report.scannedFiles),
        async () => reportWorkspaceFileScans(["src/target.ts"]),
      ),
  );
  assert.deepEqual(inner, ["src/target.ts"]);
  assert.deepEqual(outer, ["src/target.ts"]);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

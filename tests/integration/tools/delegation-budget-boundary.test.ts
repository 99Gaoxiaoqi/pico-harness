import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RepoMapService } from "../../../src/code-intelligence/repo-map.js";
import type { ToolCall } from "../../../src/schema/message.js";
import { normalizeDelegateTasks } from "../../../src/tools/delegation-contract.js";
import { DelegationManager } from "../../../src/tools/delegation-manager.js";
import { createSubagentRegistryFactory } from "../../../src/tools/delegation-registry.js";
import { observeWorkspaceFileScans } from "../../../src/tools/file-scan-observer.js";
import { ToolRegistry } from "../../../src/tools/registry-impl.js";

function registryFor(root: string, maxFiles: number) {
  const registry = createSubagentRegistryFactory({
    workDir: root,
    runner: { runSub: async () => ({ status: "completed", summary: "unused", evidenceRefs: [] }) },
    manager: new DelegationManager(),
    codeIntelligence: new RepoMapService(root),
  })({ mode: "explore", role: "leaf", depth: 1, maxSpawnDepth: 2, maxFiles, maxToolCalls: 10 });
  assert.ok(registry instanceof ToolRegistry);
  return registry;
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("default delegated scans authorize their normalized budget before T1", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-delegation-budget-"));
  try {
    await writeFile(join(root, "a.ts"), "export const answer = 42;\n");
    const task = normalizeDelegateTasks({ goal: "inspect repository" })[0]!;
    for (const [name, args] of [
      ["glob", { pattern: "*.ts" }],
      ["grep", { pattern: "answer" }],
      ["repo_map", {}],
    ] as const) {
      const registry = registryFor(root, task.maxFiles);
      let authorized: ToolCall | undefined;
      let prepared: ToolCall | undefined;
      registry.usePermission(async (call) => {
        authorized = call;
        return { allowed: true };
      });
      const step = registry.captureStep(
        "step",
        registry.getAvailableTools().map((tool) => tool.name),
      );
      const result = await registry.execute(
        { id: name, name, arguments: JSON.stringify(args) },
        {
          step,
          beforeDispatch: async (call) => {
            prepared = call;
          },
        },
      );
      assert.equal(result.isError, false, `${name}: ${result.output}`);
      assert.match(result.output, /a\.ts/);
      assert.ok(authorized);
      assert.deepEqual(prepared, authorized);
      assert.equal(JSON.parse(authorized.arguments).max_files, task.maxFiles);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a queued scan cannot exceed a budget consumed after authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-delegation-budget-race-"));
  const firstEntered = gate();
  const finishFirst = gate();
  try {
    await Promise.all(["first", "second"].map((name) => mkdir(join(root, name))));
    await writeFile(join(root, "first", "a.ts"), "a");
    await Promise.all(
      ["b", "c"].map((name) => writeFile(join(root, "second", `${name}.ts`), name)),
    );
    const registry = registryFor(root, 3);
    const secondAuthorized = gate();
    const prepared: ToolCall[] = [];
    const scanned: string[] = [];
    registry.usePermission(async (call) => {
      if (call.id === "second") {
        assert.equal(JSON.parse(call.arguments).max_files, 3);
        secondAuthorized.release();
      }
      return { allowed: true };
    });
    await observeWorkspaceFileScans(
      ({ scannedFiles }) => scanned.push(...scannedFiles),
      async () => {
        const first = registry.execute(
          {
            id: "first",
            name: "glob",
            arguments: JSON.stringify({ pattern: "a.ts", path: "first", max_files: 1 }),
          },
          {
            beforeDispatch: async (call) => {
              prepared.push(call);
              firstEntered.release();
              await finishFirst.promise;
            },
          },
        );
        await firstEntered.promise;
        const second = registry.execute(
          {
            id: "second",
            name: "glob",
            arguments: JSON.stringify({ pattern: "*.ts", path: "second" }),
          },
          {
            beforeDispatch: async (call) => {
              prepared.push(call);
            },
          },
        );
        await secondAuthorized.promise;
        finishFirst.release();
        assert.equal((await first).isError, false);
        const stale = await second;
        assert.equal(stale.isError, true);
        assert.match(stale.output, /预算.*变化/);
        assert.deepEqual(
          prepared.map((call) => call.id),
          ["first"],
        );
        assert.deepEqual(scanned, ["a.ts"]);

        const retry = await registry.execute(
          {
            id: "retry",
            name: "glob",
            arguments: JSON.stringify({ pattern: "*.ts", path: "second" }),
          },
          {
            beforeDispatch: async (call) => {
              prepared.push(call);
            },
          },
        );
        assert.equal(retry.isError, false, retry.output);
        assert.equal(JSON.parse(prepared.at(-1)!.arguments).max_files, 2);
        assert.deepEqual([...scanned].sort(), ["a.ts", "b.ts", "c.ts"]);
        const exhausted = await registry.execute({
          id: "exhausted",
          name: "glob",
          arguments: JSON.stringify({ pattern: "*.ts" }),
        });
        assert.equal(exhausted.isError, true);
        assert.equal(scanned.length, 3);
      },
    );
  } finally {
    finishFirst.release();
    await rm(root, { recursive: true, force: true });
  }
});

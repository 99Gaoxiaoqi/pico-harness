import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DISCOVERY_DEPTH_BUDGETS, type DiscoveryCheckpoint } from "../../src/discovery/contract.js";
import { DiscoveryCoordinator } from "../../src/discovery/coordinator.js";
import {
  orchestrateDiscovery,
  type DiscoveryWorkerInput,
} from "../../src/discovery/orchestrator.js";
import { RuntimeEventStore } from "../../src/storage/runtime-event-store.js";

const AT = new Date("2026-08-06T00:00:00.000Z");

test("Discovery orchestrator launches preset branches concurrently and owns durable writeback", async (t) => {
  const fixture = await createFixture("presets");
  t.after(() => fixture.dispose());

  for (const [depth, expectedBranches] of [
    ["quick", 1],
    ["balanced", 2],
    ["deep", 3],
  ] as const) {
    const sessionId = `preset-${depth}`;
    await fixture.initialize(sessionId);
    const coordinator = fixture.coordinator(sessionId);
    const workers: DiscoveryWorkerInput[] = [];
    let activeWorkers = 0;
    let maxActiveWorkers = 0;
    let releaseWorkers: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseWorkers = resolve;
    });

    const result = await orchestrateDiscovery({
      coordinator,
      operationId: `orchestrate-${depth}`,
      discoveryId: `${depth}-discovery`,
      objective: "定位请求路由的最终实现",
      depth,
      roots: ["src"],
      queries: ["routeRequest"],
      worker: async (input) => {
        workers.push(input);
        activeWorkers += 1;
        maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
        if (workers.length === expectedBranches) releaseWorkers?.();
        await release;
        activeWorkers -= 1;
        return {
          status: "completed",
          checkpoint: checkpoint(input.ordinal),
        };
      },
    });

    assert.equal(result.cancelled, false);
    assert.equal(result.stoppedEarly, false);
    assert.equal(workers.length, expectedBranches);
    assert.equal(maxActiveWorkers, expectedBranches);
    assert.deepEqual(
      workers.map((worker) => worker.branchId),
      Array.from(
        { length: expectedBranches },
        (_, ordinal) => `${depth}-discovery:branch:${String(ordinal + 1).padStart(2, "0")}`,
      ),
    );
    assert.deepEqual(
      workers.map((worker) => worker.strategy),
      ["entry_path", "symbol_reference", "boundary_verification"].slice(0, expectedBranches),
    );
    assert.equal(
      workers.reduce((sum, worker) => sum + worker.budget.maxToolCalls, 0),
      DISCOVERY_DEPTH_BUDGETS[depth].maxToolCalls,
    );
    assert.equal(
      workers.reduce((sum, worker) => sum + worker.budget.maxFiles, 0),
      DISCOVERY_DEPTH_BUDGETS[depth].maxFiles,
    );
    assert.equal(result.projection.active?.budget.consumedToolCalls, expectedBranches);
    assert.equal(result.projection.active?.budget.consumedFiles, expectedBranches + 1);
    assert.equal(result.projection.active?.budget.reservedToolCalls, 0);
    assert.equal(result.projection.active?.budget.reservedFiles, 0);
    assert.ok(result.projection.active?.branches.every((branch) => branch.status === "completed"));

    const events = await fixture.store.readSession(sessionId);
    const kinds = events.map((event) => event.kind);
    assert.equal(
      kinds.filter((kind) => kind === "discovery.branch.started").length,
      expectedBranches,
    );
    assert.equal(
      kinds.filter((kind) => kind === "discovery.branch.checkpointed").length,
      expectedBranches,
    );
    assert.equal(
      kinds.filter((kind) => kind === "discovery.branch.completed").length,
      expectedBranches,
    );
    assert.ok(
      kinds.lastIndexOf("discovery.branch.started") <
        kinds.indexOf("discovery.branch.checkpointed"),
      "all reservations must be durable before the first worker result is written",
    );
  }
});

test("Discovery orchestrator early-stop cancels siblings and isolates late worker results", async (t) => {
  const fixture = await createFixture("early-stop");
  t.after(() => fixture.dispose());
  await fixture.initialize("early-stop-session");
  const coordinator = fixture.coordinator("early-stop-session");
  let started = 0;
  let releaseStart: (() => void) | undefined;
  const allStarted = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  let releaseLate: (() => void) | undefined;
  const late = new Promise<void>((resolve) => {
    releaseLate = resolve;
  });

  const result = await orchestrateDiscovery({
    coordinator,
    operationId: "orchestrate-early-stop",
    discoveryId: "early-stop-discovery",
    objective: "定位足够证据后停止",
    depth: "deep",
    worker: async (input) => {
      started += 1;
      if (started === 3) releaseStart?.();
      await allStarted;
      if (input.ordinal === 0) {
        return {
          status: "completed",
          stop: true,
          checkpoint: checkpoint(0, "src/confirmed.ts", "evidence:confirmed"),
        };
      }
      // Deliberately ignore AbortSignal: the orchestrator must still reject this late writeback.
      await late;
      return {
        status: "completed",
        checkpoint: checkpoint(
          input.ordinal,
          `src/late-${input.ordinal}.ts`,
          `evidence:late-${input.ordinal}`,
        ),
      };
    },
  });

  assert.equal(result.stoppedEarly, true);
  assert.equal(result.cancelled, false);
  assert.deepEqual(
    result.projection.active?.branches.map((branch) => branch.status),
    ["completed", "cancelled", "cancelled"],
  );
  assert.deepEqual(result.projection.active?.inspectedFiles, ["src/shared.ts", "src/confirmed.ts"]);
  const beforeLate = await fixture.store.readSession("early-stop-session");
  assert.equal(
    beforeLate.filter((event) => event.kind === "discovery.branch.checkpointed").length,
    1,
  );
  assert.equal(beforeLate.filter((event) => event.kind === "discovery.branch.completed").length, 1);

  releaseLate?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(await fixture.store.readSession("early-stop-session"), beforeLate);
});

test("Discovery orchestrator persists external cancellation before aborted workers can write", async (t) => {
  const fixture = await createFixture("cancel");
  t.after(() => fixture.dispose());
  await fixture.initialize("cancel-session");
  const coordinator = fixture.coordinator("cancel-session");
  const controller = new AbortController();
  let started = 0;
  let releaseStarted: (() => void) | undefined;
  const allStarted = new Promise<void>((resolve) => {
    releaseStarted = resolve;
  });

  const running = orchestrateDiscovery({
    coordinator,
    operationId: "orchestrate-cancel",
    discoveryId: "cancel-discovery",
    objective: "取消并发定位",
    depth: "deep",
    signal: controller.signal,
    worker: async (input) => {
      started += 1;
      if (started === 3) releaseStarted?.();
      return new Promise((_, reject) => {
        input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
      });
    },
  });
  await allStarted;
  controller.abort(new DOMException("test cancellation", "AbortError"));
  const result = await running;

  assert.equal(result.cancelled, true);
  assert.equal(result.stoppedEarly, false);
  assert.equal(result.projection.latest?.status, "cancelled");
  assert.deepEqual(
    result.projection.latest?.branches.map((branch) => branch.status),
    ["cancelled", "cancelled", "cancelled"],
  );
  const events = await fixture.store.readSession("cancel-session");
  assert.equal(events.filter((event) => event.kind === "discovery.branch.checkpointed").length, 0);
  assert.equal(events.filter((event) => event.kind === "discovery.branch.completed").length, 0);
  assert.equal(events.at(-1)?.kind, "discovery.cancelled");
});

function checkpoint(
  ordinal: number,
  path = `src/branch-${ordinal}.ts`,
  evidence = `evidence:branch-${ordinal}`,
): DiscoveryCheckpoint {
  return {
    phase: "forage",
    cycle: 1,
    candidates: [
      {
        path,
        score: 0.8,
        reasons: ["direct worker evidence"],
        evidenceRefs: [evidence],
      },
    ],
    evidenceRefs: [evidence],
    hypotheses: [],
    openQuestions: [],
    toolCallsUsed: 1,
    inspectedFiles: ["src/shared.ts", path],
  };
}

async function createFixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `pico-discovery-orchestrator-${name}-`));
  const store = new RuntimeEventStore({ storageRoot: join(root, "state") });
  return {
    store,
    async initialize(sessionId: string) {
      const workDir = join(root, sessionId);
      await mkdir(workDir);
      await store.initializeSession({ sessionId, workDir });
    },
    coordinator(sessionId: string) {
      return new DiscoveryCoordinator(
        store,
        {
          sessionId,
          invocationId: `${sessionId}-invocation`,
          runId: `${sessionId}-run`,
          turnId: `${sessionId}-turn`,
        },
        () => AT,
      );
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

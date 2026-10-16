import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { AtomicMemoryLifecycle } from "@pico/runtime";
import type { PersistedSessionSettings, SessionRuntimeStateWritePatch } from "@pico/core";
import { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import { operationalDatabasePath } from "@pico/storage";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { memorySessionKey } from "@pico/core/atomic-memory-runtime-contracts";
import { resolvePicoPaths } from "../../../packages/pico-host/src/pico-paths.js";
import { WorkspaceRegistrationStore } from "../../../packages/pico-host/src/workspace-registration.js";
import { WorkspaceTrustStore } from "../../../packages/pico-host/src/workspace-trust.js";
import { recoverRegisteredAtomicMemory } from "../../../packages/pico-host/src/atomic-memory-recovery-host.js";
import {
  AtomicMemoryRuntime,
  type AtomicMemoryRuntimeOptions,
} from "../../../packages/pico-host/src/atomic-memory-runtime.js";

const settings: PersistedSessionSettings = {
  provider: "openai",
  model: "model/B",
  modelRouteId: "fixture/model/B",
  collaborationMode: "agent",
  permissionMode: "auto",
  orchestrationMode: "default",
  thinkingEffort: "medium",
  thinkingEffortExplicit: false,
  additionalDirectories: [],
};
const policy: SessionRuntimeStateWritePatch = {
  settings,
  boundary: { kind: "bypass", revision: 1 },
};
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pico-recovery-host-")));
  const picoHome = join(root, "home");
  const registrationStore = new WorkspaceRegistrationStore(
    join(picoHome, "daemon-workspaces.json"),
  );
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  const stores: SqliteRuntimeEventStore[] = [];
  const lifecycle = new AtomicMemoryLifecycle();
  t.after(async () => {
    await lifecycle.close();
    for (const store of stores) store.close();
    await rm(root, { recursive: true, force: true });
  });
  const workspace = async (name: string, register = true, trust = true) => {
    const workDir = join(root, name);
    await mkdir(workDir);
    if (register) await registrationStore.register(workDir);
    if (trust) await trustStore.trust(await trustStore.canonicalize(workDir));
    return workDir;
  };
  const session = async (workDir: string, sessionId: string, patch = policy, cwd = workDir) => {
    const store = new SqliteRuntimeEventStore({
      storageRoot: resolvePicoPaths(workDir, { picoHome }).workspace.root,
    });
    stores.push(store);
    await store.initializeSession({ sessionId, workDir: cwd });
    const ownerFence = await store.advanceOwnerFence(sessionId, 0);
    await store.appendSessionState(sessionId, patch, { ownerFence });
    return { store, ownerFence, sessionId, workDir };
  };
  return { root, picoHome, registrationStore, trustStore, lifecycle, workspace, session };
}

test("startup discovers both registered trusted databases without input and excludes missing/unregistered/archived/unknown authority", async (t) => {
  const f = await fixture(t);
  const a = await f.workspace("A"),
    b = await f.workspace("B");
  await f.session(a, "A");
  await f.session(b, "B");
  const archived = await f.session(b, "archived");
  archived.store.setSessionArchived("archived", true);
  await f.session(b, "side", { ...policy, settings: { ...settings, sideConversation: true } });
  await f.session(b, "plan", { ...policy, settings: { ...settings, collaborationMode: "plan" } });
  await f.session(b, "external", { ...policy, boundary: { kind: "external", revision: 1 } });
  await f.session(b, "no-boundary", { settings });
  await f.session(b, "no-settings", { boundary: policy.boundary });
  await f.session(b, "wrong-cwd", policy, a);
  await f.session(await f.workspace("untrusted", true, false), "untrusted");
  const unregistered = await f.workspace("unregistered", false);
  await f.session(unregistered, "unregistered");
  const missing = await f.workspace("missing-db");
  const snapshots: AtomicMemoryRuntimeOptions[] = [];
  const completed: string[] = [];
  await recoverRegisteredAtomicMemory({
    ...f,
    workspacePaths: [...(await f.registrationStore.list()), unregistered],
    modelFactory: async () => {
      throw new Error("discovery fixture never calls model");
    },
    createRuntime: (options) => {
      snapshots.push(options);
      return {
        reconcileAdmittedBoundaries: async () => {
          assert.equal((await options.gate()).allowed, true);
          return 1;
        },
        recoverPendingJobs: async () => {
          completed.push(options.sessionId);
          return 1;
        },
      };
    },
  });
  assert.deepEqual(completed.sort(), ["A", "B"]);
  assert.ok(
    snapshots.every(
      (options) => options.lifecycle === f.lifecycle && options.preserveSourceTools === false,
    ),
  );
  await assert.rejects(() =>
    import("node:fs/promises").then((fs) =>
      fs.stat(
        operationalDatabasePath(resolvePicoPaths(missing, { picoHome: f.picoHome }).workspace.root),
      ),
    ),
  );
});

test("every claim/model gate reloads registration, trust, catalog, policy and exact model route; a failed workspace does not stop another", async (t) => {
  const f = await fixture(t);
  const a = await f.workspace("A"),
    b = await f.workspace("B");
  const sa = await f.session(a, "A");
  await f.session(b, "B");
  const captured = new Map<string, AtomicMemoryRuntimeOptions>();
  let bRecovered = false;
  let modelCalls = 0,
    disposals = 0;
  await recoverRegisteredAtomicMemory({
    ...f,
    workspacePaths: await f.registrationStore.list(),
    modelFactory: async (workDir, route, sessionId) => {
      assert.equal(workDir, a);
      assert.equal(sessionId, "A");
      assert.deepEqual(route, { providerId: "fixture", modelId: "model/B" });
      return {
        model: {
          call: async () => {
            modelCalls++;
            return "fixture";
          },
        },
        dispose: () => {
          disposals++;
        },
      };
    },
    createRuntime: (options) => {
      captured.set(options.sessionId, options);
      return {
        reconcileAdmittedBoundaries: async () => {
          if (options.sessionId === "A") throw new Error("bad workspace");
          return 0;
        },
        recoverPendingJobs: async () => {
          bRecovered = true;
          return 0;
        },
      };
    },
  });
  assert.equal(bRecovered, true);
  const runtime = captured.get("A")!;
  assert.equal((await runtime.gate()).allowed, true);
  const lease = await runtime.modelFactory();
  await f.registrationStore.unregister(a);
  assert.equal((await runtime.gate()).allowed, false);
  await assert.rejects(() => lease.model.call({ stage: "proposal", prompt: "fixture" }));
  await f.registrationStore.register(a);
  await f.trustStore.setTrusted(a, false);
  assert.equal((await runtime.gate()).allowed, false);
  await f.trustStore.trust(a);
  sa.store.setSessionArchived("A", true);
  assert.equal((await runtime.gate()).allowed, false);
  sa.store.setSessionArchived("A", false);
  for (const patch of [
    { ...policy, settings: { ...settings, collaborationMode: "research" as const } },
    { ...policy, settings: { ...settings, sideConversation: true } },
    { ...policy, boundary: { kind: "external" as const, revision: 2 } },
    { ...policy, settings: { ...settings, modelRouteId: "other/model" } },
  ]) {
    await sa.store.appendSessionState("A", patch, { ownerFence: sa.ownerFence });
    assert.equal((await runtime.gate()).allowed, false);
  }
  await sa.store.appendSessionState("A", policy, { ownerFence: sa.ownerFence });
  assert.equal((await runtime.gate()).allowed, true);
  await lease.model.call({ stage: "proposal", prompt: "fixture" });
  assert.equal(modelCalls, 1);
  await lease.dispose?.();
  assert.equal(disposals, 1);
});

test("shared Host lifecycle stops new recovery and shutdown waits for work already begun", async (t) => {
  const f = await fixture(t);
  const a = await f.workspace("A");
  await f.session(a, "A");
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let modelCalls = 0;
  const run = recoverRegisteredAtomicMemory({
    ...f,
    workspacePaths: await f.registrationStore.list(),
    modelFactory: async () => ({
      model: {
        call: async () => {
          modelCalls++;
          started();
          await hold;
          return "fixture";
        },
      },
    }),
    createRuntime: (options) => ({
      reconcileAdmittedBoundaries: async () => 0,
      recoverPendingJobs: async () => {
        const lease = await options.modelFactory();
        try {
          await lease.model.call({ stage: "proposal", prompt: "fixture" });
        } finally {
          await lease.dispose?.();
        }
        return 1;
      },
    }),
  });
  await entered;
  let closed = false;
  const close = f.lifecycle.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  let late = 0;
  await recoverRegisteredAtomicMemory({
    ...f,
    workspacePaths: [a],
    modelFactory: async () => {
      throw new Error("late");
    },
    createRuntime: () => {
      late++;
      throw new Error("late");
    },
  });
  assert.equal(late, 0);
  release();
  await run;
  await close;
  assert.equal(closed, true);
  assert.equal(modelCalls, 1);
});

async function appendAdmittedTerminal(
  target: {
    store: SqliteRuntimeEventStore;
    sessionId: string;
    workDir: string;
    ownerFence: Awaited<ReturnType<SqliteRuntimeEventStore["advanceOwnerFence"]>>;
  },
  admission: { disposition: "eligible"; deletionRevision: number; settingsVersion: number },
) {
  const base = (eventId: string) => ({
    schemaVersion: 2 as const,
    sessionId: target.sessionId,
    eventId,
    runId: "source-run",
    turnId: "source-turn",
    invocationId: "source-invocation",
    at: new Date().toISOString(),
    visibility: "internal" as const,
    partial: false,
  });
  await target.store.appendBatch(
    [
      {
        ...base("source-start"),
        kind: "run.started",
        data: { workDir: target.workDir, agentSwarmAuthorization: "none" },
      },
      {
        ...base("source-user"),
        kind: "message.committed",
        visibility: "model",
        data: { message: { role: "user", content: "I prefer concise technical explanations." } },
      },
      {
        ...base("source-terminal"),
        kind: "run.terminal",
        data: { status: "completed", memoryExtractionBoundary: admission },
      },
    ],
    { ownerFence: target.ownerFence },
  );
}
const completeReview = JSON.stringify({
  status: "complete",
  coverageStatus: "processed",
  requestedStatus: "not_applicable",
  requestedItems: [],
  incidentalItems: [],
});
async function flushUntil(predicate: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 3_000;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("recovery did not finish in bounded local fixture flush");
}

test("registered startup recovers source-to-job gap in A and prequeued job in B after restart without any new Run/input", async (t) => {
  const f = await fixture(t);
  const a = await f.workspace("A"),
    b = await f.workspace("B");
  const sa = await f.session(a, "A"),
    sb = await f.session(b, "B");
  const store = new SqliteMemoryItemStore(join(f.picoHome, "memory.sqlite"));
  t.after(() => store.close());
  const admission = {
    disposition: "eligible" as const,
    deletionRevision: await store.readDeletionRevision(),
    settingsVersion: (
      await store.readSettings(resolvePicoPaths(a, { picoHome: f.picoHome }).workspace.id)
    ).version,
  };
  await appendAdmittedTerminal(sa, admission);
  await appendAdmittedTerminal(sb, admission);
  const oldLifecycle = new AtomicMemoryLifecycle();
  const old = new AtomicMemoryRuntime({
    workDir: b,
    picoHome: f.picoHome,
    sessionId: "B",
    gate: async () => ({ allowed: true }),
    modelFactory: async () => {
      throw new Error("old process must not reach model");
    },
    supported: true,
    preserveSourceTools: false,
    lifecycle: oldLifecycle,
  });
  await old.completed("source-run");
  await oldLifecycle.close();
  const bKey = memorySessionKey(resolvePicoPaths(b, { picoHome: f.picoHome }).workspace.id, "B");
  const beforeB = (
    await store.listRecoverableExtractionJobs({ now: Date.now() + 60_000, limit: 100 })
  ).find((job) => job.sessionId === bKey)!;
  assert.ok(beforeB);
  const aKey = memorySessionKey(resolvePicoPaths(a, { picoHome: f.picoHome }).workspace.id, "A");
  assert.equal(
    (await store.listRecoverableExtractionJobs({ now: Date.now() + 60_000, limit: 100 })).some(
      (job) => job.sessionId === aKey,
    ),
    false,
  );
  const calls: string[] = [];
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  await recoverRegisteredAtomicMemory({
    ...f,
    workspacePaths: await f.registrationStore.list(),
    modelFactory: async (workDir, route, sessionId) => {
      assert.ok(workDir === a || workDir === b);
      assert.deepEqual(route, { providerId: "fixture", modelId: "model/B" });
      return {
        model: {
          call: async (request) => {
            assert.equal(request.sourceTools?.length ?? 0, 0);
            calls.push(sessionId);
            return completeReview;
          },
        },
      };
    },
  });
  t.mock.timers.tick(31_000);
  try {
    await flushUntil(
      async () =>
        !!(await store.readExtractionCursor(aKey)) && !!(await store.readExtractionCursor(bKey)),
    );
  } catch (error) {
    t.diagnostic(
      JSON.stringify({
        calls,
        aCursor: await store.readExtractionCursor(aKey),
        bCursor: await store.readExtractionCursor(bKey),
        bJob: await store.readExtractionJob(beforeB.jobId),
      }),
    );
    throw error;
  }
  assert.deepEqual(calls.sort(), ["A", "B"]);
  assert.equal((await store.readExtractionJob(beforeB.jobId))?.state, "settled");
  for (const session of [sa, sb]) {
    const entries = await session.store.readSessionEntries(session.sessionId);
    assert.equal(entries.filter(({ event }) => event.kind === "run.started").length, 1);
    assert.equal(entries.filter(({ event }) => event.kind === "message.committed").length, 1);
  }
  await f.lifecycle.close();
});

test("recovery leaves queued source fenced after disabling auto memory or advancing deletion generation", async (t) => {
  for (const barrier of ["disabled", "deleted"] as const)
    await t.test(barrier, async (t) => {
      const f = await fixture(t);
      const a = await f.workspace("A");
      const target = await f.session(a, "A");
      const store = new SqliteMemoryItemStore(join(f.picoHome, "memory.sqlite"));
      t.after(() => store.close());
      const workspaceKey = resolvePicoPaths(a, { picoHome: f.picoHome }).workspace.id;
      const settings = await store.readSettings(workspaceKey);
      await appendAdmittedTerminal(target, {
        disposition: "eligible",
        deletionRevision: await store.readDeletionRevision(),
        settingsVersion: settings.version,
      });
      const oldLifecycle = new AtomicMemoryLifecycle();
      await new AtomicMemoryRuntime({
        workDir: a,
        picoHome: f.picoHome,
        sessionId: "A",
        gate: async () => ({ allowed: true }),
        modelFactory: async () => {
          throw new Error("old process");
        },
        supported: true,
        preserveSourceTools: false,
        lifecycle: oldLifecycle,
      }).completed("source-run");
      await oldLifecycle.close();
      if (barrier === "disabled")
        await store.updateSettings({
          workspaceKey,
          expectedVersion: settings.version,
          autoExtract: false,
        });
      else {
        const seeded = await store.applyMutations({
          operationId: "seed-deletion-barrier",
          mutations: [
            {
              type: "create",
              item: {
                content: "Temporary fixture preference.",
                kind: "preference",
                statementType: "fact",
                temporalType: "undated",
                scopeType: "workspace",
                scopeKey: workspaceKey,
                observedAt: 1,
                origin: "user_requested",
                keys: [{ key: "temporary", keyType: "concept", keyOrigin: "user" }],
                sources: [],
              },
            },
          ],
        });
        await store.deleteItem({
          itemId: seeded.results[0]!.itemId,
          expectedVersion: seeded.results[0]!.version,
          operationId: "delete-barrier",
        });
      }
      let calls = 0;
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
      await recoverRegisteredAtomicMemory({
        ...f,
        workspacePaths: await f.registrationStore.list(),
        modelFactory: async () => ({
          model: {
            call: async () => {
              calls++;
              return completeReview;
            },
          },
        }),
      });
      t.mock.timers.tick(31_000);
      // Drain only tasks already admitted; future retries remain Runtime-owned and finite.
      for (let i = 0; i < 40; i++) await new Promise<void>((resolve) => setImmediate(resolve));
      await f.lifecycle.close();
      assert.equal(calls, 0);
      assert.equal(
        await store.readExtractionCursor(memorySessionKey(workspaceKey, "A")),
        undefined,
      );
    });
});

test("startup wakes an abandoned lease at expiry with cumulative budget, while shutdown cancels its future claim", async (t) => {
  for (const stopBeforeExpiry of [false, true])
    await t.test(
      stopBeforeExpiry ? "shutdown before expiry" : "recover after expiry",
      async (t) => {
        const f = await fixture(t);
        const workDir = await f.workspace("leased");
        const target = await f.session(workDir, "leased");
        const store = new SqliteMemoryItemStore(join(f.picoHome, "memory.sqlite"));
        t.after(() => store.close());
        const workspaceKey = resolvePicoPaths(workDir, { picoHome: f.picoHome }).workspace.id;
        const sessionId = memorySessionKey(workspaceKey, "leased");
        await appendAdmittedTerminal(target, {
          disposition: "eligible",
          deletionRevision: await store.readDeletionRevision(),
          settingsVersion: (await store.readSettings(workspaceKey)).version,
        });
        const priorLifecycle = new AtomicMemoryLifecycle();
        await new AtomicMemoryRuntime({
          workDir,
          picoHome: f.picoHome,
          sessionId: "leased",
          supported: true,
          preserveSourceTools: false,
          lifecycle: priorLifecycle,
          gate: async () => ({ allowed: true }),
          modelFactory: async () => {
            throw new Error("prior process only enqueues");
          },
        }).completed("source-run");
        await priorLifecycle.close();
        const [job] = await store.listExtractionJobs({ workspaceKey, sessionId, limit: 100 });
        assert.ok(job);
        t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
        t.mock.timers.tick(Math.max(0, job.notBefore - Date.now()));
        const abandoned = await store.claimExtractionJob({
          jobId: job.jobId,
          ownerId: "abandoned-fixture-owner",
          now: Date.now(),
          leaseDurationMs: 10_000,
        });
        assert.ok(abandoned);
        await store.reserveExtractionModelCall(abandoned, "abandoned-operation");
        let calls = 0;
        await recoverRegisteredAtomicMemory({
          ...f,
          workspacePaths: await f.registrationStore.list(),
          modelFactory: async () => ({
            model: {
              call: async () => {
                calls++;
                return completeReview;
              },
            },
          }),
        });
        assert.equal(calls, 0);
        assert.equal(
          (await store.readExtractionJob(job.jobId))?.fencingToken,
          abandoned.fencingToken,
        );
        if (stopBeforeExpiry) await f.lifecycle.close();
        t.mock.timers.tick(9_999);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(calls, 0, "an unexpired foreign lease cannot be reclaimed");
        t.mock.timers.tick(1);
        if (stopBeforeExpiry) {
          for (let n = 0; n < 40; n++) await new Promise<void>((resolve) => setImmediate(resolve));
          const current = await store.readExtractionJob(job.jobId);
          assert.equal(calls, 0);
          assert.equal(current?.state, "working");
          assert.equal(current?.fencingToken, abandoned.fencingToken);
          assert.equal(current?.modelCalls, 1);
        } else {
          await flushUntil(async () => !!(await store.readExtractionCursor(sessionId)));
          const current = await store.readExtractionJob(job.jobId);
          assert.equal(calls, 1);
          assert.equal(current?.state, "settled");
          assert.ok(current!.fencingToken > abandoned.fencingToken);
          assert.equal(
            current?.modelCalls,
            2,
            "lease recovery does not reset the prior model call",
          );
          await assert.rejects(() =>
            store.reserveExtractionModelCall(abandoned, "abandoned-operation"),
          );
          await f.lifecycle.close();
        }
      },
    );
});

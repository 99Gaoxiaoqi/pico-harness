import { SqliteRuntimeEventStore } from "@pico/pico-host/product-runtime-event-store";
import { closeAllOperationalDatabasesForTest, SqliteRuntimeControlStore } from "@pico/storage";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Session } from "@pico/pico-host/session";
import { createEngineRuntimeCapability } from "@pico/pico-host/engine-runtime-port";
import { DefaultHookExecutor } from "@pico/pico-host/hooks/executors";
import type { HookInput, ResolvedHookHandler } from "@pico/pico-host/hooks/types";
import { CostTracker } from "@pico/pico-host/cost-tracker";
import { resolvePicoPaths } from "@pico/pico-host";
import type { LLMProvider } from "@pico/core";

import { RuntimeRun } from "@pico/pico-host/product-runtime-run";
import { projectRuntimeSessionUsage } from "@pico/runtime/session-runtime-projection";
import { physicalProviderFixture } from "../helpers/physical-provider.js";

test("CostTracker preserves provider retry classification", () => {
  const retryable = new Error("provider-specific retry");
  const tracker = new CostTracker(
    {
      async generate() {
        return { role: "assistant", content: "unused" };
      },
      isRetryableError: (error) => error === retryable,
    },
    "unknown-model",
  );

  assert.equal(tracker.isRetryableError(retryable), true);
  assert.equal(tracker.isRetryableError(new Error("fatal")), false);
});

test("durable CostTracker requires and records the matching host RuntimeRun", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-cost-tracker-boundary-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const session = new Session("cost-tracker-boundary", workDir, { persistence: true, picoHome });
  const ledger = new SqliteRuntimeControlStore({
    storageRoot: resolvePicoPaths(workDir, { picoHome }).workspace.root,
  });
  context.after(async () => {
    await session.close();
    ledger.close();
    closeAllOperationalDatabasesForTest();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();
  const store = session.runtimeEventStore;
  assert.ok(store);

  let providerCalls = 0;
  const provider: LLMProvider = {
    async generate() {
      providerCalls++;
      return {
        role: "assistant",
        content: "tracked",
        usage: { promptTokens: 8, completionTokens: 3 },
      };
    },
  };
  const tracked = new CostTracker(
    physicalProviderFixture(provider, "unknown-model"),
    "unknown-model",
    session,
    { ledger, context: { purpose: "main", sessionId: session.id } },
  );

  await assert.rejects(
    tracked.generate([{ role: "user", content: "outside" }], []),
    /matching host-owned RuntimeRun/u,
  );
  assert.equal(providerCalls, 0);

  const capability = session.runtimeEventCapability!;
  await assert.rejects(
    RuntimeRun.start({
      capability: {
        ...capability,
        writeGuard: {
          assertRuntimeEventAuthority: (authority) =>
            session.assertRuntimeEventAuthority(authority),
          assertRuntimeEventWriteAllowed: () => session.assertRuntimeEventWriteAllowed(),
        },
      },
      agentSwarmAuthorization: "none",
    }),
    /was not issued/u,
  );
  const foreignStore = new SqliteRuntimeEventStore({
    storageRoot: join(root, "foreign-runtime"),
  });
  context.after(() => foreignStore.close());
  assert.throws(
    () =>
      createEngineRuntimeCapability({
        owner: session,
        runtimeAuthority: foreignStore,
      }),
    /not owned by Session/u,
  );
  assert.throws(
    () =>
      createEngineRuntimeCapability({
        owner: {
          id: session.id,
          workDir: session.workDir,
          assertRuntimeEventAuthority: () => undefined,
          assertRuntimeEventWriteAllowed: async () => undefined,
        } as unknown as Session,
        runtimeAuthority: foreignStore,
      }),
    /actual Session/u,
  );
  await assert.rejects(
    RuntimeRun.start({
      capability: { ...capability, runtimeAuthority: foreignStore },
      agentSwarmAuthorization: "none",
    }),
    /was not issued/u,
  );
  assert.equal(providerCalls, 0);

  const run = await RuntimeRun.start({ capability, agentSwarmAuthorization: "none" });
  const response = await run.run(() => tracked.generate([{ role: "user", content: "inside" }], []));
  assert.equal(response.content, "tracked");
  assert.equal(providerCalls, 1);

  const runEvents = await store.readRun(session.id, run.runId);
  assert.deepEqual(
    runEvents.map((event) => event.kind),
    ["run.started", "model.call.started", "model.call.settled", "run.terminal"],
  );
  const events = await store.readSession(session.id);
  assert.deepEqual(session.getRuntimeStateSnapshot().usage, projectRuntimeSessionUsage(events));
});

test("prompt Hook never calls a Provider without the host modelRuntime capability", async (context) => {
  const workDir = await mkdtemp(join(tmpdir(), "pico-hook-runtime-boundary-"));
  context.after(() => rm(workDir, { recursive: true, force: true }));
  let providerCalls = 0;
  const provider: LLMProvider = {
    async generate() {
      providerCalls++;
      return { role: "assistant", content: '{"ok":true,"reason":"PICO_HOOK_OK"}' };
    },
  };
  const resolved: ResolvedHookHandler = {
    id: "prompt-runtime-boundary",
    event: "UserPromptSubmit",
    source: { kind: "project", path: join(workDir, "hooks.json"), version: 1 },
    order: 0,
    handler: { type: "prompt", prompt: "allow" },
    trusted: true,
  };
  const input: HookInput<"UserPromptSubmit"> = {
    session_id: "hook-runtime-boundary",
    cwd: workDir,
    hook_event_name: "UserPromptSubmit",
    payload: { prompt: "hello" },
  };

  const withoutRuntime = new DefaultHookExecutor({ workDir, provider });
  context.after(() => withoutRuntime.dispose());
  const failOpen = await withoutRuntime.execute(resolved, input, {});
  assert.equal(providerCalls, 0);
  assert.equal(failOpen.decision, "allow");
  assert.match(failOpen.diagnostics?.[0]?.message ?? "", /未配置 RuntimeRun/u);

  let runtimeCalls = 0;
  const withRuntime = new DefaultHookExecutor({
    workDir,
    provider,
    modelRuntime: {
      async run(execute) {
        runtimeCalls++;
        return execute();
      },
    },
  });
  context.after(() => withRuntime.dispose());
  const allowed = await withRuntime.execute(resolved, input, {});
  assert.equal(runtimeCalls, 1);
  assert.equal(providerCalls, 1);
  assert.deepEqual(allowed, { decision: "allow", reason: "PICO_HOOK_OK" });
});

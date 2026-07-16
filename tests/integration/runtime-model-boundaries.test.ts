import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Session } from "../../src/engine/session.js";
import { DefaultHookExecutor } from "../../src/hooks/executors/index.js";
import type { HookInput, ResolvedHookHandler } from "../../src/hooks/types.js";
import { CostTracker } from "../../src/observability/tracker.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import { RuntimeRun } from "../../src/runtime/runtime-run.js";
import { projectRuntimeSessionUsage } from "../../src/runtime/runtime-session-projection.js";

test("durable CostTracker requires and records the matching host RuntimeRun", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-cost-tracker-boundary-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const session = new Session("cost-tracker-boundary", workDir, { persistence: true, picoHome });
  context.after(async () => {
    await session.close();
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
  const tracked = new CostTracker(provider, "unknown-model", session);

  await assert.rejects(
    tracked.generate([{ role: "user", content: "outside" }], []),
    /matching host-owned RuntimeRun/u,
  );
  assert.equal(providerCalls, 0);

  const mismatchedRun = await RuntimeRun.start({
    sessionId: session.id,
    workDir,
    store,
    writeGuard: {
      assertRuntimeEventWriteAllowed: () => session.assertRuntimeEventWriteAllowed(),
    },
  });
  await mismatchedRun.run(async () => {
    await assert.rejects(
      tracked.generate([{ role: "user", content: "mismatched" }], []),
      /matching host-owned RuntimeRun/u,
    );
  });
  assert.equal(providerCalls, 0);

  const run = await RuntimeRun.start({
    sessionId: session.id,
    workDir,
    store,
    writeGuard: session,
  });
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

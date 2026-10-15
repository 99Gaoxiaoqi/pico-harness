import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AtomicMemoryLifecycle } from "@pico/runtime";
import { recordRuntimeCompactionCheckpoint } from "@pico/runtime/runtime-compaction-checkpoint";
import {
  memorySessionKey,
  type MemoryModelRequest,
} from "@pico/core/atomic-memory-runtime-contracts";
import { AtomicMemoryRuntime } from "@pico/pico-host/atomic-memory-runtime";
import { FullCompactor } from "@pico/pico-host/product-full-compactor";
import { RuntimeRun } from "@pico/pico-host/product-runtime-run";
import { Session } from "@pico/pico-host/session";
import { resolvePicoPaths } from "@pico/pico-host";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";

const empty = JSON.stringify({
  status: "complete",
  coverageStatus: "processed",
  requestedStatus: "not_applicable",
  requestedItems: [],
  incidentalItems: [],
});
const summary = [
  "## Goal\nContinue the project discussion.",
  "## Progress\nThe previous project context was reviewed.",
  "## Key Decisions\nThe old project uses Rust.",
  "## Constraints\nPreserve user constraints.",
  "## Next Steps\nContinue with the latest user request.",
  "## Critical Context\nThe old project uses Rust.",
  "## Evidence\n(none)",
].join("\n\n");

async function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = await mkdtemp(join(tmpdir(), "pico-memory-idle-"));
  const workDir = join(root, "workspace"),
    picoHome = join(root, "home"),
    sessionId = "idle";
  await mkdir(workDir);
  const paths = resolvePicoPaths(workDir, { picoHome });
  const session = new Session(sessionId, workDir, { persistence: true, picoHome });
  await session.recover();
  const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
  const requests: MemoryModelRequest[] = [];
  const pending = new Set<Promise<void>>();
  const lifecycles: AtomicMemoryLifecycle[] = [];
  const makeRuntime = () => {
    const lifecycle = new AtomicMemoryLifecycle(() => {
      const completion = Promise.withResolvers<void>();
      pending.add(completion.promise);
      return {
        release: () => {
          pending.delete(completion.promise);
          completion.resolve();
        },
      };
    });
    lifecycles.push(lifecycle);
    const runtime = new AtomicMemoryRuntime({
      workDir,
      picoHome,
      sessionId,
      lifecycle,
      supported: true,
      gate: async () => ({ allowed: true }),
      modelFactory: async () => ({
        model: {
          async call(request) {
            requests.push(request);
            return empty;
          },
        },
      }),
    });
    return { runtime, lifecycle };
  };
  const current = makeRuntime();
  const tick = async (ms: number) => {
    t.mock.timers.tick(ms);
    while (pending.size) await Promise.allSettled([...pending]);
  };
  t.after(async () => {
    await Promise.all(lifecycles.map((lifecycle) => lifecycle.close()));
    store.close();
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  const admission = async () => ({
    disposition: "eligible" as const,
    deletionRevision: await store.readDeletionRevision(),
    settingsVersion: (await store.readSettings(paths.workspace.id)).version,
  });
  const run = async (content: string, within?: (run: RuntimeRun) => Promise<void>) => {
    const run = await RuntimeRun.start({
      capability: session.runtimeEventCapability!,
      agentSwarmAuthorization: "none",
    });
    await run.run(async () => {
      await run.commitMessages(session, [
        { role: "user", content },
        { role: "assistant", content: "Received." },
      ]);
      await current.runtime.capture(await run.readModelHistory(), []);
      await within?.(run);
      run.setMemoryExtractionBoundary(await admission());
    });
    await current.runtime.completed(run.runId);
    return run;
  };
  const checkpoint = async (run: RuntimeRun) => {
    await run.commitMessages(session, [
      { role: "user", content: "My old project uses Rust. " + "Old context. ".repeat(80) },
      { role: "assistant", content: "Understood. " + "Old context. ".repeat(80) },
      { role: "user", content: "Continue." },
      { role: "assistant", content: "Continuing." },
    ]);
    const checkpoint = await recordRuntimeCompactionCheckpoint({
      session,
      runtimeRun: run,
      compactor: new FullCompactor({
        provider: {
          async generate() {
            return { role: "assistant", content: summary };
          },
        },
        maxAttempts: 1,
      }),
      request: { inputBudgetTokens: 4000, targetRetainedTokens: 1, trigger: "manual" },
      memoryAdmission: admission,
    });
    assert.ok(checkpoint);
    await current.runtime.checkpoint(checkpoint.checkpointId);
    return checkpoint;
  };
  return {
    ...current,
    run,
    checkpoint,
    makeRuntime,
    requests,
    tick,
    session,
    store,
    sessionKey: memorySessionKey(paths.workspace.id, sessionId),
  };
}

test("自动提取在空闲30秒后执行，新输入重新计时并合并多个完成边界", async (t) => {
  const f = await fixture(t);
  await f.run("I prefer concise Chinese answers.");
  await f.tick(29_999);
  assert.equal(f.requests.length, 0);
  await f.runtime.capture([{ role: "user", content: "Continue with a new task." }], []);
  await f.tick(1);
  assert.equal(f.requests.length, 0, "new input cancels the old deadline");
  await f.tick(29_998);
  assert.equal(f.requests.length, 0);
  const latest = await f.run("My project uses TypeScript.");
  await f.tick(29_999);
  assert.equal(f.requests.length, 0, "completion resets the shared idle window");
  await f.tick(1);
  assert.equal(
    f.requests.length,
    2,
    "each independently admitted completed range is processed once",
  );
  assert.ok(
    f.requests.some((request) =>
      JSON.stringify(request.sourceMessages).includes("concise Chinese"),
    ),
  );
  assert.ok(
    f.requests.some((request) => JSON.stringify(request.sourceMessages).includes("TypeScript")),
  );
  const entries = await f.session.runtimeEventStore!.readSessionEntries(f.session.id);
  assert.equal(
    (await f.store.readExtractionCursor(f.sessionKey))?.processedOrdinal,
    entries.find(({ event }) => event.kind === "run.terminal" && event.runId === latest.runId)!
      .sequence,
  );
  await f.tick(60_000);
  assert.equal(f.requests.length, 2);
});

test("checkpoint与完成共享空闲窗口，重复通知只处理一次且覆盖到最后边界", async (t) => {
  const f = await fixture(t);
  const run = await f.run("Continue the project discussion.", async (run) => {
    const checkpoint = await f.checkpoint(run);
    await f.runtime.checkpoint(checkpoint.checkpointId);
    await f.tick(29_999);
    assert.equal(f.requests.length, 0);
  });
  await f.runtime.completed(run.runId);
  await f.tick(1);
  assert.equal(f.requests.length, 0);
  await f.tick(29_999);
  assert.ok(f.requests.length > 0);
  const operations = f.requests.map((request) => request.operationId);
  assert.equal(
    new Set(operations).size,
    operations.length,
    "no duplicate proposal for a checkpoint/terminal boundary",
  );
  const entries = await f.session.runtimeEventStore!.readSessionEntries(f.session.id);
  assert.equal(
    (await f.store.readExtractionCursor(f.sessionKey))?.processedOrdinal,
    entries.find(({ event }) => event.kind === "run.terminal" && event.runId === run.runId)!
      .sequence,
  );
  const count = f.requests.length;
  await f.tick(60_000);
  assert.equal(f.requests.length, count);
});

test("生命周期关闭取消尚未触发的提取，下一生命周期可恢复持久化边界", async (t) => {
  const f = await fixture(t);
  const run = await f.run("I prefer concise Chinese answers.");
  await f.tick(29_999);
  await f.lifecycle.close();
  await f.tick(60_000);
  assert.equal(f.requests.length, 0);
  assert.equal(await f.store.readExtractionCursor(f.sessionKey), undefined);
  const recovering = f.makeRuntime();
  await recovering.runtime.completed(run.runId);
  await f.tick(30_000);
  assert.equal(f.requests.length, 1);
});

for (const timing of ["before", "after"] as const) {
  test(`显式remember在完成${timing === "before" ? "前" : "后"}取消本轮自动提取`, async (t) => {
    const f = await fixture(t);
    await f.run(
      "I prefer concise Chinese answers.",
      timing === "before"
        ? async (run) => {
            await f.checkpoint(run);
            await f.runtime.capture(await run.readModelHistory(), []);
            assert.notEqual((await f.runtime.remember()).status, "unavailable");
          }
        : undefined,
    );
    if (timing === "after") {
      await f.runtime.capture([{ role: "user", content: "I prefer concise Chinese answers." }], []);
      assert.notEqual((await f.runtime.remember()).status, "unavailable");
    }
    const calls = f.requests.length;
    assert.ok(calls > 0);
    await f.tick(30_000);
    assert.equal(
      f.requests.length,
      calls,
      "explicit remembering consumes this run's pending automatic work",
    );
  });
}

test("CLI完成后不被空闲提取计时器阻止退出，持久化边界保持可恢复", async (t) => {
  const f = await fixture(t);
  const run = await f.run("I prefer concise Chinese answers.");
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { AtomicMemoryRuntime } from '@pico/pico-host/atomic-memory-runtime';
    const runtime = new AtomicMemoryRuntime({
      workDir: process.argv[1], picoHome: process.argv[2], sessionId: process.argv[3], supported: true,
      gate: async () => ({allowed:true}), modelFactory: async () => { throw new Error('idle extraction ran before exit'); }
    });
    await runtime.completed(process.argv[4]);
    process.stdout.write('scheduled');
  `,
      f.session.workDir,
      f.session.picoHome,
      f.session.id,
      run.runId,
    ],
    { cwd: process.cwd(), encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "scheduled");
  assert.equal(await f.store.readExtractionCursor(f.sessionKey), undefined);
  assert.ok(
    (await f.session.runtimeEventStore!.readSessionEntries(f.session.id)).some(
      ({ event }) =>
        event.kind === "run.terminal" &&
        event.runId === run.runId &&
        event.data.memoryExtractionBoundary?.disposition === "eligible",
    ),
  );
});

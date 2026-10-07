import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createRuntimeRequest, parseStrictRuntimeParams, type JsonObject } from "@pico/protocol";
import { DesktopRuntimeService } from "@pico/pico-host/desktop-runtime-service";
import { WorkspaceRuntimeService } from "@pico/pico-host/workspace-runtime-service";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { SqliteDesktopConversationStateStore } from "@pico/pico-host";
import { globalSessionManager } from "@pico/pico-host/session";
import { writeDesktopModelRouting } from "../../fixtures/desktop-model-routing.js";

test(
  "queued text can steer its current run once; conflicts and failures retain the input",
  { timeout: 20_000 },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-queue-steer-"));
    const picoHome = join(root, "home");
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath);
    await mkdir(picoHome);
    await writeDesktopModelRouting(picoHome);
    const canonical = await realpath(workspacePath);
    const env = { PICO_HOME: picoHome, PICO_TEST_TOKEN: "test-token" };
    const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
    await trustStore.trust(canonical);
    const store = new SqliteDesktopConversationStateStore({ picoHome });
    const received: string[] = [];
    let starts = 0;
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const runtime = new WorkspaceRuntimeService({
      env,
      execute: async ({ context: run }) => {
        starts++;
        run.onSteer((message) => received.push(message));
        ready();
        if (!run.signal.aborted)
          await new Promise<void>((resolve) =>
            run.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        await cleanup;
      },
    });
    const desktop = new DesktopRuntimeService({
      runtimeService: runtime,
      env,
      trustStore,
      conversationStateStore: store,
      createSessionId: () => "queue-steer-session",
    });
    context.after(async () => {
      finishCleanup();
      await desktop.close();
      await globalSessionManager.delete("queue-steer-session", canonical, { picoHome })?.close();
      await rm(root, { recursive: true, force: true });
    });
    const first = (await desktop.handle(
      createRuntimeRequest("session.send", {
        workspacePath,
        input: { kind: "text", text: "start" },
        idempotencyKey: "first",
      }),
    )) as JsonObject;
    await started;
    const sessionId = (first["session"] as JsonObject)["sessionId"] as string;
    const expectedRunId = (first["run"] as JsonObject)["runId"] as string;
    const send = (text: string) =>
      desktop.handle(
        createRuntimeRequest("session.send", {
          workspacePath,
          sessionId,
          input: { kind: "text", text },
          behavior: "queue",
          expectedRunId,
          idempotencyKey: text,
        }),
      );
    await send("first queued");
    await send("guide now");
    const items = await store.listQueued(canonical, sessionId);
    const params = { workspacePath, sessionId, queueId: items[1]!.queueId, expectedRunId };
    assert.throws(() =>
      parseStrictRuntimeParams("session.queue.steer", {
        workspacePath,
        sessionId,
        queueId: params.queueId,
      }),
    );
    const results = await Promise.all(
      [1, 2].map(() => desktop.handle(createRuntimeRequest("session.queue.steer", params))),
    );
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(received, ["guide now"]);
    assert.deepEqual(
      (await store.listQueued(canonical, sessionId)).map((item) => item.input),
      [{ kind: "text", text: "first queued" }],
    );

    const conflict = (error: unknown) => (error as { code?: string }).code === "CONFLICT";
    await assert.rejects(
      desktop.handle(
        createRuntimeRequest("session.queue.steer", { ...params, expectedRunId: "stale-run" }),
      ),
      conflict,
    );
    await assert.rejects(
      desktop.handle(
        createRuntimeRequest("session.queue.steer", {
          ...params,
          queueId: items[0]!.queueId,
          expectedRunId: "stale-run",
        }),
      ),
      conflict,
    );
    const skill = await store.enqueue(canonical, sessionId, {
      kind: "skill",
      name: "review",
      args: "keep",
    });
    await assert.rejects(
      desktop.handle(
        createRuntimeRequest("session.queue.steer", { ...params, queueId: skill.queueId }),
      ),
      conflict,
    );

    const failureItem = await store.enqueue(canonical, sessionId, {
      kind: "text",
      text: "retry safely",
    });
    const handle = runtime.handle.bind(runtime);
    runtime.handle = async (request) => {
      if (request.method === "run.steer") throw new Error("steer rejected");
      return handle(request);
    };
    const retryParams = { ...params, queueId: failureItem.queueId };
    await assert.rejects(
      desktop.handle(createRuntimeRequest("session.queue.steer", retryParams)),
      /steer rejected/u,
    );
    assert.ok(
      (await store.listQueued(canonical, sessionId)).some(
        (item) => item.queueId === failureItem.queueId,
      ),
    );
    assert.deepEqual(received, ["guide now"]);
    runtime.handle = handle;

    const remember = store.rememberIdempotent.bind(store);
    let failReceipt = true;
    store.rememberIdempotent = async (...args) => {
      if (args[1].startsWith("queue-steer:") && failReceipt) {
        failReceipt = false;
        throw new Error("receipt rejected");
      }
      return remember(...args);
    };
    await assert.rejects(
      desktop.handle(createRuntimeRequest("session.queue.steer", retryParams)),
      /receipt rejected/u,
    );
    await assert.rejects(
      desktop.handle(
        createRuntimeRequest("session.queue.update", {
          workspacePath,
          sessionId,
          queueId: retryParams.queueId,
          input: { kind: "text", text: "must not disappear" },
        }),
      ),
      conflict,
    );
    await desktop.handle(createRuntimeRequest("session.queue.steer", retryParams));
    assert.deepEqual(received, ["guide now", "retry safely"]);

    const deletionItem = await store.enqueue(canonical, sessionId, {
      kind: "text",
      text: "delete safely",
    });
    const deletionParams = { ...params, queueId: deletionItem.queueId };

    // A receipt survives a failed queue deletion, allowing a retry to finish cleanup.
    const remove = store.removeQueuedForSession.bind(store);
    let failDelete = true;
    store.removeQueuedForSession = async (...args) => {
      if (args[2] === deletionItem.queueId && failDelete) {
        failDelete = false;
        throw new Error("delete rejected");
      }
      return remove(...args);
    };
    await assert.rejects(
      desktop.handle(createRuntimeRequest("session.queue.steer", deletionParams)),
      /delete rejected/u,
    );
    await assert.rejects(
      desktop.handle(
        createRuntimeRequest("session.queue.update", {
          workspacePath,
          sessionId,
          queueId: deletionParams.queueId,
          input: { kind: "text", text: "must not disappear" },
        }),
      ),
      conflict,
    );
    await desktop.handle(createRuntimeRequest("session.queue.steer", deletionParams));
    assert.deepEqual(received, ["guide now", "retry safely", "delete safely"]);
    assert.deepEqual(
      (await store.listQueued(canonical, sessionId)).map((item) => item.queueId),
      [items[0]!.queueId, skill.queueId],
    );
    await desktop.handle(
      createRuntimeRequest("session.queue.remove", {
        workspacePath,
        sessionId,
        queueId: items[0]!.queueId,
      }),
    );
    await assert.rejects(
      desktop.handle(
        createRuntimeRequest("session.queue.steer", { ...params, queueId: items[0]!.queueId }),
      ),
      conflict,
    );
    assert.deepEqual(received, ["guide now", "retry safely", "delete safely"]);

    await remove(canonical, sessionId, skill.queueId);
    const endItem = await store.enqueue(canonical, sessionId, {
      kind: "text",
      text: "clean on completion",
    });
    let failEndDelete = true;
    store.removeQueuedForSession = async (...args) => {
      if (args[2] === endItem.queueId && failEndDelete) {
        failEndDelete = false;
        throw new Error("end delete rejected");
      }
      return remove(...args);
    };
    await assert.rejects(
      desktop.handle(
        createRuntimeRequest("session.queue.steer", { ...params, queueId: endItem.queueId }),
      ),
      /end delete rejected/u,
    );
    const cancellingItem = await store.enqueue(canonical, sessionId, {
      kind: "text",
      text: "retain while cancelling",
    });
    // Cancel at the Runtime layer to observe in-flight cancellation without the
    // desktop Stop command's intentional clearing of the entire pending queue.
    await runtime.handle(
      createRuntimeRequest("run.cancel", { workspacePath, runId: expectedRunId }),
    );
    await assert.rejects(
      desktop.handle(
        createRuntimeRequest("session.queue.steer", { ...params, queueId: cancellingItem.queueId }),
      ),
      conflict,
    );
    assert.ok(
      (await store.listQueued(canonical, sessionId)).some(
        (item) => item.queueId === cancellingItem.queueId,
      ),
    );
    await remove(canonical, sessionId, cancellingItem.queueId);
    finishCleanup();
    const deadline = Date.now() + 5_000;
    while ((await store.listQueued(canonical, sessionId)).length && Date.now() < deadline)
      await delay(10);
    assert.deepEqual(await store.listQueued(canonical, sessionId), []);
    assert.equal(
      starts,
      1,
      "an accepted steer left by deletion failure must not start another Run",
    );
    assert.deepEqual(received, [
      "guide now",
      "retry safely",
      "delete safely",
      "clean on completion",
    ]);
  },
);

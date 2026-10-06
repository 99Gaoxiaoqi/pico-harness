import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import { test } from "node:test";
import {
  createRuntimeRequest,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  type JsonObject,
} from "@pico/protocol";
import { DesktopRuntimeService } from "@pico/pico-host/desktop-runtime-service";
import { WorkspaceRuntimeService } from "@pico/pico-host/workspace-runtime-service";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { SqliteDesktopConversationStateStore } from "@pico/pico-host";
import { globalSessionManager } from "@pico/pico-host/session";
import { writeDesktopModelRouting } from "../../fixtures/desktop-model-routing.js";

test(
  "session.send replayOnly joins pending sends, recovers lost responses and cannot recreate evicted first/queue/steer effects",
  { timeout: 20_000 },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-send-replay-only-"));
    const picoHome = join(root, "pico-home");
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath);
    await mkdir(picoHome);
    await writeDesktopModelRouting(picoHome);
    const canonical = await realpath(workspacePath);
    const env = { PICO_HOME: picoHome, PICO_TEST_TOKEN: "test-token" };
    const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
    await trustStore.trust(canonical);
    let clock = 0;
    let sessions = 0;
    let starts = 0;
    let steers = 0;
    let queued = 0;
    let claims = 0;
    const store = new SqliteDesktopConversationStateStore({ picoHome, now: () => ++clock });
    const rememberEntered = deferred();
    const releaseRemember = deferred();
    const remember = store.rememberIdempotent.bind(store);
    store.rememberIdempotent = async (...args) => {
      if (args[1] === "first") {
        rememberEntered.resolve();
        await releaseRemember.promise;
      }
      return remember(...args);
    };
    const enqueue = store.enqueue.bind(store);
    store.enqueue = async (...args) => {
      queued++;
      return enqueue(...args);
    };
    const claim = store.claimFirstSend.bind(store);
    store.claimFirstSend = async (...args) => {
      claims++;
      return claim(...args);
    };
    const runtime = new WorkspaceRuntimeService({
      env,
      execute: async ({ context: run }) => {
        starts++;
        if (run.signal.aborted) return;
        await new Promise<void>((resolve) =>
          run.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    });
    const originalHandle = runtime.handle.bind(runtime);
    runtime.handle = async (request) => {
      if (request.method === "run.steer") steers++;
      return originalHandle(request);
    };
    const desktop = new DesktopRuntimeService({
      runtimeService: runtime,
      env,
      trustStore,
      conversationStateStore: store,
      createSessionId: () => `replay-session-${++sessions}`,
    });
    context.after(async () => {
      releaseRemember.resolve();
      await desktop.close();
      for (let index = 1; index <= sessions; index++)
        await globalSessionManager
          .delete(`replay-session-${index}`, canonical, { picoHome })
          ?.close();
      await rm(root, { recursive: true, force: true });
    });
    const firstParams = {
      workspacePath,
      input: { kind: "text" as const, text: "first" },
      idempotencyKey: "first",
    };
    const first = desktop.handle(createRuntimeRequest("session.send", firstParams));
    await rememberEntered.promise;
    let recoveredPending = false;
    const recovery = desktop
      .handle(createRuntimeRequest("session.send", { ...firstParams, replayOnly: true }))
      .then((result) => {
        recoveredPending = true;
        return result;
      });
    await nextTick();
    assert.equal(recoveredPending, false);
    releaseRemember.resolve();
    const result = (await first) as JsonObject;
    assert.deepEqual(await recovery, result);
    const sessionId = (result["session"] as JsonObject)["sessionId"] as string;
    assert.deepEqual(
      await desktop.handle(
        createRuntimeRequest("session.send", { ...firstParams, replayOnly: true }),
      ),
      result,
      "a discarded successful response is recovered without resending",
    );
    const queueParams = {
      workspacePath,
      sessionId,
      input: { kind: "text" as const, text: "queue" },
      behavior: "queue" as const,
      idempotencyKey: "queue",
    };
    const steerParams = {
      workspacePath,
      sessionId,
      input: { kind: "text" as const, text: "steer" },
      behavior: "steer" as const,
      idempotencyKey: "steer",
    };
    for (const params of [queueParams, steerParams]) {
      const accepted = await desktop.handle(createRuntimeRequest("session.send", params));
      assert.deepEqual(
        await desktop.handle(createRuntimeRequest("session.send", { ...params, replayOnly: true })),
        accepted,
      );
    }
    await assert.rejects(
      desktop.handle(
        createRuntimeRequest("session.send", {
          ...firstParams,
          replayOnly: true,
          input: { kind: "text", text: "changed" },
        }),
      ),
      (error: unknown) =>
        error instanceof RuntimeProtocolError && error.code === RUNTIME_ERROR_CODES.CONFLICT,
    );
    for (let index = 0; index < 501; index++)
      await remember(canonical, `cache-${index}`, `fingerprint-${index}`, { accepted: true });
    assert.equal(await store.getIdempotent(canonical, "first"), undefined);
    const before = { sessions, starts, steers, queued, claims };
    const queuedBefore = await store.listQueued(canonical, sessionId);
    for (const params of [firstParams, queueParams, steerParams])
      await assert.rejects(
        desktop.handle(createRuntimeRequest("session.send", { ...params, replayOnly: true })),
        (error: unknown) =>
          error instanceof RuntimeProtocolError &&
          error.code === RUNTIME_ERROR_CODES.SEND_RECOVERY_UNAVAILABLE,
      );
    assert.deepEqual({ sessions, starts, steers, queued, claims }, before);
    assert.deepEqual(await store.listQueued(canonical, sessionId), queuedBefore);
    const ping = (await desktop.handle(createRuntimeRequest("runtime.ping", {}))) as JsonObject;
    assert.ok((ping["capabilities"] as string[]).includes("session-send-replay-v1"));
  },
);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import { test } from "node:test";
import { createRuntimeRequest, type JsonObject } from "@pico/protocol";
import { DesktopRuntimeService } from "@pico/pico-host/desktop-runtime-service";
import { WorkspaceRuntimeService } from "@pico/pico-host/workspace-runtime-service";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { SqliteDesktopConversationStateStore } from "@pico/pico-host";
import { globalSessionManager } from "@pico/pico-host/session";
import { writeDesktopModelRouting } from "../../fixtures/desktop-model-routing.js";

test("session.send holds serial Provider admission through Run registration and idempotency commit", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-provider-admission-entry-"));
  const picoHome = join(root, "pico-home");
  await mkdir(picoHome);
  await writeDesktopModelRouting(picoHome);
  const env = { PICO_HOME: picoHome, PICO_TEST_TOKEN: "test-token" };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  const workspaces: string[] = [];
  for (const name of ["first", "second"]) {
    const path = join(root, name);
    await mkdir(path);
    const canonical = await realpath(path);
    await trustStore.trust(canonical);
    workspaces.push(canonical);
  }
  const entered = deferred();
  const release = deferred();
  const store = new SqliteDesktopConversationStateStore({ picoHome });
  const originalRemember = store.rememberIdempotent.bind(store);
  store.rememberIdempotent = async (...args) => {
    if (args[1] === "first") {
      entered.resolve();
      await release.promise;
    }
    return originalRemember(...args);
  };
  let sessions = 0;
  let executions = 0;
  const runtime = new WorkspaceRuntimeService({
    env,
    execute: async ({ context: run }) => {
      executions++;
      if (run.signal.aborted) return;
      await new Promise<void>((resolve) =>
        run.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
  });
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    env,
    trustStore,
    conversationStateStore: store,
    createSessionId: () => `admission-session-${++sessions}`,
  });
  context.after(async () => {
    release.resolve();
    await desktop.close();
    for (let index = 0; index < workspaces.length; index++)
      await globalSessionManager
        .delete(`admission-session-${index + 1}`, workspaces[index]!, { picoHome })
        ?.close();
    await rm(root, { recursive: true, force: true });
  });
  const first = desktop.handle(
    createRuntimeRequest("session.send", {
      workspacePath: workspaces[0]!,
      input: { kind: "text", text: "first" },
      idempotencyKey: "first",
    }),
  );
  await entered.promise;
  const second = desktop.handle(
    createRuntimeRequest("session.send", {
      workspacePath: workspaces[1]!,
      input: { kind: "text", text: "second" },
      idempotencyKey: "second",
    }),
  );
  await nextTick();
  assert.equal(sessions, 1);
  assert.equal(executions, 1);
  assert.equal(await store.getIdempotent(workspaces[0]!, "first"), undefined);
  release.resolve();
  const [left, right] = await Promise.all([first, second]);
  assert.equal((left as JsonObject)["disposition"], "started");
  assert.equal((right as JsonObject)["disposition"], "started");
  assert.equal(executions, 2);
  const metrics = desktop.providerAdmissionMetrics();
  assert.equal(metrics["session.send"].count, 2);
  assert.ok(metrics["session.send"].queueMs > 0);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

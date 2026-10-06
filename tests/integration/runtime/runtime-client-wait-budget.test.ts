import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  RuntimeHostKernel,
} from "@pico/runtime-host";
import {
  LocalRuntimeClient,
  runtimeRequestTimeoutMsForMethod,
} from "@pico/pico-host/local-runtime-client";
import { createRuntimeHostCompositionFactory } from "@pico/pico-host/runtime-host-composition";
import { ensurePicoRuntimeHostOperationsRegistered } from "@pico/pico-host/runtime-host-operations";
import {
  CAPABILITY_SCOPE_RUNTIME_CAPABILITY,
  DESKTOP_RUNTIME_SCHEMA_CAPABILITY,
  DESKTOP_RUNTIME_SCHEMA_REVISION,
  LOCAL_RUNTIME_PROTOCOL_VERSION,
  TEMPORARY_WORKSPACE_RUNTIME_CAPABILITY,
  RuntimeProtocolError,
  type JsonValue,
  RUNTIME_ERROR_CODES,
} from "@pico/protocol";

test("client wait budget: healthy timeout preserves connection, reconciles late response and never replays", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-client-wait-"));
  const capability = await resolveStorageRoot({ path: root, kind: "interactive" });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  ensurePicoRuntimeHostOperationsRegistered();
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  let reads = 0;
  let writes = 0;
  let launches = 0;
  const metrics: Array<{ method: string; encodedBytes: number; decodeMs: number }> = [];
  const config = { version: 1 as const, defaults: {}, providers: [] };
  const kernel = await RuntimeHostKernel.start({
    owner,
    compositionFactory: createRuntimeHostCompositionFactory({
      service: {
        async handle(request): Promise<JsonValue> {
          if (request.method === "runtime.ping")
            return {
              pong: true,
              protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
              desktopSchemaRevision: DESKTOP_RUNTIME_SCHEMA_REVISION,
              picoHome: root,
              capabilities: [
                DESKTOP_RUNTIME_SCHEMA_CAPABILITY,
                CAPABILITY_SCOPE_RUNTIME_CAPABILITY,
                TEMPORARY_WORKSPACE_RUNTIME_CAPABILITY,
              ],
            };
          if (request.method === "config.user.get") {
            reads++;
            if (reads === 1) await held;
            return { config, revision: "r1" };
          }
          if (request.method === "config.user.update") {
            writes++;
            await new Promise((done) => setTimeout(done, 80));
            return { config, revision: "r2" };
          }
          if (request.method === "session.send")
            throw new RuntimeProtocolError(
              RUNTIME_ERROR_CODES.SEND_RECOVERY_UNAVAILABLE,
              "无法确认原发送结果",
            );
          throw new Error("unexpected method");
        },
        close() {
          release();
        },
      },
    }),
  });
  const client = new LocalRuntimeClient({
    runtimeHostRootPath: root,
    candidateLauncher: () => {
      launches++;
      throw new Error("must not launch another Host");
    },
    requestTimeoutMsForMethod: (method) => (method === "config.user.get" ? 30 : 500),
    onResponseMetrics: (sample) => metrics.push(sample),
  });
  t.after(async () => {
    release();
    client.close();
    await kernel.close();
    await owner.close();
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(
    client.request("config.user.get", {}),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "RUNTIME_REQUEST_TIMEOUT" &&
      "retryable" in error &&
      error.retryable === false,
  );
  assert.equal(reads, 1);
  assert.equal(launches, 0);
  assert.equal((await client.request("runtime.ping", {})).pong, true);
  release();
  await new Promise((done) => setTimeout(done, 25));
  assert.equal((await client.request("config.user.get", {})).revision, "r1");
  assert.equal(
    (await client.request("config.user.update", { defaults: {}, expectedRevision: "r1" })).revision,
    "r2",
  );
  assert.equal(writes, 1);
  await Promise.all(Array.from({ length: 20 }, () => client.request("runtime.ping", {})));
  await assert.rejects(
    client.request("session.send", {
      workspacePath: root,
      input: { kind: "text", text: "原请求" },
      idempotencyKey: "original",
      replayOnly: true,
    }),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "SEND_RECOVERY_UNAVAILABLE",
  );
  assert.equal(launches, 0);
  assert.ok(
    metrics.some(
      (sample) =>
        sample.method === "config.user.update" && sample.encodedBytes > 0 && sample.decodeMs >= 0,
    ),
  );
  assert.equal(runtimeRequestTimeoutMsForMethod("runtime.ping"), 5000);
  assert.equal(runtimeRequestTimeoutMsForMethod("config.user.get"), 30000);
  assert.equal(runtimeRequestTimeoutMsForMethod("provider.test"), 125000);
});

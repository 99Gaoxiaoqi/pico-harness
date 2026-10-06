import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  RuntimeHostKernel,
} from "@pico/runtime-host";
import { LocalRuntimeClient } from "@pico/pico-host/local-runtime-client";
import { WorkspaceRuntimeService } from "@pico/pico-host/workspace-runtime-service";
import { SqliteRuntimeControlStore } from "@pico/storage/sqlite/sqlite-runtime-control-store";
import { resolvePicoPaths } from "@pico/pico-host/pico-paths";
import { createRuntimeHostCompositionFactory } from "@pico/pico-host/runtime-host-composition";
import { ensurePicoRuntimeHostOperationsRegistered } from "@pico/pico-host/runtime-host-operations";
import { RUN_POINT_LOOKUP_RUNTIME_CAPABILITY, DESKTOP_RUNTIME_METHODS } from "@pico/protocol";
import { parseRemoteRequest, type RemoteRequest } from "@pico/protocol/remote";
import {
  authorizeRuntimeRequest,
  type GatewayRuntimeClient,
} from "../../../packages/remote-gateway/src/policy.js";
import { GatewayError } from "../../../packages/remote-gateway/src/errors.js";

test("local Run point lookup preserves legacy authorization and remains bounded at 10000 rows", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-run-lookup-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const other = join(root, "other");
  await Promise.all([mkdir(home), mkdir(workspace), mkdir(other)]);
  const canonical = await realpath(workspace);
  const otherPath = await realpath(other);
  const seed = (start: number, end: number) => {
    const store = new SqliteRuntimeControlStore({
      storageRoot: resolvePicoPaths(canonical, { picoHome: home }).workspace.root,
    });
    for (let i = start; i < end; i++)
      store.upsertDaemonRun({
        runId: `history-${i}`,
        workspacePath: canonical,
        sessionId: "correct",
        description: "history",
        status: "succeeded",
        startedAt: i + 1,
        updatedAt: i + 2,
        finishedAt: i + 2,
        version: 1,
      });
    store.close();
  };
  seed(0, 100);
  ensurePicoRuntimeHostOperationsRegistered();
  const service = new WorkspaceRuntimeService({
    env: { PICO_HOME: home },
    execute: async () => undefined,
  });
  const capability = await resolveStorageRoot({ path: home, kind: "interactive" });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const kernel = await RuntimeHostKernel.start({
    owner,
    compositionFactory: createRuntimeHostCompositionFactory({ service }),
  });
  let phase = "before";
  const sizes: { phase: string; bytes: number }[] = [];
  const client = new LocalRuntimeClient({
    runtimeHostRootPath: home,
    onResponseMetrics: (metric) => {
      if (metric.method === "run.get") sizes.push({ phase, bytes: metric.encodedBytes });
    },
  });
  t.after(async () => {
    client.close();
    await kernel.close();
    await owner.close();
    await rm(root, { recursive: true, force: true });
  });
  const calls: string[] = [];
  let failPoint = false;
  const adapter = (point: boolean) =>
    ({
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push(method);
        if (method === "session.get")
          return {
            session: {
              sessionId: params["sessionId"],
              workspacePath: params["workspacePath"],
              title: "fixture",
              status: "active",
              pinned: false,
              createdAt: 1,
              updatedAt: 1,
            },
          };
        if (method === "run.get" && failPoint) throw new Error("point lookup failed");
        const result = await client.request(method as never, params as never);
        if (method === "runtime.ping" && !point) {
          const ping = result as { capabilities: string[] };
          return {
            ...ping,
            capabilities: ping.capabilities.filter(
              (value) => value !== RUN_POINT_LOOKUP_RUNTIME_CAPABILITY,
            ),
          };
        }
        return result;
      },
    }) as GatewayRuntimeClient;
  const config = {
    workspaces: [
      { id: "workspace", name: "Fixture", path: canonical },
      { id: "other", name: "Other", path: otherPath },
    ],
  };
  const principal = {
    id: "device",
    terminalOwnerId: "owner",
    permissions: ["workspace.read" as const, "session.control" as const],
    workspaceIds: ["workspace", "other"],
  };
  const request = (runId = "history-0", workspaceId = "workspace", sessionId = "correct") =>
    parseRemoteRequest({
      version: 1,
      requestId: "auth",
      method: "prompt.cancel",
      workspaceId,
      params: { promptId: "fixture", runId, sessionId },
    });
  const check = async (point: boolean, rpc: RemoteRequest) => {
    try {
      await authorizeRuntimeRequest(config, principal, adapter(point), rpc);
      return true;
    } catch (error) {
      assert.ok(error instanceof GatewayError);
      assert.equal(error.code, "FORBIDDEN");
      return false;
    }
  };
  for (const [rpc, expected] of [
    [request(), true],
    [request("missing"), false],
    [request("history-0", "other"), false],
    [request("history-0", "workspace", "wrong"), false],
  ] as const) {
    assert.equal(await check(false, rpc), expected);
    assert.equal(await check(true, rpc), expected);
  }
  const before = sizes.filter((sample) => sample.phase === "before").map((sample) => sample.bytes);
  phase = "after";
  seed(100, 10000);
  assert.equal(
    (await client.request("run.get", { workspacePath: canonical, runId: "history-9999" })).run
      ?.runId,
    "history-9999",
  );
  assert.equal(await check(true, request()), true);
  const after = sizes.filter((sample) => sample.phase === "after").map((sample) => sample.bytes);
  assert.ok(Math.max(...after) < 1024);
  assert.ok(Math.max(...after) <= Math.max(...before) + 100);
  calls.length = 0;
  failPoint = true;
  await assert.rejects(
    authorizeRuntimeRequest(config, principal, adapter(true), request()),
    /point lookup failed/,
  );
  assert.equal(
    calls.includes("runs.list"),
    false,
    "point lookup failure must not bypass authorization",
  );
  assert.equal((DESKTOP_RUNTIME_METHODS as readonly string[]).includes("run.get"), false);
  assert.throws(() =>
    parseRemoteRequest({
      version: 1,
      requestId: "private",
      method: "run.get",
      workspaceId: "workspace",
      params: { runId: "history-0" },
    }),
  );
});

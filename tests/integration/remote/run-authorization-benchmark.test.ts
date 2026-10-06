import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
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
import {
  ensurePicoRuntimeHostOperationsRegistered,
  ensurePicoRuntimeHostEventOperationsRegistered,
  ensurePicoRuntimeHostSessionContinuityOperationsRegistered,
  ensurePicoRuntimeHostShutdownOperationRegistered,
  runtimeRunResultSizeMetrics,
} from "@pico/pico-host/runtime-host-operations";
import {
  authorizeRuntimeRequest,
  type GatewayRuntimeClient,
} from "../../../packages/remote-gateway/src/policy.js";
import type { RemoteRequest } from "@pico/protocol/remote";

const enabled = process.env["PICO_RUN_ARCHITECTURE_BENCHMARK"] === "1";
const percentile = (values: number[], fraction: number) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]!;
test(
  "Run authorization real Host transport benchmark (20 warmups + 200 samples × 5 batches)",
  { skip: !enabled, timeout: 600_000 },
  async () => {
    ensurePicoRuntimeHostOperationsRegistered();
    ensurePicoRuntimeHostEventOperationsRegistered();
    ensurePicoRuntimeHostSessionContinuityOperationsRegistered();
    ensurePicoRuntimeHostShutdownOperationRegistered();
    const output: Array<Record<string, unknown>> = [];
    for (const count of [100, 1000, 10000]) {
      const root = await mkdtemp(join(tmpdir(), "pico-run-auth-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const other = join(root, "other");
      await Promise.all([mkdir(home), mkdir(workspace), mkdir(other)]);
      const canonical = await realpath(workspace);
      const canonicalOther = await realpath(other);
      for (const path of [canonical, canonicalOther]) {
        const seed = new SqliteRuntimeControlStore({
          storageRoot: resolvePicoPaths(path, { picoHome: home }).workspace.root,
        });
        for (let i = 0; i < (path === canonical ? count : 1); i++)
          seed.upsertDaemonRun({
            runId: `history-${i}`,
            workspacePath: path,
            sessionId: "session-history",
            description: "deterministic history",
            status: "succeeded",
            startedAt: i + 1,
            updatedAt: i + 2,
            finishedAt: i + 2,
            version: 1,
          });
        seed.close();
      }
      const service = new WorkspaceRuntimeService({
        env: { PICO_HOME: home },
        execute: async () => undefined,
      });
      const capability = await resolveStorageRoot({ path: home, kind: "interactive" });
      const owner = await tryAcquireInteractiveRootOwner(capability);
      assert.ok(owner);
      const kernel = await RuntimeHostKernel.start({
        owner,
        compositionFactory: async (context) => {
          const base = await createRuntimeHostCompositionFactory({ service })(context);
          const unavailable = async () => ({
            ok: false,
            error: { code: "operation_unavailable", message: "Unused benchmark channel" },
          });
          return {
            ...base,
            handlers: {
              ...base.handlers,
              "events.subscribe": unavailable,
              "events.replay": unavailable,
              "session.subscription.open": unavailable,
              "session.subscription.close": unavailable,
              "session.transcript.page": unavailable,
              "session.transcript.advance": unavailable,
              "runtime.shutdown": unavailable,
            } as typeof base.handlers,
          };
        },
      });
      const frames: Array<{ method: string; encodedBytes: number; decodeMs: number }> = [];
      const client = new LocalRuntimeClient({
        runtimeHostRootPath: home,
        onResponseMetrics: (metric) => {
          frames.push(metric);
        },
      });
      // Only session linkage is a fixed deterministic fixture; run authorization, storage and transport are real.
      const adapter = {
        request: async (method: string, params: Record<string, unknown>) => {
          if (method === "session.get")
            return {
              session: {
                sessionId: params["sessionId"],
                workspacePath: canonical,
                title: "fixture",
                status: "active",
                pinned: false,
                createdAt: 1,
                updatedAt: 1,
              },
            };
          const result = await client.request(method as never, params as never);
          if (method === "runtime.ping" && process.env["PICO_BENCHMARK_PATH"] === "list") {
            const ping = result as { capabilities: string[] };
            return {
              ...ping,
              capabilities: ping.capabilities.filter(
                (capability) => capability !== "run-point-lookup-v1",
              ),
            };
          }
          return result;
        },
      } as GatewayRuntimeClient;
      const config = { workspaces: [{ id: "authorized", name: "Fixture", path: canonical }] };
      const principal = {
        id: "device",
        terminalOwnerId: "owner",
        permissions: ["workspace.read" as const, "session.control" as const],
        workspaceIds: ["authorized"],
      };
      try {
        await client.request("runs.list", { workspacePath: canonicalOther });
        for (const scenario of ["exists", "missing", "cross-workspace", "session-mismatch"]) {
          const request = {
            version: 1,
            requestId: "benchmark",
            method: "prompt.cancel",
            workspaceId: "authorized",
            params: {
              promptId: "fixture-prompt",
              runId:
                scenario === "missing"
                  ? "missing"
                  : scenario === "cross-workspace"
                    ? "history-1"
                    : "history-0",
              ...(scenario === "session-mismatch" ? { sessionId: "different" } : {}),
            },
          } as RemoteRequest;
          const selectedConfig =
            scenario === "cross-workspace"
              ? { workspaces: [{ id: "authorized", name: "Other", path: canonicalOther }] }
              : config;
          // The other workspace uses a distinct id so the principal cannot accidentally authorize the same Run.
          const batches: number[] = [];
          let failures = 0;
          for (let batch = 0; batch < 5; batch++) {
            const samples: number[] = [];
            for (let iteration = 0; iteration < 220; iteration++) {
              const start = performance.now();
              let allowed = false;
              try {
                await authorizeRuntimeRequest(selectedConfig, principal, adapter, request);
                allowed = true;
              } catch (error) {
                if (scenario === "exists" && iteration >= 20) failures++;
                else if (scenario !== "exists") assert.ok(error instanceof Error);
              }
              if (scenario !== "exists") assert.equal(allowed, false);
              if (iteration >= 20) samples.push(performance.now() - start);
            }
            batches.push(percentile(samples, 0.95));
            console.log(
              JSON.stringify({ count, scenario, batch: batch + 1, p95Ms: batches.at(-1) }),
            );
          }
          const data = frames.filter(
            (frame) => frame.method === "runs.list" || frame.method === "run.get",
          );
          output.push({
            count,
            scenario,
            batchP95Ms: batches,
            p95MedianMs: percentile(batches, 0.5),
            failures,
            maxFrameBytes: Math.max(0, ...data.map((frame) => frame.encodedBytes)),
            hostResultBytes: runtimeRunResultSizeMetrics().maxBytes,
          });
          frames.length = 0;
        }
      } finally {
        client.close();
        await kernel.close();
        await owner.close();
        await rm(root, { recursive: true, force: true });
      }
    }
    const target = process.env["PICO_BENCHMARK_OUTPUT"];
    if (target)
      await writeFile(
        target,
        JSON.stringify(
          {
            schemaVersion: 1,
            measuredAt: new Date().toISOString(),
            path: process.env["PICO_BENCHMARK_PATH"] ?? "list",
            warmups: 20,
            samples: 200,
            batches: 5,
            results: output,
          },
          null,
          2,
        ),
      );
    console.log(JSON.stringify(output));
  },
);

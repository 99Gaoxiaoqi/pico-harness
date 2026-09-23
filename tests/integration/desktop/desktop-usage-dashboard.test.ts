import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeRequest } from "../../../packages/protocol/src/index.js";
import { DesktopRuntimeService } from "@pico/pico-host/desktop-runtime-service";
import { WorkspaceRuntimeService } from "@pico/pico-host/workspace-runtime-service";
import { WorkspaceRegistrationStore } from "@pico/pico-host/workspace-registration";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { resolvePicoPaths } from "@pico/pico-host";
import { SqliteRuntimeControlStore } from "@pico/storage/sqlite/sqlite-runtime-control-store";
import { SqliteRuntimeEventStore } from "@pico/pico-host/product-runtime-event-store";
import { parseUsage } from "../../../apps/desktop/src/renderer/usage/runtime-projection.js";
import type { RuntimeEvent } from "@pico/storage/runtime-event";
import { initializeRuntimeEventOwner } from "../helpers/runtime-event-owner.js";

test("usage dashboard joins real model and tool ledgers across workspaces, preserves partial costs and filters sessions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-usage-dashboard-"));
  const picoHome = join(root, "home");
  const env = { PICO_HOME: picoHome };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  const registrations = new WorkspaceRegistrationStore(join(picoHome, "workspaces.json"));
  const paths = await Promise.all(
    ["first", "second", "untrusted"].map(async (name) => {
      const path = join(root, name);
      await mkdir(path);
      return await trustStore.canonicalize(path);
    }),
  );
  for (const path of paths) await registrations.register(path);
  for (const [index, path] of paths.slice(0, 2).entries()) {
    await trustStore.trust(path);
    const storageRoot = resolvePicoPaths(path, { picoHome }).workspace.root;
    const calls = new SqliteRuntimeControlStore({ storageRoot });
    const prepared = {
      physicalAttemptId: "same-attempt-id",
      providerCallId: "same-call-id",
      logicalCallId: "same-call-id",
      sessionId: index === 0 ? "parent" : "child",
      purpose: index === 0 ? ("main" as const) : ("subagent" as const),
      provider: "openai",
      model: "same-model",
      status: "prepared" as const,
      usageBasis: "missing" as const,
      accountingVersion: 1 as const,
      accountingSource: "physical" as const,
      revision: 0,
      attempt: 0,
      retryAttempt: 0,
      ownerId: calls.beginPhysicalAttemptOwner(),
      startedAt: new Date(2000 + index).toISOString(),
      costStatus: "unknown" as const,
      pricingVersion: "fixture",
    };
    calls.recordPhysicalAttempt(prepared);
    calls.recordPhysicalAttempt({
      ...prepared,
      revision: 1,
      status: index === 0 ? "succeeded" : "failed",
      completedAt: new Date(2300 + index).toISOString(),
      latencyMs: 300,
      usageBasis: "reported",
      usage: {
        promptTokens: index === 0 ? 15000 : 13100,
        completionTokens: index === 0 ? 400 : 539,
        inputTokens: index === 0 ? 5000 : 4611,
        cacheReadTokens: index === 0 ? 10000 : 8489,
        cacheWriteTokens: 0,
        reportedFields: ["prompt", "completion", "input", "cacheRead"],
      },
      ...(index === 0 ? { costCNY: 0.5, costStatus: "estimated" as const } : {}),
    });
    calls.close();
    const store = new SqliteRuntimeEventStore({ storageRoot });
    const sessionId = index === 0 ? "parent" : "child";
    const { ownerFence } = await initializeRuntimeEventOwner(store, {
      sessionId,
      workDir: path,
    });
    const base = {
      schemaVersion: 2 as const,
      sessionId,
      invocationId: "inv",
      runId: "run",
      turnId: "turn",
      partial: false,
      visibility: "internal" as const,
    };
    const body = "PRIVATE_TOOL_BODY_MUST_NOT_LEAK";
    const events: RuntimeEvent[] = [
      {
        ...base,
        eventId: "start",
        at: new Date(1000).toISOString(),
        kind: "run.started",
        data: { workDir: path, agentSwarmAuthorization: "none" },
      },
      {
        ...base,
        eventId: "tool-start",
        at: new Date(1500).toISOString(),
        kind: "tool.started",
        refs: { toolCallId: "tool" },
        data: {
          toolName: "read_file",
          argumentsHash: "a".repeat(64),
          argumentsJson: "{}",
          argumentsRedacted: true,
          recoveryMode: "never_auto_retry",
        },
      },
      {
        ...base,
        visibility: "model",
        eventId: "tool-end",
        at: new Date(2500).toISOString(),
        kind: "tool.result.recorded",
        refs: { toolCallId: "tool" },
        data: {
          toolName: "read_file",
          status: index === 0 ? "succeeded" : "failed",
          body: {
            storage: "inline",
            content: body,
            sha256: createHash("sha256").update(body).digest("hex"),
            sizeBytes: Buffer.byteLength(body),
          },
          projection: {
            version: 1,
            mode: "full",
            text: body,
            strategy: "original",
            truncated: false,
          },
        },
      },
      {
        ...base,
        eventId: "end",
        at: new Date(3000).toISOString(),
        kind: "run.terminal",
        data: { status: "completed" },
      },
    ];
    await store.appendBatch(events, { ownerFence });
    store.close();
  }
  const runtime = new WorkspaceRuntimeService({ env, execute: async () => undefined });
  const desktop = new DesktopRuntimeService({
    runtimeService: runtime,
    trustStore,
    registrationStore: registrations,
    env,
  });
  t.after(async () => {
    await desktop.close();
    await rm(root, { recursive: true, force: true });
  });
  const raw = await desktop.handle(createRuntimeRequest("usage.get", {}));
  const usage = parseUsage(raw);
  const details = usage.details!;
  assert.ok(details.pricing.length > 1000);
  const flash = details.pricing.find(
    (row) => row.model === "deepseek-v4-flash" && row.tier === "低峰",
  )!;
  assert.equal(flash.inputPerMillion, 0.22);
  assert.equal(flash.cacheWritePerMillion, null);
  assert.match(flash.sourceUrl!, /^https:\/\/api-docs.deepseek.com/);
  assert.equal(usage.providerCallCount, 2);
  assert.equal(usage.totalTokens, 29039);
  assert.equal(usage.inputTokens, 9611);
  assert.equal(usage.outputTokens, 939);
  assert.equal(usage.cacheWriteTokens, undefined);
  assert.equal(details.cacheWriteReportedCallCount, 0);
  assert.equal(usage.costStatus, "partial");
  assert.equal(details.knownCacheReadTokens, 18489);
  assert.equal(details.cacheReadReportedCallCount, 2);
  assert.equal(details.activityCount, 4);
  for (const row of details.activities.filter((row) => row.kind === "model")) {
    assert.equal(row.cacheReadReported, true);
    assert.equal(row.cacheWriteReported, false);
  }
  assert.equal(new Set(details.activities.map((r) => r.id)).size, 4);
  assert.equal(details.providers[0]!.count, 2);
  assert.equal(details.providers[0]!.costStatus, "partial");
  assert.equal(details.tools[0]!.count, 2);
  assert.equal(details.tools[0]!.averageDurationMs, 1000);
  assert.equal(details.tools[0]!.errorCount, 1);
  assert.equal(details.unavailableWorkspaces.length, 1);
  assert.match(details.unavailableWorkspaces[0]!.error, /信任/);
  assert.doesNotMatch(JSON.stringify(raw), /PRIVATE_TOOL_BODY_MUST_NOT_LEAK/);
  for (const [index, workspacePath] of paths.slice(0, 2).entries()) {
    const scoped = parseUsage(
      await desktop.handle(createRuntimeRequest("usage.get", { workspacePath })),
    );
    assert.equal(scoped.workspacePath, workspacePath);
    assert.equal(scoped.totalTokens, index === 0 ? 15400 : 13639);
    assert.equal(scoped.details!.unavailableWorkspaces.length, 0);
  }
  const ranged = parseUsage(
    await desktop.handle(
      createRuntimeRequest("usage.get", {
        workspacePath: paths[1]!,
        sessionId: "child",
        from: 2400,
        to: 2600,
      }),
    ),
  );
  assert.equal(ranged.providerCallCount, 0);
  assert.equal(ranged.details!.activityCount, 1);
  assert.equal(ranged.details!.activities[0]!.kind, "tool");
  assert.equal(ranged.details!.activities[0]!.durationMs, 1000);
});

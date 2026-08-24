import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDesktopAutomationRequestHandlers } from "../../src/daemon/desktop-automation-request-handlers.js";
import { createDesktopCatalogRequestHandlers } from "../../src/daemon/desktop-catalog-request-handlers.js";
import type { DesktopAutomationService } from "../../src/daemon/desktop-automation-service.js";
import { createTypedRuntimeRequest } from "../../src/daemon/protocol.js";
import { UserMcpConfigStore } from "../../src/mcp/user-config-store.js";

test("Desktop Automation handlers preserve CRUD routing and dependency locking", async () => {
  const calls: string[] = [];
  const job = { workspacePath: "/canonical", jobId: "job-1" };
  const automations = {
    list: (workspacePath: string) => {
      calls.push(`list:${workspacePath}`);
      return [job];
    },
    create: async (workspacePath: string, input: { name: string }) => {
      calls.push(`create:${workspacePath}:${input.name}`);
      return job;
    },
    update: (workspacePath: string, jobId: string, input: { prompt?: string }) => {
      calls.push(`update:${workspacePath}:${jobId}:${input.prompt}`);
      return job;
    },
    delete: (workspacePath: string, jobId: string) => {
      calls.push(`delete:${workspacePath}:${jobId}`);
      return true;
    },
    setEnabled: async (workspacePath: string, jobId: string, enabled: boolean) => {
      calls.push(`enabled:${workspacePath}:${jobId}:${enabled}`);
      return job;
    },
    runNow: async (workspacePath: string, jobId: string) => {
      calls.push(`run:${workspacePath}:${jobId}`);
      return { job, runId: "run-1" };
    },
    history: (workspacePath: string, jobId: string, limit?: number) => {
      calls.push(`history:${workspacePath}:${jobId}:${limit}`);
      return [];
    },
  } as unknown as DesktopAutomationService;
  const handlers = createDesktopAutomationRequestHandlers({
    automations,
    credentialVault: {} as never,
    effectiveConfigResolver: {} as never,
    userConfigStore: {} as never,
    pluginRuntimeSnapshotRegistry: {} as never,
    env: {},
    now: () => 1,
    requireTrustedWorkspace: async (workspacePath) => {
      calls.push(`trust:${workspacePath}`);
      return "/canonical";
    },
    publishJob: (published) => calls.push(`publish:${String(asRecord(published)["jobId"])}`),
    withProviderDependencyLock: async (operation) => {
      calls.push("lock:start");
      const result = await operation();
      calls.push("lock:end");
      return result;
    },
  });

  assert.deepEqual(
    await handlers["jobs.list"]!(
      createTypedRuntimeRequest("jobs.list", { workspacePath: "/workspace" }),
    ),
    { jobs: [job] },
  );
  assert.deepEqual(
    await handlers["jobs.create"]!(
      createTypedRuntimeRequest("jobs.create", {
        workspacePath: "/workspace",
        name: "daily",
        prompt: "review",
        schedule: "0 9 * * *",
      }),
    ),
    { job },
  );
  assert.deepEqual(
    await handlers["jobs.update"]!(
      createTypedRuntimeRequest("jobs.update", {
        workspacePath: "/workspace",
        jobId: "job-1",
        prompt: "updated",
      }),
    ),
    { job },
  );
  assert.deepEqual(
    await handlers["jobs.delete"]!(
      createTypedRuntimeRequest("jobs.delete", {
        workspacePath: "/workspace",
        jobId: "job-1",
      }),
    ),
    { deleted: true },
  );
  assert.deepEqual(
    await handlers["jobs.setEnabled"]!(
      createTypedRuntimeRequest("jobs.setEnabled", {
        workspacePath: "/workspace",
        jobId: "job-1",
        enabled: true,
      }),
    ),
    { job },
  );
  assert.deepEqual(
    await handlers["jobs.runNow"]!(
      createTypedRuntimeRequest("jobs.runNow", {
        workspacePath: "/workspace",
        jobId: "job-1",
      }),
    ),
    { job, runId: "run-1" },
  );
  assert.deepEqual(
    await handlers["jobs.history"]!(
      createTypedRuntimeRequest("jobs.history", {
        workspacePath: "/workspace",
        jobId: "job-1",
        limit: 7,
      }),
    ),
    { runs: [] },
  );
  assert.deepEqual(calls, [
    "trust:/workspace",
    "list:/canonical",
    "lock:start",
    "trust:/workspace",
    "create:/canonical:daily",
    "publish:job-1",
    "lock:end",
    "trust:/workspace",
    "update:/canonical:job-1:updated",
    "publish:job-1",
    "trust:/workspace",
    "delete:/canonical:job-1",
    "lock:start",
    "trust:/workspace",
    "enabled:/canonical:job-1:true",
    "publish:job-1",
    "lock:end",
    "lock:start",
    "trust:/workspace",
    "run:/canonical:job-1",
    "publish:job-1",
    "lock:end",
    "trust:/workspace",
    "history:/canonical:job-1:7",
  ]);
});

test("Desktop Automation handlers keep missing services and lock failures fail-closed", async () => {
  const failure = new Error("lock failed");
  let lockAttempts = 0;
  const handlers = createDesktopAutomationRequestHandlers({
    credentialVault: {} as never,
    effectiveConfigResolver: {} as never,
    userConfigStore: {} as never,
    pluginRuntimeSnapshotRegistry: {} as never,
    env: {},
    now: () => 1,
    requireTrustedWorkspace: async () => "/canonical",
    publishJob: () => undefined,
    withProviderDependencyLock: async () => {
      lockAttempts++;
      throw failure;
    },
  });

  await assert.rejects(
    Promise.resolve().then(() =>
      handlers["jobs.list"]!(
        createTypedRuntimeRequest("jobs.list", { workspacePath: "/workspace" }),
      ),
    ),
    /Automations 尚未连接/u,
  );
  await assert.rejects(
    Promise.resolve().then(() =>
      handlers["jobs.create"]!(
        createTypedRuntimeRequest("jobs.create", {
          workspacePath: "/workspace",
          name: "daily",
          prompt: "review",
          schedule: "0 9 * * *",
        }),
      ),
    ),
    (error: unknown) => error === failure,
  );
  await assert.rejects(
    Promise.resolve().then(() =>
      handlers["automation.credential.import"]!(
        createTypedRuntimeRequest("automation.credential.import", {
          workspacePath: "/workspace",
          modelRouteId: "provider/model",
          expectedCredentialRef: "provider:fixture",
          secret: "credential-value-must-not-be-rendered",
        }),
      ),
    ),
    (error: unknown) => error === failure,
  );
  await assert.rejects(
    Promise.resolve().then(() =>
      handlers["automation.create"]!(
        createTypedRuntimeRequest("automation.create", {
          workspacePath: "/workspace",
          prompt: "review",
          schedule: "0 9 * * *",
          modelRouteId: "provider/model",
          expectedCredentialRef: "provider:fixture",
          allowedTools: [],
          toolNetworkPolicy: "disabled",
        }),
      ),
    ),
    (error: unknown) => error === failure,
  );
  assert.equal(lockAttempts, 3);
});

test("Desktop catalog handlers retain MCP redaction and trust error propagation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-catalog-handlers-"));
  const picoHome = join(root, "pico-home");
  await mkdir(picoHome, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));
  const userMcpConfigStore = new UserMcpConfigStore({ picoHome });
  const trustFailure = new Error("workspace trust failed");
  const handlers = createDesktopCatalogRequestHandlers({
    env: { PICO_HOME: picoHome },
    picoHome,
    pluginRuntimeSnapshotRegistry: {} as never,
    trustStore: {} as never,
    userMcpConfigStore,
    requireTrustedWorkspace: async () => {
      throw trustFailure;
    },
    projectCapabilityRevision: (_capability, _scope, revision) => `public:${revision}`,
    publishCapabilityConfigUpdated: async () => undefined,
  });

  const initial = await handlers["mcp.user.list"]!(createTypedRuntimeRequest("mcp.user.list", {}));
  assert.deepEqual(initial, {
    servers: [],
    revision: `public:${(await userMcpConfigStore.read()).revision}`,
  });
  const created = await handlers["mcp.user.upsert"]!(
    createTypedRuntimeRequest("mcp.user.upsert", {
      server: {
        name: "fixture",
        transport: "stdio",
        command: "/private/bin/node --token=SECRET_COMMAND",
        args: ["SECRET_ARGUMENT"],
        env: { API_TOKEN: "SECRET_VALUE" },
      },
      expectedRevision: String(asRecord(initial)["revision"]),
      idempotencyKey: "catalog-handler-upsert",
    }),
  );
  const serialized = JSON.stringify(created);
  assert.doesNotMatch(serialized, /SECRET_COMMAND|SECRET_ARGUMENT|SECRET_VALUE|\/private\/bin/u);
  assert.match(serialized, /configured-command/u);

  await assert.rejects(
    Promise.resolve().then(() =>
      handlers["catalog.agents"]!(
        createTypedRuntimeRequest("catalog.agents", { workspacePath: "/workspace" }),
      ),
    ),
    (error: unknown) => error === trustFailure,
  );
});

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected object");
  }
  return value as Record<string, unknown>;
}

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { RuntimeResult } from "@pico/protocol";
import { createRuntimeRequest } from "../../src/daemon/index.js";
import {
  assembleProductionDaemonHost,
  createProductionRuntimeServices,
} from "../../src/daemon/production-host.js";
import { UserConfigStore } from "../../src/input/user-config-store.js";
import {
  OPENCODE_FREE_PROVIDER,
  OPENCODE_FREE_ROUTE_ID,
} from "../../src/input/default-provider.js";
import {
  credentialRefForProvider,
  type CredentialVault,
} from "../../src/provider/credential-vault.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import { CronService } from "../../src/tasks/cron-service.js";
import { globalSessionManager } from "../../src/engine/session.js";
import { closeAllOperationalDatabasesForTest } from "../../src/storage/sqlite/sqlite-database.js";

test("anonymous default creates and executes desktop and trusted Cron jobs without vault access while keeping route and trust checks", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-opencode-free-automation-"));
  const picoHome = join(root, "home");
  await mkdir(join(root, "workspace"));
  const workspacePath = await realpath(join(root, "workspace"));
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    assert.equal(request.headers.authorization, undefined);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      'data: {"choices":[{"delta":{"content":"anonymous automation works"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseURL = `http://127.0.0.1:${address.port}/v1`;
  const store = new UserConfigStore({ picoHome });
  const seeded = await store.ensureDefaultProvider({});
  await store.write(
    { ...seeded.config, providers: { "opencode-free": { ...OPENCODE_FREE_PROVIDER, baseURL } } },
    { expectedRevision: seeded.revision },
  );
  let vaultCalls = 0;
  const vault: CredentialVault = {
    capability: () => {
      vaultCalls++;
      throw new Error("unexpected vault capability");
    },
    has: async () => {
      vaultCalls++;
      return false;
    },
    resolve: async () => {
      vaultCalls++;
      throw new Error("unexpected credential resolution");
    },
    put: async () => {
      vaultCalls++;
      throw new Error("unexpected credential write");
    },
    delete: async () => {
      vaultCalls++;
      throw new Error("unexpected credential delete");
    },
  };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(workspacePath);
  const services = createProductionRuntimeServices({
    env: { PICO_HOME: picoHome },
    userConfigStore: store,
    credentialVault: vault,
    trustStore,
  });
  const host = assembleProductionDaemonHost(services, {});
  context.after(async () => {
    await host.stop();
    await globalSessionManager.clearAndDrain();
    closeAllOperationalDatabasesForTest();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  });
  await host.start();
  const created = (await services.desktopService.handle(
    createRuntimeRequest("jobs.create", {
      workspacePath,
      name: "anonymous desktop",
      prompt: "synthetic hello",
      schedule: "0 0 1 1 *",
      enabled: true,
    }),
  )) as RuntimeResult<"jobs.create">;
  assert.equal(created.job.enabled, true);
  const credentialRef = credentialRefForProvider({
    providerId: "opencode-free",
    protocol: "openai",
    baseURL,
  });
  const trusted = (await services.desktopService.handle(
    createRuntimeRequest("automation.create", {
      workspacePath,
      prompt: "synthetic trusted cron",
      schedule: "0 0 1 1 *",
      modelRouteId: OPENCODE_FREE_ROUTE_ID,
      expectedCredentialRef: credentialRef,
      allowedTools: [],
      toolNetworkPolicy: "disabled",
      enabled: true,
    }),
  )) as RuntimeResult<"automation.create">;
  assert.equal(trusted.job.enabled, true);
  const run = await host.runCronJobNow(workspacePath, created.job.jobId);
  let history: RuntimeResult<"jobs.history">;
  const deadline = Date.now() + 10000;
  do {
    history = (await services.desktopService.handle(
      createRuntimeRequest("jobs.history", { workspacePath, jobId: created.job.jobId }),
    )) as RuntimeResult<"jobs.history">;
    if (history.runs.some((entry) => entry.runId === run.cronRunId && entry.status === "succeeded"))
      break;
    await delay(20);
  } while (Date.now() < deadline);
  assert.ok(
    history.runs.some((entry) => entry.runId === run.cronRunId && entry.status === "succeeded"),
    JSON.stringify(history),
  );
  assert.equal(requests, 1);
  assert.equal(vaultCalls, 0);
  const cron = new CronService({ workDir: workspacePath, picoHome });
  const job = cron.list(workspacePath).find((entry) => entry.cronJobId === created.job.jobId)!;
  assert.deepEqual(await services.validateAutomation(job), { allowed: true });
  await assert.rejects(
    services.desktopService.handle(
      createRuntimeRequest("automation.create", {
        workspacePath,
        prompt: "wrong authority",
        schedule: "0 0 1 1 *",
        modelRouteId: OPENCODE_FREE_ROUTE_ID,
        expectedCredentialRef: credentialRefForProvider({
          providerId: "opencode-free",
          protocol: "openai",
          baseURL: "https://different.invalid/v1",
        }),
        allowedTools: [],
        toolNetworkPolicy: "disabled",
      }),
    ),
    /authority 已变化/,
  );
  const current = await store.read();
  await store.write(
    {
      ...current.config,
      providers: {
        "opencode-free": { ...OPENCODE_FREE_PROVIDER, baseURL: "https://changed.invalid/v1" },
      },
    },
    { expectedRevision: current.revision },
  );
  assert.equal((await services.validateAutomation(job)).allowed, false);
  assert.equal(vaultCalls, 0, "endpoint changes must fail before consulting credentials");
  const changed = await store.read();
  await store.write(
    {
      ...changed.config,
      providers: { "opencode-free": { ...OPENCODE_FREE_PROVIDER, baseURL, auth: "api-key" } },
    },
    { expectedRevision: changed.revision },
  );
  assert.equal((await services.validateAutomation(job)).allowed, false);
  assert.equal(vaultCalls, 1, "ordinary Provider still requires the exact vault credential");
  await assert.rejects(
    services.desktopService.handle(
      createRuntimeRequest("jobs.create", {
        workspacePath,
        name: "ordinary without key",
        prompt: "synthetic",
        schedule: "0 0 1 1 *",
      }),
    ),
    /尚未导入系统凭证库/,
  );
  const keyConfig = await store.read();
  await store.write(
    { ...keyConfig.config, providers: { "opencode-free": { ...OPENCODE_FREE_PROVIDER, baseURL } } },
    { expectedRevision: keyConfig.revision },
  );
  await trustStore.setTrusted(workspacePath, false);
  assert.equal((await services.validateAutomation(job)).allowed, false);
});

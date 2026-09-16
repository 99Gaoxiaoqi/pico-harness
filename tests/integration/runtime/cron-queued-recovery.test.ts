import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { CronService } from "@pico/runtime/cron-service";
import { CronRuntimeScheduler } from "@pico/pico-host/cron-runtime-scheduler";
import { WorkspaceTaskRuntime } from "@pico/pico-host/workspace-task-runtime";
import { resolvePicoPaths } from "@pico/pico-host/pico-paths";
import {
  credentialRefForProvider,
  type CredentialVault,
} from "@pico/pico-host/provider/credential-vault";
import {
  assembleProductionDaemonHost,
  createProductionRuntimeServices,
} from "@pico/pico-host/production-host";
import { UserConfigStore } from "@pico/pico-host/input/user-config-store";
import {
  OPENCODE_FREE_PROVIDER,
  OPENCODE_FREE_ROUTE_ID,
} from "@pico/pico-host/input/default-provider";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { WorkspaceRegistrationStore } from "@pico/pico-host/workspace-registration";
import {
  BACKGROUND_HARDLINE_VERSION,
  BACKGROUND_HOOK_VERSION,
} from "@pico/pico-host/background-autonomous-policy";
import { globalSessionManager } from "@pico/pico-host/session";
import { AgentRuntime } from "@pico/pico-host/agent-runtime";
import type { AutonomousPolicySnapshot } from "@pico/storage/runtime-control-types";

const baseURL = "http://127.0.0.1:1/v1";
const credentialRef = credentialRefForProvider({
  providerId: "opencode-free",
  protocol: "openai",
  baseURL,
});
function policy(now: number): AutonomousPolicySnapshot {
  return {
    mode: "full-access",
    backgroundEnabled: true,
    trustedWorkspace: true,
    toolNetworkPolicy: "disabled",
    allowedTools: [],
    hardlineVersion: BACKGROUND_HARDLINE_VERSION,
    hookVersion: BACKGROUND_HOOK_VERSION,
    createdAt: now,
  };
}
function createJob(cron: CronService, workspacePath: string, now: number) {
  return cron.create({
    workspacePath,
    schedule: "* * * * *",
    timeZone: "UTC",
    prompt: "fixture",
    credentialRef,
    modelRouteId: OPENCODE_FREE_ROUTE_ID,
    policySnapshot: policy(now),
  });
}

test("queued crash recovery waits for ownership expiry, never replays the same minute, and permits later triggers", async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pico-cron-queued-recovery-")));
  let now = Date.parse("2026-09-16T10:00:00Z");
  const old = new CronService({ storageRoot: root, ownerId: "old", now: () => now });
  const job = createJob(old, root, now);
  const queued = old.tick().runs[0]!;
  assert.equal(queued.ownerId, "old");
  assert.equal(queued.leaseEpoch, 1);
  old.close(); // Exact durable crash state after queued commit, before preflight completes.
  const replacement = new CronService({
    storageRoot: root,
    ownerId: "replacement",
    now: () => now,
  });
  context.after(async () => {
    replacement.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.deepEqual(replacement.recoverInterruptedRuns(), []);
  assert.throws(() => replacement.claim(queued.cronRunId), /lease 已失效/u);
  assert.throws(() => replacement.block(queued.cronRunId, "rival"), /lease 所有权已变化或过期/u);
  assert.equal(replacement.tick().runs[0]!.cronRunId, queued.cronRunId);
  now += 30_001;
  const sameMinute = replacement.tick().runs[0]!;
  assert.equal(sameMinute.cronRunId, queued.cronRunId);
  assert.equal(sameMinute.status, "failed");
  assert.equal(sameMinute.reason, "daemon_interrupted_after_lease_expiry");
  assert.equal(sameMinute.version, queued.version + 1);
  assert.equal(replacement.events().filter((event) => event.topic === "cron.run.failed").length, 1);
  assert.deepEqual(replacement.recoverInterruptedRuns(), []);
  now += 180_000;
  const next = replacement.tick().runs[0]!;
  assert.equal(next.status, "queued");
  const claimed = replacement.claim(next.cronRunId);
  assert.equal(claimed.run.leaseEpoch, next.leaseEpoch);
  assert.equal(claimed.run.ownerId, "replacement");
  assert.throws(() => replacement.claim(next.cronRunId), /不能启动/u);
  replacement.finish({
    cronRunId: next.cronRunId,
    leaseEpoch: claimed.lease!.leaseEpoch,
    expectedVersion: claimed.run.version,
    status: "succeeded",
  });
  assert.equal(replacement.runs().length, 2, "missed minutes must not be backfilled");
  const manual = replacement.runNow(job.cronJobId);
  now += 30_001;
  assert.equal(replacement.runNow(job.cronJobId).status, "queued");
  assert.equal(replacement.store.getCronRun(manual.cronRunId)!.status, "failed");
  now += 30_001;
  replacement.recoverInterruptedRuns();
  const legacy = replacement.store.createCronRun({
    cronRunId: "legacy-queued",
    cronJobId: job.cronJobId,
    scheduledFor: now + 1,
    status: "queued",
  });
  assert.equal(legacy.ownerId, undefined);
  assert.equal(replacement.recoverInterruptedRuns()[0]!.cronRunId, legacy.cronRunId);
});

test("expired queued preflight cannot resume after recovery at either asynchronous boundary", async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pico-cron-preflight-expiry-")));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  for (const phase of ["policy", "runtime"]) {
    let now = Date.parse("2026-09-16T10:00:00Z");
    const storageRoot = join(root, phase);
    const old = new CronService({ storageRoot, ownerId: "old", now: () => now });
    const replacement = new CronService({ storageRoot, ownerId: "new", now: () => now });
    const runtime = await WorkspaceTaskRuntime.create({ workDir: root });
    createJob(old, root, now);
    const entered = deferred();
    const release = deferred();
    let executions = 0;
    const pause = async () => {
      entered.resolve();
      await release.promise;
    };
    const scheduler = new CronRuntimeScheduler({
      cronService: old,
      now: () => now,
      canRun: async () => {
        if (phase === "policy") await pause();
        return { allowed: true };
      },
      getWorkspaceRuntime: async () => {
        if (phase === "runtime") await pause();
        return runtime;
      },
      execute: async () => {
        executions++;
      },
    });
    const active = scheduler.tick();
    try {
      await entered.promise;
      const queued = old.runs()[0]!;
      now += 30_001;
      // Even an explicitly acquired replacement lease cannot claim an old queued owner/epoch.
      const stolen = replacement.store.acquireLease(`cron-run:${queued.cronRunId}`, "new");
      assert.throws(
        () =>
          replacement.store.claimCronRun({
            cronRunId: queued.cronRunId,
            ownerId: "new",
            leaseEpoch: stolen.leaseEpoch,
          }),
        /preflight owner\/lease 已变化/u,
      );
      replacement.store.releaseLease(stolen.resourceKey, "new", stolen.leaseEpoch);
      assert.equal(replacement.recoverInterruptedRuns()[0]!.status, "failed");
      release.resolve();
      await active;
      assert.equal(executions, 0);
      assert.equal(old.store.getCronRun(queued.cronRunId)!.status, "failed");
    } finally {
      release.resolve();
      await active;
      await runtime.close();
      old.close();
      replacement.close();
    }
  }
});

test("long queued preflight heartbeats protect against rival recovery and duplicate dispatch", async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pico-cron-preflight-ownership-")));
  let now = Date.parse("2026-09-16T10:00:00Z");
  const cron = new CronService({ storageRoot: root, ownerId: "active", now: () => now });
  const rival = new CronService({ storageRoot: root, ownerId: "rival", now: () => now });
  createJob(cron, root, now);
  const runtime = await WorkspaceTaskRuntime.create({ workDir: root });
  const policyGate = deferred();
  const runtimeGate = deferred();
  let policyCalls = 0;
  let runtimeCalls = 0;
  let executions = 0;
  const scheduler = new CronRuntimeScheduler({
    cronService: cron,
    now: () => now,
    leaseHeartbeatMs: 1_000,
    canRun: async () => {
      policyCalls++;
      await policyGate.promise;
      return { allowed: true };
    },
    getWorkspaceRuntime: async () => {
      runtimeCalls++;
      await runtimeGate.promise;
      return runtime;
    },
    execute: async () => {
      executions++;
      return { ok: true };
    },
  });
  const other = new CronRuntimeScheduler({
    cronService: rival,
    now: () => now,
    canRun: async () => {
      throw new Error("rival must not dispatch an owned queued run");
    },
    getWorkspaceRuntime: async () => runtime,
    execute: async () => {
      throw new Error("rival executed");
    },
  });
  const active = scheduler.tick();
  context.after(async () => {
    policyGate.resolve();
    runtimeGate.resolve();
    await active;
    await runtime.close();
    cron.close();
    rival.close();
    await rm(root, { recursive: true, force: true });
  });
  const queued = cron.runs()[0]!;
  now += 20_000;
  await waitUntil(() => cron.store.getLease(`cron-run:${queued.cronRunId}`)!.heartbeatAt === now);
  assert.deepEqual(rival.recoverInterruptedRuns(), []);
  await Promise.all([scheduler.tick(), other.tick()]);
  assert.equal(policyCalls, 1);
  policyGate.resolve();
  await waitUntil(() => runtimeCalls === 1);
  now += 20_000;
  await waitUntil(() => cron.store.getLease(`cron-run:${queued.cronRunId}`)!.heartbeatAt === now);
  assert.deepEqual(rival.recoverInterruptedRuns(), []);
  runtimeGate.resolve();
  await active;
  assert.equal(executions, 1);
  assert.equal(cron.store.getCronRun(queued.cronRunId)!.status, "succeeded");
});

test("production daemon startup terminalizes orphan queued rows and executes the current trigger", async (context) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pico-production-queued-recovery-")));
  const picoHome = join(root, "home");
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  const config = new UserConfigStore({ picoHome });
  const initial = await config.ensureDefaultProvider({});
  await config.write(
    { ...initial.config, providers: { "opencode-free": { ...OPENCODE_FREE_PROVIDER, baseURL } } },
    { expectedRevision: initial.revision },
  );
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(workspacePath);
  const registrationStore = new WorkspaceRegistrationStore(
    join(picoHome, "daemon-workspaces.json"),
  );
  await registrationStore.register(workspacePath);
  const storageRoot = resolvePicoPaths(workspacePath, { picoHome }).workspace.root;
  const oldMinute = Math.floor(Date.now() / 60_000) * 60_000 - 180_000;
  const old = new CronService({ storageRoot, ownerId: "crashed", now: () => oldMinute });
  const job = createJob(old, workspacePath, oldMinute);
  const queued = old.tick().runs[0]!;
  old.close();
  const cron = new CronService({ storageRoot });
  let executions = 0;
  const forbidVault = (): never => {
    throw new Error("fixture must not access credentials");
  };
  const vault: CredentialVault = {
    capability: forbidVault,
    has: forbidVault,
    resolve: forbidVault,
    put: forbidVault,
    delete: forbidVault,
  };
  const agentRuntime = new AgentRuntime();
  context.mock.method(agentRuntime, "execute", async () => {
    executions++;
    throw new Error("fixture execution reached");
  });
  const services = createProductionRuntimeServices({
    env: { PICO_HOME: picoHome },
    userConfigStore: config,
    trustStore,
    registrationStore,
    credentialVault: vault,
    agentRuntime,
  });
  const host = assembleProductionDaemonHost(services, {});
  context.after(async () => {
    await host.stop();
    cron.close();
    await globalSessionManager.clearAndDrain();
    await rm(root, { recursive: true, force: true });
  });
  assert.deepEqual(await services.validateAutomation(job), { allowed: true });
  await host.start();
  await waitUntil(() =>
    cron.runs().some((run) => run.cronRunId !== queued.cronRunId && run.status === "failed"),
  );
  assert.equal(
    cron.store.getCronRun(queued.cronRunId)!.reason,
    "daemon_interrupted_after_lease_expiry",
  );
  assert.equal(cron.store.getCronRun(queued.cronRunId)!.status, "failed");
  const current = cron.runs().find((run) => run.cronRunId !== queued.cronRunId)!;
  assert.equal(current.reason, "fixture execution reached");
  assert.equal(executions, 1);
  assert.equal(cron.runs().length, 2);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "condition timed out");
    await delay(20);
  }
}

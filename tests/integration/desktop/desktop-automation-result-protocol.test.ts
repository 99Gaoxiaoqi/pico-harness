import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { credentialRefForProvider } from "@pico/core/provider-identity";
import {
  DesktopAutomationService,
  type DesktopAutomationSecurity,
} from "@pico/pico-host/desktop-automation-service";
import { resolvePicoPaths } from "@pico/pico-host/pico-paths";
import { parseRuntimeResult, RUNTIME_ERROR_CODES, RuntimeProtocolError } from "@pico/protocol";
import { CronService } from "@pico/runtime/cron-service";

async function fixture(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pico-automation-result-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const picoHome = join(root, "home");
  await mkdir(join(root, "workspace"));
  const workspacePath = await realpath(join(root, "workspace"));
  const security: DesktopAutomationSecurity = {
    credentialRef: credentialRefForProvider({
      providerId: "test",
      protocol: "openai",
      baseURL: "https://automation.invalid/v1",
    }),
    modelRouteId: "test/model",
    policySnapshot: {
      mode: "full-access",
      backgroundEnabled: true,
      trustedWorkspace: true,
      allowedTools: [],
      toolNetworkPolicy: "disabled",
      hardlineVersion: "test",
      hookVersion: "test",
      createdAt: 1,
    },
  };
  const openCron = () =>
    new CronService({ storageRoot: resolvePicoPaths(workspacePath, { picoHome }).workspace.root });
  const service = new DesktopAutomationService({
    picoHome,
    prepareSecurity: async () => security,
    validateSecurity: async () => {},
    ensureWorkspaceRuntime: async () => {},
    runNow: async (_workspacePath, jobId) => {
      const cron = openCron();
      try {
        return cron.runNow(jobId);
      } finally {
        cron.close();
      }
    },
  });
  return { service, workspacePath, security, openCron };
}

test("durable automation CRUD and run history decode through the Runtime result boundary", async (context) => {
  const { service, workspacePath, security, openCron } = await fixture(context);
  const { job: created } = parseRuntimeResult("jobs.create", {
    job: await service.create(workspacePath, {
      name: "日报",
      prompt: "生成日报",
      schedule: "0 9 * * *",
    }),
  });
  assert.equal(created.enabled, true);
  assert.equal(created.status, "idle");
  assert.equal(created.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(created.version, 2);
  assert.equal(created.modelRouteId, security.modelRouteId);
  assert.equal(created.latestRunId, undefined);
  assert.deepEqual(parseRuntimeResult("jobs.list", { jobs: service.list(workspacePath) }), {
    jobs: [created],
  });

  const { job: updated } = parseRuntimeResult("jobs.update", {
    job: service.update(workspacePath, created.jobId, {
      name: "晚报",
      prompt: "生成晚报",
      schedule: "0 18 * * *",
    }),
  });
  assert.equal(updated.name, "晚报");
  assert.equal(updated.prompt, "生成晚报");
  assert.equal(updated.schedule, "0 18 * * *");
  assert.equal(updated.version, 3);
  for (const enabled of [false, true]) {
    const result = parseRuntimeResult("jobs.setEnabled", {
      job: await service.setEnabled(workspacePath, created.jobId, enabled),
    });
    assert.equal(result.job.enabled, enabled);
  }

  const started = parseRuntimeResult(
    "jobs.runNow",
    await service.runNow(workspacePath, created.jobId),
  );
  assert.equal(started.job.status, "running");
  assert.equal(started.job.latestRunId, started.runId);
  const queued = parseRuntimeResult("jobs.history", {
    runs: service.history(workspacePath, created.jobId, 1),
  });
  assert.equal(queued.runs.length, 1);
  assert.equal(queued.runs[0]?.runId, started.runId);
  assert.equal(queued.runs[0]?.status, "running");
  const cron = openCron();
  try {
    const { run, lease } = cron.claim(started.runId);
    assert.ok(lease);
    cron.finish({
      cronRunId: run.cronRunId,
      leaseEpoch: lease.leaseEpoch,
      expectedVersion: run.version,
      status: "succeeded",
    });
  } finally {
    cron.close();
  }
  const completed = parseRuntimeResult("jobs.history", {
    runs: service.history(workspacePath, created.jobId),
  });
  assert.equal(completed.runs[0]?.status, "succeeded");
  assert.equal(typeof completed.runs[0]?.finishedAt, "number");
  const listed = parseRuntimeResult("jobs.list", { jobs: service.list(workspacePath) });
  assert.equal(listed.jobs[0]?.status, "succeeded");
  assert.equal(listed.jobs[0]?.latestRunId, started.runId);

  const { job: trusted } = parseRuntimeResult("automation.create", {
    job: await service.createWithSecurity(
      workspacePath,
      { prompt: "生成周报", schedule: "0 9 * * 1", timeZone: "UTC", enabled: false },
      security,
    ),
  });
  assert.equal(trusted.timeZone, "UTC");
  assert.equal(trusted.enabled, false);
  assert.equal(trusted.version, 1);
  for (const jobId of [created.jobId, trusted.jobId]) {
    parseRuntimeResult("jobs.setEnabled", {
      job: await service.setEnabled(workspacePath, jobId, false),
    });
    assert.deepEqual(
      parseRuntimeResult("jobs.delete", { deleted: service.delete(workspacePath, jobId) }),
      { deleted: true },
    );
  }
  assert.deepEqual(parseRuntimeResult("jobs.list", { jobs: service.list(workspacePath) }), {
    jobs: [],
  });
});

test("automation job metadata remains typed and unknown result fields stay rejected", async (context) => {
  const { service, workspacePath } = await fixture(context);
  const job = await service.create(workspacePath, {
    name: "日报",
    prompt: "生成日报",
    schedule: "0 9 * * *",
    enabled: false,
  });
  for (const patch of [
    { unexpected: "protocol-drift" },
    { id: "retired-alias" },
    { timeZone: "" },
    { timeZone: 1 },
    { version: "1" },
    { version: 0 },
    { version: 1.5 },
    { modelRouteId: "" },
    { latestRunId: "" },
  ]) {
    for (const method of [
      "jobs.create",
      "jobs.update",
      "jobs.setEnabled",
      "automation.create",
    ] as const) {
      assert.throws(
        () => parseRuntimeResult(method, { job: { ...job, ...patch } }),
        (error: unknown) =>
          error instanceof RuntimeProtocolError &&
          error.code === RUNTIME_ERROR_CODES.INVALID_REQUEST,
      );
    }
    assert.throws(() => parseRuntimeResult("jobs.list", { jobs: [{ ...job, ...patch }] }));
    assert.throws(() =>
      parseRuntimeResult("jobs.runNow", { job: { ...job, ...patch }, runId: "run-1" }),
    );
  }
  assert.throws(() => parseRuntimeResult("jobs.create", { job, unexpected: true }));
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { createRuntimeRequest, type JsonObject } from "@pico/protocol";
import { DesktopRuntimeService } from "@pico/pico-host/desktop-runtime-service";
import { WorkspaceRuntimeService } from "@pico/pico-host/workspace-runtime-service";
import type { WorkspaceTaskRuntime } from "@pico/pico-host/workspace-task-runtime";
import { globalSessionManager } from "@pico/pico-host/session";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { writeDesktopModelRouting } from "../../fixtures/desktop-model-routing.js";

interface Batch {
  admissionP95Ms: number;
  queueP95Ms: number;
  queueFraction: number;
  measured: number;
  providerWrites: number;
}
// Explicit opt-in: routine integration runs should not depend on machine performance.
test(
  "Provider admission benchmark uses real services and independent fixtures across 1/2/4 workspaces",
  { skip: process.env["PICO_RUN_ADMISSION_BENCHMARK"] !== "1", timeout: 240_000 },
  async (context) => {
    const results = [];
    for (const count of [1, 2, 4]) {
      const batches: Batch[] = [];
      for (let batch = 0; batch < 5; batch++) {
        const result = await runBatch(count);
        batches.push(result);
        console.log(
          JSON.stringify({
            fixture: "provider-admission",
            workspaces: count,
            batch: batch + 1,
            ...result,
          }),
        );
      }
      results.push({
        workspaces: count,
        batches,
        medianAdmissionP95Ms: percentile(
          batches.map((batch) => batch.admissionP95Ms),
          0.5,
        ),
        medianQueueP95Ms: percentile(
          batches.map((batch) => batch.queueP95Ms),
          0.5,
        ),
        medianQueueFraction: percentile(
          batches.map((batch) => batch.queueFraction),
          0.5,
        ),
      });
    }
    const two = results.find((result) => result.workspaces === 2)!;
    const output = {
      method: "run.start",
      fixturePerBatch: "new",
      warmupPerBatch: 20,
      measuredPerBatch: 200,
      batches: 5,
      clock: "performance.now",
      queueHistogramResolutionMs: 1,
      sharedAdmissionThresholdMet: two.medianQueueP95Ms > 100 && two.medianQueueFraction >= 0.25,
      results,
    };
    context.diagnostic(JSON.stringify(output));
    if (process.env["PICO_ADMISSION_BENCHMARK_OUTPUT"])
      await writeFile(
        process.env["PICO_ADMISSION_BENCHMARK_OUTPUT"]!,
        `${JSON.stringify(output, null, 2)}\n`,
      );
  },
);

async function runBatch(count: number): Promise<Batch> {
  const root = await mkdtemp(join(tmpdir(), "pico-provider-admission-"));
  const picoHome = join(root, "pico-home");
  await mkdir(picoHome);
  await writeDesktopModelRouting(picoHome);
  const env = { PICO_HOME: picoHome, PICO_TEST_TOKEN: "test-token" };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  const workspaces: string[] = [];
  for (let index = 0; index < count; index++) {
    const path = join(root, `workspace-${index}`);
    await mkdir(path);
    const canonical = await realpath(path);
    await trustStore.trust(canonical);
    workspaces.push(canonical);
  }
  const runtimes = new Map<string, WorkspaceTaskRuntime>();
  let executions = 0;
  const runtime = new WorkspaceRuntimeService({
    env,
    execute: async ({ workspacePath, workspaceRuntime }) => {
      runtimes.set(workspacePath, workspaceRuntime);
      executions++;
      return { deterministic: true };
    },
  });
  const desktop = new DesktopRuntimeService({ runtimeService: runtime, env, trustStore });
  let sequence = 0;
  let revision = (
    (await desktop.handle(createRuntimeRequest("config.user.get", {}))) as JsonObject
  )["revision"] as string;
  try {
    const wave = async (size: number, measured?: number[]): Promise<void> => {
      const admissions = workspaces.slice(0, size).map(async (workspacePath) => {
        const start = performance.now();
        const result = (await desktop.handle(
          createRuntimeRequest("run.start", {
            workspacePath,
            sessionId: "benchmark-session",
            prompt: "deterministic benchmark",
            idempotencyKey: `admission-${++sequence}`,
          }),
        )) as JsonObject;
        if (measured) measured.push(performance.now() - start);
        const workspaceRuntime = runtimes.get(workspacePath);
        assert.ok(workspaceRuntime);
        assert.equal(
          (await workspaceRuntime.waitForRun(result["runId"] as string)).status,
          "succeeded",
        );
      });
      const mutation =
        sequence % 20 === 0
          ? desktop
              .handle(
                createRuntimeRequest("config.user.update", {
                  defaults: {
                    modelRouteId: "test/coder",
                    thinkingEffort: sequence % 40 ? "off" : "high",
                  },
                  expectedRevision: revision,
                }),
              )
              .then((result) => {
                revision = (result as JsonObject)["revision"] as string;
              })
          : Promise.resolve();
      await Promise.all([...admissions, mutation]);
    };
    for (let sample = 0; sample < 20; sample += count) await wave(Math.min(count, 20 - sample));
    desktop.providerAdmissionMetrics(true);
    const durations: number[] = [];
    for (let sample = 0; sample < 200; sample += count)
      await wave(Math.min(count, 200 - sample), durations);
    const metrics = desktop.providerAdmissionMetrics(true);
    const admission = metrics["run.start"];
    assert.equal(admission.count, 200);
    assert.equal(durations.length, 200);
    assert.equal(metrics.mutation.count, 10);
    assert.equal(executions, 220);
    return {
      admissionP95Ms: percentile(durations, 0.95),
      queueP95Ms: admission.queueP95Ms,
      queueFraction: admission.queueMs / admission.admissionMs,
      measured: admission.count,
      providerWrites: metrics.mutation.count,
    };
  } finally {
    await desktop.close();
    for (const workspacePath of workspaces) {
      await globalSessionManager.delete("benchmark-session", workspacePath, { picoHome })?.close();
    }
    await rm(root, { recursive: true, force: true });
  }
}

function percentile(values: readonly number[], fraction: number): number {
  return [...values].sort((left, right) => left - right)[
    Math.max(0, Math.ceil(values.length * fraction) - 1)
  ]!;
}

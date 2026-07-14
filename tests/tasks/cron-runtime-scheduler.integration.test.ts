import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTaskRuntime } from "../../src/runtime/workspace-runtime.js";
import { CronRuntimeScheduler } from "../../src/tasks/cron-runtime-scheduler.js";
import { CronService } from "../../src/tasks/cron-service.js";

const exec = promisify(execFile);

describe("CronRuntimeScheduler integration", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("将当前分钟的 durable Cron Run 交给唯一 Workspace Runtime，并在完成后收口租约", async () => {
    const { root, repo } = await createRepository();
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const now = Date.UTC(2026, 0, 1, 12, 0, 15);
    const cron = new CronService({ workDir: repo, now: () => now, ownerId: "scheduler-test" });
    cleanups.push(() => cron.close());
    const runtime = await WorkspaceTaskRuntime.create({ workDir: repo });
    cleanups.push(() => runtime.close());
    const job = cron.create({
      workspacePath: repo,
      schedule: "0 12 * * *",
      timeZone: "UTC",
      prompt: "write the scheduled result",
      policySnapshot: yoloPolicy(now),
    });
    const scheduler = new CronRuntimeScheduler({
      cronService: cron,
      getWorkspaceRuntime: async () => runtime,
      canRun: async () => ({ allowed: true }),
      execute: async (_job, context) => {
        context.signal.throwIfAborted();
        return { summary: "completed by daemon runtime" };
      },
    });

    await scheduler.tick(now);

    expect(cron.runs({ cronJobId: job.cronJobId })).toEqual([
      expect.objectContaining({
        status: "succeeded",
        result: { summary: "completed by daemon runtime" },
      }),
    ]);
    expect(cron.events({ workspacePath: repo }).map((event) => event.topic)).toEqual(
      expect.arrayContaining(["cron.run.queued", "cron.run.running", "cron.run.succeeded"]),
    );
  });

  it.each(["canRun", "getWorkspaceRuntime", "listRuns", "claim"] as const)(
    "%s 异常会收口 queued Run，不阻塞下一分钟",
    async (failurePoint) => {
      const { root, repo } = await createRepository();
      cleanups.push(() => rm(root, { recursive: true, force: true }));
      const now = Date.UTC(2026, 0, 1, 12, 0, 15);
      const cron = new CronService({ workDir: repo, now: () => now, ownerId: "scheduler-test" });
      cleanups.push(() => cron.close());
      const runtime = await WorkspaceTaskRuntime.create({ workDir: repo });
      cleanups.push(() => runtime.close());
      const job = cron.create({
        workspacePath: repo,
        schedule: "* * * * *",
        timeZone: "UTC",
        prompt: "write the scheduled result",
        policySnapshot: yoloPolicy(now),
      });
      let shouldFail = true;
      const scheduler = new CronRuntimeScheduler({
        cronService: cron,
        getWorkspaceRuntime: async () => {
          if (shouldFail && failurePoint === "getWorkspaceRuntime") {
            throw new Error("runtime unavailable");
          }
          return runtime;
        },
        canRun: async () => {
          if (shouldFail && failurePoint === "canRun") throw new Error("policy unavailable");
          return { allowed: true };
        },
        execute: async () => ({ summary: "completed" }),
      });
      const listRuns =
        failurePoint === "listRuns"
          ? vi.spyOn(runtime, "listRuns").mockImplementation(() => {
              throw new Error("runtime state unavailable");
            })
          : undefined;
      const claim =
        failurePoint === "claim"
          ? vi.spyOn(cron, "claim").mockImplementation(() => {
              throw new Error("lease unavailable");
            })
          : undefined;

      await scheduler.tick(now);

      expect(cron.runs({ cronJobId: job.cronJobId })).toEqual([
        expect.objectContaining({
          status: "blocked",
          reason: expect.stringContaining("scheduler_preflight_failed:"),
        }),
      ]);

      listRuns?.mockRestore();
      claim?.mockRestore();
      shouldFail = false;
      await scheduler.tick(now + 60_000);

      expect(cron.runs({ cronJobId: job.cronJobId })).toEqual([
        expect.objectContaining({ status: "succeeded" }),
        expect.objectContaining({ status: "blocked" }),
      ]);
    },
  );
});

async function createRepository(): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), "pico-cron-runtime-"));
  const repo = join(root, "repo");
  await git(["init", "-b", "main", repo], root);
  await git(["config", "user.name", "Pico Integration"], repo);
  await git(["config", "user.email", "pico@example.test"], repo);
  await writeFile(join(repo, "README.md"), "cron runtime\n", "utf8");
  await git(["add", "."], repo);
  await git(["commit", "-m", "initial"], repo);
  return { root, repo };
}

async function git(args: readonly string[], cwd: string): Promise<void> {
  await exec("git", [...args], { cwd, encoding: "utf8" });
}

function yoloPolicy(createdAt: number) {
  return {
    mode: "yolo" as const,
    backgroundEnabled: true as const,
    trustedWorkspace: true as const,
    toolNetworkPolicy: "disabled" as const,
    allowedTools: ["read_file"],
    hardlineVersion: "hardline-v1",
    hookVersion: "hook-v1",
    createdAt,
  };
}

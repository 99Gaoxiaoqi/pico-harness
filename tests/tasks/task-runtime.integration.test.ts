import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobService } from "../../src/tasks/job-service.js";
import { TaskHostRuntime } from "../../src/tasks/task-runtime.js";
import { DelegationManager } from "../../src/tools/delegation-manager.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";
import { DelegateTaskTool, type AgentRunner } from "../../src/tools/subagent.js";

const exec = promisify(execFile);

describe("TaskHostRuntime durable executor integration", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("长时间 worker 持续 heartbeat，并以宿主合并作为成功终态", async () => {
    const { root, repo } = await createRepository();
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const leaseTtlMs = 60;
    let now = 1_000;
    const runtime = await TaskHostRuntime.create({
      workDir: repo,
      runtimeMirror: { leaseTtlMs, heartbeatIntervalMs: 15 },
      reconcileIntervalMs: 10,
      now: () => now,
    });
    cleanups.push(() => runtime.close());
    const heartbeat = vi.spyOn(runtime.jobService, "heartbeat");

    const entered = deferred();
    const release = deferred();
    cleanups.push(() => {
      release.resolve();
      return Promise.resolve();
    });
    const task = runtime.start(
      {
        description: "durable worker",
        branchSlug: "durable",
        completionMode: "merge_to_host",
        data: {
          ownerSessionId: "session-owner",
          childSessionId: "child-a",
          completionPolicy: "detached",
          internalCompletion: true,
        },
      },
      async (context) => {
        entered.resolve();
        await release.promise;
        await writeFile(join(context.worktreePath, "worker.txt"), "merged\n", "utf8");
        return { summary: "worker completed", data: { childSessionId: "child-a" } };
      },
    );
    await entered.promise;
    expect(runtime.jobService.get(task.taskId)?.job.status).toBe("running");

    const initialLeaseExpiresAt = now + leaseTtlMs;
    now = initialLeaseExpiresAt - 10;
    const renewedLeaseExpiresAt = now + leaseTtlMs;
    await vi.waitFor(() => {
      expect(heartbeat).toHaveReturnedWith(
        expect.objectContaining({
          heartbeatAt: now,
          expiresAt: renewedLeaseExpiresAt,
        }),
      );
    });

    // 跨过初始 lease 后主动执行回收，任务仍受续租 lease 保护。
    now = initialLeaseExpiresAt + 10;
    expect(now).toBeGreaterThan(initialLeaseExpiresAt);
    expect(now).toBeLessThan(renewedLeaseExpiresAt);
    expect(runtime.jobService.reconcileExpiredJobs()).toEqual([]);
    expect(runtime.jobService.get(task.taskId)?.job.status).toBe("running");

    release.resolve();

    const completed = await runtime.supervisor.wait(task.taskId);
    expect(completed).toMatchObject({
      status: "completed",
      finalization: { status: "merged" },
      dirty: false,
    });
    expect(await readFile(join(repo, "worker.txt"), "utf8")).toBe("merged\n");
    expect(runtime.jobService.get(task.taskId)).toMatchObject({
      job: {
        status: "succeeded",
        executionClass: "host_bound",
        ownerSessionId: "session-owner",
        childSessionId: "child-a",
        attemptCount: 1,
      },
      attempts: [
        {
          status: "succeeded",
          result: {
            finalization: { status: "merged" },
          },
        },
      ],
    });
    expect(runtime.jobService.listMerges(task.taskId)).toEqual([
      expect.objectContaining({ status: "merged", sourceHead: completed.commitHash }),
    ]);
    expect(runtime.jobService.pendingCompletions()).toEqual([]);

    const noChange = runtime.start(
      {
        description: "no changes",
        branchSlug: "no-change",
        completionMode: "merge_to_host",
        data: { ownerSessionId: "session-owner", internalCompletion: true },
      },
      async () => ({ summary: "nothing to commit" }),
    );
    await expect(runtime.supervisor.wait(noChange.taskId)).resolves.toMatchObject({
      status: "completed",
      finalization: { status: "not_needed" },
    });
    expect(runtime.jobService.listMerges(noChange.taskId)).toEqual([
      expect.objectContaining({ status: "not_needed" }),
    ]);
  });

  it("合并冲突保留主工作树现场，worker 只能收口为 partial", async () => {
    const { root, repo } = await createRepository();
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(repo, "shared.txt"), "base\n", "utf8");
    await git(["add", "shared.txt"], repo);
    await git(["commit", "-m", "add shared"], repo);

    const runtime = await TaskHostRuntime.create({ workDir: repo });
    cleanups.push(() => runtime.close());
    const runner: AgentRunner = {
      runSub: async (_prompt, _registry, _reporter, options) => {
        if (!options?.workDir) throw new Error("worker workDir missing");
        await writeFile(join(options.workDir, "shared.txt"), "worker\n", "utf8");
        await writeFile(join(repo, "shared.txt"), "host\n", "utf8");
        await git(["add", "shared.txt"], repo);
        await git(["commit", "-m", "host change"], repo);
        return { status: "completed", summary: "worker result remains on branch", artifacts: [] };
      },
    };
    const delegation = new DelegateTaskTool(
      runner,
      () => new ToolRegistry(),
      new DelegationManager(),
      {
        workDir: repo,
        worktreeSupervisor: runtime.supervisor,
        ownerSessionId: "session-conflict",
      },
    );
    const outer = JSON.parse(
      await delegation.execute(JSON.stringify({ goal: "conflicting worker", mode: "worker" })),
    ) as { status: string; results: Array<{ status: string; error?: string }> };
    expect(outer).toMatchObject({
      status: "partial",
      results: [
        {
          status: "partial",
          error: expect.stringContaining("git merge 失败"),
        },
      ],
    });

    const blocked = runtime.supervisor.list()[0]!;
    expect(blocked).toMatchObject({
      status: "failed",
      finalization: {
        status: "blocked",
        error: expect.stringContaining("git merge 失败"),
      },
    });
    expect(runtime.jobService.get(blocked.taskId)?.job).toMatchObject({
      status: "partial",
      ownerSessionId: "session-conflict",
    });
    expect(runtime.jobService.listMerges(blocked.taskId)).toEqual([
      expect.objectContaining({ status: "blocked", error: expect.stringContaining("已保留现场") }),
    ]);
    expect(await readFile(join(repo, "shared.txt"), "utf8")).toContain("<<<<<<< HEAD");
    await expect(access(blocked.worktreePath)).resolves.toBeUndefined();
    expect(runtime.jobService.pendingCompletions()).toEqual([]);
  });

  it("runtime.sqlite 独有的 queued/running 任务在重启后投影为可见兼容视图", async () => {
    const { root, repo } = await createRepository();
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const first = await JobService.create({ workDir: repo, ownerId: "first-host" });
    first.service.dispatch({
      jobId: "sqlite-only-queued",
      type: "local_agent",
      executionClass: "recoverable",
      completionPolicy: "optional",
      description: "queued only in sqlite",
      ownerSessionId: "owner-session",
    });
    const running = first.service.dispatch({
      jobId: "sqlite-only-running",
      type: "worker",
      executionClass: "recoverable",
      completionPolicy: "required",
      description: "running only in sqlite",
      ownerSessionId: "owner-session",
    });
    first.service.start(running.jobId, {
      expectedVersion: running.version,
      attemptId: "attempt-running",
      leaseTtlMs: 60_000,
    });
    first.service.close();

    const restored = await TaskHostRuntime.create({ workDir: repo });
    cleanups.push(() => restored.close());

    expect(restored.list()).toEqual([
      expect.objectContaining({
        taskId: "sqlite-only-queued",
        type: "local_agent",
        status: "pending",
      }),
      expect.objectContaining({
        taskId: "sqlite-only-running",
        type: "local_agent",
        status: "running",
        data: expect.objectContaining({
          runtimeStatus: "running",
          executionClass: "recoverable",
        }),
      }),
    ]);
    expect(restored.taskRegistry.get("sqlite-only-running")).toMatchObject({
      status: "running",
    });
    expect(restored.get("sqlite-only-running")).toMatchObject({
      status: "running",
      data: { attemptId: "attempt-running" },
    });

    const compatibility = JSON.parse(
      await readFile(join(repo, ".claw", "tasks", "state.json"), "utf8"),
    ) as { tasks: Array<{ taskId: string }> };
    expect(compatibility.tasks.map((task) => task.taskId)).toEqual([
      "sqlite-only-queued",
      "sqlite-only-running",
    ]);
  });
});

async function createRepository(): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-integration-"));
  const repo = join(root, "repo");
  await git(["init", "-b", "main", repo], root);
  await git(["config", "user.name", "Pico Integration"], repo);
  await git(["config", "user.email", "pico@example.test"], repo);
  await writeFile(join(repo, ".gitignore"), ".claw/\n.worktrees/\n", "utf8");
  await writeFile(join(repo, "README.md"), "runtime integration\n", "utf8");
  await git(["add", "."], repo);
  await git(["commit", "-m", "initial"], repo);
  return { root, repo };
}

async function git(args: readonly string[], cwd: string): Promise<string> {
  const result = await exec("git", [...args], { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

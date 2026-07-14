import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkspaceTaskRuntime,
  type WorkspaceRuntimeEvent,
} from "../../src/runtime/workspace-runtime.js";

const exec = promisify(execFile);

describe("WorkspaceTaskRuntime integration", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("以 canonical workspace 维护单一 Run，并发布 steer、cancel 与任务事件", async () => {
    const { root, repo } = await createRepository();
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    let now = 1_000;
    const runtime = await WorkspaceTaskRuntime.create({
      workDir: join(repo, "."),
      now: () => ++now,
      generateRunId: () => "run_workspace",
    });
    cleanups.push(() => runtime.close());
    const canonicalRepo = await realpath(repo);

    const events: WorkspaceRuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));
    const gate = deferred();
    let contextSteers: string[] = [];
    const run = runtime.startRun({ description: "long running agent" }, async (context) => {
      await gate.promise;
      contextSteers = context.drainSteers();
      context.signal.throwIfAborted();
      return { completed: true };
    });

    expect(run).toMatchObject({
      runId: "run_workspace",
      workspace: runtime.workspace,
      status: "running",
    });
    expect(runtime.workspace).toBe(canonicalRepo);
    expect(runtime.listRuns()).toEqual([expect.objectContaining({ runId: run.runId })]);
    expect(() => runtime.startRun({ description: "second" }, async () => undefined)).toThrow(
      "已有活跃 Run",
    );

    runtime.steer(run.runId, "use the focused test");
    expect(runtime.cancel(run.runId, "test cancellation")).toMatchObject({ status: "cancelling" });
    gate.resolve();
    await expect(runtime.waitForRun(run.runId)).resolves.toMatchObject({
      status: "cancelled",
      finishedAt: expect.any(Number),
    });
    expect(contextSteers).toEqual(["use the focused test"]);

    const task = runtime.startTask(
      { description: "workspace task", completionMode: "worktree_only" },
      async (context) => {
        await writeFile(join(context.worktreePath, "task.txt"), "done\n", "utf8");
        return { summary: "done" };
      },
    );
    await expect(runtime.taskHostRuntime.supervisor.wait(task.taskId)).resolves.toMatchObject({
      status: "completed",
    });
    expect(runtime.getTask(task.taskId)).toMatchObject({
      taskId: task.taskId,
      status: "completed",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "run.started",
          run: expect.objectContaining({ runId: run.runId }),
        }),
        expect.objectContaining({
          type: "run.steer_requested",
          run: expect.objectContaining({ runId: run.runId }),
        }),
        expect.objectContaining({
          type: "run.cancel_requested",
          run: expect.objectContaining({ runId: run.runId }),
        }),
        expect.objectContaining({
          type: "run.finished",
          run: expect.objectContaining({ status: "cancelled" }),
        }),
        expect.objectContaining({
          type: "task.updated",
          task: expect.objectContaining({ taskId: task.taskId }),
        }),
      ]),
    );
  });

  it("在安全边界暂停，继续后恢复执行", async () => {
    const { root, repo } = await createRepository();
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const runtime = await WorkspaceTaskRuntime.create({
      workDir: repo,
      generateRunId: () => "run_pause",
    });
    cleanups.push(() => runtime.close());

    const toolStarted = deferred();
    const toolFinished = deferred();
    const paused = deferred();
    let crossedBoundary = false;
    runtime.subscribe((event) => {
      if (event.type === "run.paused") paused.resolve();
    });
    const run = runtime.startRun({ description: "pause safely" }, async (context) => {
      toolStarted.resolve();
      await toolFinished.promise;
      await context.waitAtSafeBoundary();
      crossedBoundary = true;
      return { completed: true };
    });

    await toolStarted.promise;
    expect(runtime.pause(run.runId)).toMatchObject({ status: "pause_requested" });
    toolFinished.resolve();
    await paused.promise;
    expect(runtime.getRun(run.runId)).toMatchObject({ status: "paused" });
    expect(crossedBoundary).toBe(false);

    expect(runtime.resume(run.runId)).toMatchObject({ status: "running" });
    await expect(runtime.waitForRun(run.runId)).resolves.toMatchObject({ status: "succeeded" });
    expect(crossedBoundary).toBe(true);
  });

  it("取消已暂停 Run 时释放安全边界等待", async () => {
    const { root, repo } = await createRepository();
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const runtime = await WorkspaceTaskRuntime.create({
      workDir: repo,
      generateRunId: () => "run_cancel_paused",
    });
    cleanups.push(() => runtime.close());

    const ready = deferred();
    const enterBoundary = deferred();
    const paused = deferred();
    runtime.subscribe((event) => {
      if (event.type === "run.paused") paused.resolve();
    });
    const run = runtime.startRun({ description: "cancel paused" }, async (context) => {
      ready.resolve();
      await enterBoundary.promise;
      await context.waitAtSafeBoundary();
    });

    await ready.promise;
    runtime.pause(run.runId);
    enterBoundary.resolve();
    await paused.promise;
    expect(runtime.cancel(run.runId)).toMatchObject({ status: "cancelling" });
    await expect(runtime.waitForRun(run.runId)).resolves.toMatchObject({ status: "cancelled" });
  });
});

async function createRepository(): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), "pico-workspace-runtime-"));
  const repo = join(root, "repo");
  await git(["init", "-b", "main", repo], root);
  await git(["config", "user.name", "Pico Integration"], repo);
  await git(["config", "user.email", "pico@example.test"], repo);
  await writeFile(join(repo, ".gitignore"), ".claw/\n.worktrees/\n", "utf8");
  await writeFile(join(repo, "README.md"), "workspace runtime\n", "utf8");
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

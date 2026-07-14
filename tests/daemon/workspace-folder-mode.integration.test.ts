import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRuntimeRequest,
  DesktopRuntimeService,
  WorkspaceRegistrationStore,
  WorkspaceRuntimeService,
} from "../../src/daemon/index.js";

describe("普通文件夹 Runtime integration", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("可登记非 Git 文件夹并执行前台 Run，隔离任务需要版本保护", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-folder-runtime-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, "notes");
    await mkdir(workspace);
    const canonicalWorkspace = await realpath(workspace);
    const registrationStore = new WorkspaceRegistrationStore(
      join(root, "state", "workspaces.json"),
    );
    const runtimeService = new WorkspaceRuntimeService({
      registrationStore,
      execute: async ({ prompt }) => ({ reply: `finished: ${prompt}` }),
    });
    const desktopService = new DesktopRuntimeService({
      runtimeService,
      registrationStore,
    });
    cleanups.push(() => desktopService.close());

    await expect(
      desktopService.handle(
        createRuntimeRequest("workspace.register", { workspacePath: workspace }),
      ),
    ).resolves.toEqual({ workspacePath: canonicalWorkspace, registered: true });

    const expectedStatus = {
      workspacePath: canonicalWorkspace,
      registered: true,
      schedulerStatus: "unknown",
      mode: "folder",
      capabilities: {
        foregroundRuns: true,
        fileHistory: true,
        isolatedWorktrees: false,
        branchMerge: false,
      },
    };
    await expect(
      desktopService.handle(createRuntimeRequest("workspace.status", { workspacePath: workspace })),
    ).resolves.toEqual(expectedStatus);
    await expect(
      desktopService.handle(createRuntimeRequest("workspace.list", {})),
    ).resolves.toEqual({ workspaces: [expectedStatus] });

    const started = await desktopService.handle(
      createRuntimeRequest("run.start", { workspacePath: workspace, prompt: "organize notes" }),
    );
    expect(started).toMatchObject({ workspace: canonicalWorkspace, status: "running" });
    const runId = objectString(started, "runId");
    const runtime = await runtimeService.getWorkspaceRuntime(workspace);
    await expect(runtime.waitForRun(runId)).resolves.toMatchObject({
      status: "succeeded",
      result: { reply: "finished: organize notes" },
    });
    expect(runtime.listTasks()).toEqual([]);
    expect(runtime.getTask("missing")).toBeUndefined();
    expect(() =>
      runtime.startTask(
        { description: "isolated edit", completionMode: "worktree_only" },
        async () => undefined,
      ),
    ).toThrow("此功能需要先为项目启用版本保护");
  });
});

function objectString(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("期望 Runtime 返回对象");
  }
  const field = (value as Record<string, unknown>)[key];
  if (typeof field !== "string") throw new Error(`期望 ${key} 为字符串`);
  return field;
}

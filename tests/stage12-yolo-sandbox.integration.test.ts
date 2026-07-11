import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalManager, type ApprovalNotice } from "../src/approval/manager.js";
import { buildApprovalMiddleware } from "../src/cli/run-agent.js";
import type { InteractionMode } from "../src/input/session-settings.js";
import { DelegationManager } from "../src/tools/delegation-manager.js";
import { createSubagentRegistryFactory } from "../src/tools/delegation-registry.js";
import { buildDefaultToolRegistry } from "../src/tools/default-registry.js";
import type { Registry } from "../src/tools/registry.js";
import type { AgentRunner } from "../src/tools/subagent.js";
import { WorkspaceRoots } from "../src/tools/workspace-roots.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Bash permission mode integration", () => {
  it("主会话 YOLO 全程放权并保留 hardline，worker 继续受 worktree 沙箱约束", async () => {
    const workDir = await tempDir("pico-yolo-main-");
    const outsideDir = await tempDir("pico-yolo-outside-");
    const roots = await WorkspaceRoots.create(workDir);
    const notices: ApprovalNotice[] = [];
    const registry = buildDefaultToolRegistry(workDir, {
      truncateResults: false,
      deferWorkspaceBoundary: true,
      workspaceRoots: roots,
    });
    registry.use(
      buildApprovalMiddleware(
        (notice) => notices.push(notice),
        workDir,
        undefined,
        new ApprovalManager(100),
        { sessionId: "main-yolo", mode: "yolo", additionalDirectories: [] },
        roots,
      ),
    );

    const outsideFile = join(outsideDir, "direct.txt");
    const hiddenOutsideFile = join(outsideDir, "hidden.txt");
    const outsideWrite = await execute(registry, "write_file", {
      path: outsideFile,
      content: "direct-yolo",
    });
    const sensitiveWrite = await execute(registry, "write_file", {
      path: ".env",
      content: "TOKEN=yolo",
    });
    const hiddenWrite = await execute(registry, "bash", {
      command: nodeWriteCommand(hiddenOutsideFile, "hidden-yolo"),
    });
    const hardline = await execute(registry, "bash", {
      // 在临时非 Git 目录执行也不会产生远端副作用；若红线失效，测试仍可安全失败。
      command: "git push --force origin main",
    });

    expect([outsideWrite.isError, sensitiveWrite.isError, hiddenWrite.isError]).toEqual([
      false,
      false,
      false,
    ]);
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("direct-yolo");
    await expect(readFile(hiddenOutsideFile, "utf8")).resolves.toBe("hidden-yolo");
    await expect(readFile(join(workDir, ".env"), "utf8")).resolves.toBe("TOKEN=yolo");
    expect(hardline).toMatchObject({
      isError: true,
      output: expect.stringContaining("Hardline"),
    });
    expect(notices).toHaveLength(0);

    const runner: AgentRunner = {
      runSub: async () => ({ summary: "unused", artifacts: [] }),
    };
    const workerRegistry = createSubagentRegistryFactory({
      workDir,
      workspaceRoots: roots,
      runner,
      manager: new DelegationManager(),
      yoloSandbox: {},
    })({ mode: "worker", role: "leaf", depth: 1, maxSpawnDepth: 2 });
    const workerDirectFile = join(outsideDir, "worker-direct.txt");
    const workerHiddenFile = join(outsideDir, "worker-hidden.txt");
    const workerDirect = await execute(workerRegistry, "write_file", {
      path: workerDirectFile,
      content: "blocked",
    });
    const workerHidden = await execute(workerRegistry, "bash", {
      command: nodeWriteCommand(workerHiddenFile, "blocked"),
    });

    expect(workerDirect).toMatchObject({
      isError: true,
      output: expect.stringContaining("[sandbox:workspace_write_denied]"),
    });
    expect(workerHidden).toMatchObject({
      isError: true,
      output: expect.stringContaining("[sandbox:"),
    });
    await expect(access(workerDirectFile)).rejects.toThrow();
    await expect(access(workerHiddenFile)).rejects.toThrow();
  });

  it("default/auto 对不确定 Bash 请求审批，Plan 仅放行可证明只读命令", async () => {
    const workDir = await tempDir("pico-bash-permission-");
    const roots = await WorkspaceRoots.create(workDir);

    for (const mode of ["default", "auto"] as const) {
      const manager = new ApprovalManager(1_000);
      let resolveNotice!: (notice: ApprovalNotice) => void;
      const noticeReady = new Promise<ApprovalNotice>((resolve) => {
        resolveNotice = resolve;
      });
      const registry = registryForMode(workDir, roots, mode, manager, resolveNotice);

      const readOnly = await execute(registry, "bash", { command: "pwd | wc -l" });
      expect(readOnly.isError).toBe(false);

      const target = join(workDir, `${mode}-indirect.txt`);
      const pending = execute(registry, "bash", {
        command: nodeWriteCommand(target, "must-not-run"),
      });
      const notice = await noticeReady;
      expect(notice.preview?.summary).toContain("bash 执行");
      expect(manager.resolveApproval(notice.taskId, false, "integration reject")).toBe(true);
      const rejected = await pending;
      expect(rejected.isError).toBe(true);
      await expect(access(target)).rejects.toThrow();
    }

    const planNotices: ApprovalNotice[] = [];
    const planManager = new ApprovalManager(1_000);
    const planRegistry = registryForMode(workDir, roots, "plan", planManager, (notice) =>
      planNotices.push(notice),
    );
    const planReadOnly = await execute(planRegistry, "bash", { command: "pwd | wc -l" });
    const interpreter = await execute(planRegistry, "bash", {
      command: nodeWriteCommand(join(workDir, "plan-indirect.txt"), "must-not-run"),
    });
    const redirect = await execute(planRegistry, "bash", {
      command: "printf planned > PLAN.md",
    });

    expect(planReadOnly.isError).toBe(false);
    for (const rejected of [interpreter, redirect]) {
      expect(rejected).toMatchObject({
        isError: true,
        output: expect.stringContaining("只允许可证明只读的 Bash"),
      });
    }
    expect(planNotices).toHaveLength(0);
    await expect(access(join(workDir, "plan-indirect.txt"))).rejects.toThrow();
    await expect(access(join(workDir, "PLAN.md"))).rejects.toThrow();
  });
});

function registryForMode(
  workDir: string,
  roots: WorkspaceRoots,
  mode: InteractionMode,
  manager: ApprovalManager,
  notifier: (notice: ApprovalNotice) => void,
) {
  const registry = buildDefaultToolRegistry(workDir, {
    truncateResults: false,
    deferWorkspaceBoundary: true,
    workspaceRoots: roots,
  });
  registry.use(
    buildApprovalMiddleware(
      notifier,
      workDir,
      undefined,
      manager,
      { sessionId: `bash-${mode}`, mode, additionalDirectories: [] },
      roots,
    ),
  );
  return registry;
}

async function tempDir(prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  tempDirs.push(path);
  return path;
}

async function execute(registry: Registry, name: string, input: object) {
  return registry.execute({
    id: `${name}-${Math.random().toString(16).slice(2)}`,
    name,
    arguments: JSON.stringify(input),
  });
}

function nodeWriteCommand(path: string, content: string): string {
  const script = `require("node:fs").writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(content)})`;
  return `node -e ${shellQuote(script)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

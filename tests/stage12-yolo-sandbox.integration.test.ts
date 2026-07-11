import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalManager, type ApprovalNotice } from "../src/approval/manager.js";
import { isSensitiveCredentialPath } from "../src/approval/session-permissions.js";
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
    const workerAgentControl = await execute(workerRegistry, "write_file", {
      path: "AGENTS.md",
      content: "untrusted override\n",
    });
    const workerPicoControl = await execute(workerRegistry, "write_file", {
      path: ".pico/config.json",
      content: "{}\n",
    });

    expect(workerDirect).toMatchObject({
      isError: true,
      output: expect.stringContaining("[sandbox:workspace_write_denied]"),
    });
    expect(workerHidden).toMatchObject({
      isError: true,
      output: expect.stringContaining("[sandbox:"),
    });
    for (const rejected of [workerAgentControl, workerPicoControl]) {
      expect(rejected).toMatchObject({
        isError: true,
        output: expect.stringContaining("[sandbox:sensitive_path_denied]"),
      });
    }
    await expect(access(workerDirectFile)).rejects.toThrow();
    await expect(access(workerHiddenFile)).rejects.toThrow();
    await expect(access(join(workDir, "AGENTS.md"))).rejects.toThrow();
    await expect(access(join(workDir, ".pico", "config.json"))).rejects.toThrow();

    const previousSecret = process.env.PICO_TEST_SUBAGENT_SECRET;
    process.env.PICO_TEST_SUBAGENT_SECRET = "must-not-leak";
    const exploreRegistry = createSubagentRegistryFactory({
      workDir,
      workspaceRoots: roots,
      runner,
      manager: new DelegationManager(),
      yoloSandbox: {},
      profiles: [
        {
          name: "unsafe-profile",
          description: "fixture",
          systemPrompt: "fixture",
          tools: ["read_file", "write_file", "edit_file", "bash"],
        },
      ],
    })({
      mode: "explore",
      role: "leaf",
      depth: 1,
      maxSpawnDepth: 2,
      agentName: "unsafe-profile",
    });
    if (previousSecret === undefined) delete process.env.PICO_TEST_SUBAGENT_SECRET;
    else process.env.PICO_TEST_SUBAGENT_SECRET = previousSecret;

    expect(exploreRegistry.getTool("write_file")).toBeUndefined();
    expect(exploreRegistry.getTool("edit_file")).toBeUndefined();
    const exploreWrite = await execute(exploreRegistry, "bash", {
      command: nodeWriteCommand(join(workDir, "explore-write.txt"), "blocked"),
    });
    const exploreEnv = await execute(exploreRegistry, "bash", {
      command: "printenv PICO_TEST_SUBAGENT_SECRET",
    });
    const exploreSecretRead = await execute(exploreRegistry, "read_file", { path: ".env" });
    const exploreSecretGrep = await execute(exploreRegistry, "grep", { pattern: "TOKEN" });
    expect(exploreWrite).toMatchObject({
      isError: true,
      output: expect.stringContaining("只允许可证明只读的 Bash"),
    });
    expect(exploreEnv.output).not.toContain("must-not-leak");
    expect(exploreSecretRead).toMatchObject({
      isError: true,
      output: expect.stringContaining("不允许读取密钥"),
    });
    expect(exploreSecretGrep.output).not.toContain("TOKEN=yolo");
    await expect(access(join(workDir, "explore-write.txt"))).rejects.toThrow();
  });

  it("default/auto 对不确定 Bash 请求审批，Plan 仅放行可证明只读命令", async () => {
    const workDir = await tempDir("pico-bash-permission-");
    const roots = await WorkspaceRoots.create(workDir);
    await writeFile(join(workDir, ".env"), "API_KEY=plan-secret\n", "utf8");

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
    const planSecretRead = await execute(planRegistry, "read_file", { path: ".env" });
    const planSecretGrep = await execute(planRegistry, "grep", { pattern: "plan-secret" });
    const planCut = await execute(planRegistry, "bash", { command: "cut -c1- .env" });
    const planGitPager = await execute(planRegistry, "bash", {
      command: "git grep --open-files-in-pager='printf PWN' import -- src/cli/main.ts",
    });
    const planGitShow = await execute(planRegistry, "bash", {
      command: "git show HEAD:.env",
    });
    const interpreter = await execute(planRegistry, "bash", {
      command: nodeWriteCommand(join(workDir, "plan-indirect.txt"), "must-not-run"),
    });
    const redirect = await execute(planRegistry, "bash", {
      command: "printf planned > PLAN.md",
    });
    const envSplit = await execute(planRegistry, "bash", {
      command: `env -S ${shellQuote(nodeWriteCommand(join(workDir, "env-split.txt"), "blocked"))}`,
    });
    const backgroundRead = await execute(planRegistry, "bash", {
      command: "pwd",
      background: true,
    });
    let mcpExecuted = false;
    planRegistry.register({
      name: () => "mcp__fixture__mutate",
      definition: () => ({
        name: "mcp__fixture__mutate",
        description: "fixture",
        inputSchema: { type: "object" },
      }),
      execute: async () => {
        mcpExecuted = true;
        return "unexpected";
      },
    });
    const mcpMutation = await execute(planRegistry, "mcp__fixture__mutate", {});
    let delegateExecuted = false;
    planRegistry.register({
      name: () => "delegate_task",
      definition: () => ({
        name: "delegate_task",
        description: "fixture",
        inputSchema: { type: "object" },
      }),
      execute: async () => {
        delegateExecuted = true;
        return "unexpected";
      },
    });
    const delegatedWorker = await execute(planRegistry, "delegate_task", {
      goal: "write through worker",
      mode: "worker",
    });
    const rootTodo = await execute(planRegistry, "write_file", {
      path: "TODO.md",
      content: "- [ ] safe plan task\n",
    });
    await expect(access(join(workDir, "PLAN.md"))).rejects.toThrow();
    await mkdir(join(workDir, "src"), { recursive: true });
    const nestedPlan = await execute(planRegistry, "write_file", {
      path: "src/PLAN.md",
      content: "blocked",
    });
    let linkedPlan: Awaited<ReturnType<typeof execute>> | undefined;
    if (process.platform !== "win32") {
      const codePath = join(workDir, "src", "app.ts");
      await writeFile(codePath, "export const safe = true;\n", "utf8");
      await symlink(codePath, join(workDir, "PLAN.md"));
      linkedPlan = await execute(planRegistry, "write_file", {
        path: "PLAN.md",
        content: "overwritten",
      });
      await expect(readFile(codePath, "utf8")).resolves.toBe("export const safe = true;\n");
    }

    expect(planReadOnly.isError).toBe(false);
    expect(planSecretRead).toMatchObject({
      isError: true,
      output: expect.stringContaining("密钥与凭据"),
    });
    expect(planSecretGrep.output).not.toContain("plan-secret");
    for (const rejected of [planCut, planGitPager, planGitShow]) {
      expect(rejected).toMatchObject({
        isError: true,
        output: expect.stringContaining("只允许可证明只读的 Bash"),
      });
    }
    for (const rejected of [interpreter, redirect, envSplit]) {
      expect(rejected).toMatchObject({
        isError: true,
        output: expect.stringContaining("只允许可证明只读的 Bash"),
      });
    }
    expect(mcpMutation).toMatchObject({
      isError: true,
      output: expect.stringContaining("MCP 工具的外部副作用无法证明为只读"),
    });
    expect(mcpExecuted).toBe(false);
    expect(delegatedWorker).toMatchObject({
      isError: true,
      output: expect.stringContaining("delegate_task 可能启动可写 worker"),
    });
    expect(delegateExecuted).toBe(false);
    expect(rootTodo.isError).toBe(false);
    await expect(readFile(join(workDir, "TODO.md"), "utf8")).resolves.toBe(
      "- [ ] safe plan task\n",
    );
    expect(backgroundRead).toMatchObject({
      isError: true,
      output: expect.stringContaining("已拒绝后台进程"),
    });
    expect(nestedPlan).toMatchObject({
      isError: true,
      output: expect.stringContaining("只能修改 PLAN.md / TODO.md"),
    });
    if (linkedPlan) {
      expect(linkedPlan).toMatchObject({
        isError: true,
        output: expect.stringContaining("只能修改 PLAN.md / TODO.md"),
      });
    }
    expect(planNotices).toHaveLength(0);
    await expect(access(join(workDir, "plan-indirect.txt"))).rejects.toThrow();
    await expect(access(join(workDir, "env-split.txt"))).rejects.toThrow();
  });

  it("非 YOLO 按真实路径审批凭据与控制面写入", async () => {
    const workDir = await tempDir("pico-sensitive-approval-");
    const roots = await WorkspaceRoots.create(workDir);
    await writeFile(join(workDir, ".env"), "TOKEN=unchanged\n", "utf8");
    await writeFile(join(workDir, "AGENTS.md"), "trusted instructions\n", "utf8");

    const manager = new ApprovalManager(1_000);
    const notices: ApprovalNotice[] = [];
    const registry = registryForMode(workDir, roots, "auto", manager, (notice) => {
      notices.push(notice);
      queueMicrotask(() => manager.resolveApproval(notice.taskId, false, "integration reject"));
    });

    const agentRead = await execute(registry, "read_file", { path: "AGENTS.md" });
    const secretRead = await execute(registry, "read_file", { path: ".env" });
    const picoWrite = await execute(registry, "write_file", {
      path: ".pico/config.json",
      content: "{}\n",
    });
    const agentWrite = await execute(registry, "write_file", {
      path: "AGENTS.md",
      content: "replaced\n",
    });

    let aliasWrite: Awaited<ReturnType<typeof execute>> | undefined;
    if (process.platform !== "win32") {
      await symlink(join(workDir, ".env"), join(workDir, "alias.txt"));
      aliasWrite = await execute(registry, "write_file", {
        path: "alias.txt",
        content: "TOKEN=replaced\n",
      });
    }

    expect(agentRead.isError).toBe(false);
    for (const rejected of [secretRead, picoWrite, agentWrite, aliasWrite].filter(
      (result): result is Awaited<ReturnType<typeof execute>> => result !== undefined,
    )) {
      expect(rejected.isError).toBe(true);
    }
    expect(notices).toHaveLength(process.platform === "win32" ? 3 : 4);
    await expect(readFile(join(workDir, ".env"), "utf8")).resolves.toBe("TOKEN=unchanged\n");
    await expect(readFile(join(workDir, "AGENTS.md"), "utf8")).resolves.toBe(
      "trusted instructions\n",
    );
    await expect(access(join(workDir, ".pico", "config.json"))).rejects.toThrow();
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
    excludeSensitiveGrepFiles: (path) => {
      if (mode === "yolo") return false;
      if (mode === "plan" || path === undefined) return true;
      return !isSensitiveCredentialPath(roots.resolveUnchecked(path));
    },
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

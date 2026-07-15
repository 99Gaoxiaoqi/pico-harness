import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runAgentFromCli } from "../src/cli/run-agent.js";
import { globalSessionManager } from "../src/engine/session.js";
import { createSessionRuntime } from "../src/runtime/session-runtime.js";
import { TaskHostRuntime } from "../src/tasks/task-runtime.js";

const exec = promisify(execFile);

const realModelEnabled =
  process.env.RUN_REAL_MODEL_TEST === "1" &&
  Boolean(process.env.LLM_BASE_URL && process.env.LLM_API_KEY);

const describeRealModel = realModelEnabled ? describe : describe.skip;

describeRealModel("real model delegation integration", () => {
  it("uses delegate_task to launch a worker subagent that writes a real file", async () => {
    const { root, repo: workDir } = await createRepository();
    const sessionId = `real-delegate-test-${Date.now()}`;
    let taskHostRuntime: TaskHostRuntime | undefined;
    let runtimeState: Awaited<ReturnType<typeof createSessionRuntime>> | undefined;

    try {
      taskHostRuntime = await TaskHostRuntime.create({ workDir });
      const session = await globalSessionManager.getOrCreate(sessionId, workDir);
      runtimeState = await createSessionRuntime({
        workDir,
        sessionId,
        session,
        taskHostRuntime,
        lspServers: [],
        hooks: false,
      });
      const result = await runAgentFromCli(
        {
          prompt:
            "这是一次真实模型集成测试。你必须调用 delegate_task 工具，不要直接调用 write_file。" +
            "请用 delegate_task 的 tasks 参数启动 1 个 mode=worker 的子代理。" +
            "子代理目标：必须调用 write_file，在当前工作区创建 real-subagent-result.txt，" +
            "文件内容必须精确为 REAL_SUBAGENT_OK。子代理完成后，你读取/确认结果，" +
            "然后最终只回复 REAL_DELEGATE_DONE。",
          dir: workDir,
          session: sessionId,
          provider: "openai",
          planMode: false,
        },
        { runtimeState },
      );

      expect(result.finalMessage.trim()).toBe("REAL_DELEGATE_DONE");
      expect(await readFile(join(workDir, "real-subagent-result.txt"), "utf8")).toBe(
        "REAL_SUBAGENT_OK",
      );
    } finally {
      await runtimeState?.dispose();
      await taskHostRuntime?.close();
      const session = globalSessionManager.delete(sessionId, workDir);
      await session?.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);
});

async function createRepository(): Promise<{ root: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), "pico-real-delegate-test-"));
  const repo = join(root, "repo");
  await git(["init", "-b", "main", repo], root);
  await git(["config", "user.name", "Pico Real E2E"], repo);
  await git(["config", "user.email", "pico@example.test"], repo);
  await writeFile(join(repo, ".gitignore"), ".worktrees/\n", "utf8");
  await writeFile(join(repo, "README.md"), "real model delegation fixture\n", "utf8");
  await git(["add", "."], repo);
  await git(["commit", "-m", "initial"], repo);
  return { root, repo: await realpath(repo) };
}

async function git(args: readonly string[], cwd: string): Promise<void> {
  await exec("git", [...args], { cwd, encoding: "utf8" });
}

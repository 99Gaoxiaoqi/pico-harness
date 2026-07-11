import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { runCli, type CliRuntime } from "../src/cli/main.js";
import { resolveCliWorkDir } from "../src/cli/session-args.js";
import {
  ensureWorkspaceTrusted,
  WorkspaceTrustStore,
  type WorkspaceTrustPrompt,
  type WorkspaceTrustPromptRequest,
} from "../src/security/workspace-trust.js";

describe("workspace trust startup integration", () => {
  it("首次显式信任后持久化，已信任工作区直接启动，非交互首启 fail-closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-workspace-trust-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    const untrustedWorkspace = join(root, "untrusted");
    const userStateDirectory = join(root, "home", ".pico");
    await mkdir(join(workspace, ".pico"), { recursive: true });
    await mkdir(untrustedWorkspace, { recursive: true });
    // 项目内文件即使声明 trusted 也不能自行越过用户级信任门。
    await writeFile(join(workspace, ".pico", "config.json"), '{"trusted":true}\n', "utf8");

    const store = new WorkspaceTrustStore({
      userStateDirectory,
      now: () => new Date("2026-07-11T00:00:00.000Z"),
    });
    const trustRequests: WorkspaceTrustPromptRequest[] = [];
    const prompt = {
      requestTrust: vi.fn(async (request: WorkspaceTrustPromptRequest) => {
        trustRequests.push(request);
        return "trust" as const;
      }),
    } satisfies WorkspaceTrustPrompt;
    const firstEvents: string[] = [];
    const firstStart = vi.fn(async () => {
      firstEvents.push("tui");
    });
    const firstRuntime = createRuntime({
      workDir: workspace,
      store,
      prompt,
      events: firstEvents,
      startTuiRepl: firstStart,
    });

    await expect(runCli(["--dir", workspace], firstRuntime)).resolves.toBe(0);

    const canonicalWorkspace = await resolveCliWorkDir(workspace);
    expect(firstEvents).toEqual(["resolve-dir", "trust", "tokenizer", "session", "tui"]);
    expect(prompt.requestTrust).toHaveBeenCalledOnce();
    expect(trustRequests[0]?.workspacePath).toBe(canonicalWorkspace);
    const displayedRisks = trustRequests[0]?.risks.join(" ") ?? "";
    for (const expectedRisk of ["AGENTS.md", "LSP", "Provider", "MCP", "Hook"]) {
      expect(displayedRisks).toContain(expectedRisk);
    }
    expect(firstStart).toHaveBeenCalledOnce();

    const persisted = JSON.parse(await readFile(store.filePath, "utf8")) as {
      workspaces: Array<{ path: string; trustedAt: string }>;
    };
    expect(persisted.workspaces).toEqual([
      { path: canonicalWorkspace, trustedAt: "2026-07-11T00:00:00.000Z" },
    ]);
    if (process.platform !== "win32") {
      expect((await stat(store.directoryPath)).mode & 0o777).toBe(0o700);
      expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
    }

    const unexpectedPrompt = {
      requestTrust: vi.fn(async () => {
        throw new Error("已信任工作区不应再询问");
      }),
    } satisfies WorkspaceTrustPrompt;
    const resumedStart = vi.fn(async () => {});
    await expect(
      runCli(
        ["--dir", workspace],
        createRuntime({
          workDir: workspace,
          store,
          prompt: unexpectedPrompt,
          events: [],
          startTuiRepl: resumedStart,
        }),
      ),
    ).resolves.toBe(0);
    expect(unexpectedPrompt.requestTrust).not.toHaveBeenCalled();
    expect(resumedStart).toHaveBeenCalledOnce();

    const stderr: string[] = [];
    const closedStart = vi.fn(async () => {});
    const closedRuntime = createRuntime({
      workDir: untrustedWorkspace,
      store,
      events: [],
      startTuiRepl: closedStart,
      stderr,
    });
    await expect(runCli(["--dir", untrustedWorkspace], closedRuntime)).resolves.toBe(1);
    expect(stderr.join("")).toMatch(/工作区尚未信任.*非交互环境.*交互式终端/su);
    expect(closedStart).not.toHaveBeenCalled();

    if (process.platform !== "win32") {
      const linkedStateParent = join(root, "linked-state");
      const attackerDirectory = join(root, "attacker-state");
      await Promise.all([
        mkdir(linkedStateParent, { recursive: true }),
        mkdir(attackerDirectory, { recursive: true }),
      ]);
      const linkedStateDirectory = join(linkedStateParent, ".pico");
      await symlink(attackerDirectory, linkedStateDirectory, "dir");
      await expect(
        ensureWorkspaceTrusted(workspace, {
          store: new WorkspaceTrustStore({ userStateDirectory: linkedStateDirectory }),
          prompt,
        }),
      ).rejects.toThrow(/信任状态目录.*不能是符号链接/u);
    }
  });
});

function createRuntime(options: {
  workDir: string;
  store: WorkspaceTrustStore;
  prompt?: WorkspaceTrustPrompt;
  events: string[];
  startTuiRepl: CliRuntime["startTuiRepl"];
  stderr?: string[];
}): CliRuntime {
  return {
    env: {},
    version: "test",
    writeStdout: () => undefined,
    writeStderr: (text) => options.stderr?.push(text),
    resolveCliWorkDir: async () => {
      options.events.push("resolve-dir");
      return resolveCliWorkDir(options.workDir);
    },
    ensureWorkspaceTrusted: async (workDir) => {
      options.events.push("trust");
      await ensureWorkspaceTrusted(workDir, {
        store: options.store,
        ...(options.prompt ? { prompt: options.prompt } : {}),
      });
    },
    primeTokenizer: async () => {
      options.events.push("tokenizer");
    },
    resolveCliStartupSession: async (_args, startupOptions) => {
      options.events.push("session");
      return {
        workDir: startupOptions?.trustedWorkDir ?? options.workDir,
        sessionSelection: { mode: "new", sessionId: "trust-integration" },
      };
    },
    startTuiRepl: options.startTuiRepl,
  };
}

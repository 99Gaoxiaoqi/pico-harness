import { access, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalManager } from "../src/approval/manager.js";
import { buildApprovalMiddleware } from "../src/cli/run-agent.js";
import { detectSandboxBackend } from "../src/safety/yolo-sandbox.js";
import { buildDefaultToolRegistry } from "../src/tools/default-registry.js";
import { WorkspaceRoots } from "../src/tools/workspace-roots.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Stage 12 trusted YOLO integration", () => {
  it("普通工作区写入无审批，越界、敏感路径与网络由宿主边界拒绝", async () => {
    const workDir = await tempDir("pico-stage12-yolo-");
    const outsideDir = await tempDir("pico-stage12-outside-");
    const roots = await WorkspaceRoots.create(workDir);
    const notices: unknown[] = [];
    const registry = buildDefaultToolRegistry(workDir, {
      truncateResults: false,
      deferWorkspaceBoundary: true,
      workspaceRoots: roots,
      yoloSandbox: {},
    });
    registry.use(
      buildApprovalMiddleware(
        (notice) => notices.push(notice),
        workDir,
        undefined,
        new ApprovalManager(100),
        { sessionId: "stage12-yolo", mode: "yolo", additionalDirectories: [] },
        roots,
      ),
    );

    const ordinary = await execute(registry, "write_file", {
      path: "ordinary.txt",
      content: "before",
    });
    const edited = await execute(registry, "edit_file", {
      path: "ordinary.txt",
      old_text: "before",
      new_text: "after",
    });
    expect(ordinary.isError).toBe(false);
    expect(edited.isError).toBe(false);
    await expect(readFile(join(workDir, "ordinary.txt"), "utf8")).resolves.toBe("after");

    const outsideFile = join(outsideDir, "blocked.txt");
    const outsideWrite = await execute(registry, "write_file", {
      path: outsideFile,
      content: "blocked",
    });
    const sensitiveWrite = await execute(registry, "write_file", {
      path: "nested/.env.secret",
      content: "TOKEN=blocked",
    });
    expect(outsideWrite).toMatchObject({
      isError: true,
      output: expect.stringContaining("[sandbox:workspace_write_denied]"),
    });
    expect(sensitiveWrite).toMatchObject({
      isError: true,
      output: expect.stringContaining("[sandbox:sensitive_path_denied]"),
    });
    await expect(access(outsideFile)).rejects.toThrow();

    const backend = detectSandboxBackend();
    const bashOrdinaryPath = join(workDir, "bash-ordinary.txt");
    const bashOrdinary = await execute(registry, "bash", {
      command: nodeWriteCommand(bashOrdinaryPath, "bash-ok"),
    });
    if (backend === "unavailable") {
      expect(bashOrdinary).toMatchObject({
        isError: true,
        output: expect.stringContaining("[sandbox:sandbox_unavailable]"),
      });
    } else {
      expect(bashOrdinary.isError).toBe(false);
      await expect(readFile(bashOrdinaryPath, "utf8")).resolves.toBe("bash-ok");

      const nestedGit = join(workDir, "nested", ".git");
      await mkdir(nestedGit, { recursive: true });
      const sensitiveFile = join(nestedGit, "config");
      const hiddenOutside = await execute(registry, "bash", {
        command: nodeWriteCommand(outsideFile, "bypass"),
      });
      const hiddenSensitive = await execute(registry, "bash", {
        command: nodeWriteCommand(sensitiveFile, "bypass"),
      });
      const hiddenNetwork = await execute(registry, "bash", {
        command: nodeNetworkCommand(),
      });
      for (const result of [hiddenOutside, hiddenSensitive, hiddenNetwork]) {
        expect(result).toMatchObject({
          isError: true,
          output: expect.stringContaining("[sandbox:sandbox_runtime_denied]"),
        });
      }
      await expect(access(outsideFile)).rejects.toThrow();
      await expect(access(sensitiveFile)).rejects.toThrow();
    }

    expect(notices).toHaveLength(0);
  });
});

async function tempDir(prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  tempDirs.push(path);
  return path;
}

async function execute(
  registry: ReturnType<typeof buildDefaultToolRegistry>,
  name: string,
  input: object,
) {
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

function nodeNetworkCommand(): string {
  const script =
    'const socket=require("node:net").connect(80,"1.1.1.1");' +
    'socket.on("error",error=>{console.error(error);process.exit(2)});' +
    "setTimeout(()=>process.exit(3),500)";
  return `node -e ${shellQuote(script)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

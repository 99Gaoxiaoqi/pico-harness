import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDefaultToolRegistry } from "../../src/tools/default-registry.js";
import { GlobTool } from "../../src/tools/glob.js";
import { GrepTool, resetRgCache, setRgAvailable } from "../../src/tools/grep.js";
import { EditFileTool, ReadFileTool, WriteFileTool } from "../../src/tools/registry-impl.js";
import { WorkspaceRoots } from "../../src/tools/workspace-roots.js";

describe("附加工作目录文件工具", () => {
  let sandbox: string;
  let primaryRoot: string;
  let additionalRoot: string;
  let outsideRoot: string;
  let roots: WorkspaceRoots;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "pico-additional-tools-"));
    primaryRoot = join(sandbox, "primary");
    additionalRoot = join(sandbox, "additional");
    outsideRoot = join(sandbox, "outside");
    await Promise.all([mkdir(primaryRoot), mkdir(additionalRoot), mkdir(outsideRoot)]);
    await writeFile(join(additionalRoot, "note.txt"), "hello old\n");
    await writeFile(join(outsideRoot, "secret.txt"), "secret\n");
    roots = await WorkspaceRoots.create(primaryRoot, [additionalRoot]);
    setRgAvailable(false);
  });

  afterEach(async () => {
    resetRgCache();
    await rm(sandbox, { recursive: true, force: true });
  });

  it("Read/Write/Edit 共享 roots 并访问附加目录", async () => {
    const readTool = new ReadFileTool(roots);
    const writeTool = new WriteFileTool(roots);
    const editTool = new EditFileTool(roots);
    const created = join(additionalRoot, "nested", "created.txt");

    await writeTool.execute(JSON.stringify({ path: created, content: "created\n" }));
    await editTool.execute(
      JSON.stringify({
        path: join(additionalRoot, "note.txt"),
        old_text: "hello old",
        new_text: "hello new",
      }),
    );

    await expect(readTool.execute(JSON.stringify({ path: created }))).resolves.toContain("created");
    await expect(
      readTool.execute(JSON.stringify({ path: join(additionalRoot, "note.txt") })),
    ).resolves.toContain("hello new");
  });

  it("Glob/Grep 共享 roots 并搜索附加目录", async () => {
    const globTool = new GlobTool(roots);
    const grepTool = new GrepTool(roots);

    await expect(
      globTool.execute(JSON.stringify({ path: additionalRoot, pattern: "**/*.txt" })),
    ).resolves.toContain("note.txt");
    await expect(
      grepTool.execute(JSON.stringify({ path: additionalRoot, pattern: "hello" })),
    ).resolves.toContain("note.txt:1:hello old");
  });

  it("五类文件工具 schema 都说明可访问已授权工作区", () => {
    const definitions = [
      new ReadFileTool(roots),
      new WriteFileTool(roots),
      new EditFileTool(roots),
      new GlobTool(roots),
      new GrepTool(roots),
    ].map((tool) => tool.definition());

    for (const definition of definitions) {
      expect(JSON.stringify(definition)).toContain("已授权工作区");
    }
  });

  it("五类工具都拒绝未授权目录", async () => {
    const outsideFile = join(outsideRoot, "secret.txt");
    const message = /\/add-dir <directory>/;

    await expect(
      new ReadFileTool(roots).execute(JSON.stringify({ path: outsideFile })),
    ).rejects.toThrow(message);
    await expect(
      new WriteFileTool(roots).execute(JSON.stringify({ path: outsideFile, content: "changed" })),
    ).rejects.toThrow(message);
    await expect(
      new EditFileTool(roots).execute(
        JSON.stringify({ path: outsideFile, old_text: "secret", new_text: "changed" }),
      ),
    ).rejects.toThrow(message);
    await expect(
      new GlobTool(roots).execute(JSON.stringify({ path: outsideRoot, pattern: "**/*" })),
    ).rejects.toThrow(message);
    await expect(
      new GrepTool(roots).execute(JSON.stringify({ path: outsideRoot, pattern: "secret" })),
    ).rejects.toThrow(message);
  });

  it("默认注册表在审批前拒绝越界，新增根后同一实例立即生效", async () => {
    const registry = buildDefaultToolRegistry(primaryRoot, { workspaceRoots: roots });
    let approvalCalls = 0;
    let preWriteCalls = 0;
    registry.useRequest(async () => {
      approvalCalls++;
      return { allowed: true };
    });
    registry.setPreWriteHook(async () => {
      preWriteCalls++;
    });
    const target = join(outsideRoot, "approved.txt");
    const request = {
      id: "write-outside",
      name: "write_file",
      arguments: JSON.stringify({ path: target, content: "approved" }),
    };

    const denied = await registry.execute(request);
    expect(denied.isError).toBe(true);
    expect(denied.output).toContain("/add-dir <directory>");
    expect(approvalCalls).toBe(0);
    expect(preWriteCalls).toBe(0);

    await roots.addDirectory(outsideRoot);
    const allowed = await registry.execute(request);
    expect(allowed.isError).toBe(false);
    expect(approvalCalls).toBe(1);
    expect(preWriteCalls).toBe(1);
    expect(await readFile(target, "utf8")).toBe("approved");
  });

  it("审批中间件改写为越界路径时仍由工具执行边界拒绝", async () => {
    const registry = buildDefaultToolRegistry(primaryRoot, { workspaceRoots: roots });
    const outsideFile = join(outsideRoot, "rewritten.txt");
    registry.useRequest(async (call) => ({
      allowed: true,
      call: {
        ...call,
        arguments: JSON.stringify({ path: outsideFile, content: "escaped" }),
      },
    }));

    const result = await registry.execute({
      id: "rewrite-write",
      name: "write_file",
      arguments: JSON.stringify({ path: "allowed.txt", content: "safe" }),
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain("/add-dir <directory>");
    await expect(readFile(outsideFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

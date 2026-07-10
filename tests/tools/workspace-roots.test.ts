import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolCall } from "../../src/schema/message.js";
import {
  WorkspaceRoots,
  buildWorkspaceBoundaryMiddleware,
} from "../../src/tools/workspace-roots.js";

const OUTSIDE_MESSAGE = "路径不在当前工作区。请先运行 /add-dir <directory> 授权该目录。";

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call-${name}`, name, arguments: JSON.stringify(args) };
}

describe("WorkspaceRoots", () => {
  let sandbox: string;
  let primaryRoot: string;
  let additionalRoot: string;
  let outsideRoot: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "pico-workspace-roots-"));
    primaryRoot = join(sandbox, "primary");
    additionalRoot = join(sandbox, "additional");
    outsideRoot = join(sandbox, "outside");
    await Promise.all([mkdir(primaryRoot), mkdir(additionalRoot), mkdir(outsideRoot)]);
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it("规范化主根和初始附加根并保持稳定顺序", async () => {
    const roots = await WorkspaceRoots.create(join(primaryRoot, "."), [join(additionalRoot, ".")]);

    expect(roots.list()).toEqual([await realpath(primaryRoot), await realpath(additionalRoot)]);
  });

  it("重复添加同一真实目录是幂等操作", async () => {
    const roots = await WorkspaceRoots.create(primaryRoot);

    const first = await roots.addDirectory(additionalRoot);
    const second = await roots.addDirectory(join(additionalRoot, "."));

    expect(first).toEqual({
      added: true,
      path: await realpath(additionalRoot),
    });
    expect(second).toEqual({ ...first, added: false });
    expect(roots.list()).toHaveLength(2);
  });

  it("新增目录必须存在且必须是目录", async () => {
    const filePath = join(sandbox, "not-a-directory.txt");
    await writeFile(filePath, "x");
    const roots = await WorkspaceRoots.create(primaryRoot);

    await expect(roots.addDirectory(join(sandbox, "missing"))).rejects.toThrow(/不存在/);
    await expect(roots.addDirectory(filePath)).rejects.toThrow(/不是目录/);
  });

  it("相对路径始终锚定主根，绝对路径可落在任一根内", async () => {
    const roots = await WorkspaceRoots.create(primaryRoot, [additionalRoot]);
    const normalizedPrimary = await realpath(primaryRoot);
    const normalizedAdditional = await realpath(additionalRoot);

    expect(roots.resolve("nested/file.txt")).toBe(join(normalizedPrimary, "nested/file.txt"));
    expect(roots.resolve(join(additionalRoot, "file.txt"))).toBe(
      join(normalizedAdditional, "file.txt"),
    );
  });

  it("允许根目录内以两个点开头的普通目录名", async () => {
    await mkdir(join(primaryRoot, "..cache"));
    const roots = await WorkspaceRoots.create(primaryRoot);

    expect(roots.resolve("..cache/file.txt")).toBe(
      join(await realpath(primaryRoot), "..cache/file.txt"),
    );
  });

  it("拒绝未授权绝对路径并提示 /add-dir", async () => {
    const roots = await WorkspaceRoots.create(primaryRoot);

    expect(() => roots.resolve(join(outsideRoot, "file.txt"))).toThrow(OUTSIDE_MESSAGE);
    await expect(roots.assertAllowed(join(outsideRoot, "file.txt"))).rejects.toThrow(
      OUTSIDE_MESSAGE,
    );
  });

  it("已存在目标会通过 realpath 拦截符号链接逃逸", async () => {
    const outsideFile = join(outsideRoot, "secret.txt");
    const link = join(primaryRoot, "secret-link.txt");
    await writeFile(outsideFile, "secret");
    await symlink(outsideFile, link);
    const roots = await WorkspaceRoots.create(primaryRoot);

    await expect(roots.assertAllowed(link)).rejects.toThrow(OUTSIDE_MESSAGE);
  });

  it("新文件会检查最近存在祖先并拦截目录符号链接逃逸", async () => {
    const link = join(primaryRoot, "outside-link");
    await symlink(outsideRoot, link, "dir");
    const roots = await WorkspaceRoots.create(primaryRoot);

    await expect(roots.assertAllowed(join(link, "new", "file.txt"))).rejects.toThrow(
      OUTSIDE_MESSAGE,
    );
  });
});

describe("buildWorkspaceBoundaryMiddleware", () => {
  let sandbox: string;
  let primaryRoot: string;
  let outsideRoot: string;
  let roots: WorkspaceRoots;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "pico-workspace-middleware-"));
    primaryRoot = join(sandbox, "primary");
    outsideRoot = join(sandbox, "outside");
    await Promise.all([mkdir(primaryRoot), mkdir(outsideRoot)]);
    roots = await WorkspaceRoots.create(primaryRoot);
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it.each([
    ["read_file", { path: "../outside/file.txt" }],
    ["write_file", { path: "../outside/file.txt", content: "x" }],
    ["edit_file", { path: "../outside/file.txt", old_text: "a", new_text: "b" }],
    ["glob", { path: "../outside", pattern: "**/*" }],
    ["grep", { path: "../outside", pattern: "x" }],
  ])("在工具执行前拒绝 %s 的越界路径", async (name, args) => {
    const middleware = buildWorkspaceBoundaryMiddleware(roots);

    const result = await middleware(call(name, args));

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain(OUTSIDE_MESSAGE);
  });

  it("不静态解析 bash 路径", async () => {
    const middleware = buildWorkspaceBoundaryMiddleware(roots);

    await expect(
      middleware(call("bash", { command: `cat ${join(outsideRoot, "file.txt")}` })),
    ).resolves.toEqual({ allowed: true });
  });
});

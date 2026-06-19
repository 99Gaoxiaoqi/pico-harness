// ToolRegistry 与 ReadFileTool 的单元测试。
// 对应课程第 05 讲:路由分发、截断保护、路径穿越防护。

import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BashTool, ReadFileTool, ToolRegistry, WriteFileTool } from "../src/tools/registry-impl.js";
import type { BaseTool } from "../src/tools/registry.js";
import type { ToolDefinition } from "../src/schema/message.js";

class FakeTool implements BaseTool {
  constructor(
    private readonly n: string,
    private readonly def: ToolDefinition,
    private readonly run: (args: string) => Promise<string>,
  ) {}
  name(): string {
    return this.n;
  }
  definition(): ToolDefinition {
    return this.def;
  }
  execute(args: string): Promise<string> {
    return this.run(args);
  }
}

describe("ToolRegistry 路由分发", () => {
  it("getAvailableTools 返回所有已挂载工具的 Schema", () => {
    const r = new ToolRegistry();
    r.register(
      new FakeTool("a", { name: "a", description: "A", inputSchema: { type: "object" } }, async () => ""),
    );
    r.register(
      new FakeTool("b", { name: "b", description: "B", inputSchema: { type: "object" } }, async () => ""),
    );
    const tools = r.getAvailableTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["a", "b"]);
  });

  it("execute 找到工具并返回其输出", async () => {
    const r = new ToolRegistry();
    r.register(
      new FakeTool(
        "say",
        { name: "say", description: "", inputSchema: { type: "object" } },
        async (args) => `said:${JSON.parse(args).msg}`,
      ),
    );
    const result = await r.execute({ id: "c1", name: "say", arguments: '{"msg":"hi"}' });
    expect(result.isError).toBe(false);
    expect(result.output).toBe("said:hi");
    expect(result.toolCallId).toBe("c1");
  });

  it("execute 找不到工具时返回 isError,提示模型自纠", async () => {
    const r = new ToolRegistry();
    const result = await r.execute({ id: "c1", name: "ghost", arguments: "{}" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("不存在名为 'ghost' 的工具");
  });

  it("execute 捕获工具抛出的错误,封成 isError 的 ToolResult", async () => {
    const r = new ToolRegistry();
    r.register(
      new FakeTool(
        "boom",
        { name: "boom", description: "", inputSchema: { type: "object" } },
        async () => {
          throw new Error("炸了");
        },
      ),
    );
    const result = await r.execute({ id: "c1", name: "boom", arguments: "{}" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("炸了");
  });
});

describe("ReadFileTool 防御底线", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "claw-test-"));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("读取工作区内文件内容", async () => {
    await writeFile(join(workDir, "hello.txt"), "Hello, tiny-claw!");
    const tool = new ReadFileTool(workDir);
    const out = await tool.execute(JSON.stringify({ path: "hello.txt" }));
    expect(out).toBe("Hello, tiny-claw!");
  });

  it("超过 8000 字节时触发截断保护", async () => {
    const big = "x".repeat(9000);
    await writeFile(join(workDir, "big.txt"), big);
    const tool = new ReadFileTool(workDir);
    const out = await tool.execute(JSON.stringify({ path: "big.txt" }));
    expect(out.length).toBeLessThan(9000);
    expect(out).toContain("已被系统截断");
  });

  it("路径穿越到工作区外被拒绝", async () => {
    await mkdir(join(workDir, "sub"), { recursive: true });
    await writeFile(join(workDir, "sub", "real.txt"), "ok");
    const tool = new ReadFileTool(workDir);
    await expect(
      tool.execute(JSON.stringify({ path: "../../../etc/passwd" })),
    ).rejects.toThrow(/路径越界/);
  });

  it("参数格式错误时抛出解析错误", async () => {
    const tool = new ReadFileTool(workDir);
    await expect(tool.execute("not-json")).rejects.toThrow(/参数解析失败/);
  });
});

describe("WriteFileTool", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "claw-test-"));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("写入新文件并可被读回", async () => {
    const tool = new WriteFileTool(workDir);
    const out = await tool.execute(JSON.stringify({ path: "a.txt", content: "hello" }));
    expect(out).toContain("成功");
    const readBack = await readFile(join(workDir, "a.txt"), "utf8");
    expect(readBack).toBe("hello");
  });

  it("自动创建缺失的父级目录", async () => {
    const tool = new WriteFileTool(workDir);
    await tool.execute(JSON.stringify({ path: "nested/dir/b.txt", content: "deep" }));
    const readBack = await readFile(join(workDir, "nested/dir/b.txt"), "utf8");
    expect(readBack).toBe("deep");
  });

  it("覆盖已存在的文件", async () => {
    await writeFile(join(workDir, "c.txt"), "old");
    const tool = new WriteFileTool(workDir);
    await tool.execute(JSON.stringify({ path: "c.txt", content: "new" }));
    expect(await readFile(join(workDir, "c.txt"), "utf8")).toBe("new");
  });

  it("路径穿越被拒绝", async () => {
    const tool = new WriteFileTool(workDir);
    await expect(
      tool.execute(JSON.stringify({ path: "../../escape.txt", content: "x" })),
    ).rejects.toThrow(/路径越界/);
  });
});

describe("BashTool", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "claw-test-"));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("执行命令并返回 stdout", async () => {
    const tool = new BashTool(workDir);
    const out = await tool.execute(JSON.stringify({ command: "echo hello-bash" }));
    expect(out.trim()).toBe("hello-bash");
  });

  it("命令在工作区目录下执行", async () => {
    const tool = new BashTool(workDir);
    const out = await tool.execute(JSON.stringify({ command: "pwd" }));
    // macOS 下 /var 是 /private/var 的符号链接,用 realpath 解析真实路径后比较
    expect(await realpath(out.trim())).toBe(await realpath(workDir));
  });

  it("命令失败时原样回传错误,不抛异常 (自愈机制)", async () => {
    const tool = new BashTool(workDir);
    const out = await tool.execute(JSON.stringify({ command: "ls /no-such-dir-xyz" }));
    // 不应抛异常,而是把错误信息作为字符串返回
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("支持管道与链式命令", async () => {
    const tool = new BashTool(workDir);
    const out = await tool.execute(
      JSON.stringify({ command: "echo 'a\\nb\\nc' | grep b" }),
    );
    expect(out.trim()).toBe("b");
  });

  it("空输出时返回成功提示", async () => {
    const tool = new BashTool(workDir);
    const out = await tool.execute(JSON.stringify({ command: "true" }));
    expect(out).toContain("执行成功");
  });
});

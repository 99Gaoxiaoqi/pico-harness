// ToolRegistry 与 ReadFileTool 的单元测试。
// 对应课程第 05 讲:路由分发、截断保护、路径穿越防护。

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReadFileTool, ToolRegistry } from "../src/tools/registry-impl.js";
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

// ToolRegistry 与 ReadFileTool 的单元测试。
// 对应课程第 05 讲:路由分发、截断保护、路径穿越防护。

import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BashTool,
  EditFileTool,
  ReadFileTool,
  ToolRegistry,
  WriteFileTool,
} from "../src/tools/registry-impl.js";
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
      new FakeTool(
        "a",
        { name: "a", description: "A", inputSchema: { type: "object" } },
        async () => "",
      ),
    );
    r.register(
      new FakeTool(
        "b",
        { name: "b", description: "B", inputSchema: { type: "object" } },
        async () => "",
      ),
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
    await writeFile(join(workDir, "hello.txt"), "Hello, pico!");
    const tool = new ReadFileTool(workDir);
    const out = await tool.execute(JSON.stringify({ path: "hello.txt" }));
    expect(out).toBe("Hello, pico!");
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
    await expect(tool.execute(JSON.stringify({ path: "../../../etc/passwd" }))).rejects.toThrow(
      /路径越界/,
    );
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
    const out = await tool.execute(JSON.stringify({ command: "echo 'a\\nb\\nc' | grep b" }));
    expect(out.trim()).toBe("b");
  });

  it("空输出时返回成功提示", async () => {
    const tool = new BashTool(workDir);
    const out = await tool.execute(JSON.stringify({ command: "true" }));
    expect(out).toContain("执行成功");
  });
});

describe("EditFileTool 多级模糊匹配", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "claw-test-"));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("L1 精确匹配成功替换", async () => {
    await writeFile(join(workDir, "f.txt"), "line1\nold\nline3");
    const tool = new EditFileTool(workDir);
    const out = await tool.execute(
      JSON.stringify({ path: "f.txt", old_text: "old", new_text: "new" }),
    );
    expect(out).toContain("成功修改");
    expect(await readFile(join(workDir, "f.txt"), "utf8")).toBe("line1\nnew\nline3");
  });

  it("L2 换行符归一化:old_text 用 \\r\\n 也能匹配", async () => {
    await writeFile(join(workDir, "f.txt"), "a\nb\nc");
    const tool = new EditFileTool(workDir);
    const out = await tool.execute(
      JSON.stringify({ path: "f.txt", old_text: "a\r\nb", new_text: "x\ny" }),
    );
    expect(out).toContain("成功修改");
    expect(await readFile(join(workDir, "f.txt"), "utf8")).toBe("x\ny\nc");
  });

  it("L3 Trim 首尾空白后匹配", async () => {
    await writeFile(join(workDir, "f.txt"), "before\n  target  \nafter");
    const tool = new EditFileTool(workDir);
    await tool.execute(
      JSON.stringify({ path: "f.txt", old_text: "\n\ttarget\n", new_text: "replaced" }),
    );
    // L3 替换 trimmed 部分
    const result = await readFile(join(workDir, "f.txt"), "utf8");
    expect(result).toContain("replaced");
  });

  it("L4 逐行去缩进:old_text 缺少缩进仍能匹配 (缩进幻觉容错)", async () => {
    // 原文件带 8 空格缩进
    await writeFile(
      join(workDir, "f.txt"),
      "func main() {\n        if err != nil {\n            return err\n        }\n}",
    );
    const tool = new EditFileTool(workDir);
    // old_text 无缩进 (模拟模型幻觉)
    const out = await tool.execute(
      JSON.stringify({
        path: "f.txt",
        old_text: "if err != nil {\n    return err\n}",
        new_text: "if err == nil {\n    // ok\n}",
      }),
    );
    expect(out).toContain("L4");
    const result = await readFile(join(workDir, "f.txt"), "utf8");
    expect(result).toContain("if err == nil");
  });

  it("精确匹配到多处时拒绝替换,要求更多上下文", async () => {
    await writeFile(join(workDir, "f.txt"), "dup\ndup\nother");
    const tool = new EditFileTool(workDir);
    await expect(
      tool.execute(JSON.stringify({ path: "f.txt", old_text: "dup", new_text: "x" })),
    ).rejects.toThrow(/匹配到了.*处/);
  });

  it("完全找不到时报错提示先 read_file", async () => {
    await writeFile(join(workDir, "f.txt"), "aaa\nbbb");
    const tool = new EditFileTool(workDir);
    await expect(
      tool.execute(JSON.stringify({ path: "f.txt", old_text: "zzz", new_text: "x" })),
    ).rejects.toThrow(/未找到 old_text/);
  });

  it("路径穿越被拒绝", async () => {
    const tool = new EditFileTool(workDir);
    await expect(
      tool.execute(JSON.stringify({ path: "../../x.txt", old_text: "a", new_text: "b" })),
    ).rejects.toThrow(/路径越界/);
  });
});

describe("EditFileTool 多级模糊匹配", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "claw-test-"));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("L1 精确匹配成功替换", async () => {
    await writeFile(join(workDir, "a.txt"), "foo\nbar\nbaz");
    const tool = new EditFileTool(workDir);
    const out = await tool.execute(
      JSON.stringify({ path: "a.txt", old_text: "bar", new_text: "BAR" }),
    );
    expect(out).toContain("L1");
    expect(await readFile(join(workDir, "a.txt"), "utf8")).toBe("foo\nBAR\nbaz");
  });

  it("L2 换行符归一化:old_text 用 \\r\\n 也能匹配", async () => {
    await writeFile(join(workDir, "b.txt"), "line1\nline2\nline3");
    const tool = new EditFileTool(workDir);
    const out = await tool.execute(
      JSON.stringify({ path: "b.txt", old_text: "line1\r\nline2", new_text: "L1\nL2" }),
    );
    expect(out).toContain("L2");
    expect(await readFile(join(workDir, "b.txt"), "utf8")).toBe("L1\nL2\nline3");
  });

  it("L3 Trim 首尾空白后匹配", async () => {
    await writeFile(join(workDir, "c.txt"), "code\n\n");
    const tool = new EditFileTool(workDir);
    // old_text 带首尾空行,实际文件是 "code\n\n"
    const out = await tool.execute(
      JSON.stringify({ path: "c.txt", old_text: "\n\ncode\n\n", new_text: "CODE" }),
    );
    expect(out).toContain("L3");
  });

  it("L4 逐行去缩进:old_text 丢缩进也能匹配 (核心容错)", async () => {
    // 原文件有 8 空格缩进
    await writeFile(join(workDir, "d.txt"), "if user == nil {\n        return err\n}");
    const tool = new EditFileTool(workDir);
    // 模型幻觉:old_text 不带缩进
    const out = await tool.execute(
      JSON.stringify({
        path: "d.txt",
        old_text: "if user == nil {\nreturn err\n}",
        new_text: 'if user == nil {\n    return fmt.Errorf("nil")\n}',
      }),
    );
    expect(out).toContain("L4");
    const result = await readFile(join(workDir, "d.txt"), "utf8");
    expect(result).toContain("fmt.Errorf");
  });

  it("唯一性校验:精确匹配多处时拒绝替换", async () => {
    await writeFile(join(workDir, "e.txt"), "dup\ndup\ndup");
    const tool = new EditFileTool(workDir);
    await expect(
      tool.execute(JSON.stringify({ path: "e.txt", old_text: "dup", new_text: "x" })),
    ).rejects.toThrow(/匹配到了.*处/);
  });

  it("完全找不到时报错,提示先 read_file", async () => {
    await writeFile(join(workDir, "f.txt"), "hello");
    const tool = new EditFileTool(workDir);
    await expect(
      tool.execute(JSON.stringify({ path: "f.txt", old_text: "nope", new_text: "x" })),
    ).rejects.toThrow(/未找到 old_text/);
  });

  it("路径穿越被拒绝", async () => {
    const tool = new EditFileTool(workDir);
    await expect(
      tool.execute(JSON.stringify({ path: "../../x", old_text: "a", new_text: "b" })),
    ).rejects.toThrow(/路径越界/);
  });
});

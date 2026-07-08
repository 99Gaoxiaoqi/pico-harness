// ToolRegistry 与 ReadFileTool 的单元测试。
// 对应课程第 05 讲:路由分发、截断保护、路径穿越防护。

import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BashTool,
  EditFileTool,
  ReadFileTool,
  ToolRegistry,
  WriteFileTool,
} from "../src/tools/registry-impl.js";
import { BackgroundManager } from "../src/tools/background-manager.js";
import type { BaseTool } from "../src/tools/registry.js";
import type { ToolDefinition } from "../src/schema/message.js";
import { HookRunner } from "../src/hooks/runner.js";

class FakeTool implements BaseTool {
  maxResultSizeChars?: number;

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

  it("RequestMiddleware 可以改写工具调用参数", async () => {
    const r = new ToolRegistry();
    r.register(
      new FakeTool(
        "say",
        { name: "say", description: "", inputSchema: { type: "object" } },
        async (args) => `said:${JSON.parse(args).msg}`,
      ),
    );
    r.useRequest(async (call) => ({
      allowed: true,
      call: { ...call, arguments: '{"msg":"rewritten"}' },
    }));

    const result = await r.execute({ id: "c1", name: "say", arguments: '{"msg":"original"}' });
    expect(result.output).toBe("said:rewritten");
  });

  it("ExecutionMiddleware 可以包裹工具执行结果", async () => {
    const r = new ToolRegistry();
    r.register(
      new FakeTool(
        "say",
        { name: "say", description: "", inputSchema: { type: "object" } },
        async () => "inner",
      ),
    );
    r.useExecution(async (call, next) => `before:${await next(call)}:after`);

    const result = await r.execute({ id: "c1", name: "say", arguments: "{}" });
    expect(result.output).toBe("before:inner:after");
  });

  it("工具可声明 maxResultSizeChars,Registry 统一截断返回", async () => {
    const r = new ToolRegistry();
    const tool = new FakeTool(
      "big",
      { name: "big", description: "", inputSchema: { type: "object" } },
      async () => "X".repeat(100),
    );
    tool.maxResultSizeChars = 20;
    r.register(tool);

    const result = await r.execute({ id: "c1", name: "big", arguments: "{}" });

    expect(result.output.length).toBeLessThan(100);
    expect(result.output).toContain("工具输出过长");
  });

  it("可关闭 Registry 截断,把大输出交给上层 Observation Processor", async () => {
    const r = new ToolRegistry({ truncateResults: false });
    r.register(
      new FakeTool(
        "big",
        { name: "big", description: "", inputSchema: { type: "object" } },
        async () => "X".repeat(100),
      ),
    );

    const result = await r.execute({ id: "c1", name: "big", arguments: "{}" });

    expect(result.output).toBe("X".repeat(100));
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

  it("读取工作区内文件内容(加行号前缀)", async () => {
    await writeFile(join(workDir, "hello.txt"), "Hello, pico!");
    const tool = new ReadFileTool(workDir);
    const out = await tool.execute(JSON.stringify({ path: "hello.txt" }));
    expect(out).toBe("1\tHello, pico!\n共 1 行,行尾: LF");
  });

  it("CRLF 文件归一化为 LF 并加行号前缀", async () => {
    await writeFile(join(workDir, "crlf.txt"), "a\r\nb\r\nc\r\n");
    const tool = new ReadFileTool(workDir);
    const out = await tool.execute(JSON.stringify({ path: "crlf.txt" }));
    expect(out).not.toContain("\r\n");
    expect(out).toContain("1\ta\n2\tb\n3\tc");
    expect(out).toContain("行尾: CRLF");
  });

  it("LF 文件加行号前缀", async () => {
    await writeFile(join(workDir, "lf.txt"), "foo\nbar\nbaz\n");
    const tool = new ReadFileTool(workDir);
    const out = await tool.execute(JSON.stringify({ path: "lf.txt" }));
    expect(out).toContain("1\tfoo\n2\tbar\n3\tbaz");
    expect(out).toContain("行尾: LF");
  });

  it("mixed 行尾 \\r 显形为字面 \\\\r", async () => {
    // CRLF 与 lone LF 混杂 → mixed,不归一化,\r 显示成字面量提醒用户
    await writeFile(join(workDir, "mixed.txt"), "a\r\nb\nc");
    const tool = new ReadFileTool(workDir);
    const out = await tool.execute(JSON.stringify({ path: "mixed.txt" }));
    expect(out).toContain("行尾: MIXED");
    // \r 显形为字面量 "\r"(反斜杠 + r 两个字符)
    expect(out).toContain("\\r");
    expect(out).toContain("1\ta\\r");
  });

  it("超过 12000 字节时触发截断保护", async () => {
    const big = "x".repeat(20000);
    await writeFile(join(workDir, "big.txt"), big);
    const tool = new ReadFileTool(workDir);
    const out = await tool.execute(JSON.stringify({ path: "big.txt" }));
    expect(out.length).toBeLessThan(20000);
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
    expect(out).toContain("新建");
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
  let backgroundManager: BackgroundManager;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "claw-test-"));
    backgroundManager = new BackgroundManager();
  });
  afterEach(async () => {
    for (const task of backgroundManager.list()) {
      if (task.status === "running") {
        await backgroundManager.stop(task.taskId);
      }
    }
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
    // 不同 shell 输出的路径格式不同:
    // - macOS/Linux bash:/var/... 或 /private/var/...(realpath 归一)
    // - Windows Git Bash:/d/.../claw-test-xxx(Node realpath 不认 POSIX 风格)
    // 统一用 realpath 解析真实路径后比较;realpath 失败时(Git Bash POSIX 路径)
    // 退化为比较 basename,因为 workDir 是 mkdtemp 产生的唯一随机目录名。
    const pwdOut = out.trim();
    try {
      expect(await realpath(pwdOut)).toBe(await realpath(workDir));
    } catch {
      expect(basename(pwdOut)).toBe(basename(workDir));
    }
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
    // 用 printf 而非 echo:POSIX 单引号下 echo 不解释 \n,printf 才会真正换行,
    // 这样 `grep b` 才能从多行输出中匹配到 "b"。对 bash/sh 均成立。
    const out = await tool.execute(JSON.stringify({ command: "printf 'a\\nb\\nc\\n' | grep b" }));
    expect(out.trim()).toBe("b");
  });

  it("空输出时返回成功提示", async () => {
    const tool = new BashTool(workDir);
    const out = await tool.execute(JSON.stringify({ command: "true" }));
    expect(out).toContain("执行成功");
  });

  it("schema 声明 background 参数", () => {
    const tool = new BashTool(workDir, backgroundManager);
    const schema = tool.definition().inputSchema as {
      properties?: Record<string, unknown>;
    };

    expect(schema.properties?.background).toMatchObject({ type: "boolean" });
  });

  it("background=true 时立即返回 taskId 且不等待命令结束", async () => {
    const tool = new BashTool(workDir, backgroundManager);
    const startedAt = Date.now();

    const out = await tool.execute(
      JSON.stringify({
        command: "node -e \"setTimeout(() => console.log('late'), 500)\"",
        background: true,
      }),
    );

    expect(Date.now() - startedAt).toBeLessThan(200);
    const parsed = JSON.parse(out) as { taskId: string; pid: number; status: string };
    expect(parsed.taskId).toMatch(/^bg-/);
    expect(parsed.pid).toBeGreaterThan(0);
    expect(parsed.status).toBe("running");
    expect(backgroundManager.list().map((task) => task.taskId)).toContain(parsed.taskId);
  });

  it("可在只读场景禁用 background=true", async () => {
    const tool = new BashTool(workDir, backgroundManager, { allowBackground: false });

    await expect(
      tool.execute(
        JSON.stringify({
          command: "node -e \"setTimeout(() => {}, 1000)\"",
          background: true,
        }),
      ),
    ).rejects.toThrow("不允许后台执行");
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

describe("EditFileTool 模型视图与缩进重对齐", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "claw-test-"));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("CRLF 文件精确匹配,写回仍是 CRLF(视图往返)", async () => {
    // 磁盘 CRLF;模型在 LF 视图里匹配;写回 materialize 还原 CRLF
    await writeFile(join(workDir, "crlf.txt"), "line1\r\nold\r\nline3");
    const tool = new EditFileTool(workDir);
    const out = await tool.execute(
      JSON.stringify({ path: "crlf.txt", old_text: "old", new_text: "new" }),
    );
    expect(out).toContain("L1");
    const result = await readFile(join(workDir, "crlf.txt"), "utf8");
    // 格式不变:仍是 CRLF
    expect(result).toBe("line1\r\nnew\r\nline3");
    expect(result).not.toBe("line1\nnew\nline3");
  });

  it("LF 文件编辑后仍是 LF(不引入 CR)", async () => {
    await writeFile(join(workDir, "lf.txt"), "line1\nold\nline3");
    const tool = new EditFileTool(workDir);
    await tool.execute(
      JSON.stringify({ path: "lf.txt", old_text: "old", new_text: "new" }),
    );
    const result = await readFile(join(workDir, "lf.txt"), "utf8");
    expect(result).toBe("line1\nnew\nline3");
    expect(result).not.toContain("\r");
  });

  it("L4 缩进重对齐:文件 4 空格、模型 2 空格,写回对齐文件风格", async () => {
    // 文件用 4 空格缩进
    await writeFile(
      join(workDir, "indent.ts"),
      "function foo() {\n    bar();\n    baz();\n}",
    );
    const tool = new EditFileTool(workDir);
    // 模型幻觉:用 2 空格缩进
    const out = await tool.execute(
      JSON.stringify({
        path: "indent.ts",
        old_text: "  bar();\n  baz();",
        new_text: "  barNew();\n  bazNew();",
      }),
    );
    expect(out).toContain("L4");
    const result = await readFile(join(workDir, "indent.ts"), "utf8");
    // new_text 被重对齐到文件实际缩进(4 空格),而非模型的 2 空格
    expect(result).toBe("function foo() {\n    barNew();\n    bazNew();\n}");
  });

  it("L4 缩进相同:文件与模型都是 2 空格,new_text 原样写入", async () => {
    // 文件 2 空格;old_text 带 trailing 空格强制走 L4
    await writeFile(join(workDir, "same.ts"), "  bar();\n  baz();");
    const tool = new EditFileTool(workDir);
    const out = await tool.execute(
      JSON.stringify({
        path: "same.ts",
        old_text: "  bar(); \n  baz(); ",
        new_text: "  barNew();\n  bazNew();",
      }),
    );
    expect(out).toContain("L4");
    const result = await readFile(join(workDir, "same.ts"), "utf8");
    // 缩进一致,new_text 原样写入(仍是 2 空格)
    expect(result).toBe("  barNew();\n  bazNew();");
  });

  it("L4 dedent 行:比模型基准缩进更少的行锚定到文件基准", async () => {
    // 文件 4 空格
    await writeFile(
      join(workDir, "dedent.ts"),
      "wrapper {\n    line1();\n    line2();\n}",
    );
    const tool = new EditFileTool(workDir);
    // 模型基准 2 空格;new_text 首行 dedent(0 缩进注释)
    const out = await tool.execute(
      JSON.stringify({
        path: "dedent.ts",
        old_text: "  line1();\n  line2();",
        new_text: "// comment\n  line1New();\n  line2New();",
      }),
    );
    expect(out).toContain("L4");
    const result = await readFile(join(workDir, "dedent.ts"), "utf8");
    // dedent 行锚定到文件基准(4 空格),其余行按模型相对嵌套对齐
    expect(result).toBe(
      "wrapper {\n    // comment\n    line1New();\n    line2New();\n}",
    );
  });

  it("CRLF 文件 + L4 缩进重对齐:两个特性组合(视图往返 + 缩进对齐)", async () => {
    // 磁盘 CRLF + 4 空格缩进
    await writeFile(
      join(workDir, "combo.ts"),
      "function foo() {\r\n    bar();\r\n    baz();\r\n}",
    );
    const tool = new EditFileTool(workDir);
    // 模型 LF 视图 + 2 空格缩进
    const out = await tool.execute(
      JSON.stringify({
        path: "combo.ts",
        old_text: "  bar();\n  baz();",
        new_text: "  barNew();\n  bazNew();",
      }),
    );
    expect(out).toContain("L4");
    const result = await readFile(join(workDir, "combo.ts"), "utf8");
    // 写回仍是 CRLF,且缩进对齐到 4 空格
    expect(result).toBe("function foo() {\r\n    barNew();\r\n    bazNew();\r\n}");
  });
});

describe("EditFileTool replace_all 全替换", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "claw-test-"));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("L1 多处 + replace_all=true:全部替换", async () => {
    // 文件有 3 处 "foo"
    await writeFile(join(workDir, "a.txt"), "foo\nbar\nfoo\nbaz\nfoo");
    const tool = new EditFileTool(workDir);
    const out = await tool.execute(
      JSON.stringify({
        path: "a.txt",
        old_text: "foo",
        new_text: "qux",
        replace_all: true,
      }),
    );
    expect(out).toContain("L1");
    expect(out).toContain("全部替换");
    // 3 处 foo 全部变成 qux
    expect(await readFile(join(workDir, "a.txt"), "utf8")).toBe("qux\nbar\nqux\nbaz\nqux");
  });

  it("L1 多处 + 默认 false(不传):仍抛唯一性错误(行为不变)", async () => {
    await writeFile(join(workDir, "b.txt"), "foo\nbar\nfoo\nbaz\nfoo");
    const tool = new EditFileTool(workDir);
    await expect(
      tool.execute(
        JSON.stringify({ path: "b.txt", old_text: "foo", new_text: "qux" }),
      ),
    ).rejects.toThrow(/匹配到了.*处/);
    // 文件内容未改
    expect(await readFile(join(workDir, "b.txt"), "utf8")).toBe("foo\nbar\nfoo\nbaz\nfoo");
  });

  it("L1 单处 + replace_all=true:行为与 false 一致(单处替换)", async () => {
    await writeFile(join(workDir, "c.txt"), "foo\nbar");
    const tool = new EditFileTool(workDir);
    const out = await tool.execute(
      JSON.stringify({
        path: "c.txt",
        old_text: "foo",
        new_text: "baz",
        replace_all: true,
      }),
    );
    expect(out).toContain("L1");
    expect(await readFile(join(workDir, "c.txt"), "utf8")).toBe("baz\nbar");
  });

  it("L4 多处 + replace_all=true:各区间独立缩进重对齐后全替换", async () => {
    // 文件中两段相似代码,缩进不同(4 空格与 2 空格),L4 逐行去缩进后两处都会匹配
    await writeFile(
      join(workDir, "d.ts"),
      "function a() {\n    bar();\n    baz();\n}\nfunction b() {\n  bar();\n  baz();\n}\n",
    );
    const tool = new EditFileTool(workDir);
    // old_text 无缩进(模型幻觉),触发 L4
    const out = await tool.execute(
      JSON.stringify({
        path: "d.ts",
        old_text: "bar();\nbaz();",
        new_text: "barNew();\nbazNew();",
        replace_all: true,
      }),
    );
    expect(out).toContain("L4");
    expect(out).toContain("全部替换");
    const result = await readFile(join(workDir, "d.ts"), "utf8");
    // 第一段保持 4 空格缩进
    expect(result).toContain("    barNew();\n    bazNew();");
    // 第二段保持 2 空格缩进(各自独立重对齐)
    expect(result).toContain("  barNew();\n  bazNew();");
    // 不应残留旧代码
    expect(result).not.toContain("bar();");
    expect(result).not.toContain("baz();");
  });

  it("L4 多处 + 默认 false:仍抛模糊匹配错误(行为不变)", async () => {
    // 两段缩进不同的相似代码,L4 逐行去缩进后两处都匹配
    await writeFile(
      join(workDir, "e.ts"),
      "function a() {\n    bar();\n    baz();\n}\nfunction b() {\n  bar();\n  baz();\n}\n",
    );
    const tool = new EditFileTool(workDir);
    // old_text 无缩进(模型幻觉),L1/L2/L3 不命中,降级到 L4,两处匹配
    await expect(
      tool.execute(
        JSON.stringify({ path: "e.ts", old_text: "bar();\nbaz();", new_text: "barNew();\nbazNew();" }),
      ),
    ).rejects.toThrow(/模糊匹配.*处/);
    // 文件内容未改
    const result = await readFile(join(workDir, "e.ts"), "utf8");
    expect(result).toContain("bar();");
  });

  it("inputSchema 含 replace_all 字段(可选,默认 false)", () => {
    const tool = new EditFileTool(workDir);
    const props = tool.definition().inputSchema.properties as Record<string, unknown>;
    expect(props.replace_all).toBeDefined();
    expect((props.replace_all as { type: string }).type).toBe("boolean");
    // required 不含 replace_all
    const required = tool.definition().inputSchema.required ?? [];
    expect(required).not.toContain("replace_all");
  });

  it("经 ToolRegistry execute 端到端跑 replace_all=true", async () => {
    await writeFile(join(workDir, "f.txt"), "foo\nfoo\nfoo");
    const registry = new ToolRegistry();
    registry.register(new EditFileTool(workDir));
    const result = await registry.execute({
      id: "call-1",
      name: "edit_file",
      arguments: JSON.stringify({
        path: "f.txt",
        old_text: "foo",
        new_text: "bar",
        replace_all: true,
      }),
    });
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("全部替换");
    expect(await readFile(join(workDir, "f.txt"), "utf8")).toBe("bar\nbar\nbar");
  });
});

// ==========================================
// 任务 2.6:Registry 集成 PreToolUse / PostToolUse hooks
// 测 hook deny 阻断工具、allow 放行、modifiedInput 改写参数、PostToolUse fire-and-forget
// ==========================================
describe("ToolRegistry hooks 集成 (任务 2.6)", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-reg-hook-"));
  });
  afterEach(async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(workDir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  });

  /**
   * 写一个 node hook 脚本,经 shell 调用。behavior 控制行为(见 runner.test.ts)。
   */
  async function writeHookScript(behavior: string): Promise<string> {
    const scriptPath = join(workDir, `reg-hook-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
    let body: string;
    if (behavior.startsWith("exit2:")) {
      const msg = behavior.slice("exit2:".length);
      body = `process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write(${JSON.stringify(msg)});process.exit(2);});`;
    } else if (behavior === "exit1") {
      body = `process.stdin.resume();process.stdin.on('end',()=>process.exit(1));`;
    } else if (behavior.startsWith("json:")) {
      const json = behavior.slice("json:".length);
      body = `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(json)});process.exit(0);});`;
    } else if (behavior.startsWith("capture:")) {
      // 把 stdin 写到指定文件,用于断言 PostToolUse 收到 tool_response
      const outFile = behavior.slice("capture:".length);
      body = `let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{require("fs").writeFileSync(${JSON.stringify(outFile)},d);process.exit(0);});`;
    } else {
      body = `process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`;
    }
    await writeFile(scriptPath, body, "utf8");
    return `node ${JSON.stringify(scriptPath)}`;
  }

  it("PreToolUse deny → 工具不执行,返回 isError", async () => {
    const command = await writeHookScript("exit2:禁止执行");
    const registry = new ToolRegistry();
    let executed = false;
    registry.register(
      new FakeTool(
        "danger",
        { name: "danger", description: "", inputSchema: { type: "object" } },
        async () => {
          executed = true;
          return "should-not-run";
        },
      ),
    );
    registry.setHookRunner(
      new HookRunner(workDir, { PreToolUse: [{ hooks: [{ type: "command", command }] }] }),
    );

    const result = await registry.execute({ id: "c1", name: "danger", arguments: "{}" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("PreToolUse hook 阻断");
    expect(result.output).toContain("禁止执行");
    expect(executed).toBe(false);
  });

  it("PreToolUse allow(exit 0)→ 工具正常执行", async () => {
    const command = await writeHookScript("exit0");
    const registry = new ToolRegistry();
    registry.register(
      new FakeTool(
        "say",
        { name: "say", description: "", inputSchema: { type: "object" } },
        async (args) => `said:${JSON.parse(args).msg}`,
      ),
    );
    registry.setHookRunner(
      new HookRunner(workDir, { PreToolUse: [{ hooks: [{ type: "command", command }] }] }),
    );

    const result = await registry.execute({ id: "c1", name: "say", arguments: '{"msg":"hi"}' });
    expect(result.isError).toBe(false);
    expect(result.output).toBe("said:hi");
  });

  it("PreToolUse permissionDecision deny(stdout JSON)→ 阻断", async () => {
    const command = await writeHookScript(
      `json:{"permissionDecision":"deny","permissionDecisionReason":"危险"}`,
    );
    const registry = new ToolRegistry();
    registry.register(
      new FakeTool(
        "x",
        { name: "x", description: "", inputSchema: { type: "object" } },
        async () => "ran",
      ),
    );
    registry.setHookRunner(
      new HookRunner(workDir, { PreToolUse: [{ hooks: [{ type: "command", command }] }] }),
    );

    const result = await registry.execute({ id: "c1", name: "x", arguments: "{}" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("危险");
  });

  it("PreToolUse modifiedInput → 改写工具参数后执行", async () => {
    const command = await writeHookScript(`json:{"modifiedInput":{"msg":"rewritten-by-hook"}}`);
    const registry = new ToolRegistry();
    registry.register(
      new FakeTool(
        "say",
        { name: "say", description: "", inputSchema: { type: "object" } },
        async (args) => `said:${JSON.parse(args).msg}`,
      ),
    );
    registry.setHookRunner(
      new HookRunner(workDir, { PreToolUse: [{ hooks: [{ type: "command", command }] }] }),
    );

    const result = await registry.execute({ id: "c1", name: "say", arguments: '{"msg":"orig"}' });
    expect(result.isError).toBe(false);
    // 工具收到的是 hook 改写后的参数
    expect(result.output).toBe("said:rewritten-by-hook");
  });

  it("PreToolUse fail-open(exit 1)→ 工具仍执行", async () => {
    const command = await writeHookScript("exit1");
    const registry = new ToolRegistry();
    registry.register(
      new FakeTool(
        "say",
        { name: "say", description: "", inputSchema: { type: "object" } },
        async () => "ran-anyway",
      ),
    );
    registry.setHookRunner(
      new HookRunner(workDir, { PreToolUse: [{ hooks: [{ type: "command", command }] }] }),
    );

    const result = await registry.execute({ id: "c1", name: "say", arguments: "{}" });
    expect(result.isError).toBe(false);
    expect(result.output).toBe("ran-anyway");
  });

  it("PreToolUse 在 requestMiddleware 之后执行(审批先于 hook)", async () => {
    // requestMiddleware 拦截 → 应直接返回,PreToolUse hook 根本不执行
    const command = await writeHookScript("exit2:should-not-run");
    const registry = new ToolRegistry();
    registry.register(
      new FakeTool(
        "say",
        { name: "say", description: "", inputSchema: { type: "object" } },
        async () => "ran",
      ),
    );
    // 中间件拦截
    registry.useRequest(async () => ({ allowed: false, reason: "中间件拒绝" }));
    registry.setHookRunner(
      new HookRunner(workDir, { PreToolUse: [{ hooks: [{ type: "command", command }] }] }),
    );

    const result = await registry.execute({ id: "c1", name: "say", arguments: "{}" });
    expect(result.isError).toBe(true);
    // 应是中间件拦截文案,而非 hook 阻断文案
    expect(result.output).toContain("中间件拒绝");
    expect(result.output).not.toContain("PreToolUse hook 阻断");
  });

  it("PostToolUse fire-and-forget:工具执行后通知,不阻断返回值", async () => {
    const command = await writeHookScript("exit0");
    const registry = new ToolRegistry();
    registry.register(
      new FakeTool(
        "say",
        { name: "say", description: "", inputSchema: { type: "object" } },
        async () => "done",
      ),
    );
    registry.setHookRunner(
      new HookRunner(workDir, { PostToolUse: [{ hooks: [{ type: "command", command }] }] }),
    );

    const result = await registry.execute({ id: "c1", name: "say", arguments: "{}" });
    expect(result.isError).toBe(false);
    expect(result.output).toBe("done");
  });

  it("PostToolUse 收到 tool_response(工具输出)", async () => {
    // hook 把 stdin 写到文件,断言含 tool_response
    const outFile = join(workDir, "post-input.json");
    const command = await writeHookScript(`capture:${outFile}`);
    const registry = new ToolRegistry();
    registry.register(
      new FakeTool(
        "say",
        { name: "say", description: "", inputSchema: { type: "object" } },
        async () => "TOOL-OUTPUT-123",
      ),
    );
    registry.setHookRunner(
      new HookRunner(workDir, { PostToolUse: [{ hooks: [{ type: "command", command }] }] }),
    );

    await registry.execute({ id: "c1", name: "say", arguments: "{}" });
    // fire-and-forget:子进程异步写文件,轮询等待(最多 ~2s)
    let received: Record<string, unknown> | undefined;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        received = JSON.parse(await readFile(outFile, "utf8")) as Record<string, unknown>;
        break;
      } catch {
        // 文件尚未写完,继续轮询
      }
    }
    expect(received).toBeDefined();
    expect(received!.hook_event_name).toBe("PostToolUse");
    expect(received!.tool_response).toBe("TOOL-OUTPUT-123");
    expect(received!.tool_name).toBe("say");
  });

  it("未挂载 hookRunner 时 → 零开销,正常执行", async () => {
    const registry = new ToolRegistry();
    registry.register(
      new FakeTool(
        "say",
        { name: "say", description: "", inputSchema: { type: "object" } },
        async () => "no-hook",
      ),
    );
    // 不 setHookRunner
    const result = await registry.execute({ id: "c1", name: "say", arguments: "{}" });
    expect(result.isError).toBe(false);
    expect(result.output).toBe("no-hook");
  });

  it("setSessionId 注入的 session_id 传给 hook stdin", async () => {
    const outFile = join(workDir, "pre-input.json");
    const command = await writeHookScript(`capture:${outFile}`);
    const registry = new ToolRegistry();
    registry.register(
      new FakeTool(
        "say",
        { name: "say", description: "", inputSchema: { type: "object" } },
        async () => "ok",
      ),
    );
    registry.setHookRunner(
      new HookRunner(workDir, { PreToolUse: [{ hooks: [{ type: "command", command }] }] }),
    );
    registry.setSessionId("sess-abc-789");

    await registry.execute({ id: "c1", name: "say", arguments: "{}" });

    let received: Record<string, unknown> | undefined;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        received = JSON.parse(await readFile(outFile, "utf8")) as Record<string, unknown>;
        break;
      } catch {
        // 文件尚未写完,继续轮询
      }
    }
    expect(received).toBeDefined();
    expect(received!.session_id).toBe("sess-abc-789");
  });
});


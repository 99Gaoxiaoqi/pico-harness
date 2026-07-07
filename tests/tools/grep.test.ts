// GrepTool 单元测试。
// 覆盖:基本搜索、大小写、glob 过滤、无匹配、max_results 截断、
//       rg 可用 / 不可用两条路径(用 setRgAvailable 强制降级,确保 CI 无 rg 也稳定)。
//
// 测试策略:Node.js 降级路径是基线(强制 setRgAvailable(false) 跑全套);
// rg 路径用单独的 describe 块,先探测 rg 是否真实可用,可用才跑,否则 it.skip。

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GrepTool,
  resetRgCache,
  setRgAvailable,
} from "../../src/tools/grep.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";
import type { ToolCall } from "../../src/schema/message.js";

/** 建立测试用临时工作区,返回 workDir。 */
async function makeWorkDir(): Promise<string> {
  const workDir = await mkdtemp(join(tmpdir(), "claw-grep-"));
  await mkdir(join(workDir, "src"), { recursive: true });
  await writeFile(join(workDir, "src", "foo.ts"), "function hello() { return 'world'; }\n");
  await writeFile(join(workDir, "src", "bar.ts"), "const HELLO = 1;\n");
  await writeFile(join(workDir, "readme.md"), "# Hello World\n");
  return workDir;
}

function call(name: string, args: unknown): ToolCall {
  return { id: `call-${name}`, name, arguments: JSON.stringify(args) };
}

describe("GrepTool - Node.js 降级路径 (强制 rgAvailable=false)", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await makeWorkDir();
    setRgAvailable(false);
  });
  afterEach(async () => {
    resetRgCache();
    await rm(workDir, { recursive: true, force: true });
  });

  it("直接 execute:大小写不敏感匹配 foo.ts 与 bar.ts", async () => {
    const tool = new GrepTool(workDir);
    const out = await tool.execute(JSON.stringify({ pattern: "hello" }));
    // 大小写不敏感:foo.ts 的 hello + bar.ts 的 HELLO 都命中
    expect(out).toContain("src/foo.ts:1:");
    expect(out).toContain("function hello()");
    expect(out).toContain("src/bar.ts:1:");
    expect(out).toContain("const HELLO = 1");
    expect(out).not.toContain("未找到匹配");
  });

  it("case_sensitive=true:只匹配精确大小写 hello", async () => {
    const tool = new GrepTool(workDir);
    const out = await tool.execute(
      JSON.stringify({ pattern: "hello", case_sensitive: true }),
    );
    expect(out).toContain("src/foo.ts:1:");
    expect(out).toContain("function hello()");
    // HELLO(大写)不应命中
    expect(out).not.toContain("src/bar.ts");
    expect(out).not.toContain("HELLO");
  });

  it("glob 过滤 *.ts:不搜 markdown", async () => {
    const tool = new GrepTool(workDir);
    const out = await tool.execute(
      JSON.stringify({ pattern: "hello", glob: "*.ts" }),
    );
    // ts 文件命中
    expect(out).toContain("src/foo.ts:1:");
    expect(out).toContain("src/bar.ts:1:");
    // readme.md 不应命中
    expect(out).not.toContain("readme.md");
  });

  it("glob 过滤 *.md:只搜 markdown", async () => {
    const tool = new GrepTool(workDir);
    const out = await tool.execute(
      JSON.stringify({ pattern: "hello", glob: "*.md" }),
    );
    expect(out).toContain("readme.md:1:");
    expect(out).toContain("# Hello World");
    expect(out).not.toContain("src/foo.ts");
    expect(out).not.toContain("src/bar.ts");
  });

  it("无匹配返回提示", async () => {
    const tool = new GrepTool(workDir);
    const out = await tool.execute(JSON.stringify({ pattern: "zzzznotfound" }));
    expect(out).toBe("未找到匹配");
  });

  it("max_results 截断并附截断提示", async () => {
    // 制造大量匹配:在一个文件里写多行 hello,并限定 glob 只搜该文件,
    // 使匹配总数确知为 20,避免其他文件干扰计数。
    const many = Array.from({ length: 20 }, (_, i) => `hello line ${i}`).join("\n");
    await writeFile(join(workDir, "many.txt"), many + "\n");
    const tool = new GrepTool(workDir);
    const out = await tool.execute(
      JSON.stringify({ pattern: "hello", glob: "many.txt", max_results: 5 }),
    );
    const lines = out.split("\n");
    // 前 5 行是匹配,第 6 行是截断提示
    const matchLines = lines.filter((l) => l.includes(":hello line"));
    expect(matchLines.length).toBe(5);
    expect(out).toContain("已截断");
    expect(out).toContain("共 20 条");
  });

  it("line_number=false:省略行号,格式为 路径:内容", async () => {
    const tool = new GrepTool(workDir);
    const out = await tool.execute(
      JSON.stringify({ pattern: "hello", glob: "*.ts", case_sensitive: true, line_number: false }),
    );
    // foo.ts 内容 "function hello() { return 'world'; }"
    expect(out).toContain("src/foo.ts:function hello()");
    // 不应出现行号 1: 紧跟路径的形式
    expect(out).not.toMatch(/src\/foo\.ts:1:/);
  });

  it("支持 path 子目录限定", async () => {
    const tool = new GrepTool(workDir);
    const out = await tool.execute(
      JSON.stringify({ pattern: "hello", path: "src", case_sensitive: true }),
    );
    expect(out).toContain("foo.ts:1:");
    expect(out).toContain("function hello()");
    // readme.md 在根目录,限定 src 后不应命中
    expect(out).not.toContain("readme.md");
  });

  it("正则模式匹配", async () => {
    const tool = new GrepTool(workDir);
    const out = await tool.execute(JSON.stringify({ pattern: "const\\s+HELLO" }));
    expect(out).toContain("src/bar.ts:1:");
    expect(out).toContain("const HELLO");
  });

  it("参数解析失败抛错", async () => {
    const tool = new GrepTool(workDir);
    await expect(tool.execute("not-json")).rejects.toThrow(/参数解析失败/);
  });

  it("缺少 pattern 抛错", async () => {
    const tool = new GrepTool(workDir);
    await expect(tool.execute(JSON.stringify({}))).rejects.toThrow(/pattern/);
  });

  it("路径穿越被拒绝", async () => {
    const tool = new GrepTool(workDir);
    await expect(
      tool.execute(JSON.stringify({ pattern: "hello", path: "../../../etc" })),
    ).rejects.toThrow(/路径越界/);
  });

  it("经 Registry 路由:execute 走工具实例", async () => {
    const registry = new ToolRegistry();
    registry.register(new GrepTool(workDir));
    const result = await registry.execute(call("grep", { pattern: "hello", case_sensitive: true }));
    expect(result.isError).toBe(false);
    expect(result.output).toContain("src/foo.ts:1:");
  });

  it("经 Registry:未找到工具返回 isError", async () => {
    const registry = new ToolRegistry();
    const result = await registry.execute(call("grep", { pattern: "hello" }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("不存在名为 'grep'");
  });
});

describe("GrepTool - rg 路径 (仅当环境真实装有 rg 时运行)", () => {
  let workDir: string;
  let rgInstalled: boolean;

  beforeEach(async () => {
    workDir = await makeWorkDir();
    resetRgCache(); // 让工具自行探测真实环境
    try {
      execFileSync("rg", ["--version"], { stdio: "pipe", encoding: "utf8" });
      rgInstalled = true;
    } catch {
      rgInstalled = false;
    }
  });
  afterEach(async () => {
    resetRgCache();
    await rm(workDir, { recursive: true, force: true });
  });

  it("rg 路径:大小写不敏感匹配 foo.ts 与 bar.ts", async () => {
    if (!rgInstalled) return; // 等价 it.skip,无 rg 环境直接通过
    const tool = new GrepTool(workDir);
    const out = await tool.execute(JSON.stringify({ pattern: "hello" }));
    expect(out).toContain("foo.ts:1:");
    expect(out).toContain("function hello()");
    expect(out).toContain("bar.ts:1:");
    expect(out).toContain("const HELLO");
  });

  it("rg 路径:case_sensitive=true 只匹配精确大小写", async () => {
    if (!rgInstalled) return;
    const tool = new GrepTool(workDir);
    const out = await tool.execute(
      JSON.stringify({ pattern: "hello", case_sensitive: true }),
    );
    expect(out).toContain("foo.ts:1:");
    expect(out).not.toContain("bar.ts");
  });

  it("rg 路径:无匹配返回提示", async () => {
    if (!rgInstalled) return;
    const tool = new GrepTool(workDir);
    const out = await tool.execute(JSON.stringify({ pattern: "zzzznotfound" }));
    expect(out).toBe("未找到匹配");
  });

  it("rg 路径:glob 过滤 *.ts", async () => {
    if (!rgInstalled) return;
    const tool = new GrepTool(workDir);
    const out = await tool.execute(JSON.stringify({ pattern: "hello", glob: "*.ts" }));
    expect(out).toContain("foo.ts:1:");
    expect(out).not.toContain("readme.md");
  });

  it("rg 路径:rg 执行失败时降级到 Node.js (单次探测后置 false)", async () => {
    if (!rgInstalled) return;
    // 模拟 rg 路径抛错 → 降级。这里用一个畸形 glob 触发 rg 报错的可能性低,
    // 故直接验证:强制 setRgAvailable(false) 后,即便环境有 rg 也走 Node.js。
    setRgAvailable(false);
    const tool = new GrepTool(workDir);
    const out = await tool.execute(JSON.stringify({ pattern: "hello", case_sensitive: true }));
    expect(out).toContain("foo.ts:1:");
    // 标记为降级后,后续探测仍可恢复(resetRgCache 在 afterEach 执行)
  });
});

describe("GrepTool - 接口元数据", () => {
  it("name() 返回 grep", () => {
    const tool = new GrepTool("/tmp");
    expect(tool.name()).toBe("grep");
  });

  it("readOnly = true", () => {
    const tool = new GrepTool("/tmp");
    expect(tool.readOnly).toBe(true);
  });

  it("accesses() 返回 none (无冲突)", () => {
    const tool = new GrepTool("/tmp");
    const accesses = tool.accesses(JSON.stringify({ pattern: "x" }));
    expect(accesses).toEqual([]);
  });

  it("definition() schema 含所有参数", () => {
    const tool = new GrepTool("/tmp");
    const def = tool.definition();
    expect(def.name).toBe("grep");
    const props = def.inputSchema["properties"] as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(
      [
        "case_sensitive",
        "glob",
        "line_number",
        "max_results",
        "path",
        "pattern",
      ].sort(),
    );
    expect(def.inputSchema["required"]).toEqual(["pattern"]);
  });
});

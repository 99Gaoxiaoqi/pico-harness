// GlobTool 单元测试。
// 覆盖:各种 glob 语义、花括号展开、忽略目录、无匹配提示、
// 经 ToolRegistry 路由分发、globToRegExp 转换单元测试。

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GlobTool, globToRegExp, expandBraces } from "../../src/tools/glob.js";
import { ToolRegistry } from "../../src/tools/registry-impl.js";

/**
 * 构建测试用的目录树:
 *   tmp/
 *     src/
 *       a.ts
 *       b.ts
 *       c.test.ts
 *       sub/
 *         d.ts
 *     docs/
 *       readme.md
 *     package.json
 *     node_modules/  x.ts   ← 应被忽略
 */
async function buildTree(root: string): Promise<void> {
  await mkdir(join(root, "src", "sub"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(root, "node_modules"), { recursive: true });

  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(root, "src", "b.ts"), "export const b = 2;\n");
  await writeFile(join(root, "src", "c.test.ts"), "test();\n");
  await writeFile(join(root, "src", "sub", "d.ts"), "export const d = 4;\n");
  await writeFile(join(root, "docs", "readme.md"), "# readme\n");
  await writeFile(join(root, "package.json"), "{}\n");
  await writeFile(join(root, "node_modules", "x.ts"), "// ignored\n");
}

describe("GlobTool", () => {
  let workDir: string;
  let tool: GlobTool;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-glob-"));
    await buildTree(workDir);
    tool = new GlobTool(workDir);
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  function lines(s: string): string[] {
    return s.split("\n").filter((l) => l.length > 0 && !l.startsWith("..."));
  }

  it("**/*.ts 匹配所有 .ts(含子目录,不含 node_modules)", async () => {
    const out = await tool.execute(JSON.stringify({ pattern: "**/*.ts" }));
    const set = new Set(lines(out));
    expect(set.has("src/a.ts")).toBe(true);
    expect(set.has("src/b.ts")).toBe(true);
    expect(set.has("src/c.test.ts")).toBe(true);
    expect(set.has("src/sub/d.ts")).toBe(true);
    // node_modules 应被忽略
    expect(set.has("node_modules/x.ts")).toBe(false);
  });

  it("src/**/*.test.ts 匹配 c.test.ts", async () => {
    const out = await tool.execute(JSON.stringify({ pattern: "src/**/*.test.ts" }));
    const set = new Set(lines(out));
    expect(set.has("src/c.test.ts")).toBe(true);
    expect(set.size).toBe(1);
  });

  it("*.json 只匹配根目录的 package.json(单层 *)", async () => {
    const out = await tool.execute(JSON.stringify({ pattern: "*.json" }));
    const set = new Set(lines(out));
    expect(set.has("package.json")).toBe(true);
    expect(set.size).toBe(1);
  });

  it("src/*.ts 单层匹配(不含 sub/d.ts)", async () => {
    const out = await tool.execute(JSON.stringify({ pattern: "src/*.ts" }));
    const set = new Set(lines(out));
    expect(set.has("src/a.ts")).toBe(true);
    expect(set.has("src/b.ts")).toBe(true);
    expect(set.has("src/c.test.ts")).toBe(true);
    expect(set.has("src/sub/d.ts")).toBe(false);
  });

  it("**/*.{ts,md} 花括号匹配 ts 和 md", async () => {
    const out = await tool.execute(JSON.stringify({ pattern: "**/*.{ts,md}" }));
    const set = new Set(lines(out));
    expect(set.has("src/a.ts")).toBe(true);
    expect(set.has("docs/readme.md")).toBe(true);
    expect(set.has("src/sub/d.ts")).toBe(true);
    // node_modules 仍被忽略
    expect(set.has("node_modules/x.ts")).toBe(false);
  });

  it("src/**/*.ts 递归匹配 src 下所有 ts(含 sub)", async () => {
    const out = await tool.execute(JSON.stringify({ pattern: "src/**/*.ts" }));
    const set = new Set(lines(out));
    expect(set.has("src/a.ts")).toBe(true);
    expect(set.has("src/b.ts")).toBe(true);
    expect(set.has("src/c.test.ts")).toBe(true);
    expect(set.has("src/sub/d.ts")).toBe(true);
  });

  it("**/readme.md 跨层匹配", async () => {
    const out = await tool.execute(JSON.stringify({ pattern: "**/readme.md" }));
    const set = new Set(lines(out));
    expect(set.has("docs/readme.md")).toBe(true);
    expect(set.size).toBe(1);
  });

  it("无匹配返回明确提示", async () => {
    const out = await tool.execute(JSON.stringify({ pattern: "**/*.nonexistent" }));
    expect(out).toBe("未找到匹配文件");
  });

  it("path 参数限定搜索起始目录", async () => {
    const out = await tool.execute(JSON.stringify({ pattern: "**/*.ts", path: "src/sub" }));
    const set = new Set(lines(out));
    // 相对路径以 src/sub 为根
    expect(set.has("d.ts")).toBe(true);
    expect(set.size).toBe(1);
  });

  it("路径越界抛错", async () => {
    await expect(
      tool.execute(JSON.stringify({ pattern: "**/*.ts", path: "../outside" })),
    ).rejects.toThrow(/路径越界/);
  });

  it("参数解析失败抛错", async () => {
    await expect(tool.execute("{not json")).rejects.toThrow(/参数解析失败/);
  });

  it("空 pattern 抛错", async () => {
    await expect(tool.execute(JSON.stringify({ pattern: "" }))).rejects.toThrow(/pattern/);
  });

  it("经 ToolRegistry 路由分发也能正常工作", async () => {
    const registry = new ToolRegistry();
    registry.register(tool);

    const result = await registry.execute({
      id: "call_glob",
      name: "glob",
      arguments: JSON.stringify({ pattern: "src/*.ts" }),
    });
    expect(result.isError).toBe(false);
    const set = new Set(lines(result.output));
    expect(set.has("src/a.ts")).toBe(true);
    expect(set.has("src/b.ts")).toBe(true);
    expect(set.has("src/c.test.ts")).toBe(true);
    expect(set.has("src/sub/d.ts")).toBe(false);
  });

  it("工具元信息正确", () => {
    expect(tool.name()).toBe("glob");
    expect(tool.readOnly).toBe(true);
    expect(tool.accesses("{}")).toEqual([]);
    const def = tool.definition();
    expect(def.name).toBe("glob");
    expect((def.inputSchema.required as string[]).includes("pattern")).toBe(true);
  });

  it("结果按字典序排序", async () => {
    const out = await tool.execute(JSON.stringify({ pattern: "**/*.ts" }));
    const matched = lines(out);
    const sorted = [...matched].sort();
    expect(matched).toEqual(sorted);
  });

  it("结果超过 100 条时截断并提示总数", async () => {
    // 制造 150 个文件
    await mkdir(join(workDir, "many"), { recursive: true });
    for (let i = 0; i < 150; i++) {
      await writeFile(join(workDir, "many", `f${i}.txt`), "");
    }
    const out = await tool.execute(JSON.stringify({ pattern: "many/*.txt" }));
    expect(out).toContain("共 150 条,已截断");
    // 实际列出 100 行 + 截断提示行
    const matched = lines(out);
    expect(matched.length).toBe(100);
  });
});

describe("globToRegExp", () => {
  it("单层 * 不跨目录", () => {
    const re = globToRegExp("src/*.ts");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/sub/d.ts")).toBe(false);
  });

  it("** 跨任意层级", () => {
    const re = globToRegExp("src/**/*.ts");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/sub/d.ts")).toBe(true);
    expect(re.test("src/sub/deep/e.ts")).toBe(true);
  });

  it("** 匹配零层(直接落在目录下)", () => {
    const re = globToRegExp("a/**/*.ts");
    expect(re.test("a/x.ts")).toBe(true);
    expect(re.test("a/p/q.ts")).toBe(true);
  });

  it("? 匹配单字符", () => {
    const re = globToRegExp("a?.ts");
    expect(re.test("ab.ts")).toBe(true);
    expect(re.test("a.ts")).toBe(false);
  });

  it("[abc] 字符集", () => {
    const re = globToRegExp("[abc].ts");
    expect(re.test("a.ts")).toBe(true);
    expect(re.test("b.ts")).toBe(true);
    expect(re.test("d.ts")).toBe(false);
  });

  it("[a-z] 字符范围", () => {
    const re = globToRegExp("[a-c].ts");
    expect(re.test("a.ts")).toBe(true);
    expect(re.test("c.ts")).toBe(true);
    expect(re.test("d.ts")).toBe(false);
  });

  it("{ts,js} 花括号多选一", () => {
    const re = globToRegExp("*.{ts,js}");
    expect(re.test("a.ts")).toBe(true);
    expect(re.test("a.js")).toBe(true);
    expect(re.test("a.md")).toBe(false);
  });

  it(". 字面量(不是任意字符)", () => {
    const re = globToRegExp("a.b.ts");
    expect(re.test("a.b.ts")).toBe(true);
    expect(re.test("axb.ts")).toBe(false);
  });

  it("点号文件名如 .gitignore 能匹配", () => {
    const re = globToRegExp("**/.gitignore");
    expect(re.test(".gitignore")).toBe(true);
    expect(re.test("src/.gitignore")).toBe(true);
  });

  it("根级 **/*.ts 匹配顶层文件", () => {
    const re = globToRegExp("**/*.ts");
    expect(re.test("a.ts")).toBe(true);
    expect(re.test("src/a.ts")).toBe(true);
  });

  it("多组花括号交叉展开", () => {
    const re = globToRegExp("x{a,b}y{c,d}.ts");
    expect(re.test("xayc.ts")).toBe(true);
    expect(re.test("xayd.ts")).toBe(true);
    expect(re.test("xbyc.ts")).toBe(true);
    expect(re.test("xbyd.ts")).toBe(true);
    expect(re.test("xaye.ts")).toBe(false);
  });
});

describe("expandBraces", () => {
  it("无花括号原样返回", () => {
    expect(expandBraces("a.ts")).toEqual(["a.ts"]);
  });

  it("单组花括号展开", () => {
    expect(expandBraces("a{b,c}d")).toEqual(["abd", "acd"]);
  });

  it("多组花括号交叉展开", () => {
    const r = expandBraces("{x,y}{1,2}");
    expect(r.sort()).toEqual(["x1", "x2", "y1", "y2"]);
  });

  it("��套花括号", () => {
    expect(expandBraces("a{b,{c,d}}e")).toEqual(["abe", "ace", "ade"]);
  });
});

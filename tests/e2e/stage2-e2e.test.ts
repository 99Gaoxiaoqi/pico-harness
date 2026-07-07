// 阶段 2 端到端真实测试 — 验证新工具(glob/grep/todo/replace_all)在真实大模型下的可用性。
// 与 stage1-e2e 同样直接用真实 DeepSeek API,不走 mock。
// 用法: npx vitest run tests/e2e/stage2-e2e.test.ts
//
// 测试目标:
//   1. 工具描述能否引导模型正确调用(参数填对、工具名对)
//   2. 工具返回结果能否被模型理解并继续推理
//   3. 多工具串联(glob→grep→edit)在 ReAct loop 里能否跑通
//   4. todo 工具能否被模型主动使用,prompt 注入是否生效
//
// 注意:本测试依赖 .env 的真实 API 凭证,会消耗 token。CI 无凭证时整体跳过。

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenAIProvider } from "../../src/provider/openai.js";
import { AgentEngine } from "../../src/engine/loop.js";
import { Session } from "../../src/engine/session.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { buildDefaultToolRegistry } from "../../src/tools/default-registry.js";
import { TodoStore } from "../../src/context/todo-store.js";
import { PromptComposer } from "../../src/context/composer.js";
import type { Message } from "../../src/schema/message.js";

// ─── 加载 .env(与 stage1-e2e 同模式)───
let BASE_URL: string | undefined;
let API_KEY: string | undefined;
let MODEL: string | undefined;
try {
  const envContent = readFileSync(".env", "utf8");
  for (const line of envContent.split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
  }
  BASE_URL = process.env.LLM_BASE_URL;
  API_KEY = process.env.LLM_API_KEY;
  MODEL = process.env.LLM_MODEL;
} catch {
  // 无 .env,跳过
}

const skip = !BASE_URL || !API_KEY || !MODEL;

const describeOrSkip = skip ? describe.skip : describe;

describeOrSkip("���段 2 端到端测试(真实大模型)", { timeout: 180000 }, () => {
  let workDir: string;
  let provider: OpenAIProvider;
  let registry: ReturnType<typeof buildDefaultToolRegistry>;

  beforeAll(() => {
    // 建一个有结构的工作区,让 glob/grep 有东西可搜
    workDir = mkdtempSync(join(tmpdir(), "pico-stage2-e2e-"));
    mkdirSync(join(workDir, "src"), { recursive: true });
    mkdirSync(join(workDir, "tests"), { recursive: true });
    writeFileSync(
      join(workDir, "src", "app.ts"),
      [
        'const GREETING = "hello";',
        "function greet(name: string): string {",
        "  return GREETING + ', ' + name;",
        "}",
        "function bye(name: string): string {",
        "  return 'bye, ' + name;",
        "}",
        "export { greet, bye };",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(workDir, "src", "util.ts"),
      [
        "export function add(a: number, b: number): number {",
        "  return a + b;",
        "}",
        "export const VERSION = '1.0.0';",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(workDir, "tests", "app.test.ts"),
      [
        "import { greet } from '../src/app';",
        "test('greet', () => {",
        "  expect(greet('world')).toBe('hello, world');",
        "});",
        "",
      ].join("\n"),
    );
    writeFileSync(join(workDir, "package.json"), '{"name":"demo","version":"1.0.0"}\n');

    provider = new OpenAIProvider({ baseURL: BASE_URL!, apiKey: API_KEY!, model: MODEL! });
    registry = buildDefaultToolRegistry(workDir);
  });

  afterAll(() => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Windows EBUSY 偶发,忽略
    }
  });

  // ─── 测试 1: glob 工具 — 模型能用 glob 找文件 ───
  describe("glob 工具(真实模型调用)", () => {
    it("模型能用 glob 模式找到所有 .ts 文件", async () => {
      const session = new Session(`e2e-glob-${Date.now()}`, workDir, { persistence: false });
      session.append({ role: "user", content: "请用 glob 工具搜索 **/*.ts,列出所有匹配的 TypeScript 文件路径。只调用工具并直接报告结果,不要做其他操作。" });
      const engine = new AgentEngine({
        provider,
        registry,
        workDir,
        maxTurns: 3,
        reporter: new SilentReporter(),
      });
      const messages = await engine.run(session);

      // 验证 loop 完成且有 assistant 输出
      const last = messages[messages.length - 1]!;
      expect(last.role).toBe("assistant");
      const text = last.content ?? "";
      console.log(`[E2E glob] 模型最终回复:\n${text.slice(0, 400)}`);

      // 模型应该至少提到了 src/app.ts、src/util.ts、tests/app.test.ts 中的若干个
      const mentioned = ["src/app.ts", "src/util.ts", "tests/app.test.ts"].filter((f) =>
        text.includes(f),
      );
      expect(
        mentioned.length,
        `模型回复应包含 glob 找到的文件路径,实际:${text.slice(0, 200)}`,
      ).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── 测试 2: grep 工具 — 模型能用 grep 搜索代码 ───
  describe("grep 工具(真实模型调用)", () => {
    it("模型能用 grep 搜到 greet 函数的定义位置", async () => {
      const session = new Session(`e2e-grep-${Date.now()}`, workDir, { persistence: false });
      session.append({ role: "user", content: "请用 grep 工具搜索 pattern 'greet'(不区分大小写),找出它在哪些文件的哪些行出现。只调用工具并报告结果。" });
      const engine = new AgentEngine({
        provider,
        registry,
        workDir,
        maxTurns: 3,
        reporter: new SilentReporter(),
      });
      const messages = await engine.run(session);
      const last = messages[messages.length - 1]!;
      const text = last.content ?? "";
      console.log(`[E2E grep] 模型最终回复:\n${text.slice(0, 400)}`);

      // 应该提到 src/app.ts(定义处)或 tests/app.test.ts(引用处)
      expect(text.toLowerCase()).toMatch(/app\.ts|app\.test\.ts/);
      // 应该提到行号或 greet 这个词
      expect(text.toLowerCase()).toContain("greet");
    });
  });

  // ─── 测试 3: edit_file replace_all — 模型能多处全替换 ───
  describe("edit_file replace_all(真实模型调用)", () => {
    it("模型能用 edit_file replace_all 把所有 name 参数改成 world", async () => {
      // 准备:同一个值出现多处
      writeFileSync(
        join(workDir, "src", "repeat.ts"),
        [
          "const LABEL_A = 'foo';",
          "const LABEL_B = 'foo';",
          "const LABEL_C = 'foo';",
          "export { LABEL_A, LABEL_B, LABEL_C };",
          "",
        ].join("\n"),
      );

      const session = new Session(`e2e-rep-${Date.now()}`, workDir, { persistence: false });
      session.append({
        role: "user",
        content:
          "src/repeat.ts 里有三处 'foo' 字符串字面量。请用 edit_file 工具,设置 replace_all=true,把所有 'foo' 替换成 'bar'。完成后用 read_file 确认替换结果。",
      });
      const engine = new AgentEngine({
        provider,
        registry,
        workDir,
        maxTurns: 6,
        reporter: new SilentReporter(),
      });
      await engine.run(session);

      // 验证文件确实被全替换
      const after = readFileSync(join(workDir, "src", "repeat.ts"), "utf8");
      console.log(`[E2E replace_all] 替换后文件:\n${after}`);
      expect(after).not.toContain("'foo'");
      expect(after.match(/'bar'/g)?.length ?? 0).toBe(3);
    });
  });

  // ─── 测试 4: todo 工具 + prompt 注入 ───
  describe("todo 工具(真实模型调用 + prompt 注入)", () => {
    it("PromptComposer 注入的 todo 状态对模型可见,模型能用 todo 工具操作", async () => {
      // 先在工作区建一个非空的 todo.json,看 composer 是否注入、模型是否感知
      const store = new TodoStore(workDir);
      await store.load();
      await store.add("验证 todo 工具集成测试", "high");

      // 验证 composer 确实注入了 todo 上下文
      const composer = new PromptComposer(workDir);
      const systemPrompt = await composer.build();
      expect(systemPrompt).toContain("TodoList");
      expect(systemPrompt).toContain("验证 todo 工具集成测试");
      console.log(`[E2E todo] composer 注入片段:\n${systemPrompt.split("TodoList")[1]?.slice(0, 200) ?? ""}`);

      // 让模型用 todo 工具 list 当前任务
      const session = new Session(`e2e-todo-${Date.now()}`, workDir, { persistence: false });
      session.append({
        role: "user",
        content:
          "请用 todo 工具(action=list)列出当前所有任务,并报告你看到了哪些任务。然后调用 todo(action=add, content='完成 e2e 测试', priority='medium') 添加一条新任务。",
      });
      const engine = new AgentEngine({
        provider,
        registry,
        workDir,
        systemPrompt, // 显式注入含 todo 状态的 prompt
        maxTurns: 4,
        reporter: new SilentReporter(),
      });
      const messages = await engine.run(session);
      const last = messages[messages.length - 1]!;
      const text = last.content ?? "";
      console.log(`[E2E todo] 模型回复:\n${text.slice(0, 400)}`);

      // 模型应该提到看到了"验证 todo 工具集成测试"
      expect(text).toContain("验证 todo 工具集成测试");

      // 验证文件里真的新增了一条。
      // 注意:必须 new 一个全新的 TodoStore 实例 —— load() 是幂等的,
      // 已 load 过的实例返回内存缓存,看不到外部(TodoTool 实例)的写入。
      const freshStore = new TodoStore(workDir);
      const after = await freshStore.load();
      const has = after.items.find((it) => it.content.includes("完成 e2e 测试"));
      expect(has, "todo 工具的 add 操作应该真的写入了 todo.json").toBeDefined();
    });
  });

  // ─── 测试 5: 多工具串联 — glob → grep → edit 经典 ReAct 链 ───
  describe("多工具串联(真实 ReAct loop)", () => {
    it("模型能用 glob 找文件 → grep 定位 → edit_file 修改", async () => {
      const session = new Session(`e2e-chain-${Date.now()}`, workDir, { persistence: false });
      session.append({
        role: "user",
        content:
          "请完成这个任务,需要多步:1) 用 glob 找到 src 目录下所有 .ts 文件;" +
          "2) 用 grep 在这些文件里搜索 'VERSION' 这个词;" +
          "3) 如果找到了,用 edit_file 把它改成 '2.0.0'。" +
          "每一步都要调用对应工具,最后告诉我你改了什么。",
      });
      const engine = new AgentEngine({
        provider,
        registry,
        workDir,
        maxTurns: 8,
        reporter: new SilentReporter(),
      });
      await engine.run(session);

      // util.ts 里的 VERSION 应该被改成 2.0.0
      const util = readFileSync(join(workDir, "src", "util.ts"), "utf8");
      console.log(`[E2E chain] util.ts 最终内容:\n${util}`);
      expect(util).toContain("'2.0.0'");
      expect(util).not.toContain("'1.0.0'");
    });
  });
});

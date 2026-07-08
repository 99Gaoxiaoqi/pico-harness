import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentFromCli, runUserInputFromCli } from "../src/cli/run-agent.js";
import type { Message, ToolDefinition } from "../src/schema/message.js";
import type { LLMProvider } from "../src/provider/interface.js";
import { resetSessionSettingsForTests } from "../src/input/session-settings.js";

class ScriptedProvider implements LLMProvider {
  readonly calls: Array<{ messages: Message[]; toolNames: string[] }> = [];

  constructor(private readonly responses: Message[]) {}

  generate(messages: Message[], availableTools: ToolDefinition[]): Promise<Message> {
    this.calls.push({
      messages: [...messages],
      toolNames: availableTools.map((tool) => tool.name),
    });
    const next = this.responses.shift();

    if (!next) {
      throw new Error("No scripted provider response left.");
    }

    return Promise.resolve(next);
  }
}

describe("runAgentFromCli", () => {
  afterEach(() => {
    resetSessionSettingsForTests();
  });

  it("拼装完整 CLI Harness 并在指定工作区执行工具闭环", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-"));
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "I will create the answer file.",
        toolCalls: [
          {
            id: "call_write",
            name: "write_file",
            arguments: JSON.stringify({
              path: "answer.txt",
              content: "hello from cli",
            }),
          },
        ],
        usage: { promptTokens: 10, completionTokens: 4 },
      },
      {
        role: "assistant",
        content: "Done.",
        usage: { promptTokens: 12, completionTokens: 3 },
      },
    ]);
    const output: string[] = [];

    const result = await runAgentFromCli(
      {
        prompt: "Create answer.txt",
        dir: workDir,
        session: "cli_session",
        model: "glm-5.2",
        enableThinking: false,
        planMode: true,
        trace: true,
      },
      {
        provider,
        write: (chunk) => {
          output.push(chunk);
        },
      },
    );

    expect(await readFile(join(workDir, "answer.txt"), "utf8")).toBe("hello from cli");
    expect(result).toMatchObject({
      sessionId: "cli_session",
      workDir: await realpath(workDir),
      finalMessage: "Done.",
      usage: {
        promptTokens: 22,
        completionTokens: 7,
      },
    });
    expect(result.tracePath).toContain(join(".claw", "traces"));
    expect(await readdir(join(workDir, ".claw", "traces"))).toHaveLength(1);
    expect(provider.calls[0]?.toolNames).toEqual(
      expect.arrayContaining([
        "bash",
        "read_file",
        "write_file",
        "edit_file",
        "search_tools",
      ]),
    );
    expect(provider.calls[0]?.toolNames).not.toContain("delegate_task");
    expect(provider.calls[0]?.toolNames).not.toContain("task_list");
    expect(provider.calls[0]?.messages[0]?.content).toContain("PLAN.md");
    expect(output.join("")).toContain("Session: cli_session");
    expect(output.join("")).toContain("Trace:");
  });

  it("从环境与参数解析 Provider 配置并允许命令行覆盖模型", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-"));
    const created: unknown[] = [];

    const result = await runAgentFromCli(
      {
        prompt: "Say done",
        dir: workDir,
        provider: "claude",
        model: "claude-override",
        enableThinking: false,
      },
      {
        env: {
          LLM_BASE_URL: "https://llm.example/v1",
          LLM_API_KEY: "test-key",
          LLM_MODEL: "claude-env",
        },
        providerFactory: (kind, config) => {
          created.push({ kind, config });
          return new ScriptedProvider([
            {
              role: "assistant",
              content: "Anthropic route works.",
              usage: { promptTokens: 7, completionTokens: 3 },
            },
          ]);
        },
        write: () => undefined,
      },
    );

    expect(created).toEqual([
      {
        kind: "claude",
        config: {
          baseURL: "https://llm.example/v1",
          apiKey: "test-key",
          model: "claude-override",
        },
      },
    ]);
    expect(result.finalMessage).toBe("Anthropic route works.");
  });

  it("glm-5.2 不可用时自动切到 kimi-k2.5", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-"));
    const created: string[] = [];

    const result = await runAgentFromCli(
      {
        prompt: "Say done",
        dir: workDir,
        provider: "openai",
        model: "glm-5.2",
        enableThinking: false,
      },
      {
        env: {
          LLM_BASE_URL: "https://llm.example/v1",
          LLM_API_KEY: "test-key",
          LLM_MODEL: "glm-5.2",
        },
        providerFactory: (_kind, config) => {
          created.push(config.model);
          if (config.model === "glm-5.2") {
            return {
              generate: async () => {
                throw new Error("model glm-5.2 is unavailable");
              },
            };
          }
          return new ScriptedProvider([
            {
              role: "assistant",
              content: "Kimi fallback works.",
              usage: { promptTokens: 5, completionTokens: 2 },
            },
          ]);
        },
        write: () => undefined,
      },
    );

    expect(created).toEqual(["glm-5.2", "kimi-k2.5"]);
    expect(result.finalMessage).toBe("Kimi fallback works.");
    expect(result.usage).toMatchObject({
      promptTokens: 5,
      completionTokens: 2,
    });
  });

  it("CLI 单轮本地命令写 stdout 且不调用模型", async () => {
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "should not be used",
      },
    ]);
    const output: string[] = [];

    const result = await runUserInputFromCli(
      { prompt: "/help", provider: "openai" },
      {
        provider,
        write: (chunk) => {
          output.push(chunk);
        },
      },
    );

    expect(result.type).toBe("local-command");
    expect(provider.calls).toHaveLength(0);
    expect(output.join("")).toContain("/clear");
  });

  it("CLI 单轮 prompt command 调用模型", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-"));
    await mkdir(join(workDir, ".pico", "commands"), { recursive: true });
    await writeFile(
      join(workDir, ".pico", "commands", "review.md"),
      "---\ndescription: Review changes\n---\nReview the current changes: $ARGUMENTS",
      "utf8",
    );
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "Review prompt received.",
        usage: { promptTokens: 3, completionTokens: 2 },
      },
    ]);

    const result = await runUserInputFromCli(
      {
        prompt: "/review src",
        dir: workDir,
        provider: "openai",
        enableThinking: false,
      },
      {
        provider,
        write: () => undefined,
      },
    );

    expect(result.type).toBe("agent");
    expect(provider.calls[0]?.messages.at(-1)?.content).toBe("Review the current changes: src");
  });

  it("/model 切换同一 session 后续请求使用的模型", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-cli-settings-"));
    const createdModels: string[] = [];

    const local = await runUserInputFromCli({
      prompt: "/model kimi-k2.5",
      dir: workDir,
      session: "cli-settings-session",
      provider: "openai",
      model: "glm-5.2",
    });

    const agent = await runUserInputFromCli(
      {
        prompt: "Say done",
        dir: workDir,
        session: "cli-settings-session",
        provider: "openai",
        enableThinking: false,
      },
      {
        env: {
          LLM_BASE_URL: "https://llm.example/v1",
          LLM_API_KEY: "test-key",
          LLM_MODEL: "glm-5.2",
        },
        providerFactory: (_kind, config) => {
          createdModels.push(config.model);
          return new ScriptedProvider([
            {
              role: "assistant",
              content: "Done with switched model.",
              usage: { promptTokens: 2, completionTokens: 1 },
            },
          ]);
        },
        write: () => undefined,
      },
    );

    expect(local.type).toBe("local-command");
    expect(agent.type).toBe("agent");
    expect(createdModels).toEqual(["kimi-k2.5"]);
  });
});

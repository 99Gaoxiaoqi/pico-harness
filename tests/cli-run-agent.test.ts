import { mkdtemp, readFile, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentFromCli } from "../src/cli/run-agent.js";
import type { Message, ToolDefinition } from "../src/schema/message.js";
import type { LLMProvider } from "../src/provider/interface.js";

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
  it("拼装完整 CLI Harness 并在指定工作区执行工具闭环", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "tiny-claw-cli-"));
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
      expect.arrayContaining(["bash", "read_file", "write_file", "edit_file", "spawn_subagent"]),
    );
    expect(provider.calls[0]?.messages[0]?.content).toContain("PLAN.md");
    expect(output.join("")).toContain("Session: cli_session");
    expect(output.join("")).toContain("Trace:");
  });

  it("从环境与参数解析 Provider 配置并允许命令行覆盖模型", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "tiny-claw-cli-"));
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
    const workDir = await mkdtemp(join(tmpdir(), "tiny-claw-cli-"));
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
});

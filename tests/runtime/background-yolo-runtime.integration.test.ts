import { access, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { globalApprovalManager } from "../../src/approval/manager.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { globalSessionManager } from "../../src/engine/session.js";
import { resetSessionSettingsForTests } from "../../src/input/session-settings.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import { AgentRuntime, type RuntimeExecution } from "../../src/runtime/agent-runtime.js";
import {
  BACKGROUND_HARDLINE_VERSION,
  BACKGROUND_HOOK_VERSION,
  BackgroundPolicyViolationError,
  type BackgroundYoloPolicySnapshot,
} from "../../src/safety/background-yolo-policy.js";
import type { Message, ToolDefinition } from "../../src/schema/message.js";

class ScriptedProvider implements LLMProvider {
  readonly calls: Array<{ messages: readonly Message[]; tools: readonly ToolDefinition[] }> = [];

  constructor(private readonly responses: Message[]) {}

  async generate(messages: Message[], tools: ToolDefinition[]): Promise<Message> {
    this.calls.push({ messages: [...messages], tools: [...tools] });
    const response = this.responses.shift();
    if (!response) throw new Error("script exhausted");
    return response;
  }
}

describe("AgentRuntime background YOLO integration", () => {
  afterEach(() => {
    globalApprovalManager.clear();
    globalSessionManager.clear();
    resetSessionSettingsForTests();
  });

  it("fails closed before provider execution when background policy is missing", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-background-missing-policy-"));
    const provider = new ScriptedProvider([{ role: "assistant", content: "must not run" }]);
    const invalidExecution = { kind: "background" } as RuntimeExecution;

    await expect(
      new AgentRuntime().execute(
        { prompt: "run", dir: workDir, execution: invalidExecution },
        {
          provider,
          reporter: new SilentReporter(),
          backgroundTrustStore: trustedWorkspaceVerifier(),
        },
      ),
    ).rejects.toMatchObject<Partial<BackgroundPolicyViolationError>>({
      name: "BackgroundPolicyViolationError",
      code: "missing_policy",
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("rechecks trust and exposes only the immutable allowedTools snapshot", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-background-tools-"));
    const deniedFile = join(workDir, "denied.txt");
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "write-denied",
            name: "write_file",
            arguments: JSON.stringify({ path: deniedFile, content: "unsafe" }),
          },
        ],
      },
      { role: "assistant", content: "write was denied" },
    ]);

    const result = await new AgentRuntime().execute(
      {
        prompt: "try writing",
        dir: workDir,
        execution: { kind: "background", policy: backgroundPolicy(["read_file"]) },
      },
      {
        provider,
        reporter: new SilentReporter(),
        backgroundTrustStore: trustedWorkspaceVerifier(),
      },
    );

    expect(result.finalMessage).toBe("write was denied");
    expect(provider.calls[0]?.tools.map((tool) => tool.name)).toEqual(["read_file"]);
    await expect(access(deniedFile)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function backgroundPolicy(allowedTools: string[]): BackgroundYoloPolicySnapshot {
  return {
    mode: "yolo",
    backgroundEnabled: true,
    trustedWorkspace: true,
    networkPolicy: "disabled",
    allowedTools,
    hardlineVersion: BACKGROUND_HARDLINE_VERSION,
    hookVersion: BACKGROUND_HOOK_VERSION,
    createdAt: Date.now(),
  };
}

function trustedWorkspaceVerifier() {
  return {
    canonicalize: (workspacePath: string) => realpath(workspacePath),
    isTrusted: async () => true,
  };
}

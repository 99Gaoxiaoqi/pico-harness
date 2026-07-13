import { access, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { globalApprovalManager } from "../../src/approval/manager.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { globalSessionManager } from "../../src/engine/session.js";
import { resetSessionSettingsForTests } from "../../src/input/session-settings.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import { credentialRefForModelRoute } from "../../src/provider/credential-vault.js";
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

  it("后台 Provider 只按 credentialRef 取钥，缺少 resolver 时在构建 Provider 前失败", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-background-credential-"));
    const ref = credentialRefForModelRoute("configured/model");
    const provider = new ScriptedProvider([{ role: "assistant", content: "vault resolved" }]);
    const providerConfigs: string[] = [];
    const options = {
      prompt: "run",
      dir: workDir,
      baseURL: "https://provider.test/v1",
      model: "model",
      credentialRef: ref,
      execution: { kind: "background", policy: backgroundPolicy([]) } as const,
    };

    const result = await new AgentRuntime().execute(options, {
      providerFactory: (_kind, config) => {
        providerConfigs.push(config.apiKey);
        return provider;
      },
      credentialResolver: { resolve: async () => "resolved-only-at-runtime" },
      reporter: new SilentReporter(),
      backgroundTrustStore: trustedWorkspaceVerifier(),
    });
    expect(result.finalMessage).toBe("vault resolved");
    expect(providerConfigs).toEqual(["resolved-only-at-runtime"]);

    await expect(
      new AgentRuntime().execute(options, {
        providerFactory: () => provider,
        reporter: new SilentReporter(),
        backgroundTrustStore: trustedWorkspaceVerifier(),
      }),
    ).rejects.toThrow(/credentialRef.*凭证解析器/u);
  });
});

function backgroundPolicy(allowedTools: string[]): BackgroundYoloPolicySnapshot {
  return {
    mode: "yolo",
    backgroundEnabled: true,
    trustedWorkspace: true,
    toolNetworkPolicy: "disabled",
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

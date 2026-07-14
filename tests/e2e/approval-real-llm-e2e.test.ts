import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { globalApprovalManager, type ApprovalNotice } from "../../src/approval/manager.js";
import { runAgentFromCli } from "../../src/cli/run-agent.js";
import { getOrCreateSessionSettings } from "../../src/input/session-settings.js";
import { OpenAIProvider } from "../../src/provider/openai.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import type { Message, ToolDefinition } from "../../src/schema/message.js";

function readDotEnv(): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(".env", "utf8")
        .split("\n")
        .map((line) => line.match(/^([^#=]+)=(.*)$/))
        .filter((match): match is RegExpMatchArray => Boolean(match))
        .map((match) => [match[1]!.trim(), match[2]!.trim()]),
    );
  } catch {
    return {};
  }
}

class WriteOnlyRealProvider implements LLMProvider {
  readonly modelName?: string;
  readonly calls: Message[][] = [];

  constructor(private readonly real: OpenAIProvider) {
    this.modelName = real.modelName;
  }

  generate(messages: Message[], availableTools: ToolDefinition[]): Promise<Message> {
    this.calls.push([...messages]);
    return this.real.generate(
      messages,
      availableTools.filter((tool) => tool.name === "write_file"),
    );
  }
}

const dotEnv = readDotEnv();
const BASE_URL = process.env.LLM_BASE_URL ?? dotEnv.LLM_BASE_URL;
const API_KEY = process.env.LLM_API_KEY ?? dotEnv.LLM_API_KEY;
const MODEL = process.env.LLM_MODEL ?? dotEnv.LLM_MODEL;
const RUN_LLM_E2E = process.env.RUN_LLM_E2E === "1" || process.env.PICO_LLM_E2E === "1";
const describeRealLLM = RUN_LLM_E2E && BASE_URL && API_KEY && MODEL ? describe : describe.skip;

describeRealLLM("approval e2e with real LLM", { timeout: 180000 }, () => {
  const tempDirs: string[] = [];

  afterAll(() => {
    globalApprovalManager.clear();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("real model write_file is blocked until human approval", async () => {
    const workDir = realpathSync(mkdtempSync(join(tmpdir(), "pico-real-approval-")));
    tempDirs.push(workDir);
    const sessionId = `real_approval_${Date.now()}`;
    getOrCreateSessionSettings({
      sessionId,
      cwd: workDir,
      provider: "openai",
      model: MODEL!,
      mode: "default",
    });
    const provider = new WriteOnlyRealProvider(
      new OpenAIProvider({ baseURL: BASE_URL!, apiKey: API_KEY!, model: MODEL! }),
    );
    const notices: ApprovalNotice[] = [];

    const result = await runAgentFromCli(
      {
        prompt: [
          "Use the write_file tool exactly once.",
          "Create real-approval.txt with the exact content PICO_REAL_APPROVAL_OK.",
          "If the tool result is rejected, stop and say PICO_APPROVAL_REJECTED_OK.",
          "Do not answer directly before attempting the tool call.",
        ].join(" "),
        dir: workDir,
        session: sessionId,
        provider: "openai",
        model: MODEL!,
      },
      {
        provider,
        env: {
          LLM_BASE_URL: BASE_URL,
          LLM_API_KEY: API_KEY,
          LLM_MODEL: MODEL,
        },
        approvalNotifier: (notice) => {
          notices.push(notice);
          globalApprovalManager.resolveApproval(notice.taskId, false, "real e2e rejection");
        },
      },
    );

    expect(provider.calls.length).toBeGreaterThan(0);
    expect(notices.length).toBeGreaterThan(0);
    expect(notices[0]).toMatchObject({
      toolName: "write_file",
    });
    expect(notices[0]?.preview?.target).toBe("real-approval.txt");
    expect(notices[0]?.diff).toContain("PICO_REAL_APPROVAL_OK");
    expect(existsSync(join(workDir, "real-approval.txt"))).toBe(false);
    expect(result.finalMessage).toContain("PICO_APPROVAL_REJECTED_OK");
  });
});

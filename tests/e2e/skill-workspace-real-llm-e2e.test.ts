import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { globalApprovalManager, type ApprovalNotice } from "../../src/approval/manager.js";
import { runAgentFromCli } from "../../src/cli/run-agent.js";
import { createPicoCommandRegistry } from "../../src/input/pico-command-registry.js";
import { processUserInput } from "../../src/input/process-user-input.js";
import { getOrCreateSessionSettings } from "../../src/input/session-settings.js";
import type { LLMProvider, LLMProviderRequestOptions } from "../../src/provider/interface.js";
import { OpenAIProvider } from "../../src/provider/openai.js";
import {
  isToolResultErrorMessage,
  type Message,
  type ToolDefinition,
} from "../../src/schema/message.js";

function readDotEnv(path: string): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(path, "utf8")
        .split(/\r?\n/u)
        .map((line) => line.match(/^([^#=]+)=(.*)$/u))
        .filter((match): match is RegExpMatchArray => Boolean(match))
        .map((match) => [match[1]!.trim(), stripEnvQuotes(match[2]!.trim())]),
    );
  } catch {
    return {};
  }
}

function stripEnvQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  return (first === '"' && last === '"') || (first === "'" && last === "'")
    ? value.slice(1, -1)
    : value;
}

function mainRepoDir(cwd: string): string {
  const marker = `${sep}.worktrees${sep}`;
  const index = cwd.indexOf(marker);
  return index === -1 ? cwd : cwd.slice(0, index);
}

const worktreeEnv = readDotEnv(join(process.cwd(), ".env"));
const mainEnv = readDotEnv(join(mainRepoDir(process.cwd()), ".env"));
const realEnv = {
  LLM_BASE_URL: process.env.LLM_BASE_URL ?? worktreeEnv.LLM_BASE_URL ?? mainEnv.LLM_BASE_URL,
  LLM_API_KEY: process.env.LLM_API_KEY ?? worktreeEnv.LLM_API_KEY ?? mainEnv.LLM_API_KEY,
  LLM_MODEL: process.env.LLM_MODEL ?? worktreeEnv.LLM_MODEL ?? mainEnv.LLM_MODEL,
};
const RUN_LLM_E2E = process.env.RUN_LLM_E2E === "1" || process.env.PICO_LLM_E2E === "1";
const hasRealLlmConfig = Boolean(realEnv.LLM_BASE_URL && realEnv.LLM_API_KEY && realEnv.LLM_MODEL);
const describeRealLLM = RUN_LLM_E2E && hasRealLlmConfig ? describe : describe.skip;

class WriteOnlyObservingProvider implements LLMProvider {
  readonly modelName?: string;
  readonly responses: Message[] = [];

  constructor(private readonly real: LLMProvider) {
    this.modelName = real.modelName;
  }

  async generate(
    messages: Message[],
    availableTools: ToolDefinition[],
    options?: LLMProviderRequestOptions,
  ): Promise<Message> {
    const response = await this.real.generate(
      messages,
      availableTools.filter((tool) => tool.name === "write_file"),
      options,
    );
    this.responses.push(response);
    return response;
  }
}

describeRealLLM("explicit skill and additional workspace real LLM e2e", { timeout: 240000 }, () => {
  const tempDirs: string[] = [];
  let originalPersistence: string | undefined;

  beforeAll(() => {
    originalPersistence = process.env.PICO_PERSISTENCE;
    process.env.PICO_PERSISTENCE = "0";
  });

  afterAll(() => {
    if (originalPersistence === undefined) delete process.env.PICO_PERSISTENCE;
    else process.env.PICO_PERSISTENCE = originalPersistence;
    globalApprovalManager.clear();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it("真实模型遵循显式 Skill，且外部写入遵循审批与 add-dir 边界", async () => {
    const workDir = realpathSync(mkdtempSync(join(tmpdir(), "pico-real-skill-root-")));
    const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "pico-real-skill-outside-")));
    tempDirs.push(workDir, outsideDir);
    const outsideFile = join(outsideDir, "skill-marker.txt");
    const skillDir = join(workDir, ".claw", "skills", "marker");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: marker",
        "description: create a marker file",
        "---",
        "Use the write_file tool exactly once.",
        "Create $0 with the exact content SKILL_ACTIVATED.",
        "Do not write any other file. If the tool fails, stop and explain the failure.",
      ].join("\n"),
    );
    const commandRegistry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: realEnv.LLM_MODEL!,
    });
    const command = await processUserInput(`/marker ${outsideFile}`, {
      registry: commandRegistry,
    });
    expect(command.type).toBe("prompt-command");
    if (command.type !== "prompt-command") return;
    expect(command.result.metadata).toMatchObject({
      skillName: "marker",
      skillArgs: outsideFile,
      skillTrigger: "user-slash",
    });

    const blockedProvider = createProvider();
    const blockedNotices: ApprovalNotice[] = [];
    const blockedSessionId = `real_skill_blocked_${Date.now()}`;
    getOrCreateSessionSettings({
      sessionId: blockedSessionId,
      cwd: workDir,
      provider: "openai",
      model: realEnv.LLM_MODEL!,
      mode: "default",
    });
    const blocked = await runAgentFromCli(
      {
        prompt: command.result.prompt,
        dir: workDir,
        session: blockedSessionId,
        provider: "openai",
        model: realEnv.LLM_MODEL!,
      },
      {
        provider: blockedProvider,
        env: realEnv,
        approvalNotifier: (notice) => {
          blockedNotices.push(notice);
          globalApprovalManager.resolveApproval(notice.taskId, false, "real e2e outside denied");
        },
      },
    );

    expect(blockedProvider.responses.some(hasWriteFileCall)).toBe(true);
    expect(blockedNotices).toHaveLength(1);
    expect(
      blocked.messages.some(
        (message) => message.toolCallId !== undefined && isToolResultErrorMessage(message),
      ),
    ).toBe(true);
    expect(() => readFileSync(outsideFile, "utf8")).toThrow();

    const allowedProvider = createProvider();
    const allowedNotices: ApprovalNotice[] = [];
    const allowedSessionId = `real_skill_allowed_${Date.now()}`;
    getOrCreateSessionSettings({
      sessionId: allowedSessionId,
      cwd: workDir,
      provider: "openai",
      model: realEnv.LLM_MODEL!,
      mode: "default",
    });
    await runAgentFromCli(
      {
        prompt: command.result.prompt,
        dir: workDir,
        session: allowedSessionId,
        provider: "openai",
        model: realEnv.LLM_MODEL!,
        addDirs: [outsideDir],
      },
      {
        provider: allowedProvider,
        env: realEnv,
        approvalNotifier: (notice) => {
          allowedNotices.push(notice);
          globalApprovalManager.resolveApproval(notice.taskId, true, "real e2e added directory");
        },
      },
    );

    expect(allowedProvider.responses.some(hasWriteFileCall)).toBe(true);
    expect(allowedNotices).toHaveLength(1);
    expect(readFileSync(outsideFile, "utf8")).toBe("SKILL_ACTIVATED");
  });

  function createProvider(): WriteOnlyObservingProvider {
    return new WriteOnlyObservingProvider(
      new OpenAIProvider({
        baseURL: realEnv.LLM_BASE_URL!,
        apiKey: realEnv.LLM_API_KEY!,
        model: realEnv.LLM_MODEL!,
      }),
    );
  }
});

function hasWriteFileCall(message: Message): boolean {
  return message.toolCalls?.some((call) => call.name === "write_file") ?? false;
}

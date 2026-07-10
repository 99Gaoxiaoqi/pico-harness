import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import React from "react";
import { globalApprovalManager } from "../../src/approval/manager.js";
import { runAgentFromCli, type RunAgentCliDependencies } from "../../src/cli/run-agent.js";
import { buildTranscriptLayout } from "../../src/tui/transcript-layout.js";
import type { DialogRequest } from "../../src/tui/dialog-arbiter.js";
import { OpenAIProvider } from "../../src/provider/openai.js";
import type {
  LLMProvider,
  LLMProviderRequestOptions,
} from "../../src/provider/interface.js";
import type { Message, ToolDefinition } from "../../src/schema/message.js";
import {
  runTuiAgentPrompt,
  type TuiAbortControllerRef,
  type TuiRunAgent,
} from "../../src/tui/repl.js";
import { TuiReporter, type TuiEntry } from "../../src/tui/tui-reporter.js";

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

function mainRepoDir(cwd: string): string {
  const marker = `${sep}.worktrees${sep}`;
  const index = cwd.indexOf(marker);
  return index === -1 ? cwd : cwd.slice(0, index);
}

function loadRealLlmEnv(): Record<string, string | undefined> {
  const cwd = process.cwd();
  const worktreeEnv = readDotEnv(join(cwd, ".env"));
  const mainEnv = readDotEnv(join(mainRepoDir(cwd), ".env"));
  return {
    LLM_BASE_URL: process.env.LLM_BASE_URL ?? worktreeEnv.LLM_BASE_URL ?? mainEnv.LLM_BASE_URL,
    LLM_API_KEY: process.env.LLM_API_KEY ?? worktreeEnv.LLM_API_KEY ?? mainEnv.LLM_API_KEY,
    LLM_MODEL: process.env.LLM_MODEL ?? worktreeEnv.LLM_MODEL ?? mainEnv.LLM_MODEL,
  };
}

function stripEnvQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  return (first === "\"" && last === "\"") || (first === "'" && last === "'")
    ? value.slice(1, -1)
    : value;
}

class ToolFilteringProvider implements LLMProvider {
  readonly modelName?: string;

  constructor(
    private readonly real: LLMProvider,
    private readonly allowedTools: Set<string>,
  ) {
    this.modelName = real.modelName;
  }

  generate(
    messages: Message[],
    availableTools: ToolDefinition[],
    options?: LLMProviderRequestOptions,
  ): Promise<Message> {
    return this.real.generate(messages, this.filterTools(availableTools), options);
  }

  generateStream(
    messages: Message[],
    availableTools: ToolDefinition[],
    onDelta: (delta: string) => void,
    options?: LLMProviderRequestOptions,
  ): Promise<Message> {
    if (!this.real.generateStream) {
      return this.generate(messages, availableTools, options);
    }
    return this.real.generateStream(messages, this.filterTools(availableTools), onDelta, options);
  }

  isRetryableError(error: unknown): boolean {
    return this.real.isRetryableError?.(error) ?? false;
  }

  private filterTools(tools: ToolDefinition[]): ToolDefinition[] {
    return tools.filter((tool) => this.allowedTools.has(tool.name));
  }
}

interface TuiRealHarness {
  workDir: string;
  sessionId: string;
  entries: () => TuiEntry[];
  runPrompt: (
    prompt: string,
    options?: {
      provider?: LLMProvider;
      abortControllerRef?: TuiAbortControllerRef;
      openDialog?: (request: DialogRequest) => void;
      closeDialog?: (id: string) => void;
    },
  ) => Promise<void>;
}

const realEnv = loadRealLlmEnv();
const RUN_LLM_E2E = process.env.RUN_LLM_E2E === "1" || process.env.PICO_LLM_E2E === "1";
const hasRealLlmConfig = Boolean(realEnv.LLM_BASE_URL && realEnv.LLM_API_KEY && realEnv.LLM_MODEL);
const describeRealLLM = RUN_LLM_E2E && hasRealLlmConfig ? describe : describe.skip;

describeRealLLM("TUI productization real LLM e2e", { timeout: 240000 }, () => {
  const tempDirs: string[] = [];
  let originalPersistence: string | undefined;

  beforeAll(() => {
    originalPersistence = process.env.PICO_PERSISTENCE;
    process.env.PICO_PERSISTENCE = "0";
  });

  afterAll(() => {
    if (originalPersistence === undefined) {
      delete process.env.PICO_PERSISTENCE;
    } else {
      process.env.PICO_PERSISTENCE = originalPersistence;
    }
    globalApprovalManager.clear();
    vi.restoreAllMocks();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createHarness(name: string): TuiRealHarness {
    const workDir = mkdtempSync(join(tmpdir(), `pico-tui-real-${name}-`));
    tempDirs.push(workDir);
    const snapshots: TuiEntry[][] = [];
    const reporter = new TuiReporter((entries) => snapshots.push(entries));
    const sessionId = `tui_real_${name}_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    return {
      workDir,
      sessionId,
      entries: () => snapshots.at(-1) ?? [],
      async runPrompt(prompt, options = {}) {
        reporter.pushUserMessage(prompt);
        const provider =
          options.provider ??
          new OpenAIProvider({
            baseURL: realEnv.LLM_BASE_URL!,
            apiKey: realEnv.LLM_API_KEY!,
            model: realEnv.LLM_MODEL!,
          });
        const runAgent: TuiRunAgent = (cliOptions, deps) =>
          runAgentFromCli(cliOptions, {
            ...deps,
            provider,
            env: realEnv,
          } satisfies RunAgentCliDependencies);

        await runTuiAgentPrompt(
          {
            prompt,
            dir: workDir,
            session: sessionId,
            sessionSelection: { mode: "new", sessionId },
            provider: "openai",
            model: realEnv.LLM_MODEL!,
            thinkingEffort: "off",
          },
          {
            reporter,
            runAgent,
            ...(options.abortControllerRef ? { abortControllerRef: options.abortControllerRef } : {}),
            ...(options.openDialog ? { openDialog: options.openDialog } : {}),
            ...(options.closeDialog ? { closeDialog: options.closeDialog } : {}),
          },
        );
      },
    };
  }

  it("普通问候不产生 tool entry", async () => {
    const harness = createHarness("hello");

    await harness.runPrompt("Reply exactly: PICO_TUI_HELLO_OK. Do not use tools.");

    const entries = harness.entries();
    expect(entries.some((entry) => entry.kind === "tool")).toBe(false);
    expect(assistantText(entries)).toContain("PICO_TUI_HELLO_OK");
  });

  it("触发写入时出现真实审批请求且拒绝后文件不变", async () => {
    const harness = createHarness("approval");
    const target = join(harness.workDir, "real-approval.txt");
    writeFileSync(target, "ORIGINAL\n");
    const realProvider = new OpenAIProvider({
      baseURL: realEnv.LLM_BASE_URL!,
      apiKey: realEnv.LLM_API_KEY!,
      model: realEnv.LLM_MODEL!,
    });
    const writeOnlyProvider = new ToolFilteringProvider(realProvider, new Set(["write_file"]));
    const openDialog = vi.fn((request: DialogRequest) => {
      const element = request.content;
      if (React.isValidElement<{ onAction?: (action: "reject") => void }>(element)) {
        element.props.onAction?.("reject");
      }
    });
    const closeDialog = vi.fn();

    await harness.runPrompt(
      [
        "Use the write_file tool exactly once.",
        "Overwrite real-approval.txt with the exact content PICO_TUI_APPROVAL_SHOULD_NOT_WRITE.",
        "If the tool is rejected, stop and say PICO_TUI_APPROVAL_REJECTED_OK.",
        "Do not answer directly before attempting the tool call.",
      ].join(" "),
      { provider: writeOnlyProvider, openDialog, closeDialog },
    );

    const entries = harness.entries();
    expect(openDialog).toHaveBeenCalledWith(
      expect.objectContaining({ id: "approval:pending", layer: "modal" }),
    );
    expect(closeDialog).toHaveBeenCalledWith("approval:pending");
    expect(entries).toContainEqual(
      expect.objectContaining({ kind: "tool", name: "write_file", status: "denied" }),
    );
    expect(readFileSync(target, "utf8")).toBe("ORIGINAL\n");
    expect(assistantText(entries)).toContain("PICO_TUI_APPROVAL_REJECTED_OK");
  });

  it("AbortSignal 中断后同 session 可继续", async () => {
    const harness = createHarness("abort");
    const abortControllerRef: TuiAbortControllerRef = { current: null };
    const interrupted = harness.runPrompt(
      "Write a long numbered list with at least 800 items. Start now and do not use tools.",
      { abortControllerRef },
    );

    await vi.waitFor(() => expect(abortControllerRef.current).not.toBeNull(), { timeout: 5000 });
    abortControllerRef.current?.abort(new DOMException("real e2e interrupted", "AbortError"));
    await expect(interrupted).rejects.toThrow();

    await harness.runPrompt("Reply exactly: PICO_TUI_AFTER_ABORT_OK. Do not use tools.");

    const entries = harness.entries();
    expect(entries.some((entry) => entry.kind === "error")).toBe(false);
    expect(assistantText(entries)).toContain("PICO_TUI_AFTER_ABORT_OK");
  });

  it("长回复和多轮后仍能提交下一条并保持 transcript 可用", async () => {
    const harness = createHarness("long");

    await harness.runPrompt(
      "Write 12 short lines. Each line must include the token PICO_TUI_LONG_LINE. Do not use tools.",
    );
    await harness.runPrompt("Reply exactly: PICO_TUI_NEXT_OK. Do not use tools.");

    const entries = harness.entries();
    const assistantEntries = entries.filter((entry) => entry.kind === "assistant");
    expect(assistantEntries.length).toBeGreaterThanOrEqual(2);
    expect(assistantText(entries)).toContain("PICO_TUI_LONG_LINE");
    expect(assistantText(entries)).toContain("PICO_TUI_NEXT_OK");
    expect(entries.some((entry) => entry.kind === "error")).toBe(false);

    const layout = buildTranscriptLayout(entries, { wrapWidth: 60 });
    expect(layout.contentRows).toBeGreaterThan(entries.length);
  });
});

function assistantText(entries: readonly TuiEntry[]): string {
  return entries
    .filter((entry): entry is Extract<TuiEntry, { kind: "assistant" }> => entry.kind === "assistant")
    .map((entry) => entry.content)
    .join("\n");
}

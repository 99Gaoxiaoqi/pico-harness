import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import React from "react";
import { globalApprovalManager } from "../../src/approval/manager.js";
import { runAgentFromCli, type RunAgentCliDependencies } from "../../src/cli/run-agent.js";
import { buildTranscriptLayout } from "../../src/tui/transcript-layout.js";
import type { DialogRequest } from "../../src/tui/dialog-arbiter.js";
import { LLMStatusError } from "../../src/provider/errors.js";
import { defaultIsRetryableError } from "../../src/provider/retry.js";
import { OpenAIProvider } from "../../src/provider/openai.js";
import type { LLMProvider, LLMProviderRequestOptions } from "../../src/provider/interface.js";
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
  return (first === '"' && last === '"') || (first === "'" && last === "'")
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
    return this.real.isRetryableError?.(error) ?? defaultIsRetryableError(error);
  }

  private filterTools(tools: ToolDefinition[]): ToolDefinition[] {
    return tools.filter((tool) => this.allowedTools.has(tool.name));
  }
}

class ObservingProvider implements LLMProvider {
  readonly modelName?: string;
  readonly requests: Array<{ messages: Message[]; tools: ToolDefinition[] }> = [];
  private streamStartResolve!: () => void;
  private streamStarted = new Promise<void>((resolve) => {
    this.streamStartResolve = resolve;
  });

  constructor(private readonly real: LLMProvider) {
    this.modelName = real.modelName;
  }

  async waitForStreamStart(): Promise<void> {
    await this.streamStarted;
  }

  generate(
    messages: Message[],
    availableTools: ToolDefinition[],
    options?: LLMProviderRequestOptions,
  ): Promise<Message> {
    this.requests.push({ messages: [...messages], tools: [...availableTools] });
    this.streamStartResolve();
    return this.real.generate(messages, availableTools, options);
  }

  generateStream(
    messages: Message[],
    availableTools: ToolDefinition[],
    onDelta: (delta: string) => void,
    options?: LLMProviderRequestOptions,
  ): Promise<Message> {
    this.requests.push({ messages: [...messages], tools: [...availableTools] });
    this.streamStartResolve();
    return this.real.generateStream
      ? this.real.generateStream(messages, availableTools, onDelta, options)
      : this.real.generate(messages, availableTools, options);
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

describe("TUI real LLM e2e helpers", () => {
  it("ToolFilteringProvider falls back to the default retryable classifier", () => {
    const provider: LLMProvider = {
      modelName: "stub",
      async generate() {
        return { role: "assistant", content: "ok" };
      },
    };
    const filtering = new ToolFilteringProvider(provider, new Set(["write_file"]));
    const error = new LLMStatusError(503, "temporarily unavailable");

    expect(filtering.isRetryableError(error)).toBe(defaultIsRetryableError(error));
  });
});

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
            ...(options.abortControllerRef
              ? { abortControllerRef: options.abortControllerRef }
              : {}),
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
    let rejectApproval: (() => void) | undefined;
    let rejectedApproval = false;
    const openDialog = vi.fn((request: DialogRequest) => {
      const element = request.content;
      if (React.isValidElement<{ onAction?: (action: "reject") => void }>(element)) {
        rejectApproval = () => element.props.onAction?.("reject");
      }
    });
    const closeDialog = vi.fn();
    const abortControllerRef: TuiAbortControllerRef = { current: null };
    const rejectCapturedApproval = () => {
      if (rejectedApproval || !rejectApproval) return;
      rejectedApproval = true;
      rejectApproval();
    };

    const run = harness.runPrompt(
      [
        "Use the write_file tool exactly once.",
        "Overwrite real-approval.txt with the exact content PICO_TUI_APPROVAL_SHOULD_NOT_WRITE.",
        "If the tool is rejected, stop and say PICO_TUI_APPROVAL_REJECTED_OK.",
        "Do not answer directly before attempting the tool call.",
      ].join(" "),
      { provider: writeOnlyProvider, openDialog, closeDialog, abortControllerRef },
    );
    const outcome = observeOutcome(run);
    let approvalCompleted = false;
    let hasApprovalTryError = false;
    let approvalTryError: unknown;
    let hasApprovalCleanupError = false;
    let approvalCleanupError: unknown;
    try {
      await waitForDialogOrOutcome(openDialog, outcome, 60000);
      const settledBeforeReject = await promiseSettled(outcome);
      expect(settledBeforeReject).toBe(false);
      expect(readFileSync(target, "utf8")).toBe("ORIGINAL\n");
      expect(rejectApproval).toBeTypeOf("function");
      rejectCapturedApproval();
      const approvalOutcome = await withTimeout(
        outcome,
        60000,
        "timed out waiting for approval run to finish",
      );
      expect(approvalOutcome).toMatchObject({ status: "fulfilled" });
      approvalCompleted = true;

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
    } catch (error) {
      hasApprovalTryError = true;
      approvalTryError = error;
    } finally {
      if (!approvalCompleted) {
        rejectCapturedApproval();
        abortControllerRef.current?.abort(new DOMException("approval test cleanup", "AbortError"));
        try {
          await withTimeout(outcome, 5000, "timed out cleaning up approval run");
        } catch (cleanupError) {
          hasApprovalCleanupError = true;
          approvalCleanupError = cleanupError;
          console.warn("approval run cleanup did not settle", cleanupError);
        }
      } else {
        expect(await promiseSettled(outcome)).toBe(true);
      }
    }
    if (hasApprovalTryError) throw approvalTryError;
    if (hasApprovalCleanupError) throw approvalCleanupError;
  });

  it("AbortSignal 中断后同 session 可继续", async () => {
    const harness = createHarness("abort");
    const abortControllerRef: TuiAbortControllerRef = { current: null };
    const firstPrompt =
      "Write a long numbered list with at least 800 items. Include PICO_TUI_ABORT_FIRST_PROMPT. Start now and do not use tools.";
    const observedProvider = new ObservingProvider(
      new OpenAIProvider({
        baseURL: realEnv.LLM_BASE_URL!,
        apiKey: realEnv.LLM_API_KEY!,
        model: realEnv.LLM_MODEL!,
      }),
    );
    const interrupted = harness.runPrompt(firstPrompt, {
      abortControllerRef,
      provider: observedProvider,
    });
    const interruptedOutcome = observeOutcome(interrupted);

    let interruptCompleted = false;
    let hasInterruptTryError = false;
    let interruptTryError: unknown;
    let hasInterruptCleanupError = false;
    let interruptCleanupError: unknown;
    try {
      await withTimeout(
        observedProvider.waitForStreamStart(),
        10_000,
        "timed out waiting for real provider stream start",
      );
      abortControllerRef.current?.abort(new DOMException("real e2e interrupted", "AbortError"));
      const interruptedResult = await withTimeout(
        interruptedOutcome,
        15000,
        "timed out waiting for interrupted run to finish",
      );
      expect(interruptedResult).toMatchObject({
        status: "rejected",
        error: expect.objectContaining({ name: "AbortError" }),
      });
      interruptCompleted = true;
    } catch (error) {
      hasInterruptTryError = true;
      interruptTryError = error;
    } finally {
      if (!interruptCompleted) {
        abortControllerRef.current?.abort(new DOMException("real e2e cleanup", "AbortError"));
        try {
          await withTimeout(interruptedOutcome, 5000, "timed out cleaning up interrupted run");
        } catch (cleanupError) {
          hasInterruptCleanupError = true;
          interruptCleanupError = cleanupError;
          console.warn("interrupted run cleanup did not settle", cleanupError);
        }
      } else {
        expect(await promiseSettled(interruptedOutcome)).toBe(true);
      }
    }
    if (hasInterruptTryError) throw interruptTryError;
    if (hasInterruptCleanupError) throw interruptCleanupError;

    await harness.runPrompt("Reply exactly: PICO_TUI_AFTER_ABORT_OK. Do not use tools.", {
      provider: observedProvider,
    });

    const entries = harness.entries();
    expect(entries.some((entry) => entry.kind === "error")).toBe(false);
    expect(assistantText(entries)).toContain("PICO_TUI_AFTER_ABORT_OK");
    expect(observedProvider.requests.length).toBeGreaterThanOrEqual(2);
    const secondRequestMessages = observedProvider.requests.at(-1)?.messages ?? [];
    expect(
      secondRequestMessages.some((message) =>
        message.content.includes("PICO_TUI_ABORT_FIRST_PROMPT"),
      ),
    ).toBe(true);
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
    const longAssistant = assistantEntries.find((entry) =>
      entry.content.includes("PICO_TUI_LONG_LINE"),
    );
    expect(longAssistant).toBeDefined();
    expect(
      countOccurrences(longAssistant?.content ?? "", "PICO_TUI_LONG_LINE"),
    ).toBeGreaterThanOrEqual(10);
    expect(assistantText(entries)).toContain("PICO_TUI_NEXT_OK");
    expect(entries.some((entry) => entry.kind === "error")).toBe(false);

    const layout = buildTranscriptLayout(entries, { wrapWidth: 60 });
    const longAssistantIndex = entries.findIndex((entry) => entry === longAssistant);
    expect(layout.items[longAssistantIndex]?.rows).toBeGreaterThanOrEqual(10);
    expect(entries.at(-1)).toMatchObject({
      kind: "assistant",
      content: expect.stringContaining("PICO_TUI_NEXT_OK"),
    });
  });
});

function assistantText(entries: readonly TuiEntry[]): string {
  return entries
    .filter(
      (entry): entry is Extract<TuiEntry, { kind: "assistant" }> => entry.kind === "assistant",
    )
    .map((entry) => entry.content)
    .join("\n");
}

type PromiseOutcome =
  | { status: "fulfilled" }
  | {
      status: "rejected";
      error: unknown;
    };

function observeOutcome(promise: Promise<unknown>): Promise<PromiseOutcome> {
  return promise.then(
    () => ({ status: "fulfilled" }),
    (error: unknown) => ({ status: "rejected", error }),
  );
}

async function waitForDialogOrOutcome(
  openDialog: ReturnType<typeof vi.fn>,
  outcome: Promise<PromiseOutcome>,
  timeoutMs: number,
): Promise<void> {
  const result = await Promise.race([
    vi
      .waitFor(() => expect(openDialog).toHaveBeenCalled(), { timeout: timeoutMs })
      .then(() => ({ kind: "dialog" as const })),
    outcome.then((settledOutcome) => ({ kind: "outcome" as const, outcome: settledOutcome })),
  ]);
  if (result.kind === "outcome") {
    throw new Error(`run settled before approval dialog opened: ${result.outcome.status}`);
  }
}

async function promiseSettled(promise: Promise<unknown>): Promise<boolean> {
  const pending = Symbol("pending");
  const result = await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), 100)),
  ]);
  return result !== pending;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

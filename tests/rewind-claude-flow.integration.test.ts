import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listRewindPointSummaries } from "../src/cli/file-history.js";
import { runAgentFromCli } from "../src/cli/run-agent.js";
import { globalSessionManager } from "../src/engine/session.js";
import { createBuiltinCommandRegistry } from "../src/input/builtin-commands.js";
import {
  commandArgumentSuggestions,
  commandSuggestions,
  createPicoCommandRegistry,
} from "../src/input/pico-command-registry.js";
import { processUserInput } from "../src/input/process-user-input.js";
import { resolvePicoPaths } from "../src/paths/pico-paths.js";
import { RuntimeEventStore } from "../src/runtime/runtime-event-store.js";
import {
  exitSessionPlanMode,
  getOrCreateSessionSettings,
  resetSessionSettingsForTests,
  restoreSessionInteractionMode,
  setSessionMode,
} from "../src/input/session-settings.js";
import type { LLMProvider } from "../src/provider/interface.js";
import type { Message, ToolDefinition } from "../src/schema/message.js";
import { handleTuiInputSubmission } from "../src/tui/repl.js";
import {
  createInputControllerState,
  reduceInputControllerEvent,
} from "../src/tui/input-controller.js";
import {
  createRewindCommandDialogState,
  resolveRewindCommandDialogKey,
} from "../src/tui/rewind-command-dialog.js";
import { createRewindSelectorState, formatRewindSelector } from "../src/tui/rewind-selector.js";
import { applyTuiRewind, rewindInputReplacement } from "../src/tui/rewind-runtime.js";
import { TuiReporter, type TuiEntry } from "../src/tui/tui-reporter.js";
import type { LocalCommandResult } from "../src/input/types.js";

describe("Claude Code style rewind integration", () => {
  let workDir: string | undefined;

  afterEach(async () => {
    globalSessionManager.clear();
    resetSessionSettingsForTests();
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("按用户消息展示变化，并原子恢复 code、conversation、transcript 与输入", async () => {
    workDir = await realpath(await mkdtemp(join(tmpdir(), "pico-claude-rewind-")));
    const filePath = join(workDir, "note.txt");
    await writeFile(filePath, "base\n", "utf8");

    const sessionId = `rewind-integration-${Date.now()}`;
    const session = await globalSessionManager.getOrCreate(sessionId, workDir, {
      persistence: true,
    });
    const transcript: TuiEntry[] = [];
    const reporter = new TuiReporter(() => undefined, transcript);
    const originalConversationId = session.conversationId;
    const provider = new ScriptedRewindProvider([
      {
        role: "assistant",
        content: "write first version",
        toolCalls: [
          {
            id: "write-first",
            name: "write_file",
            arguments: JSON.stringify({ path: "note.txt", content: "first\n" }),
          },
        ],
      },
      { role: "assistant", content: "第一版完成" },
      {
        role: "assistant",
        content: "edit second version",
        toolCalls: [
          {
            id: "edit-second",
            name: "edit_file",
            arguments: JSON.stringify({
              path: "note.txt",
              old_text: "first\n",
              new_text: "second\n",
            }),
          },
        ],
      },
      { role: "assistant", content: "第二版完成" },
    ]);
    getOrCreateSessionSettings({
      sessionId,
      cwd: workDir,
      provider: "openai",
      model: "test-model",
      mode: "yolo",
      permissionMode: "yolo",
    });
    let pendingRewind: { prompt: string; transcriptIndex: number } | undefined;
    let runCount = 0;
    const runAgent = async (prompt: string) => {
      const rewind = pendingRewind;
      pendingRewind = undefined;
      if (!rewind) throw new Error("missing TUI rewind context");
      await runAgentFromCli(
        {
          prompt,
          dir: workDir,
          session: sessionId,
          provider: "openai",
          model: "test-model",
          rewindPrompt: rewind.prompt,
          rewindTranscriptIndex: rewind.transcriptIndex,
          rewindInteractionMode: runCount === 0 ? "default" : "plan",
          ...(runCount === 1 ? { rewindPrePlanMode: "default" } : {}),
        },
        { provider, reporter },
      );
      runCount++;
    };
    const submit = (prompt: string) =>
      handleTuiInputSubmission(prompt, {
        reporter,
        registry: createBuiltinCommandRegistry(),
        workDir,
        runAgent,
        setRewindContext: (context) => {
          pendingRewind = context;
        },
        exit: () => undefined,
      });

    await submit("把 note 改成第一版");
    await submit("再改成第二版");

    const points = await listRewindPointSummaries(session);
    expect(points.map((point) => point.userPrompt)).toEqual(["把 note 改成第一版", "再改成第二版"]);
    expect(points[1]).toMatchObject({ interactionMode: "plan", prePlanMode: "default" });
    expect(
      points.map((point) => [point.changedFileCount, point.addedLines, point.removedLines]),
    ).toEqual([
      [1, 1, 1],
      [1, 1, 1],
    ]);
    expect(points.every((point) => !point.messageId.startsWith("turn-"))).toBe(true);
    const selector = formatRewindSelector(session.id, points);
    expect(selector).toContain("把 note 改成第一版");
    expect(selector).not.toContain("Current prompt");
    expect(selector).not.toContain("turn-");

    const commandRegistry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "test-model",
      session,
      sessionId,
    });
    const inputOptions = {
      slashCommandSuggestions: (query: string) => commandSuggestions(commandRegistry, query),
      slashArgumentSuggestions: (command: string, query: string) =>
        commandArgumentSuggestions(commandRegistry, command, query),
    };
    const typed = reduceInputControllerEvent(
      createInputControllerState(),
      "/rewind",
      {},
      inputOptions,
    ).state;
    const submitted = reduceInputControllerEvent(typed, "", { return: true }, inputOptions);
    expect(submitted.submittedText).toBe("/rewind");

    let selectorResult: LocalCommandResult | undefined;
    await handleTuiInputSubmission(submitted.submittedText!, {
      reporter,
      registry: commandRegistry,
      workDir,
      runAgent: async () => undefined,
      exit: () => undefined,
      openLocalUiDialog: (result) => {
        selectorResult = result;
      },
    });
    expect(selectorResult?.ui).toEqual({ kind: "open-selector", selector: "rewind" });

    let restoredMode: string | undefined;
    let rewind: Awaited<ReturnType<typeof applyTuiRewind>> | undefined;
    const callbacks = {
      getDiffStat: (messageId: string) => session.getRewindDiffStat(messageId),
      onRewind: async (
        snapshot: (typeof points)[number],
        mode: "code" | "conversation" | "both",
      ) => {
        rewind = await applyTuiRewind({
          session,
          reporter,
          snapshot,
          mode,
          onRestoreInteractionMode: (interactionMode) => {
            restoredMode = interactionMode;
          },
        });
      },
    };
    let dialog = createRewindCommandDialogState(createRewindSelectorState(points));
    dialog = await resolveRewindCommandDialogKey(
      dialog,
      points,
      { input: "", key: { upArrow: true } },
      callbacks,
    );
    dialog = await resolveRewindCommandDialogKey(
      dialog,
      points,
      { input: "", key: { return: true } },
      callbacks,
    );
    expect(dialog.selector).toMatchObject({
      phase: "confirm",
      messageId: points[0]!.messageId,
      selectedAction: "both",
    });
    dialog = await resolveRewindCommandDialogKey(
      dialog,
      points,
      { input: "", key: { return: true } },
      callbacks,
    );
    expect(dialog.status).toBe("closed");

    expect(await readFile(filePath, "utf8")).toBe("base\n");
    expect(session.getHistory()).toEqual([]);
    expect(session.conversationId).not.toBe(originalConversationId);
    expect(session.fileHistory.snapshots).toEqual([]);
    expect(reporter.getEntryCount()).toBe(1);
    expect(transcript).toEqual([
      expect.objectContaining({
        kind: "system",
        content: expect.stringContaining("Rewind complete: restored code and conversation"),
      }),
    ]);
    expect(rewind).toMatchObject({ inputText: "把 note 改成第一版", interactionMode: "default" });
    expect(restoredMode).toBe("default");
    expect(rewindInputReplacement(undefined, rewind)).toEqual({
      sequence: 1,
      text: "把 note 改成第一版",
    });

    const runtimeStore = new RuntimeEventStore({
      databasePath: resolvePicoPaths(workDir).workspace.runtimeDatabase,
    });
    const records = (await runtimeStore.readSession(sessionId)).filter(
      (event) => event.kind === "history.rewound" || event.kind === "session.state.committed",
    );
    expect(records.slice(-2)).toMatchObject([
      {
        kind: "history.rewound",
        data: { branchId: expect.stringMatching(/^rewind:/) as string },
      },
      {
        kind: "session.state.committed",
        data: { patch: { settings: { mode: "default" } } },
      },
    ]);
  });

  it("rewind 后退出 plan 会恢复该消息原始的权限模式", async () => {
    workDir = await realpath(await mkdtemp(join(tmpdir(), "pico-rewind-pre-plan-")));
    const sessionId = `rewind-pre-plan-${Date.now()}`;
    const session = await globalSessionManager.getOrCreate(sessionId, workDir, {
      persistence: true,
    });
    const settings = getOrCreateSessionSettings(
      {
        sessionId,
        cwd: workDir,
        provider: "openai",
        model: "test-model",
        mode: "plan",
        permissionMode: "default",
      },
      { persistence: session },
    );
    expect(settings).toMatchObject({ mode: "plan", prePlanMode: "default" });
    await session.flushPersistence();

    const messageId = await session.beginRewindPoint({
      userPrompt: "inspect before editing",
      transcriptIndex: 0,
      interactionMode: settings.mode,
      prePlanMode: settings.prePlanMode,
    });
    const user = await session.commitMessageOnce(`user-message:${messageId}`, {
      role: "user",
      content: "inspect before editing",
    });
    await session.bindRewindPointSource(messageId, user);
    await session.commitMessages({ role: "assistant", content: "plan ready" });

    expect(setSessionMode(settings, "yolo")).toMatchObject({ ok: true });
    await session.flushPersistence();
    const [snapshot] = await listRewindPointSummaries(session);
    if (!snapshot) throw new Error("missing rewind snapshot");
    expect(snapshot).toMatchObject({
      interactionMode: "plan",
      prePlanMode: "default",
    });

    const reporter = new TuiReporter(() => undefined, []);
    const rewind = await applyTuiRewind({
      session,
      reporter,
      snapshot,
      mode: "conversation",
      onRestoreInteractionMode: (interactionMode, prePlanMode) => {
        const restored = restoreSessionInteractionMode(settings, interactionMode, prePlanMode);
        expect(restored.ok).toBe(true);
      },
    });

    expect(rewind).toMatchObject({
      inputText: "inspect before editing",
      interactionMode: "plan",
      prePlanMode: "default",
    });
    expect(session.getRuntimeStateSnapshot().settings).toMatchObject({
      mode: "plan",
      prePlanMode: "default",
    });
    await expect(session.getPendingTuiRewindHandoff()).resolves.toMatchObject({
      interactionMode: "plan",
      prePlanMode: "default",
    });
    expect(settings).toMatchObject({ mode: "plan", prePlanMode: "default" });
    expect(exitSessionPlanMode(settings)).toMatchObject({ ok: true });
    expect(settings.mode).toBe("default");
  });

  it("slash 输入只补全合法命令 token，并保留命名空间、别名与提交后的纠错", async () => {
    workDir = await realpath(await mkdtemp(join(tmpdir(), "pico-slash-completion-")));
    await mkdir(join(workDir, ".pico", "commands", "trailofbits-skills", "plugins"), {
      recursive: true,
    });
    await writeFile(
      join(workDir, ".pico", "commands", "trailofbits-skills", "plugins", "inspect.md"),
      "Inspect the current workspace.",
    );

    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "test-model",
      sessionId: "slash-completion-integration",
    });
    const inputOptions = {
      slashCommandSuggestions: (query: string) => commandSuggestions(registry, query),
      slashArgumentSuggestions: (command: string, query: string) =>
        commandArgumentSuggestions(registry, command, query),
    };
    const type = (text: string) =>
      reduceInputControllerEvent(createInputControllerState(), text, {}, inputOptions).state;

    expect(type("/吃").activeSuggestions).toBeNull();
    expect(type("/吃 le").activeSuggestions).toBeNull();
    expect(type("/qwerty").activeSuggestions).toBeNull();

    expect(type("/re").activeSuggestions?.items.map((item) => item.value)).toContain("rewind");
    expect(type("/?").activeSuggestions?.items.map((item) => item.value)).toContain("help");
    expect(
      type("/trailofbits-skills:plugins:").activeSuggestions?.items.map((item) => item.value),
    ).toContain("trailofbits-skills:plugins:inspect");

    const submittedTypo = await processUserInput("/hlep", { registry });
    expect(submittedTypo).toMatchObject({
      type: "unknown-command",
      suggestions: expect.arrayContaining(["help"]),
    });
  });
});

class ScriptedRewindProvider implements LLMProvider {
  constructor(private readonly responses: Message[]) {}

  generate(_messages: Message[], _availableTools: ToolDefinition[]): Promise<Message> {
    const response = this.responses.shift();
    if (!response) throw new Error("No scripted response left");
    return Promise.resolve(response);
  }
}

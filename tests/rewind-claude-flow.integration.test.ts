import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listRewindPointSummaries } from "../src/cli/file-history.js";
import { runAgentFromCli } from "../src/cli/run-agent.js";
import { globalSessionManager } from "../src/engine/session.js";
import { createBuiltinCommandRegistry } from "../src/input/builtin-commands.js";
import {
  getOrCreateSessionSettings,
  resetSessionSettingsForTests,
} from "../src/input/session-settings.js";
import type { LLMProvider } from "../src/provider/interface.js";
import type { Message, ToolDefinition } from "../src/schema/message.js";
import { handleTuiInputSubmission } from "../src/tui/repl.js";
import { formatRewindSelector } from "../src/tui/rewind-selector.js";
import { applyTuiRewind, rewindInputReplacement } from "../src/tui/rewind-runtime.js";
import { TuiReporter } from "../src/tui/tui-reporter.js";

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
    const reporter = new TuiReporter(() => undefined);
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
    expect(
      points.map((point) => [point.changedFileCount, point.addedLines, point.removedLines]),
    ).toEqual([
      [1, 1, 1],
      [1, 1, 1],
    ]);
    expect(points.every((point) => !point.messageId.startsWith("turn-"))).toBe(true);
    const selector = formatRewindSelector(session.id, points);
    expect(selector).toContain("把 note 改成第一版");
    expect(selector).toContain("Current prompt");
    expect(selector).not.toContain("turn-");

    const rewind = await applyTuiRewind({
      session,
      reporter,
      snapshot: points[0]!,
      mode: "both",
    });

    expect(await readFile(filePath, "utf8")).toBe("base\n");
    expect(session.getHistory()).toEqual([]);
    expect(session.conversationId).not.toBe(originalConversationId);
    expect(session.fileHistory.snapshots).toEqual([]);
    expect(reporter.getEntryCount()).toBe(0);
    expect(rewind).toMatchObject({ inputText: "把 note 改成第一版", interactionMode: "default" });
    expect(rewindInputReplacement(undefined, rewind)).toEqual({
      sequence: 1,
      text: "把 note 改成第一版",
    });

    const records = (
      await readFile(join(workDir, ".claw", "sessions", `${sessionId}.jsonl`), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.at(-1)).toMatchObject({ type: "rewind_to", messageIndex: 0 });
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

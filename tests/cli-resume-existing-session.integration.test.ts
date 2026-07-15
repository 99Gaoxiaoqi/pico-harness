import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentFromCli } from "../src/cli/run-agent.js";
import { globalSessionManager } from "../src/engine/session.js";
import type { LLMProvider } from "../src/provider/interface.js";
import type { Message } from "../src/schema/message.js";
import { createTuiRuntimeState } from "../src/tui/runtime-state.js";

describe("runAgentFromCli existing-session resume", () => {
  let activeSession: { id: string; workDir: string } | undefined;

  afterEach(() => {
    if (activeSession) {
      globalSessionManager.delete(activeSession.id, activeSession.workDir);
      activeSession = undefined;
    }
  });

  it("continues the existing turn without adding a visible user message or rewind point", async () => {
    const workDir = await realpath(await mkdtemp(join(tmpdir(), "pico-resume-existing-")));
    const sessionId = `resume-existing-${Date.now()}`;
    const session = await globalSessionManager.getOrCreate(sessionId, workDir, {
      persistence: true,
    });
    activeSession = { id: sessionId, workDir };
    await session.beginRewindPoint({ userPrompt: "original request" });
    await session.commitMessages({ role: "user", content: "original request" });
    const runtimeState = await createTuiRuntimeState({ workDir, sessionId, session });
    const seenContexts: Message[][] = [];
    const provider: LLMProvider = {
      async generate(messages): Promise<Message> {
        seenContexts.push(messages);
        return {
          role: "assistant",
          content: "resumed without another user turn",
          usage: { promptTokens: 1, completionTokens: 1 },
        };
      },
    };
    const rewindCountBefore = session.fileHistory.snapshots.length;

    try {
      const result = await runAgentFromCli(
        {
          prompt: "",
          dir: workDir,
          session: sessionId,
          provider: "openai",
          model: "glm-5.2",
        },
        {
          provider,
          runtimeState,
          resumeExistingSession: true,
        },
      );

      const visibleUsers = session
        .getHistory()
        .filter(
          (message) =>
            message.role === "user" &&
            message.toolCallId === undefined &&
            message.providerData?.["picoHiddenFromTranscript"] !== true,
        );
      expect(result.finalMessage).toBe("resumed without another user turn");
      expect(visibleUsers.map((message) => message.content)).toEqual(["original request"]);
      expect(session.fileHistory.snapshots).toHaveLength(rewindCountBefore);
      expect(seenContexts[0]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "original request" }),
        ]),
      );
    } finally {
      await runtimeState.dispose();
    }
  });
});

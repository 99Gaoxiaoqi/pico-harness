import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Session } from "../../src/engine/session.js";
import { createTuiRuntimeState } from "../../src/tui/runtime-state.js";

describe("TuiRuntimeState", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    for (const directory of cleanup.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates one session-scoped service graph", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-runtime-state-"));
    cleanup.push(workDir);
    const session = new Session("runtime-session", workDir, { persistence: false });

    const runtime = await createTuiRuntimeState({
      session,
      sessionId: session.id,
      workDir,
    });

    expect(runtime.backgroundManager.taskRegistry).toBe(runtime.taskRegistry);
    expect(runtime.delegationManager.taskRegistry).toBe(runtime.taskRegistry);
    expect(runtime.skillRegistry.getAll()).toEqual([]);
    expect(runtime.memoryNudger).toBeDefined();
    expect(runtime.goalManager.getActive()).toBeUndefined();

    runtime.goalManager.create("persisted", "same TUI process");
    expect(runtime.goalManager.getActive()?.title).toBe("persisted");
    expect(() => runtime.assertCompatible(workDir, session.id)).not.toThrow();
    expect(() => runtime.assertCompatible(workDir, "other-session")).toThrow("session");

    await runtime.dispose();
    session.close();
  });

  it("counts persisted user conversation turns", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-runtime-turns-"));
    cleanup.push(workDir);
    const session = new Session("runtime-turns", workDir, { persistence: false });
    const runtime = await createTuiRuntimeState({ session, sessionId: session.id, workDir });

    session.append({ role: "user", content: "one" });
    session.append({ role: "assistant", content: "answer" });
    session.append({ role: "user", content: "two" });

    expect(runtime.conversationTurnCount(session)).toBe(2);

    await runtime.dispose();
    session.close();
  });
});

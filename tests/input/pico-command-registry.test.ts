import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Session } from "../../src/engine/session.js";
import { createBuiltinCommandRegistry } from "../../src/input/builtin-commands.js";
import { createPicoCommandRegistry } from "../../src/input/pico-command-registry.js";
import { processUserInput } from "../../src/input/process-user-input.js";
import {
  getStoredSessionSettings,
  resetSessionSettingsForTests,
} from "../../src/input/session-settings.js";
import {
  fileHistoryMakeSnapshot,
  fileHistoryTrackEdit,
} from "../../src/safety/file-history.js";

describe("Pico command registry", () => {
  const cleanup: Array<() => void> = [];

  afterEach(() => {
    resetSessionSettingsForTests();
    while (cleanup.length > 0) {
      cleanup.pop()?.();
    }
  });

  async function registryWithSnapshot(messageId = "turn-1") {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-rewind-"));
    const session = new Session(`pico-command-${Date.now()}-${Math.random()}`, workDir, {
      persistence: false,
    });
    const filePath = join(workDir, "note.txt");
    writeFileSync(filePath, "before\n");
    session.append({ role: "user", content: "edit" });
    session.append({ role: "assistant", content: "done" });
    await fileHistoryTrackEdit(session.fileHistory, filePath, messageId, session.id);
    writeFileSync(filePath, "after\n");
    await fileHistoryMakeSnapshot(
      session.fileHistory,
      messageId,
      session.id,
      undefined,
      session.length,
    );
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
      session,
      sessionId: session.id,
    });
    cleanup.push(() => {
      session.close();
      rmSync(workDir, { recursive: true, force: true });
    });
    return { registry, filePath };
  }

  it("/mode shows the current interaction mode", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-mode-show",
    });

    const result = await processUserInput("/mode", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("mode");
    expect(result.result.message).toContain("Current mode: default");
  });

  it("/mode updates the current interaction mode", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-mode-update",
    });

    const result = await processUserInput("/mode plan", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("mode");
    expect(result.result.message).toContain("Mode set to plan");
    expect(getStoredSessionSettings("session-mode-update")?.mode).toBe("plan");
  });

  it("/mode rejects unsupported interaction modes", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-mode-reject",
    });

    const result = await processUserInput("/mode fast", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("mode");
    expect(result.result.message).toContain("Usage: /mode <default|plan|auto|yolo>");
    expect(getStoredSessionSettings("session-mode-reject")?.mode).toBe("default");
  });

  it("/model switches the session model used by later requests", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-model",
    });

    const result = await processUserInput("/model kimi-k2.5", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.result.message).toContain("Model set to kimi-k2.5");
    expect(getStoredSessionSettings("session-model")?.model).toBe("kimi-k2.5");
  });

  it("/thinking and /effort update supported thinking effort", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-thinking",
      thinkingEffort: "off",
    });

    const thinking = await processUserInput("/thinking medium", { registry });
    const effort = await processUserInput("/effort high", { registry });

    expect(thinking.type).toBe("local-command");
    expect(effort.type).toBe("local-command");
    expect(getStoredSessionSettings("session-thinking")?.thinkingEffort).toBe("high");
  });

  it("/thinking explains unsupported provider profiles", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "gemini",
      model: "gemini-2.0-flash",
      sessionId: "session-gemini",
      thinkingEffort: "off",
    });

    const result = await processUserInput("/thinking high", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.result.message).toContain("does not support thinking effort");
    expect(getStoredSessionSettings("session-gemini")?.thinkingEffort).toBe("off");
  });

  it("/tools lists tool read/write attributes", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      tools: [
        { name: "read_file", readOnly: true },
        { name: "write_file", readOnly: false },
      ],
    });

    const result = await processUserInput("/tools", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.result.message).toContain("read_file - read-only");
    expect(result.result.message).toContain("write_file - write");
  });

  it("/tools uses default tool status when no snapshot is provided", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
    });

    const result = await processUserInput("/tools", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.result.message).toContain("read_file - read-only");
    expect(result.result.message).toContain("write_file - write");
  });

  it("/status summarizes mode permission mode model and thinking effort", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: "/tmp/pico-work",
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-status",
      thinkingEffort: "medium",
      permissionMode: "ask",
    });

    const result = await processUserInput("/status", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.result.message).toContain("Mode: default");
    expect(result.result.message).toContain("Permission mode: ask");
    expect(result.result.message).toContain("Model: glm-5.2");
    expect(result.result.message).toContain("Thinking effort: medium");
    expect(result.result.message).toContain("Session: session-status");
    expect(result.result.message).toContain("CWD: /tmp/pico-work");
  });

  it("builtin registry exposes /mode as its own command", async () => {
    const result = await processUserInput("/mode", {
      registry: createBuiltinCommandRegistry(),
    });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("mode");
    expect(result.result.message).toContain("Mode command is not connected yet.");
  });

  it("/snapshots 展示当前 session 可回滚点", async () => {
    const { registry } = await registryWithSnapshot("turn-1");

    const result = await processUserInput("/snapshots", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("snapshots");
    expect(result.result.message).toContain("turn-1");
    expect(result.result.message).toContain("/rewind turn-1");
  });

  it("/rewind <message-id> 接到既有文件历史回滚", async () => {
    const { registry, filePath } = await registryWithSnapshot("turn-1");

    const result = await processUserInput("/rewind turn-1 code", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.result.message).toContain("已回滚");
    expect(readFileSync(filePath, "utf8")).toBe("before\n");
  });

  it("/undo 默认回滚最后一个文件历史快照", async () => {
    const { registry, filePath } = await registryWithSnapshot("turn-2");

    const result = await processUserInput("/undo", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("undo");
    expect(result.result.message).toContain("turn-2");
    expect(readFileSync(filePath, "utf8")).toBe("before\n");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { createBuiltinCommandRegistry } from "../../src/input/builtin-commands.js";
import { createPicoCommandRegistry } from "../../src/input/pico-command-registry.js";
import { processUserInput } from "../../src/input/process-user-input.js";
import { getStoredSessionSettings, resetSessionSettingsForTests } from "../../src/input/session-settings.js";

describe("Pico command registry", () => {
  afterEach(() => {
    resetSessionSettingsForTests();
  });

  it("/mode is accepted as an alias for the current model command", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
    });

    const result = await processUserInput("/mode", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("model");
    expect(result.result.action).toBe("model");
    expect(result.result.message).toContain("glm-5.2");
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

  it("/status summarizes model effort session cwd and permission mode", async () => {
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
    expect(result.result.message).toContain("Model: glm-5.2");
    expect(result.result.message).toContain("Effort: medium");
    expect(result.result.message).toContain("Session: session-status");
    expect(result.result.message).toContain("CWD: /tmp/pico-work");
    expect(result.result.message).toContain("Permission: ask");
  });

  it("builtin registry also accepts /mode as a model alias", async () => {
    const result = await processUserInput("/mode", {
      registry: createBuiltinCommandRegistry(),
    });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("model");
    expect(result.result.action).toBe("model");
  });
});

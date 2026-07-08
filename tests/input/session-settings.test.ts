import { describe, expect, it } from "vitest";
import {
  createDefaultSessionSettings,
  formatSessionStatus,
  formatToolStatus,
  setSessionThinkingEffort,
} from "../../src/input/session-settings.js";

describe("session settings", () => {
  it("creates a minimal settings snapshot for status output", () => {
    const settings = createDefaultSessionSettings({
      sessionId: "session-a",
      cwd: "/workspace/app",
      provider: "openai",
      model: "glm-5.2",
      thinkingEffort: "medium",
      permissionMode: "ask",
    });

    expect(formatSessionStatus(settings)).toContain("Model: glm-5.2");
    expect(formatSessionStatus(settings)).toContain("Effort: medium");
    expect(formatSessionStatus(settings)).toContain("Session: session-a");
    expect(formatSessionStatus(settings)).toContain("CWD: /workspace/app");
    expect(formatSessionStatus(settings)).toContain("Permission: ask");
  });

  it("updates thinking effort only when the provider profile supports it", () => {
    const settings = createDefaultSessionSettings({
      sessionId: "session-b",
      cwd: "/workspace/app",
      provider: "openai",
      model: "glm-5.2",
      thinkingEffort: "off",
      permissionMode: "ask",
    });

    const result = setSessionThinkingEffort(settings, "high");

    expect(result.ok).toBe(true);
    expect(settings.thinkingEffort).toBe("high");
    expect(result.message).toContain("Thinking effort set to high");
  });

  it("keeps the previous effort and explains unsupported providers", () => {
    const settings = createDefaultSessionSettings({
      sessionId: "session-c",
      cwd: "/workspace/app",
      provider: "gemini",
      model: "gemini-2.0-flash",
      thinkingEffort: "off",
      permissionMode: "ask",
    });

    const result = setSessionThinkingEffort(settings, "medium");

    expect(result.ok).toBe(false);
    expect(settings.thinkingEffort).toBe("off");
    expect(result.message).toContain("does not support thinking effort");
  });

  it("renders tool read/write status", () => {
    const message = formatToolStatus([
      { name: "read_file", readOnly: true },
      { name: "write_file", readOnly: false },
    ]);

    expect(message).toContain("read_file - read-only");
    expect(message).toContain("write_file - write");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import {
  addSessionAdditionalDirectory,
  createDefaultSessionSettings,
  formatPermissionStatus,
  formatSessionStatus,
  formatToolStatus,
  getOrCreateSessionSettings,
  resetSessionSettingsForTests,
  setSessionMode,
  setSessionPermissionMode,
  setSessionThinkingEffort,
  setSessionAdditionalDirectories,
  setSessionTools,
} from "../../src/input/session-settings.js";

describe("session settings", () => {
  afterEach(() => resetSessionSettingsForTests());

  it("creates a readonly additional-directory snapshot from initial values", () => {
    const initial = ["/workspace/shared", "/workspace/shared"];
    const settings = createDefaultSessionSettings({
      sessionId: "session-additional-initial",
      cwd: "/workspace/app",
      provider: "openai",
      model: "glm-5.2",
      additionalDirectories: initial,
    });

    initial.push("/workspace/later");

    expect(settings.additionalDirectories).toEqual(["/workspace/shared"]);
    expect(Object.isFrozen(settings.additionalDirectories)).toBe(true);
  });

  it("adds session directories idempotently using readonly snapshots", () => {
    const settings = createDefaultSessionSettings({
      sessionId: "session-additional-update",
      cwd: "/workspace/app",
      provider: "openai",
      model: "glm-5.2",
    });

    const first = addSessionAdditionalDirectory(settings, "/workspace/shared");
    const second = addSessionAdditionalDirectory(settings, "/workspace/shared");

    expect(settings.additionalDirectories).toEqual(["/workspace/shared"]);
    expect(second).toBe(first);
    expect(Object.isFrozen(second)).toBe(true);
  });

  it("replaces additional directories with a deduplicated readonly ordered snapshot", () => {
    const settings = createDefaultSessionSettings({
      sessionId: "session-additional-replace",
      cwd: "/workspace/app",
      provider: "openai",
      model: "glm-5.2",
      additionalDirectories: ["/workspace/session"],
    });

    const snapshot = setSessionAdditionalDirectories(settings, [
      "/workspace/config",
      "/workspace/cli",
      "/workspace/session",
      "/workspace/config",
    ]);

    expect(snapshot).toEqual(["/workspace/config", "/workspace/cli", "/workspace/session"]);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("does not carry session directory grants across different cwd values", () => {
    getOrCreateSessionSettings({
      sessionId: "same-id-different-cwd",
      cwd: "/workspace/a",
      provider: "openai",
      model: "glm-5.2",
      additionalDirectories: ["/workspace/a-shared"],
    });

    const settings = getOrCreateSessionSettings({
      sessionId: "same-id-different-cwd",
      cwd: "/workspace/b",
      provider: "openai",
      model: "glm-5.2",
    });

    expect(settings.additionalDirectories).toEqual([]);
  });

  it("replaces the tool catalog with an immutable runtime snapshot", () => {
    const settings = createDefaultSessionSettings({
      sessionId: "session-tools",
      cwd: "/workspace/app",
      provider: "openai",
      model: "glm-5.2",
    });
    const tools = [{ name: "delegate_task", readOnly: false }];

    const snapshot = setSessionTools(settings, tools);
    tools.push({ name: "mcp__late__echo", readOnly: true });

    expect(snapshot).toEqual([{ name: "delegate_task", readOnly: false }]);
    expect(settings.tools).toBe(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("creates a minimal settings snapshot for status output", () => {
    const settings = createDefaultSessionSettings({
      sessionId: "session-a",
      cwd: "/workspace/app",
      provider: "openai",
      model: "glm-5.2",
      thinkingEffort: "medium",
      permissionMode: "ask",
    });

    expect(formatSessionStatus(settings)).toContain("Mode: default");
    expect(formatSessionStatus(settings)).toContain("Model: glm-5.2");
    expect(formatSessionStatus(settings)).toContain("Thinking effort: medium");
    expect(formatSessionStatus(settings)).toContain("Session: session-a");
    expect(formatSessionStatus(settings)).toContain("sessionId: session-a");
    expect(formatSessionStatus(settings)).toContain("sessionMode: new");
    expect(formatSessionStatus(settings)).toContain("forkFrom: -");
    expect(formatSessionStatus(settings)).toContain("CWD: /workspace/app");
    expect(formatSessionStatus(settings)).toContain("Permission mode: ask");
  });

  it("stores and formats fork session semantics", () => {
    const settings = createDefaultSessionSettings({
      sessionId: "session-fork",
      cwd: "/workspace/app",
      provider: "openai",
      model: "glm-5.2",
      sessionMode: "fork",
      forkFrom: "session-source",
    });

    expect(settings.sessionMode).toBe("fork");
    expect(settings.forkFrom).toBe("session-source");
    expect(formatSessionStatus(settings)).toContain("sessionMode: fork");
    expect(formatSessionStatus(settings)).toContain("forkFrom: session-source");
  });

  it("updates session mode for supported interaction modes", () => {
    const settings = createDefaultSessionSettings({
      sessionId: "session-mode",
      cwd: "/workspace/app",
      provider: "openai",
      model: "glm-5.2",
    });

    const result = setSessionMode(settings, "plan");

    expect(result.ok).toBe(true);
    expect(settings.mode).toBe("plan");
    expect(result.message).toContain("Mode set to plan");
  });

  it("keeps the previous mode for unsupported interaction modes", () => {
    const settings = createDefaultSessionSettings({
      sessionId: "session-mode-invalid",
      cwd: "/workspace/app",
      provider: "openai",
      model: "glm-5.2",
    });

    const result = setSessionMode(settings, "fast");

    expect(result.ok).toBe(false);
    expect(settings.mode).toBe("default");
    expect(result.message).toContain("Usage: /mode <default|plan|auto|yolo>");
  });

  it("updates permission mode for supported permission modes", () => {
    const settings = createDefaultSessionSettings({
      sessionId: "session-permissions",
      cwd: "/workspace/app",
      provider: "openai",
      model: "glm-5.2",
    });

    const result = setSessionPermissionMode(settings, "yolo");

    expect(result.ok).toBe(true);
    expect(settings.permissionMode).toBe("yolo");
    expect(result.message).toContain("Permission mode set to yolo");
  });

  it("allows restoring the default ask permission mode", () => {
    const settings = createDefaultSessionSettings({
      sessionId: "session-permissions-ask",
      cwd: "/workspace/app",
      provider: "openai",
      model: "glm-5.2",
      permissionMode: "yolo",
    });

    const result = setSessionPermissionMode(settings, "ask");

    expect(result.ok).toBe(true);
    expect(settings.permissionMode).toBe("ask");
    expect(result.message).toContain("Permission mode set to ask");
  });

  it("keeps the previous permission mode for unsupported permission modes", () => {
    const settings = createDefaultSessionSettings({
      sessionId: "session-permissions-invalid",
      cwd: "/workspace/app",
      provider: "openai",
      model: "glm-5.2",
      permissionMode: "auto",
    });

    const result = setSessionPermissionMode(settings, "fast");

    expect(result.ok).toBe(false);
    expect(settings.permissionMode).toBe("auto");
    expect(result.message).toContain("Usage: /permissions <ask|default|auto|yolo|plan>");
  });

  it("formats permission mode and unavailable session approvals", () => {
    const settings = createDefaultSessionSettings({
      sessionId: "session-permissions-status",
      cwd: "/workspace/app",
      provider: "openai",
      model: "glm-5.2",
      permissionMode: "plan",
    });

    const message = formatPermissionStatus(settings);

    expect(message).toContain("Permission mode: plan");
    expect(message).toContain("Session approvals: unavailable");
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

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Session } from "../../src/engine/session.js";
import { createBuiltinCommandRegistry } from "../../src/input/builtin-commands.js";
import {
  commandSuggestions,
  createPicoCommandRegistry,
} from "../../src/input/pico-command-registry.js";
import { processUserInput } from "../../src/input/process-user-input.js";
import {
  getStoredSessionSettings,
  resetSessionSettingsForTests,
} from "../../src/input/session-settings.js";
import {
  fileHistoryMakeSnapshot,
  fileHistoryTrackEdit,
} from "../../src/safety/file-history.js";
import { ToolDisclosure } from "../../src/tools/tool-disclosure.js";

describe("Pico command registry", () => {
  const cleanup: Array<() => void> = [];
  const originalEnv = { ...process.env };

  afterEach(() => {
    resetSessionSettingsForTests();
    process.env = { ...originalEnv };
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

  it("/tools groups core disclosed and searchable tools with stable risk labels", async () => {
    const disclosure = new ToolDisclosure();
    disclosure.disclose(["web_search"]);
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      toolDisclosure: disclosure,
      tools: [
        { name: "read_file", readOnly: true },
        { name: "write_file", readOnly: false },
        { name: "web_search", readOnly: true },
        { name: "fetch_url", readOnly: true },
      ],
    });

    const result = await processUserInput("/tools", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.result.message).toContain("Core tools");
    expect(result.result.message).toContain("Disclosed tools");
    expect(result.result.message).toContain("Searchable tools");
    expect(result.result.message).toContain("- read_file - read-only - risk: low");
    expect(result.result.message).toContain("- write_file - write - risk: write");
    expect(result.result.message).toContain("- web_search - read-only - risk: low");
    expect(result.result.message).toContain("- fetch_url - read-only - risk: low");
    expect(result.result.message).toContain("Use /tools <query> to search");
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
    expect(result.result.message).toContain("risk: low");
    expect(result.result.message).toContain("risk: write");
  });

  it("/tools <query> searches searchable tools with search_tools matching", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      tools: [
        { name: "read_file", readOnly: true },
        { name: "web_search", readOnly: true },
        { name: "task_create", readOnly: false },
      ],
    });

    const result = await processUserInput("/tools web", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.result.message).toContain('Search results for "web"');
    expect(result.result.message).toContain("- web_search - read-only - risk: low");
    expect(result.result.message).not.toContain("task_create");
  });

  it("/tools explains how to search when no extension tools are loaded", async () => {
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
    expect(result.result.message).toContain("No searchable tools are loaded");
    expect(result.result.message).toContain("Use /tools <query> to search");
  });

  it("/agents lists Claude Code compatible agents", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-agents-"));
    cleanup.push(() => rmSync(workDir, { recursive: true, force: true }));
    mkdirSync(join(workDir, ".claude", "agents"), { recursive: true });
    writeFileSync(
      join(workDir, ".claude", "agents", "reviewer.md"),
      "---\ndescription: 审查代码\n---\n\n# Reviewer\n检查风险。",
    );

    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
    });

    const result = await processUserInput("/agents", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("agents");
    expect(result.result.action).toBe("agents");
    expect(result.result.message).toContain("Available Agents");
    expect(result.result.message).toContain("- Explore [built-in]");
    expect(result.result.message).toContain("- reviewer [project]: 审查代码");
  });

  it("/agent <name> <task> dispatches through delegate_task intent", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-agent-"));
    cleanup.push(() => rmSync(workDir, { recursive: true, force: true }));
    mkdirSync(join(workDir, ".claude", "agents"), { recursive: true });
    const sourcePath = join(workDir, ".claude", "agents", "reviewer.md");
    writeFileSync(
      sourcePath,
      "---\ndescription: 审查代码\ntools: read_file, grep\n---\n\n# Reviewer\n只输出高风险问题。",
    );

    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
    });

    const result = await processUserInput("/agent reviewer 检查 src/input", { registry });

    expect(result.type).toBe("prompt-command");
    if (result.type !== "prompt-command") return;
    expect(result.command).toBe("agent");
    expect(result.result.prompt).toContain("delegate_task");
    expect(result.result.prompt).toContain('"agent_name": "reviewer"');
    expect(result.result.prompt).toContain('"goal": "检查 src/input"');
    expect(result.result.prompt).toContain("只输出高风险问题。");
    expect(result.result.metadata).toEqual({
      agentName: "reviewer",
      sourcePath,
      task: "检查 src/input",
      toolName: "delegate_task",
    });
  });

  it("/agent missing arguments shows usage", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
    });

    const noName = await processUserInput("/agent", { registry });
    const noTask = await processUserInput("/agent reviewer", { registry });

    expect(noName.type).toBe("local-command");
    expect(noTask.type).toBe("local-command");
    if (noName.type !== "local-command" || noTask.type !== "local-command") return;
    expect(noName.result.message).toContain("Usage: /agent <name> <task>");
    expect(noTask.result.message).toContain("Usage: /agent <name> <task>");
  });

  it("/agent suggests the closest existing agent when name is unknown", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-agent-suggest-"));
    cleanup.push(() => rmSync(workDir, { recursive: true, force: true }));
    mkdirSync(join(workDir, ".claude", "agents"), { recursive: true });
    writeFileSync(
      join(workDir, ".claude", "agents", "reviewer.md"),
      "---\ndescription: 审查代码\n---\n\n# Reviewer",
    );
    writeFileSync(
      join(workDir, ".claude", "agents", "writer.md"),
      "---\ndescription: 撰写文档\n---\n\n# Writer",
    );
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
    });

    const result = await processUserInput("/agent reviwer 检查 src", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.result.message).toContain("未找到 Agent: reviwer");
    expect(result.result.message).toContain("Did you mean: reviewer");
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

  it("/sessions lists resumable sessions for the current project", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-sessions-"));
    cleanup.push(() => rmSync(workDir, { recursive: true, force: true }));
    writeSessionLog(workDir, "cli-current", "2026-07-09T03:00:00.000Z", [
      { type: "message", seq: 0, message: { role: "user", content: "hi" } },
      { type: "message", seq: 1, message: { role: "assistant", content: "hello" } },
    ]);
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
      sessionId: "cli-current",
    });

    const result = await processUserInput("/sessions", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("sessions");
    expect(result.result.message).toContain("cli-current");
    expect(result.result.message).toContain("messages=2");
    expect(result.result.message).toContain("current");
    expect(result.result.message).toContain("/resume cli-current");
  });

  it("/resume gives a restart hint instead of hot-switching the running engine", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "cli-active",
    });

    const result = await processUserInput("/resume cli-known", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("resume");
    expect(result.result.message).toContain("cli-known");
    expect(result.result.message).toContain("--resume cli-known");
    expect(result.result.message).toContain("当前会话不会热切换");
  });

  it("/sessions and /resume are discoverable from help and suggestions", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-discovery",
    });
    const resumeCommand = registry.resolve("resume");

    const help = await processUserInput("/help", { registry });
    const resumeHelp = await processUserInput("/help resume", { registry });

    expect(resumeCommand?.argumentHint).toBe("<session-id>");
    expect(help.type).toBe("local-command");
    if (help.type !== "local-command") return;
    expect(help.result.message).toContain("/sessions");
    expect(help.result.message).toContain("/resume");
    expect(resumeHelp.type).toBe("local-command");
    if (resumeHelp.type !== "local-command") return;
    expect(resumeHelp.result.message).toContain(
      `Usage: /resume ${resumeCommand?.argumentHint}`,
    );
    expect(commandSuggestions(registry, "sess").map((item) => item.value)).toContain("sessions");
    expect(commandSuggestions(registry, "res")).toContainEqual(
      expect.objectContaining({
        value: "resume",
        description: resumeCommand?.description,
        argumentHint: resumeCommand?.argumentHint,
      }),
    );
  });

  it("/status exposes session id mode and fork source", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: "/tmp/pico-work",
      provider: "openai",
      model: "glm-5.2",
      sessionId: "session-fork",
      sessionMode: "fork",
      forkFrom: "session-source",
    });

    const result = await processUserInput("/status", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.result.message).toContain("sessionId: session-fork");
    expect(result.result.message).toContain("sessionMode: fork");
    expect(result.result.message).toContain("forkFrom: session-source");
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
    expect(result.result.message).toContain("files=1");
    expect(result.result.message).toContain("summary=1 个文件有备份");
    expect(result.result.message).toContain("/rewind turn-1 both");
  });

  it("/rewind 无参数展示最近快照和 mode 使用说明", async () => {
    const { registry } = await registryWithSnapshot("turn-1");

    const result = await processUserInput("/rewind", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.result.message).toContain("最近快照: turn-1");
    expect(result.result.message).toContain("用法: /rewind <messageId> code|conversation|both");
    expect(result.result.message).toContain("code: 只回滚文件");
  });

  it("/rewind <message-id> 接到既有文件历史回滚", async () => {
    const { registry, filePath } = await registryWithSnapshot("turn-1");

    const result = await processUserInput("/rewind turn-1 code", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.result.message).toContain("已回滚");
    expect(result.result.message).toContain("mode=code");
    expect(result.result.message).toContain("只回滚文件");
    expect(readFileSync(filePath, "utf8")).toBe("before\n");
  });

  it("/rewind 找不到快照时给出可行动提示", async () => {
    const { registry } = await registryWithSnapshot("turn-1");

    const result = await processUserInput("/rewind missing code", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.result.message).toContain("找不到 messageId=missing");
    expect(result.result.message).toContain("请运行 /snapshots 查看可用快照");
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

  it("/compact 在无法安全触发摘要压缩时说明原因", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
    });

    const result = await processUserInput("/compact", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("compact");
    expect(result.result.message).toContain("Compact unavailable");
    expect(result.result.message).toContain("no live session");
  });

  it("/init creates lightweight Pico project entry files without overwriting existing AGENTS.md", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-init-"));
    cleanup.push(() => rmSync(workDir, { recursive: true, force: true }));
    writeFileSync(join(workDir, "AGENTS.md"), "# Existing\n");
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
    });

    const result = await processUserInput("/init", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(readFileSync(join(workDir, "AGENTS.md"), "utf8")).toBe("# Existing\n");
    expect(existsSync(join(workDir, ".pico", "config.json"))).toBe(true);
    expect(result.result.message).toContain("AGENTS.md already exists");
    expect(result.result.message).toContain("Created .pico/config.json");
  });

  it("/doctor reports env provider model cwd and node diagnostics", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "pico-command-doctor-"));
    cleanup.push(() => rmSync(workDir, { recursive: true, force: true }));
    writeFileSync(join(workDir, ".env"), "LLM_BASE_URL=https://llm.example.test\n");
    process.env.LLM_BASE_URL = "https://llm.example.test";
    process.env.LLM_API_KEY = "test-key";
    process.env.LLM_MODEL = "glm-5.2";
    const registry = await createPicoCommandRegistry({
      workDir,
      provider: "openai",
      model: "glm-5.2",
    });

    const result = await processUserInput("/doctor", { registry });

    expect(result.type).toBe("local-command");
    if (result.type !== "local-command") return;
    expect(result.command).toBe("doctor");
    expect(result.result.message).toContain(".env: found");
    expect(result.result.message).toContain("Provider: openai");
    expect(result.result.message).toContain("Model: glm-5.2");
    expect(result.result.message).toContain(`CWD: ${workDir}`);
    expect(result.result.message).toContain("Node:");
  });
});

function writeSessionLog(
  workDir: string,
  sessionId: string,
  timestamp: string,
  records: readonly unknown[],
): void {
  const dir = join(workDir, ".claw", "sessions");
  const path = join(dir, `${sessionId}.jsonl`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path,
    [
      JSON.stringify({ type: "meta", schemaVersion: 1 }),
      ...records.map((record) => JSON.stringify(record)),
    ].join("\n") + "\n",
    "utf8",
  );
  const time = new Date(timestamp);
  utimesSync(path, time, time);
}

import React from "react";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToString } from "ink";
import { describe, expect, it, vi } from "vitest";
import { createBuiltinCommandRegistry } from "../../src/input/builtin-commands.js";
import { CommandRegistry } from "../../src/input/command-registry.js";
import { createPicoCommandRegistry } from "../../src/input/pico-command-registry.js";
import { processUserInput } from "../../src/input/process-user-input.js";
import type { SlashCommand } from "../../src/input/types.js";
import { globalApprovalManager } from "../../src/approval/manager.js";
import { runAgentFromCli } from "../../src/cli/run-agent.js";
import { globalSessionManager } from "../../src/engine/session.js";
import { resetSessionSettingsForTests } from "../../src/input/session-settings.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import type { Message } from "../../src/schema/message.js";
import { LLMStatusError } from "../../src/provider/errors.js";
import { RunningInputQueue } from "../../src/tui/running-input-queue.js";
import type { CliSessionBrowserSummary } from "../../src/tui/session-browser-adapter.js";
import { TuiReporter } from "../../src/tui/tui-reporter.js";
import { WorkspaceRoots } from "../../src/tools/workspace-roots.js";
import { ScheduleDraftCoordinator } from "../../src/tasks/cron-draft-coordinator.js";
import type { CronDraftId } from "../../src/tasks/cron-draft.js";
import { ScheduleDraftReviewHandler } from "../../src/tui/schedule-draft-review.js";
import {
  appendTuiRunError,
  createTuiUpdateScheduler,
  dispatchModelSelectorSelection,
  formatTuiRunError,
  formatTuiRunErrorEntry,
  getTuiCommandAvailabilityState,
  handleTuiInterrupt,
  handleTuiInputSubmission,
  resolveLocalTuiCommandUiEffect,
  runTuiAgentPrompt,
  type TuiInputProcessResult,
  handleTuiRunningInputSubmission,
  coordinateTuiStartupSettings,
  resolveTuiStartupModelRoute,
  resolveTuiStartupSettingDefaults,
  resolveTuiPromptModelRoute,
} from "../../src/tui/repl.js";
import { ModelRouter, type ModelRoute } from "../../src/provider/model-router.js";
import { resolveModelRouteCapabilities } from "../../src/provider/model-capabilities.js";
import { createDefaultSessionSettings } from "../../src/input/session-settings.js";

class ScriptedTuiProvider implements LLMProvider {
  constructor(private readonly responses: Message[]) {}

  generate(): Promise<Message> {
    const response = this.responses.shift();
    if (!response) throw new Error("No scripted TUI response left.");
    return Promise.resolve(response);
  }
}

function tuiRunResult(finalMessage: string) {
  return {
    sessionId: "tui-session",
    sessionSelection: { mode: "new" as const, sessionId: "tui-session" },
    workDir: process.cwd(),
    finalMessage,
    usage: { promptTokens: 0, completionTokens: 0, costCNY: 0 },
    messages: [],
  };
}

function testRoute(id: string): ModelRoute {
  const [providerId, ...modelParts] = id.split("/");
  const model = modelParts.join("/");
  return {
    id,
    providerId: providerId!,
    provider: "openai",
    model,
    baseURL: "https://example.invalid/v1",
    apiKeyEnv: "TEST_API_KEY",
    source: "config",
    capabilities: resolveModelRouteCapabilities("openai", model),
  };
}

describe("TUI input routing", () => {
  function harness() {
    const snapshots: unknown[][] = [];
    const reporter = new TuiReporter((entries) => snapshots.push(entries));
    const runAgent = vi.fn(async () => undefined);
    const exit = vi.fn();
    const registry = createBuiltinCommandRegistry();
    const workDir = process.cwd();
    return { reporter, snapshots, runAgent, exit, registry, workDir };
  }

  it("启动时显式 CLI 模型覆盖 session 和项目默认，未显式时仍恢复 session", () => {
    const routes = [
      testRoute("project/default-model"),
      testRoute("session/restored-model"),
      testRoute("cli/override-model"),
    ];
    const router = new ModelRouter(routes, { TEST_API_KEY: "test-key" }, routes[0]!.id);
    const restored = {
      model: routes[1]!.model,
      modelRouteId: routes[1]!.id,
    };

    expect(
      resolveTuiStartupModelRoute(router, restored, {
        cliModel: routes[2]!.id,
        modelExplicit: true,
        projectDefaultRouteId: routes[0]!.id,
      }).id,
    ).toBe(routes[2]!.id);
    expect(
      resolveTuiStartupModelRoute(router, restored, {
        cliModel: routes[0]!.model,
        modelExplicit: false,
        projectDefaultRouteId: routes[0]!.id,
      }).id,
    ).toBe(routes[1]!.id);
  });

  it("启动时显式 thinking 覆盖恢复值，未显式时保留恢复值", () => {
    const route = testRoute("test/deepseek-v4-pro-260425");
    const router = new ModelRouter([route], { TEST_API_KEY: "test-key" }, route.id);
    const explicit = createDefaultSessionSettings({
      sessionId: "explicit-thinking",
      cwd: "/workspace/explicit",
      provider: route.provider,
      model: route.model,
      modelRouteId: route.id,
      thinkingEffort: "high",
    });
    const restored = createDefaultSessionSettings({
      sessionId: "restored-thinking",
      cwd: "/workspace/restored",
      provider: route.provider,
      model: route.model,
      modelRouteId: route.id,
      thinkingEffort: "high",
    });

    expect(coordinateTuiStartupSettings(explicit, router, route, "off")).toBe("off");
    expect(explicit).toMatchObject({ thinkingEffort: "off", thinkingEffortExplicit: true });
    expect(coordinateTuiStartupSettings(restored, router, route)).toBe("high");
    expect(restored).toMatchObject({ thinkingEffort: "high", thinkingEffortExplicit: true });
  });

  it("新 TUI Session 应用 effective mode/thinking，显式 CLI thinking 优先", () => {
    expect(resolveTuiStartupSettingDefaults({ mode: "plan", thinkingEffort: "high" })).toEqual({
      mode: "plan",
      thinkingEffort: "high",
    });
    expect(
      resolveTuiStartupSettingDefaults({ mode: "plan", thinkingEffort: "high" }, "off"),
    ).toEqual({ mode: "plan", thinkingEffort: "off" });
  });

  it("Markdown command 模型只覆盖本轮，未知路由失败且不改写 Session", () => {
    const current = testRoute("project/current-model");
    const command = testRoute("review/command-model");
    const sonnet = testRoute("anthropic/claude-sonnet-4-5");
    const router = new ModelRouter(
      [current, command, sonnet],
      { TEST_API_KEY: "test-key" },
      current.id,
    );
    const settings = createDefaultSessionSettings({
      sessionId: "command-model",
      cwd: "/workspace/command-model",
      provider: current.provider,
      model: current.model,
      modelRouteId: current.id,
    });
    const before = { model: settings.model, modelRouteId: settings.modelRouteId };

    expect(resolveTuiPromptModelRoute(router, settings, command.id).route.id).toBe(command.id);
    expect(resolveTuiPromptModelRoute(router, settings, "inherit").route.id).toBe(current.id);
    expect(
      resolveTuiPromptModelRoute(router, settings, "sonnet", {
        enabled: true,
        modelAliases: {},
      }).route.id,
    ).toBe(sonnet.id);
    expect(
      resolveTuiPromptModelRoute(router, settings, "review-alias", {
        enabled: true,
        modelAliases: { "review-alias": command.id },
      }).route.id,
    ).toBe(command.id);
    expect(() => resolveTuiPromptModelRoute(router, settings, "claude-alias")).toThrow(
      "不在当前可用路由中",
    );
    expect(settings).toMatchObject(before);
  });

  it("AbortError 不生成普通执行失败内容", () => {
    expect(formatTuiRunErrorEntry(new DOMException("interrupted", "AbortError"))).toBeUndefined();
    expect(formatTuiRunErrorEntry(new Error("boom"))).toEqual({
      kind: "error",
      message: "boom",
      retryable: false,
    });
    expect(formatTuiRunErrorEntry(new LLMStatusError(503, "unavailable"))).toMatchObject({
      kind: "error",
      retryable: true,
      action: "retry",
    });
    expect(formatTuiRunError(new Error("boom"))).toBe("⚠️ 执行出错: boom");
  });

  it("运行异常通过 reporter.pushError 进入节流快照,不会被 pending update 覆盖", async () => {
    vi.useFakeTimers();
    const snapshots: unknown[][] = [];
    const scheduler = createTuiUpdateScheduler((entries) => snapshots.push([...entries]), 100);
    const reporter = new TuiReporter(scheduler);

    reporter.pushUserMessage("run");
    reporter.onTextDelta("pending");
    appendTuiRunError(reporter, new Error("boom"));
    await vi.advanceTimersByTimeAsync(100);

    expect(snapshots.at(-1)).toEqual([
      { kind: "user", content: "run" },
      { kind: "assistant", content: "pending" },
      { kind: "error", message: "boom", retryable: false },
    ]);
    vi.useRealTimers();
  });

  it("/model local UI action opens the model selector dialog", async () => {
    const { reporter, runAgent, exit, registry, workDir } = harness();
    const openDialog = vi.fn();
    const processInput = vi.fn(
      async (): Promise<TuiInputProcessResult> => ({
        type: "local-command",
        raw: "/model",
        command: "model",
        args: "",
        argv: [],
        result: {
          type: "local",
          action: "model",
          ui: { kind: "open-selector", selector: "model" },
          message: "Select a model.",
        },
      }),
    );

    await handleTuiInputSubmission("/model", {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
      processInput,
      openDialog,
      currentModelId: "glm-5.2",
    });

    expect(openDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "local-ui:model-selector",
        layer: "modal",
        priority: 40,
      }),
    );
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("model selector selection dispatches the existing /model command path", () => {
    const onSubmit = vi.fn();

    dispatchModelSelectorSelection("kimi-k2.5", onSubmit);

    expect(onSubmit).toHaveBeenCalledWith("/model kimi-k2.5");
  });

  it("App/TUI 配置变更后 /model 在空闲边界刷新路由目录", async () => {
    const initial = testRoute("shared/model-a");
    const added = testRoute("shared/model-b");
    const initialRouter = new ModelRouter([initial], { TEST_API_KEY: "test-key" }, initial.id);
    const refreshedRouter = new ModelRouter(
      [initial, added],
      { TEST_API_KEY: "test-key" },
      initial.id,
    );
    const refresh = vi.fn(async () => refreshedRouter);
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: initial.model,
      modelRouteId: initial.id,
      modelRouter: initialRouter,
      modelRouterProvider: refresh,
      sessionId: "tui-live-model-catalog",
    });

    const opened = await processUserInput("/model", { registry });
    expect(opened.type).toBe("local-command");
    if (opened.type !== "local-command") return;
    expect(refresh).toHaveBeenCalledOnce();
    expect(
      resolveLocalTuiCommandUiEffect(opened.result, {
        models: [{ id: initial.id, name: initial.model }],
      }),
    ).toMatchObject({
      kind: "dialog",
      models: [
        { id: initial.id, name: initial.model },
        { id: added.id, name: added.model },
      ],
    });

    const selected = await processUserInput(`/model ${added.id}`, { registry });
    expect(selected).toMatchObject({
      type: "local-command",
      result: { data: { ok: true, modelRouteId: added.id } },
    });
  });

  it("/model with an explicit argument does not open the selector", () => {
    expect(
      resolveLocalTuiCommandUiEffect(
        {
          type: "local",
          action: "model",
          message: "Model change requested: kimi-k2.5",
          data: { model: "kimi-k2.5" },
        },
        { currentModelId: "glm-5.2" },
      ),
    ).toEqual({ kind: "none" });
  });

  it("本地 display 命令只追加系统消息,不调用模型", async () => {
    const { reporter, snapshots, runAgent, exit, registry, workDir } = harness();

    await handleTuiInputSubmission("/help", {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
    });

    expect(runAgent).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(snapshots.at(-1)).toEqual([
      {
        kind: "system",
        content: expect.stringContaining("/clear"),
      },
    ]);
  });

  it("/help opens the real HelpPanel dialog with command descriptor metadata", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "tui-help-panel",
    });
    const { reporter, runAgent, exit, workDir } = harness();
    const openDialog = vi.fn();

    await handleTuiInputSubmission("/help", {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
      openDialog,
    });

    expect(runAgent).not.toHaveBeenCalled();
    expect(openDialog).toHaveBeenCalledOnce();
    const request = openDialog.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      id: "local-ui:help",
      layer: "overlay",
    });
    const output = renderToString(request.content);
    expect(output).toContain("Slash commands");
    expect(output).toContain("builtin / help");
    expect(output).toContain("/help [command]");
    expect(output).toContain("builtin / permissions");
    expect(output).toContain("/permissions [default|auto|yolo|plan]");
  });

  it("/help annotates HelpPanel commands from the real running TUI state", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "tui-running-help-panel",
    });
    const { reporter, runAgent, exit, workDir } = harness();
    const openDialog = vi.fn();

    await handleTuiRunningInputSubmission("/help", {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
      openDialog,
      guard: {
        getSnapshot: () => "running",
        tryStart: () => null,
        end: () => true,
      },
      queue: new RunningInputQueue(),
    });

    const request = openDialog.mock.calls[0]?.[0];
    const output = renderToString(request.content);
    const commands = request.content.props.commands as Array<{
      name: string;
      disabled?: boolean;
      disabledReason?: string;
    }>;
    expect(output).toContain("/compact [disabled]");
    expect(output).toContain("Command is only available while idle.");
    expect(commands).toContainEqual(
      expect.objectContaining({
        name: "model",
        disabled: true,
        disabledReason: "Command is only available while idle.",
      }),
    );
    expect(commands).toContainEqual(expect.objectContaining({ name: "goal", disabled: false }));
    expect(commands).toContainEqual(expect.objectContaining({ name: "mcp", disabled: false }));
  });

  it("running command availability comes from descriptors", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "tui-running-availability",
    });

    expect(
      registry.detailedSuggestions("model", {
        availabilityState: getTuiCommandAvailabilityState("running"),
      }),
    ).toContainEqual(
      expect.objectContaining({
        name: "model",
        disabled: true,
        disabledReason: "Command is only available while idle.",
      }),
    );
    expect(
      registry.detailedSuggestions("mcp", {
        availabilityState: getTuiCommandAvailabilityState("running"),
      })[0],
    ).toEqual(expect.objectContaining({ name: "mcp" }));
    expect(
      registry.detailedSuggestions("mcp", {
        availabilityState: getTuiCommandAvailabilityState("running"),
      })[0],
    ).not.toHaveProperty("disabled");
  });

  it("running local execution follows descriptor availability instead of command names", async () => {
    const alwaysExecute = vi.fn<SlashCommand["execute"]>(() => ({
      type: "local",
      action: "message",
      message: "always local ran",
    }));
    const panelExecute = vi.fn<SlashCommand["execute"]>(() => ({
      type: "local",
      action: "message",
      message: "running panel ran",
    }));
    const statusExecute = vi.fn<SlashCommand["execute"]>(() => ({
      type: "local",
      action: "message",
      message: "idle status ran",
    }));
    const registry = new CommandRegistry([
      {
        name: "always-local",
        description: "Always local",
        kind: "local",
        execute: alwaysExecute,
      },
      {
        name: "panel",
        description: "Running panel",
        kind: "local-jsx",
        availability: "running",
        execute: panelExecute,
      },
      {
        name: "status",
        description: "Idle status override",
        kind: "local",
        availability: "idle",
        execute: statusExecute,
      },
    ]);
    const { reporter, snapshots, runAgent, exit, workDir } = harness();
    const runningDeps = {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
      guard: {
        getSnapshot: () => "running" as const,
        tryStart: () => null,
        end: () => true,
      },
      queue: new RunningInputQueue(),
    };

    await handleTuiRunningInputSubmission("/always-local", runningDeps);
    await handleTuiRunningInputSubmission("/panel", runningDeps);
    await handleTuiRunningInputSubmission("/status", runningDeps);

    expect(alwaysExecute).toHaveBeenCalledTimes(1);
    expect(panelExecute).toHaveBeenCalledTimes(1);
    expect(statusExecute).not.toHaveBeenCalled();
    expect(registry.detailedSuggestions("status", { availabilityState: "running" })).toContainEqual(
      expect.objectContaining({
        name: "status",
        disabled: true,
        disabledReason: "Command is only available while idle.",
      }),
    );
    expect(snapshots.at(-1)).toContainEqual({
      kind: "system",
      content: "Cannot run /status: Command is only available while idle.",
    });
  });

  it("idle execution blocks commands whose descriptor is running-only", async () => {
    const runningLocal = vi.fn<SlashCommand["execute"]>(() => ({
      type: "local",
      action: "message",
      message: "running local ran",
    }));
    const runningPrompt = vi.fn<SlashCommand["execute"]>(() => ({
      type: "prompt",
      prompt: "running prompt ran",
    }));
    const registry = new CommandRegistry([
      {
        name: "running-local",
        description: "Running local",
        kind: "local",
        availability: "running",
        execute: runningLocal,
      },
      {
        name: "running-prompt",
        description: "Running prompt",
        kind: "prompt",
        availability: "running",
        execute: runningPrompt,
      },
    ]);
    const { reporter, snapshots, runAgent, exit, workDir } = harness();

    await handleTuiInputSubmission("/running-local", {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
      commandAvailabilityState: "idle",
    });
    await handleTuiInputSubmission("/running-prompt", {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
      commandAvailabilityState: "idle",
    });

    expect(runningLocal).not.toHaveBeenCalled();
    expect(runningPrompt).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
    expect(
      registry.detailedSuggestions("running-local", { availabilityState: "idle" }),
    ).toContainEqual(
      expect.objectContaining({
        name: "running-local",
        disabled: true,
        disabledReason: "Command is only available while running.",
      }),
    );
    expect(snapshots.at(-1)).toContainEqual({
      kind: "system",
      content: "Cannot run /running-prompt: Command is only available while running.",
    });
  });

  it("running execution allows prompt commands marked running and blocks idle prompt commands", async () => {
    const runningPrompt = vi.fn<SlashCommand["execute"]>(() => ({
      type: "prompt",
      prompt: "summarize current output",
    }));
    const idlePrompt = vi.fn<SlashCommand["execute"]>(() => ({
      type: "prompt",
      prompt: "idle only prompt",
    }));
    const registry = new CommandRegistry([
      {
        name: "while-running",
        description: "Running prompt",
        kind: "prompt",
        availability: "running",
        execute: runningPrompt,
      },
      {
        name: "idle-review",
        description: "Idle prompt",
        kind: "prompt",
        availability: "idle",
        execute: idlePrompt,
      },
    ]);
    const { reporter, snapshots, runAgent, exit, workDir } = harness();
    const deps = {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
      guard: {
        getSnapshot: () => "running" as const,
        tryStart: () => 1,
        end: () => true,
      },
      queue: new RunningInputQueue(),
    };

    await handleTuiRunningInputSubmission("/while-running", deps);
    await handleTuiRunningInputSubmission("/idle-review", deps);

    expect(runningPrompt).toHaveBeenCalledTimes(1);
    expect(idlePrompt).not.toHaveBeenCalled();
    expect(runAgent).toHaveBeenCalledWith("summarize current output");
    expect(
      registry.detailedSuggestions("idle-review", { availabilityState: "running" }),
    ).toContainEqual(
      expect.objectContaining({
        name: "idle-review",
        disabled: true,
        disabledReason: "Command is only available while idle.",
      }),
    );
    expect(snapshots.at(-1)).toContainEqual({
      kind: "system",
      content: "Cannot run /idle-review: Command is only available while idle.",
    });
  });

  it("/mcp can run locally while an agent response is running", async () => {
    const registry = await createPicoCommandRegistry({
      workDir: process.cwd(),
      provider: "openai",
      model: "glm-5.2",
      sessionId: "tui-running-mcp",
    });
    const { reporter, snapshots, runAgent, exit, workDir } = harness();
    const processInput = vi.fn(
      async (): Promise<TuiInputProcessResult> => ({
        type: "local-command",
        raw: "/mcp",
        command: "mcp",
        args: "",
        argv: [],
        result: {
          type: "local",
          action: "mcp",
          message: "MCP status\nNo MCP config loaded.",
        },
      }),
    );

    await handleTuiRunningInputSubmission("/mcp", {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
      processInput,
      guard: {
        getSnapshot: () => "running",
        tryStart: () => null,
        end: () => true,
      },
      queue: new RunningInputQueue(),
    });

    expect(processInput).toHaveBeenCalledWith("/mcp");
    expect(runAgent).not.toHaveBeenCalled();
    expect(snapshots.at(-1)).toEqual([
      {
        kind: "system",
        content: "MCP status\nNo MCP config loaded.",
      },
    ]);
  });

  it("/clear 清空当前 TUI entries", async () => {
    const { reporter, snapshots, runAgent, exit, registry, workDir } = harness();
    reporter.pushUserMessage("old");

    await handleTuiInputSubmission("/clear", {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
    });

    expect(runAgent).not.toHaveBeenCalled();
    expect(snapshots.at(-1)).toEqual([]);
  });

  it("/exit 退出 TUI 且不调用模型", async () => {
    const { reporter, runAgent, exit, registry, workDir } = harness();

    await handleTuiInputSubmission("/exit", {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
    });

    expect(exit).toHaveBeenCalledTimes(1);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("prompt command 发送展开后的 prompt 给 runAgentFromCli", async () => {
    const { reporter, snapshots, runAgent, exit, registry, workDir } = harness();
    const processInput = vi.fn(
      async (): Promise<TuiInputProcessResult> => ({
        type: "prompt-command",
        raw: "/review",
        command: "review",
        args: "",
        argv: [],
        result: {
          type: "prompt",
          prompt: "Review the current changes.",
        },
      }),
    );

    await handleTuiInputSubmission("/review", {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
      processInput,
    });

    expect(runAgent).toHaveBeenCalledWith("Review the current changes.");
    expect(snapshots.at(0)).toEqual([{ kind: "user", content: "/review" }]);
  });

  it("prompt command 将单轮模型与工具约束传给 runtime", async () => {
    const { reporter, runAgent, exit, registry, workDir } = harness();
    const processInput = vi.fn(
      async (): Promise<TuiInputProcessResult> => ({
        type: "prompt-command",
        raw: "/review",
        command: "review",
        args: "",
        argv: [],
        result: {
          type: "prompt",
          prompt: "Review safely.",
          execution: { model: "review/model", allowedTools: ["read_file"] },
        },
      }),
    );

    await handleTuiInputSubmission("/review", {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
      processInput,
    });

    expect(runAgent).toHaveBeenCalledWith("Review safely.", {
      model: "review/model",
      allowedTools: ["read_file"],
    });
  });

  it("Skill hooks 只在当前 prompt command 运行期激活", async () => {
    const { reporter, exit, registry, workDir } = harness();
    const events: string[] = [];
    const metadata = {
      skillName: "guard",
      skillArgs: "",
      skillTrigger: "user-slash" as const,
      skillSourcePath: "/workspace/.claw/skills/guard/SKILL.md",
      skillHookConfig: { PreToolUse: [] },
    };

    await handleTuiInputSubmission("/guard", {
      reporter,
      registry,
      workDir,
      exit,
      processInput: async () => ({
        type: "prompt-command",
        raw: "/guard",
        command: "guard",
        args: "",
        argv: [],
        result: { type: "prompt", prompt: "Guard", metadata },
      }),
      activateAgentHooks: async (received) => {
        expect(received).toBe(metadata);
        events.push("activate");
      },
      runAgent: async () => {
        events.push("run");
      },
      clearComponentHooks: async () => {
        events.push("clear");
      },
    });

    expect(events).toEqual(["activate", "run", "clear"]);
  });

  it("显式 Skill 在运行 Agent 前写入结构化 transcript 条目", async () => {
    const { reporter, snapshots, runAgent, exit, registry, workDir } = harness();
    const processInput = vi.fn(
      async (): Promise<TuiInputProcessResult> => ({
        type: "prompt-command",
        raw: "/review src/a.ts",
        command: "review",
        args: "src/a.ts",
        argv: ["src/a.ts"],
        result: {
          type: "prompt",
          prompt: "wrapped skill prompt",
          metadata: {
            skillName: "review",
            skillArgs: "src/a.ts",
            skillTrigger: "user-slash",
          },
        },
      }),
    );

    await handleTuiInputSubmission("/review src/a.ts", {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
      processInput,
    });

    expect(runAgent).toHaveBeenCalledWith("wrapped skill prompt");
    expect(snapshots.at(-1)).toEqual([
      { kind: "user", content: "/review src/a.ts" },
      { kind: "skill", name: "review", args: "src/a.ts", trigger: "user-slash" },
    ]);
  });

  it("runTuiAgentPrompt routes approval notices into TUI dialog and approval tool status", async () => {
    const { reporter, snapshots } = harness();
    const openDialog = vi.fn();
    const runAgent = vi.fn(async (_options, deps) => {
      reporter.onToolCall("write_file", JSON.stringify({ path: "AIHOT.md", content: "# daily" }));
      deps.approvalNotifier?.({
        taskId: "call_1",
        toolName: "write_file",
        args: JSON.stringify({ path: "AIHOT.md", content: "# daily" }),
        message: "approval",
      });
      return {
        sessionId: "tui-session",
        sessionSelection: { mode: "new" as const, sessionId: "tui-session" },
        workDir: process.cwd(),
        finalMessage: "",
        usage: { promptTokens: 0, completionTokens: 0, costCNY: 0 },
        messages: [],
      };
    });

    await runTuiAgentPrompt(
      {
        prompt: "write",
        dir: process.cwd(),
        session: "tui-session",
      },
      {
        reporter,
        runAgent,
        openDialog,
      },
    );

    expect(openDialog).toHaveBeenCalledWith(
      expect.objectContaining({ id: "approval:pending:call_1", layer: "modal" }),
    );
    expect(snapshots.at(-1)).toEqual([
      expect.objectContaining({ kind: "tool", name: "write_file", status: "approval" }),
    ]);
  });

  it("runTuiAgentPrompt 将定时草案绑定到 TUI dialog，确认后再提交", async () => {
    const { reporter } = harness();
    const openDialog = vi.fn();
    const closeDialog = vi.fn();
    const commit = vi.fn(async () => ({
      cronJobId: "cron-confirmed",
      enabled: true,
      schedule: "0 9 * * *",
      timeZone: "Asia/Shanghai",
      daemonMessage: "daemon ready",
    }));
    const handler = new ScheduleDraftReviewHandler();
    const coordinator = new ScheduleDraftCoordinator({
      reviewer: handler,
      resolveContext: async () => ({
        workspacePath: process.cwd(),
        modelRouteId: "test/model",
        allowedTools: ["fetch_url"],
        credentialStatus: "available",
        daemonStatus: "daemon ready",
      }),
      commit,
      generateDraftId: () => "draft-tui-confirm" as CronDraftId,
    });
    const runAgent = vi.fn(async (_options, deps) => {
      const outcome = await deps.scheduleDraftCoordinator!.propose(
        {
          title: "日报",
          prompt: "生成日报",
          scheduleText: "每天上午九点",
          cronExpression: "0 9 * * *",
          timeZone: "Asia/Shanghai",
        },
        { signal: deps.signal },
      );
      expect(outcome.kind).toBe("created");
      return tuiRunResult("created");
    });

    const running = runTuiAgentPrompt(
      { prompt: "创建每日日报", dir: process.cwd(), session: "tui-schedule-confirm" },
      {
        reporter,
        runAgent,
        openDialog,
        closeDialog,
        scheduleDraft: { handler, coordinator },
      },
    );
    await vi.waitFor(() => expect(openDialog).toHaveBeenCalledOnce());
    const request = openDialog.mock.calls[0]?.[0];
    expect(request.id).toBe("schedule-draft:pending:draft-tui-confirm");
    const props = request.content.props as { onDecision: (kind: "confirm") => void };
    props.onDecision("confirm");
    await running;

    expect(commit).toHaveBeenCalledOnce();
    expect(closeDialog).toHaveBeenCalledWith(request.id);
    expect(handler.pendingCount).toBe(0);
  });

  it("中断运行会关闭未决的定时草案 dialog 且不提交", async () => {
    const { reporter } = harness();
    const openDialog = vi.fn();
    const closeDialog = vi.fn();
    const commit = vi.fn();
    const abortControllerRef = { current: null as AbortController | null };
    const handler = new ScheduleDraftReviewHandler();
    const coordinator = new ScheduleDraftCoordinator({
      reviewer: handler,
      resolveContext: async () => ({
        workspacePath: process.cwd(),
        modelRouteId: "test/model",
        allowedTools: [],
        credentialStatus: "available",
        daemonStatus: "daemon ready",
      }),
      commit,
      generateDraftId: () => "draft-tui-abort" as CronDraftId,
    });
    const runAgent = vi.fn(async (_options, deps) => {
      const outcome = await deps.scheduleDraftCoordinator!.propose(
        {
          title: "日报",
          prompt: "生成日报",
          scheduleText: "每天上午九点",
          cronExpression: "0 9 * * *",
        },
        { signal: deps.signal },
      );
      expect(outcome.kind).toBe("cancelled");
      return tuiRunResult("cancelled");
    });

    const running = runTuiAgentPrompt(
      { prompt: "创建每日日报", dir: process.cwd(), session: "tui-schedule-abort" },
      {
        reporter,
        runAgent,
        openDialog,
        closeDialog,
        abortControllerRef,
        scheduleDraft: { handler, coordinator },
      },
    );
    await vi.waitFor(() => expect(openDialog).toHaveBeenCalledOnce());
    abortControllerRef.current?.abort(new DOMException("interrupted", "AbortError"));
    await running;

    expect(commit).not.toHaveBeenCalled();
    expect(closeDialog).toHaveBeenCalledWith("schedule-draft:pending:draft-tui-abort");
    expect(handler.pendingCount).toBe(0);
  });

  it("组合校验 yolo 外部写与 default TUI Enter 审批闭环", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-tui-workspace-root-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "pico-tui-workspace-added-"));
    const target = join(outsideDir, "approved.txt");
    const blockedTarget = join(outsideDir, "blocked.txt");
    const { reporter } = harness();

    try {
      const blockedOpenDialog = vi.fn();
      const blockedProvider = new ScriptedTuiProvider([
        {
          role: "assistant",
          content: "try blocked write",
          toolCalls: [
            {
              id: "blocked-write",
              name: "write_file",
              arguments: JSON.stringify({ path: blockedTarget, content: "blocked" }),
            },
          ],
          usage: { promptTokens: 1, completionTokens: 1 },
        },
        {
          role: "assistant",
          content: "blocked as expected",
          usage: { promptTokens: 1, completionTokens: 1 },
        },
      ]);

      await runTuiAgentPrompt(
        { prompt: "write outside", dir: workDir, session: "tui-workspace-blocked" },
        {
          reporter,
          openDialog: blockedOpenDialog,
          runAgent: (options, dependencies) =>
            runAgentFromCli(options, { ...dependencies, provider: blockedProvider }),
        },
      );

      expect(blockedOpenDialog).not.toHaveBeenCalled();
      await expect(readFile(blockedTarget, "utf8")).resolves.toBe("blocked");

      const allowedOpenDialog = vi.fn();
      const closeDialog = vi.fn();
      const canonicalWorkDir = await realpath(workDir);
      const workspaceRoots = await WorkspaceRoots.create(canonicalWorkDir);
      const commandRegistry = await createPicoCommandRegistry({
        workDir: canonicalWorkDir,
        provider: "openai",
        model: "glm-5.2",
        sessionId: "tui-workspace-allowed",
        additionalDirectoryManager: workspaceRoots,
      });
      const localRunAgent = vi.fn();
      await handleTuiInputSubmission("/mode default", {
        reporter,
        registry: commandRegistry,
        workDir: canonicalWorkDir,
        runAgent: localRunAgent,
        exit: vi.fn(),
      });
      await handleTuiInputSubmission(`/add-dir ${outsideDir}`, {
        reporter,
        registry: commandRegistry,
        workDir: canonicalWorkDir,
        runAgent: localRunAgent,
        exit: vi.fn(),
      });
      expect(localRunAgent).not.toHaveBeenCalled();
      expect(workspaceRoots.list()).toContain(await realpath(outsideDir));
      const allowedProvider = new ScriptedTuiProvider([
        {
          role: "assistant",
          content: "write authorized file",
          toolCalls: [
            {
              id: "allowed-write",
              name: "write_file",
              arguments: JSON.stringify({ path: target, content: "approved by Enter" }),
            },
          ],
          usage: { promptTokens: 1, completionTokens: 1 },
        },
        {
          role: "assistant",
          content: "authorized write complete",
          usage: { promptTokens: 1, completionTokens: 1 },
        },
      ]);
      const allowedRun = runTuiAgentPrompt(
        {
          prompt: "write added directory",
          dir: canonicalWorkDir,
          session: "tui-workspace-allowed",
        },
        {
          reporter,
          openDialog: allowedOpenDialog,
          closeDialog,
          runAgent: (options, dependencies) =>
            runAgentFromCli(options, { ...dependencies, provider: allowedProvider }),
        },
      );
      await vi.waitFor(() => expect(allowedOpenDialog).toHaveBeenCalledOnce());
      const request = allowedOpenDialog.mock.calls[0]?.[0];
      expect(request.id).toMatch(/^approval:pending:/u);
      const props = request.content.props as { onAction: (action: "approve") => boolean };

      // InteractiveApprovalPanel 已单独验证 Enter -> approve；这里验证该动作贯穿真实工具链。
      props.onAction("approve");
      await allowedRun;

      await expect(readFile(target, "utf8")).resolves.toBe("approved by Enter");
      expect(closeDialog).toHaveBeenCalledWith(request.id);
    } finally {
      globalApprovalManager.clear();
      globalSessionManager.clear();
      resetSessionSettingsForTests();
      await Promise.all([
        rm(workDir, { recursive: true, force: true }),
        rm(outsideDir, { recursive: true, force: true }),
      ]);
    }
  });

  it("并发审批使用独立 dialog，解决其中一个不会关闭另一个", async () => {
    const { reporter } = harness();
    const openDialog = vi.fn();
    const closeDialog = vi.fn();
    const runAgent = vi.fn(async (_options, deps) => {
      const first = globalApprovalManager.waitForApproval(
        "parallel-1",
        "write_file",
        JSON.stringify({ path: "one.txt", content: "one" }),
        deps.approvalNotifier!,
      );
      const second = globalApprovalManager.waitForApproval(
        "parallel-2",
        "write_file",
        JSON.stringify({ path: "two.txt", content: "two" }),
        deps.approvalNotifier!,
      );
      await Promise.all([first, second]);
      return {
        sessionId: "tui-session",
        sessionSelection: { mode: "new" as const, sessionId: "tui-session" },
        workDir: process.cwd(),
        finalMessage: "approved",
        usage: { promptTokens: 0, completionTokens: 0, costCNY: 0 },
        messages: [],
      };
    });

    const prompt = runTuiAgentPrompt(
      { prompt: "write twice", dir: process.cwd(), session: "tui-session" },
      { reporter, runAgent, openDialog, closeDialog },
    );
    await vi.waitFor(() => expect(openDialog).toHaveBeenCalledTimes(2));

    const firstRequest = openDialog.mock.calls[0]?.[0];
    const secondRequest = openDialog.mock.calls[1]?.[0];
    expect([firstRequest.id, secondRequest.id]).toEqual([
      "approval:pending:parallel-1",
      "approval:pending:parallel-2",
    ]);

    const firstProps = firstRequest.content.props as { onAction: (action: "approve") => boolean };
    firstProps.onAction("approve");
    expect(closeDialog).toHaveBeenCalledWith("approval:pending:parallel-1");
    expect(closeDialog).not.toHaveBeenCalledWith("approval:pending:parallel-2");
    expect(globalApprovalManager.pendingCount).toBe(1);

    const secondProps = secondRequest.content.props as { onAction: (action: "approve") => boolean };
    secondProps.onAction("approve");
    await prompt;
    expect(closeDialog).toHaveBeenCalledWith("approval:pending:parallel-2");
    expect(globalApprovalManager.pendingCount).toBe(0);
  });

  it("approve-session records approval under the current TUI session id", async () => {
    const { reporter } = harness();
    const openDialog = vi.fn();
    const args = JSON.stringify({ path: "session-key.txt", content: "remember me" });
    let permissionResult: Awaited<ReturnType<typeof globalApprovalManager.waitForApproval>>;
    const runAgent = vi.fn(async (_options, deps) => {
      const approval = globalApprovalManager.waitForApproval(
        "approval_session_key",
        "write_file",
        args,
        deps.approvalNotifier!,
        undefined,
        undefined,
        { sessionScope: { type: "all-edits" } },
      );
      permissionResult = await approval;
      return {
        sessionId: "tui-session-key",
        sessionSelection: { mode: "new" as const, sessionId: "tui-session-key" },
        workDir: process.cwd(),
        finalMessage: "approved",
        usage: { promptTokens: 0, completionTokens: 0, costCNY: 0 },
        messages: [],
      };
    });

    const promptPromise = runTuiAgentPrompt(
      {
        prompt: "write",
        dir: process.cwd(),
        session: "tui-session-key",
        sessionSelection: { mode: "new", sessionId: "tui-session-key" },
      },
      {
        reporter,
        runAgent,
        openDialog,
      },
    );
    await vi.waitFor(() => expect(openDialog).toHaveBeenCalled());
    const request = openDialog.mock.calls[0]?.[0];
    const props = request.content.props as { onAction: (action: "approve-session") => boolean };

    props.onAction("approve-session");
    await promptPromise;
    expect(permissionResult!).toMatchObject({ allowed: true, allowForSession: true });
  });

  it("runTuiAgentPrompt 为每轮创建 controller、传递 signal 并在结束后清理", async () => {
    const { reporter } = harness();
    const abortControllerRef: { current: AbortController | null } = { current: null };
    let signalDuringRun: AbortSignal | undefined;
    let controllerDuringRun: AbortController | null = null;
    const runAgent = vi.fn(async (_options, deps) => {
      signalDuringRun = deps.signal;
      controllerDuringRun = abortControllerRef.current;
      return {
        sessionId: "tui-session",
        sessionSelection: { mode: "new" as const, sessionId: "tui-session" },
        workDir: process.cwd(),
        finalMessage: "done",
        usage: { promptTokens: 1, completionTokens: 1, costCNY: 0 },
        messages: [],
      };
    });

    await runTuiAgentPrompt(
      { prompt: "run", dir: process.cwd(), session: "tui-session" },
      { reporter, runAgent, abortControllerRef },
    );

    expect(controllerDuringRun).toBeInstanceOf(AbortController);
    expect(signalDuringRun).toBe(controllerDuringRun?.signal);
    expect(abortControllerRef.current).toBeNull();
  });

  it("TUI interrupt 调用当前 controller.abort 并清理排队输入", async () => {
    const { reporter, snapshots } = harness();
    const replModule =
      (await import("../../src/tui/repl.js")) as typeof import("../../src/tui/repl.js") & {
        handleTuiInterrupt?: (
          controller: AbortController | null,
          queue: RunningInputQueue,
          reporter: TuiReporter,
          onQueueSizeChange?: (size: number) => void,
        ) => void;
      };
    expect(replModule.handleTuiInterrupt).toBeTypeOf("function");
    if (!replModule.handleTuiInterrupt) return;

    const controller = new AbortController();
    const abort = vi.spyOn(controller, "abort");
    const queue = new RunningInputQueue();
    const onQueueSizeChange = vi.fn();
    queue.enqueue("queued prompt");

    replModule.handleTuiInterrupt(controller, queue, reporter, onQueueSizeChange);

    expect(abort).toHaveBeenCalledOnce();
    expect(abort.mock.calls[0]?.[0]).toMatchObject({ name: "AbortError" });
    expect(controller.signal.aborted).toBe(true);
    expect(queue.size).toBe(0);
    expect(onQueueSizeChange).toHaveBeenCalledWith(0);
    expect(snapshots.at(-1)).toEqual([
      {
        kind: "system",
        content: "Interrupted current run and dropped 1 queued input(s).",
      },
    ]);
  });

  it("TUI interrupt 会关闭当前审批 dialog", async () => {
    const { reporter } = harness();
    const abortControllerRef: { current: AbortController | null } = { current: null };
    const openDialog = vi.fn();
    const closeDialog = vi.fn();
    const queue = new RunningInputQueue();
    const runAgent = vi.fn(async (_options, deps) => {
      deps.approvalNotifier?.({
        taskId: "abort-dialog",
        toolName: "write_file",
        args: '{"path":"danger.txt","content":"x"}',
        message: "approval",
      });
      const signal = deps.signal;
      if (!signal) throw new Error("missing signal");
      await new Promise<never>((_resolve, reject) => {
        const rejectWithAbort = () => reject(signal.reason);
        if (signal.aborted) {
          rejectWithAbort();
          return;
        }
        signal.addEventListener("abort", rejectWithAbort, { once: true });
      });
      throw new Error("unreachable");
    });
    const run = runTuiAgentPrompt(
      { prompt: "write", dir: process.cwd(), session: "tui-session" },
      { reporter, runAgent, openDialog, closeDialog, abortControllerRef },
    );
    await vi.waitFor(() => expect(openDialog).toHaveBeenCalledOnce());

    handleTuiInterrupt(abortControllerRef.current, queue, reporter);

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(closeDialog).toHaveBeenCalledWith("approval:pending:abort-dialog");
    expect(abortControllerRef.current).toBeNull();
  });

  it("approval command is handled locally and resolves a pending approval", async () => {
    const { reporter, snapshots, runAgent, exit, registry, workDir } = harness();
    globalApprovalManager.clear();
    const approval = globalApprovalManager.waitForApproval(
      "call_local",
      "write_file",
      JSON.stringify({ path: "AIHOT.md", content: "# daily" }),
      () => undefined,
    );

    await handleTuiInputSubmission("approve call_local", {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
    });

    await expect(approval).resolves.toMatchObject({ allowed: true });
    expect(runAgent).not.toHaveBeenCalled();
    expect(snapshots.at(-1)).toEqual([{ kind: "system", content: "Allowed once." }]);
  });

  it("mention-expanded prompt 继续走 runAgentFromCli", async () => {
    const { reporter, runAgent, exit, registry, workDir } = harness();
    const processInput = vi.fn(
      async (): Promise<TuiInputProcessResult> => ({
        type: "prompt",
        raw: "review this",
        prompt: "review this",
      }),
    );

    await handleTuiInputSubmission("review this", {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
      processInput,
    });

    expect(processInput).toHaveBeenCalledWith("review this");
    expect(runAgent).toHaveBeenCalledWith("review this");
  });

  it("shows the trace path after a TUI request when tracing is enabled", async () => {
    const { reporter, snapshots } = harness();
    const runAgent = vi.fn(async () => ({
      sessionId: "tui-session",
      sessionSelection: { mode: "new" as const, sessionId: "tui-session" },
      workDir: process.cwd(),
      finalMessage: "done",
      usage: { promptTokens: 1, completionTokens: 1, costCNY: 0 },
      messages: [],
      tracePath: "/tmp/project/.claw/traces/trace_tui-session_1.json",
    }));

    await runTuiAgentPrompt(
      {
        prompt: "trace this",
        dir: process.cwd(),
        session: "tui-session",
      },
      {
        reporter,
        runAgent,
      },
    );

    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "trace this" }),
      expect.objectContaining({ reporter }),
    );
    expect(snapshots.at(-1)).toEqual([
      {
        kind: "system",
        content: "Trace saved: /tmp/project/.claw/traces/trace_tui-session_1.json",
      },
    ]);
  });

  it("@image:path 随本条 prompt 发送 ImagePart", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-tui-img-"));
    try {
      await writeFile(join(workDir, "pic.jpg"), "JPG");
      const { reporter, snapshots, runAgent, exit, registry } = harness();

      await handleTuiInputSubmission("看一下 @image:pic.jpg", {
        reporter,
        registry,
        workDir,
        runAgent,
        exit,
      });

      expect(runAgent).toHaveBeenCalledWith("看一下", {
        images: [
          expect.objectContaining({
            type: "image_base64",
            mimeType: "image/jpeg",
          }),
        ],
      });
      expect(snapshots.at(-1)).toEqual([
        { kind: "user", content: "看一下 @image:pic.jpg" },
        { kind: "system", content: "已附加图片: pic.jpg" },
      ]);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("@image:path 路径错误时显示结构化错误且不调用模型", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-tui-img-missing-"));
    try {
      const { reporter, snapshots, runAgent, exit, registry } = harness();

      await handleTuiInputSubmission("看一下 @image:missing.png", {
        reporter,
        registry,
        workDir,
        runAgent,
        exit,
      });

      expect(runAgent).not.toHaveBeenCalled();
      expect(snapshots.at(-1)).toEqual([
        { kind: "user", content: "看一下 @image:missing.png" },
        {
          kind: "error",
          message: expect.stringContaining("missing.png"),
          retryable: false,
        },
      ]);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("输入框附件不受工作区路径限制，并随当前 prompt 发送给模型", async () => {
    const { reporter, runAgent, exit, registry, workDir } = harness();
    const image = {
      type: "image_base64" as const,
      mimeType: "image/png",
      data: Buffer.from("outside-workspace-image").toString("base64"),
    };

    await handleTuiInputSubmission(
      "分析这张截图",
      { reporter, registry, workDir, runAgent, exit },
      [image],
    );

    expect(runAgent).toHaveBeenCalledWith("分析这张截图", { images: [image] });
  });

  it("/sessions 打开 session selector dialog", async () => {
    const { reporter, runAgent, exit, registry, workDir } = harness();
    const openDialog = vi.fn();
    const processInput = vi.fn(
      async (): Promise<TuiInputProcessResult> => ({
        type: "local-command",
        raw: "/sessions",
        command: "sessions",
        args: "",
        argv: [],
        result: {
          type: "local",
          action: "message",
          message: "legacy session list",
          data: [
            sessionSummary({
              id: "cli-current",
              title: "继续调试 TUI",
              firstMessage: "继续调试 TUI",
            }),
          ],
          ui: { kind: "open-selector", selector: "session" },
        },
      }),
    );

    await handleTuiInputSubmission("/sessions", {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
      processInput,
      openDialog,
    });

    expect(runAgent).not.toHaveBeenCalled();
    expect(openDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "local-ui:session-selector",
        layer: "modal",
        priority: 40,
      }),
    );
    const request = openDialog.mock.calls[0]?.[0];
    expect(renderToString(request.content)).toContain("Sessions [cwd]");
    expect(renderToString(request.content)).toContain("继续调试 TUI");
  });

  it("选择 session 后派发 /resume <session-id>", async () => {
    const { reporter, runAgent, exit, registry, workDir } = harness();
    const selected = sessionSummary({ id: "cli-current" });
    const dispatchInput = vi.fn(async () => undefined);
    const openDialog = vi.fn();
    const processInput = vi.fn(
      async (): Promise<TuiInputProcessResult> => ({
        type: "local-command",
        raw: "/sessions",
        command: "sessions",
        args: "",
        argv: [],
        result: {
          type: "local",
          action: "message",
          data: [selected],
          ui: { kind: "open-selector", selector: "session" },
        },
      }),
    );

    await handleTuiInputSubmission("/sessions", {
      reporter,
      registry,
      workDir,
      runAgent,
      exit,
      processInput,
      openDialog,
      dispatchInput,
    });

    const request = openDialog.mock.calls[0]?.[0];
    expect(React.isValidElement(request.content)).toBe(true);
    const props = request.content.props as {
      onSelect: (session: CliSessionBrowserSummary) => Promise<void> | void;
    };
    await props.onSelect(selected);

    expect(dispatchInput).toHaveBeenCalledWith("/resume cli-current");
    expect(runAgent).not.toHaveBeenCalled();
  });
});

function sessionSummary(
  overrides: Partial<CliSessionBrowserSummary> = {},
): CliSessionBrowserSummary {
  return {
    id: overrides.id ?? "cli-current",
    cwd: overrides.cwd ?? process.cwd(),
    createdAt: overrides.createdAt ?? new Date("2026-07-09T01:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-07-09T02:00:00.000Z"),
    messageCount: overrides.messageCount ?? 3,
    ...(overrides.title !== undefined ? { title: overrides.title } : {}),
    ...(overrides.firstMessage !== undefined ? { firstMessage: overrides.firstMessage } : {}),
    ...(overrides.lastMessage !== undefined ? { lastMessage: overrides.lastMessage } : {}),
  };
}

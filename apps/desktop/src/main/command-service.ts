import { isAbsolute } from "node:path";
import {
  createClientCommandRegistry,
  processClientInput,
  type ClientCommandRuntime,
} from "@pico/cli/client-commands";
import { parseSlashInput } from "@pico/core/slash-parser";
import { getCommandAvailability } from "@pico/cli/command-availability";
import { CommandRegistry } from "@pico/cli/command-registry";
import { desktopCommandPolicy } from "../shared/command-policy.js";
import type { DesktopCommandSuggestion } from "../shared/command-policy.js";
import {
  DESKTOP_RUNTIME_METHODS,
  isTerminalRunStatus,
  parseStrictRuntimeParams,
  type RuntimeParams,
  type RuntimeUserDefaults,
} from "@pico/protocol";
import type {
  DesktopCommandRequest,
  DesktopCommandExecution,
  DesktopCommandAction,
} from "../preload/command-contract.js";
import type { RuntimeClientAdapter } from "./runtime-client-adapter.js";

/** Commands run in main: environment credentials and Node helpers never enter the renderer. */
export function createDesktopCommandService(client: Pick<RuntimeClientAdapter, "request">) {
  const scopes = new Map<string, ReturnType<typeof createScope>>();
  type Execution = {
    text: string;
    promise: Promise<DesktopCommandExecution>;
    settled: boolean;
    retrySend?: RuntimeParams<"session.send"> | undefined;
  };
  const completed = new Map<string, Execution>();
  const allowed = new Set<string>(DESKTOP_RUNTIME_METHODS);

  function createScope(context: DesktopCommandRequest) {
    let sessionId = context.sessionId;
    let running = false;
    let runId: string | undefined;
    let initialSettings: RuntimeUserDefaults = {};
    let effects: {
      -readonly [Key in keyof Omit<
        DesktopCommandExecution,
        "outcome"
      >]: DesktopCommandExecution[Key];
    } = {};
    let pending = false;
    let requestId = "";
    let onSendFailure: (params: RuntimeParams<"session.send">) => void;
    const workspacePath = context.workspacePath;
    const runtime: ClientCommandRuntime = {
      get activeSessionId() {
        return sessionId;
      },
      get running() {
        return running;
      },
      get preSessionSettings() {
        return initialSettings;
      },
      async request(method, params) {
        if (!allowed.has(method)) throw new Error(`桌面端不允许调用 ${method}。`);
        if (method === "session.settings.update") {
          const {
            workspacePath: _workspace,
            sessionId: _session,
            ...patch
          } = parseStrictRuntimeParams("session.settings.update", params);
          return intent({ kind: "settings", patch });
        }
        if (method === "goal.control") {
          const {
            workspacePath: _workspace,
            sessionId: _session,
            ...input
          } = parseStrictRuntimeParams("goal.control", params);
          return intent({ kind: "goal", input });
        }
        if (method === "session.compact") return intent({ kind: "compact" });
        if (method === "session.rename")
          return intent({
            kind: "rename",
            title: parseStrictRuntimeParams("session.rename", params).title,
          });
        if (method === "session.fork")
          return intent({
            kind: "fork",
            sessionId: parseStrictRuntimeParams("session.fork", params).sessionId,
          });
        return client.request(method, parseStrictRuntimeParams(method, params));
      },
      async switchSession(target) {
        sessionId = target;
        effects.switchSession = target ?? null;
      },
      clearTranscript() {
        /* /new only navigates; /clear is rejected by policy. */
      },
      async interrupt() {
        if (runId) await runtime.request("run.cancel", { workspacePath, runId });
      },
      async sendText(text, behavior) {
        return runtime.sendInput({ kind: "text", text }, behavior);
      },
      async sendInput(input, behavior = "auto", execution) {
        await send({
          workspacePath,
          ...(sessionId ? { sessionId } : { initialSettings }),
          input:
            input.kind === "text" && execution?.orchestrationMode
              ? { ...input, orchestrationMode: execution.orchestrationMode }
              : input,
          behavior,
          ...(runId ? { expectedRunId: runId } : {}),
          idempotencyKey: requestId,
        });
        return true;
      },
      setPreSessionCollaborationMode(mode) {
        return setInitial({ collaborationMode: mode });
      },
      setPreSessionPermissionMode(mode) {
        return setInitial({ permissionMode: mode });
      },
      setPreSessionOrchestrationMode(mode) {
        return setInitial({ orchestrationMode: mode });
      },
    };
    function intent(action: DesktopCommandAction): never {
      effects.action = action;
      // Shared handlers validate arguments and construct typed requests. Desktop owns
      // confirmation and execution through its existing UI actions.
      throw new Error("等待桌面交互。");
    }
    async function send(params: RuntimeParams<"session.send">) {
      try {
        const result = await runtime.request("session.send", params);
        if (!sessionId) await runtime.switchSession(result.session.sessionId);
      } catch (error) {
        // Keep the exact admission request: the daemon may already have accepted it.
        onSendFailure(params);
        throw error;
      }
    }
    function setInitial(patch: RuntimeUserDefaults) {
      if (sessionId || running) return false;
      initialSettings = { ...initialSettings, ...patch };
      effects.initialSettings = patch;
      return true;
    }
    const registry = createClientCommandRegistry({ runtime, workspacePath });
    const viewCommands = new Set([
      "model",
      "goal",
      "thinking",
      "graph",
      "swarm",
      "rewind",
      "changes",
    ]);
    const navigationCommands = new Set(["new", "resume"]);
    function catalog(isRunning: boolean): DesktopCommandSuggestion[] {
      return registry
        .commandSuggestions("", { availabilityState: isRunning ? "running" : "idle" })
        .flatMap((command) => {
          const policy = desktopCommandPolicy(command.name);
          if (!policy || (policy.tier !== "primary" && policy.tier !== "advanced")) return [];
          const entryAvailable =
            viewCommands.has(command.name) || navigationCommands.has(command.name);
          const missingSession = policy.session && !context.sessionId;
          const disabled = Boolean(missingSession || (!entryAvailable && command.disabled));
          const disabledReason = missingSession
            ? "请先发送消息或打开历史会话。"
            : disabled
              ? command.disabledReason?.includes("running")
                ? "仅在任务运行中可用。"
                : "任务执行中，结束后可执行此操作。"
              : undefined;
          return [
            {
              ...command,
              tier: policy.tier,
              ...(command.name === "resume" ? { description: "打开历史会话" } : {}),
              disabled,
              disabledReason,
            },
          ];
        });
    }
    return {
      get pending() {
        return pending;
      },
      catalog,
      async complete(text: string) {
        const parsed = parseSlashInput(text);
        const command = parsed && registry.resolve(parsed.name);
        const policy = command && desktopCommandPolicy(command.name);
        if (!policy || (policy.tier !== "primary" && policy.tier !== "advanced") || !workspacePath)
          return [];
        return parsed
          ? ((await registry.resolve(parsed.name)?.argumentCompleter?.(parsed.args)) ?? [])
          : [];
      },
      async execute(
        input: DesktopCommandRequest & { operation: "execute" },
        failedSend: (params: RuntimeParams<"session.send">) => void,
        retrySend?: RuntimeParams<"session.send">,
      ): Promise<DesktopCommandExecution> {
        if (pending) throw new Error("当前会话的命令正在执行，请稍后重试。");
        pending = true;
        effects = {};
        sessionId = input.sessionId;
        initialSettings = input.initialSettings ?? {};
        requestId = input.requestId;
        onSendFailure = failedSend;
        try {
          const parsed = parseSlashInput(input.text);
          const command = parsed && registry.resolve(parsed.name);
          const policy = command && desktopCommandPolicy(command.name);
          if (!parsed || !command || !policy)
            return {
              outcome: { kind: "unknown", message: "未知桌面命令，请使用 /help 查看可用命令。" },
            };
          const explanation =
            command.name === "help" && parsed.argv[0] ? registry.resolve(parsed.argv[0]) : command;
          const targetPolicy = explanation && desktopCommandPolicy(explanation.name);
          if (targetPolicy?.tier === "page")
            return {
              outcome: { kind: "rejected", message: targetPolicy.message },
              redirect: { destination: targetPolicy.destination, label: targetPolicy.label },
            };
          if (targetPolicy?.tier === "unsupported")
            return { outcome: { kind: "rejected", message: targetPolicy.message } };
          if (targetPolicy?.tier === "control") {
            return {
              outcome:
                command.name === "help"
                  ? { kind: "rejected", message: targetPolicy.message }
                  : {
                      kind: "local",
                      result: { type: "local", action: "message", message: targetPolicy.message },
                    },
              ...(command.name === "help"
                ? {}
                : { action: { kind: "open", target: targetPolicy.target } as const }),
            };
          }
          if (command.name === "help" && targetPolicy?.tier === "resource")
            return {
              outcome: {
                kind: "local",
                result: {
                  type: "local",
                  action: "message",
                  message: `/${explanation!.name} 在输入框选择${targetPolicy.target === "skill" ? "技能" : "子代理"}，也可使用加号入口；选择后编辑正文并发送。`,
                },
              },
            };
          if (command.name === "help") {
            const commands = catalog(input.running ?? false).filter(
              (item) => !parsed.argv[0] || item.name === explanation?.name,
            );
            return {
              outcome: {
                kind: "local",
                result: {
                  type: "local",
                  action: "help",
                  ui: { kind: "open-panel", panel: "help" },
                  message:
                    commands
                      .map(
                        (item) =>
                          `${item.usage ?? `/${item.name}`}\n${item.tier === "advanced" ? "高级 · " : ""}${item.description}${item.disabledReason ? `\n${item.disabledReason}` : ""}`,
                      )
                      .join("\n\n") +
                      (!parsed.argv[0]
                        ? "\n\nSkill / Agent：使用加号或 /skill、/agent 选择任务上下文。"
                        : "") || "没有找到该桌面命令。",
                },
              },
            };
          }
          if (policy.tier !== "primary" && policy.tier !== "advanced" && policy.tier !== "resource")
            return { outcome: { kind: "rejected", message: "此命令不适用于桌面。" } };
          if ("session" in policy && policy.session && !sessionId)
            return { outcome: { kind: "rejected", message: "请先打开一个会话。" } };
          if (retrySend) {
            // Replay admission with its original key and expected run, even if run
            // availability changed after the first request was accepted.
            await send(retrySend);
            return { outcome: { kind: "sent" }, ...effects };
          }
          const runs = sessionId
            ? await runtime.request("runs.list", { workspacePath, sessionId })
            : { runs: [] };
          runId = runs.runs.find((run) => !isTerminalRunStatus(run.status))?.runId;
          running = Boolean(runId);
          const opensView =
            (viewCommands.has(command.name) && !parsed.args.trim()) ||
            ["rewind", "changes"].includes(command.name) ||
            (command.name === "swarm" && parsed.args.trim() === "status");
          const entryOnly = opensView || navigationCommands.has(command.name);
          const availability = getCommandAvailability(
            entryOnly ? { ...command, availability: "always" } : command,
            running ? "running" : "idle",
          );
          if (!availability.available)
            return {
              outcome: {
                kind: "rejected",
                message:
                  command.availability === "running"
                    ? "仅在任务运行中可用。"
                    : "任务执行中，结束后可执行此操作。",
              },
            };
          if (
            !parsed.args.trim() &&
            ["goal", "model", "skill", "agent", "thinking"].includes(command.name)
          )
            return {
              outcome: { kind: "local" },
              action: {
                kind: "open",
                target: command.name as "goal" | "model" | "skill" | "agent" | "thinking",
              },
            };
          // Unbound tasks must be able to recover projectless history without creating a workspace.
          if (command.name === "resume" && !parsed.args.trim())
            return { outcome: { kind: "local" }, action: { kind: "open", target: "sessions" } };
          if (!sessionId && command.name === "graph" && !parsed.args.trim())
            return {
              outcome: {
                kind: "local",
                result: {
                  type: "local",
                  action: "message",
                  message: `Graph 模式：${initialSettings.orchestrationMode === "graph" ? "开启" : "关闭"}`,
                },
              },
            };
          if (
            !workspacePath &&
            !["new", "mode", "plan", "permissions", "graph", "swarm"].includes(command.name)
          )
            return { outcome: { kind: "rejected", message: "请先选择项目。" } };
          if (!sessionId && command.name === "graph" && ["on", "off"].includes(parsed.args.trim()))
            return {
              outcome: { kind: "local" },
              initialSettings: {
                orchestrationMode: parsed.args.trim() === "on" ? "graph" : "default",
              },
            };
          // Desktop view/navigation exceptions do not relax the shared TUI execution gate.
          const executionRegistry = entryOnly
            ? new CommandRegistry([{ ...command, availability: "always" }])
            : registry;
          const outcome = await processClientInput(input.text, executionRegistry, runtime);
          if (effects.action) return { outcome: { kind: "local" }, ...effects };
          return { outcome, ...effects };
        } finally {
          pending = false;
        }
      },
    };
  }

  return {
    async invoke(ownerId: number, value: unknown) {
      const input = readCommandRequest(value);
      const key = JSON.stringify([ownerId, input.workspacePath, input.sessionId ?? ""]);
      let scope = scopes.get(key);
      if (!scope) {
        if (scopes.size >= 64) {
          const oldest = [...scopes].find(([, entry]) => !entry.pending)?.[0];
          if (oldest) scopes.delete(oldest);
          else throw new Error("命令处理中，请稍后重试。");
        }
        scope = createScope(input);
        scopes.set(key, scope);
      }
      if (input.operation === "catalog") return scope.catalog(input.running ?? false);
      if (input.operation === "complete") return scope.complete(input.text);
      const executionKey = JSON.stringify([key, input.requestId]);
      const previous = completed.get(executionKey);
      if (previous) {
        if (previous.text !== input.text) throw new Error("命令请求标识已被使用。");
        if (!previous.settled || !previous.retrySend) return previous.promise;
      }
      const retrySend = previous?.retrySend;
      const entry: Execution = {
        text: input.text,
        settled: false,
        retrySend,
        promise: Promise.resolve({ outcome: { kind: "rejected" } }),
      };
      entry.promise = scope.execute(
        input,
        (params) => {
          entry.retrySend = params;
        },
        retrySend,
      );
      completed.set(executionKey, entry);
      void entry.promise.then(
        (result) => {
          entry.settled = true;
          if (retrySend) entry.retrySend = undefined;
          if (!entry.retrySend && result.outcome.result?.message?.startsWith("命令执行失败："))
            completed.delete(executionKey);
        },
        () => {
          entry.settled = true;
          if (!entry.retrySend) completed.delete(executionKey);
        },
      );
      if (completed.size > 128) completed.delete(completed.keys().next().value!);
      return entry.promise;
    },
    dispose() {
      scopes.clear();
      completed.clear();
    },
  };
}

export function readCommandRequest(value: unknown): DesktopCommandRequest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("命令参数无效。");
  const input = value as Record<string, unknown>;
  const keys = [
    "operation",
    "workspacePath",
    "sessionId",
    "initialSettings",
    "running",
    "text",
    "requestId",
  ];
  if (
    Object.keys(input).some((key) => !keys.includes(key)) ||
    !["catalog", "complete", "execute"].includes(String(input.operation)) ||
    typeof input.workspacePath !== "string" ||
    (input.workspacePath !== "" && !isAbsolute(input.workspacePath)) ||
    (input.sessionId !== undefined &&
      (typeof input.sessionId !== "string" || !input.sessionId || !input.workspacePath)) ||
    (input.running !== undefined && typeof input.running !== "boolean")
  )
    throw new Error("命令上下文无效。");
  if (
    input.operation !== "catalog" &&
    (typeof input.text !== "string" ||
      input.text.length > 100_000 ||
      !input.text.trimStart().startsWith("/"))
  )
    throw new Error("只能通过命令入口执行斜杠命令。");
  if (
    input.operation === "execute" &&
    (typeof input.requestId !== "string" || !/^[\w-]{8,128}$/u.test(input.requestId))
  )
    throw new Error("命令请求标识无效。");
  if (input.initialSettings !== undefined)
    parseStrictRuntimeParams("session.send", {
      workspacePath: input.workspacePath || "/",
      input: { kind: "text", text: "validate" },
      idempotencyKey: "command-validation",
      initialSettings: input.initialSettings,
    });
  return input as unknown as DesktopCommandRequest;
}

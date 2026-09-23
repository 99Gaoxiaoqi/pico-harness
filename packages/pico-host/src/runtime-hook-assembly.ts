import { randomUUID } from "node:crypto";
import { FullCompactor } from "@pico/pico-host/product-full-compactor";
import type { ContextBudget } from "@pico/runtime/context-budget";
import { bindToolResultArchiveReader } from "@pico/runtime/tool-result-archive";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { join } from "node:path";
import { AgentEngine } from "@pico/pico-host/agent-engine";
import { Session } from "@pico/pico-host/session";
import type { McpConnectionManager } from "@pico/pico-host/mcp-connection-manager";
import type { HookHostNetworkGate } from "@pico/pico-host/hooks/executors";
import type { LLMProvider } from "@pico/core";
import type { WorkspaceSandboxConfig } from "@pico/pico-host/workspace-sandbox";
import { createHookVerifierRegistry } from "@pico/pico-host/child-agent-policy";
import { logger } from "@pico/pico-host/logger";
import type { WorkspaceRoots } from "@pico/pico-host/workspace-roots";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { currentRuntimeRun, RuntimeRun } from "@pico/pico-host/product-runtime-run";
import type { SessionRuntime } from "@pico/pico-host/session-runtime";

export interface RuntimeHookAssemblyInput {
  readonly session: Session;
  readonly runtimeState: SessionRuntime;
  readonly provider: LLMProvider;
  readonly contextBudget?: ContextBudget;
  readonly contextRouteIdentity?: string;
  readonly workDir: string;
  readonly workspaceRoots: WorkspaceRoots;
  readonly picoHome: string;
  readonly runtimeEnv: Readonly<Record<string, string | undefined>>;
  readonly sandboxConfig: WorkspaceSandboxConfig;
  readonly mcpManager: () => McpConnectionManager | undefined;
  /** Rechecked immediately before every Hook HTTP/MCP network operation. */
  readonly hostNetworkGate?: HookHostNetworkGate;
  readonly toolResultRedactionSecrets?: readonly string[];
}

/** Bind the model-backed Hook ports without exposing AgentRuntime's wider assembly state. */
export function bindRuntimeHookCapabilities(input: RuntimeHookAssemblyInput): void {
  input.runtimeState.bindHookRuntime({
    provider: input.provider,
    modelRuntime: {
      run: (execute, signal) => runHostOwnedRuntimeOperation(input.session, execute, signal),
    },
    mcpInvoker: {
      async invokeConnectedTool(server, tool, toolInput, context) {
        const manager = input.mcpManager();
        if (!manager) throw new Error("MCP manager 尚未连接");
        return await manager.invokeConnectedTool(server, tool, toolInput, context);
      },
    },
    ...(input.hostNetworkGate ? { hostNetworkGate: input.hostNetworkGate } : {}),
    agentVerifier: {
      async verify(request) {
        request.signal.throwIfAborted();
        const runtimePort = createEngineRuntimePort();
        const child = new Session(`hook-verifier-${randomUUID()}`, input.workDir, {
          persistence: true,
          picoHome: input.picoHome,
          runtimePort,
        });
        try {
          await child.recover();
          const verifierRegistry = createHookVerifierRegistry({
            diagnostics: logger,
            skillLogger: logger,
            grepDiagnostics: logger,
            workDir: input.workDir,
            workspaceRoots: input.workspaceRoots,
            processSandbox: {
              config: input.sandboxConfig,
              scratchRoot: join(input.picoHome, "sandboxes", input.session.id, "subagents"),
            },
            env: input.runtimeEnv,
            codeIntelligence: input.runtimeState.codeIntelligence,
            toolResultArchive: bindToolResultArchiveReader(child.runtimeEventStore!, child.id),
          });
          const task = [
            request.prompt,
            "",
            "只读核验以下 Hook input。最终只输出单个 JSON 对象：",
            '{"ok": boolean, "reason": string}',
            JSON.stringify(request.input),
          ].join("\n");
          await child.commitMessages({ role: "user", content: task });
          const provider = hookPurposeProvider(input.provider);
          const verifierEngine = new AgentEngine({
            provider,
            registry: verifierRegistry,
            workDir: input.workDir,
            runtimePort,
            workspaceRoots: input.workspaceRoots,
            goalManager: input.runtimeState.goalManager,
            systemPrompt:
              '你是只读 Hook 验证器。核验用户提供的任务与证据；最终只输出单个 JSON 对象 {"ok": boolean, "reason": string}。',
            // Reserve the final tools-disabled grace response within the Hook turn limit.
            maxTurns: Math.max(0, request.maxTurns - 1),
            ...(input.contextBudget ? { contextBudget: input.contextBudget } : {}),
            ...(input.contextRouteIdentity
              ? { contextRouteIdentity: input.contextRouteIdentity }
              : {}),
            fullCompactor: new FullCompactor({ provider, workDir: input.workDir }),
            reporter: new SilentReporter(),
            ...(input.toolResultRedactionSecrets
              ? { toolResultRedactionSecrets: input.toolResultRedactionSecrets }
              : {}),
          });
          // No Hook service is mounted: child tools and compaction cannot recurse into Hooks.
          const messages = await verifierEngine.run(child, undefined, undefined, request.signal);
          return (
            messages.findLast(
              (message) => message.role === "assistant" && !message.toolCalls?.length,
            )?.content ?? ""
          );
        } finally {
          await child.close();
        }
      },
    },
    onAsyncRewake(handler, output) {
      input.runtimeState.hookRewakeQueue.enqueue(
        `[Hook asyncRewake ${handler.id}] ${output.reason ?? output.additionalContext ?? output.decision}`,
      );
    },
  });
}

/** Hook verifier model calls always use their dedicated billing purpose. */
function hookPurposeProvider(provider: LLMProvider): LLMProvider {
  return {
    ...(provider.modelName ? { modelName: provider.modelName } : {}),
    get requestCapabilities() {
      return provider.requestCapabilities;
    },
    generate: (messages, tools, options) =>
      provider.generate(messages, tools, { ...options, purpose: "hook" }),
    ...(provider.generateStream
      ? {
          generateStream: (messages, tools, onDelta, options) =>
            provider.generateStream!(messages, tools, onDelta, {
              ...options,
              purpose: "hook",
            }),
        }
      : {}),
  };
}

async function runHostOwnedRuntimeOperation<Result>(
  session: Session,
  execute: () => Promise<Result>,
  signal: AbortSignal,
): Promise<Result> {
  const ambient = currentRuntimeRun();
  if (ambient) {
    if (!ambient.claimsSession(session) || ambient.runtimeEventWriteGuard !== session) {
      throw new Error(
        `Hook model handler cannot reuse RuntimeRun ${ambient.runId} for Session ${session.id}`,
      );
    }
    return execute();
  }

  return session.serialize(async () => {
    const runtimeCapability = session.runtimeEventCapability;
    if (!runtimeCapability) {
      throw new Error(`Hook model handler requires a durable Session: ${session.id}`);
    }
    await RuntimeRun.reconcileIncompleteRuns({ capability: runtimeCapability });
    await RuntimeRun.repairSessionProjection(session, { capability: runtimeCapability });
    const runtimeRun = await RuntimeRun.start({
      capability: runtimeCapability,
      agentSwarmAuthorization: "none",
    });
    return runtimeRun.run(execute, signal);
  });
}

import { join } from "node:path";
import { AgentEngine } from "../engine/loop.js";
import type { Session } from "../engine/session.js";
import type { McpConnectionManager } from "../mcp/manager.js";
import type { HookHostNetworkGate } from "../hooks/executors/index.js";
import type { LLMProvider } from "../provider/interface.js";
import type { WorkspaceSandboxConfig } from "../safety/workspace-sandbox.js";
import { ToolRegistry } from "../tools/registry-impl.js";
import { createHookVerifierRegistry } from "../tools/child-agent-policy.js";
import type { WorkspaceRoots } from "../tools/workspace-roots.js";
import { createEngineRuntimePort } from "./engine-runtime-port-adapter.js";
import { currentRuntimeRun, RuntimeRun } from "./runtime-run.js";
import type { SessionRuntime } from "./session-runtime.js";

export interface RuntimeHookAssemblyInput {
  readonly session: Session;
  readonly runtimeState: SessionRuntime;
  readonly provider: LLMProvider;
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
        const verifierEngine = new AgentEngine({
          provider: hookPurposeProvider(input.provider),
          registry: new ToolRegistry(),
          workDir: input.workDir,
          runtimePort: createEngineRuntimePort(),
          workspaceRoots: input.workspaceRoots,
          usageSession: input.session,
          goalManager: input.runtimeState.goalManager,
          ...(input.toolResultRedactionSecrets
            ? { toolResultRedactionSecrets: input.toolResultRedactionSecrets }
            : {}),
        });
        const verifierRegistry = createHookVerifierRegistry({
          workDir: input.workDir,
          workspaceRoots: input.workspaceRoots,
          processSandbox: {
            config: input.sandboxConfig,
            scratchRoot: join(input.picoHome, "sandboxes", input.session.id, "subagents"),
          },
          env: input.runtimeEnv,
          codeIntelligence: input.runtimeState.codeIntelligence,
        });
        const task = [
          request.prompt,
          "",
          "只读核验以下 Hook input。最终只输出单个 JSON 对象：",
          '{"ok": boolean, "reason": string}',
          JSON.stringify(request.input),
        ].join("\n");
        const result = await verifierEngine.runSub(task, verifierRegistry, undefined, {
          maxTurns: request.maxTurns,
          signal: request.signal,
          workDir: input.workDir,
        });
        return result.summary;
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
    const runtimeRun = await RuntimeRun.start({ capability: runtimeCapability });
    return runtimeRun.run(execute, signal);
  });
}

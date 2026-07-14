import { logger } from "../observability/logger.js";
import type { SlashCommand } from "../input/types.js";
import {
  loadHookSnapshot,
  type LoadHookSnapshotOptions,
  type LoadHookSnapshotResult,
} from "./config.js";
import { HookConfigReloader } from "./config/reloader.js";
import {
  DefaultHookExecutor,
  type HookHandlerExecutorOptions,
} from "./executors/index.js";
import {
  applyHookifyProposal,
  createHookifyProposal,
  evaluateHookifyRules,
  loadHookifyRules,
  type HookifyProposal,
  type HookifyRule,
} from "./hookify/rules.js";
import { createHookManagementCommands } from "./management/commands.js";
import { HookManagementService } from "./management/service.js";
import { HookLocalStateStore } from "./management/state.js";
import { HookService, type HookDecisionProvider } from "./service.js";
import { HookTrustStore } from "./trust/store.js";

export interface SessionHookRuntimeOptions
  extends Pick<LoadHookSnapshotOptions, "workDir" | "userHome"> {
  sessionId: string;
}

export interface SessionHookRuntime {
  service: HookService;
  executor: DefaultHookExecutor;
  management: HookManagementService;
  commands: readonly SlashCommand[];
  bind(dependencies: Parameters<DefaultHookExecutor["bind"]>[0]): void;
  reload(changedPaths?: readonly string[]): Promise<boolean>;
  dispose(): Promise<void>;
}

/** 组合配置、信任、Hookify、热重载和会话级执行器，不依赖 TUI。 */
export async function createSessionHookRuntime(
  options: SessionHookRuntimeOptions,
): Promise<SessionHookRuntime> {
  const trustStore = new HookTrustStore({ userHome: options.userHome });
  const stateStore = new HookLocalStateStore(options.workDir);
  const loadOptions = {
    workDir: options.workDir,
    ...(options.userHome ? { userHome: options.userHome } : {}),
    trustStore,
    stateStore,
  } satisfies LoadHookSnapshotOptions;
  const initial = await loadHookSnapshot(loadOptions);
  let rules = await safeLoadHookifyRules(options.workDir);
  let candidateRules: readonly HookifyRule[] | undefined;
  const decisionProvider: HookDecisionProvider = {
    evaluate(event, payload) {
      return evaluateHookifyRules(rules, event, payload);
    },
  };
  const executor = new DefaultHookExecutor({ workDir: options.workDir });
  const service = new HookService({
    workDir: options.workDir,
    sessionId: options.sessionId,
    executor,
    snapshot: initial.snapshot,
    decisionProviders: [decisionProvider],
  });
  const reloader = new HookConfigReloader({
    ...loadOptions,
    initial,
    beforeSwap: async ({ candidate, changedPaths }) => {
      try {
        candidateRules = await loadHookifyRules(options.workDir);
      } catch (error) {
        return { decision: "deny", reason: `Hookify 规则无效: ${errorMessage(error)}` };
      }
      return await service.dispatch("ConfigChange", {
        paths: changedPaths,
        proposedHash: candidate.snapshot.id,
      });
    },
    onSwap(result) {
      service.replaceSnapshot(result.snapshot);
      rules = candidateRules ?? rules;
      candidateRules = undefined;
    },
    onReject(message) {
      candidateRules = undefined;
      logger.warn({ message }, "[Hook] 配置热重载被拒绝，保留旧快照");
    },
  });
  await reloader.start();

  const management = new HookManagementService({
    workDir: options.workDir,
    currentSnapshot: () => service.currentSnapshot(),
    reload: async () => await reloader.reload(),
    trustStore,
    stateStore,
  });
  let pendingProposal: HookifyProposal | undefined;
  const hookify = async (
    description: string,
  ): Promise<{ proposal: HookifyProposal; applied: boolean }> => {
    const action = description.trim().toLowerCase();
    if (action === "confirm") {
      if (!pendingProposal) throw new Error("没有待确认的 Hookify proposal");
      const proposal = pendingProposal;
      const applied = await applyHookifyProposal(proposal, {
        confirm: () => true,
        onApplied: async (path) => {
          await reloader.reload([path]);
        },
      });
      pendingProposal = undefined;
      return { proposal, applied };
    }
    if (action === "cancel") {
      if (!pendingProposal) throw new Error("没有待取消的 Hookify proposal");
      const proposal = pendingProposal;
      pendingProposal = undefined;
      return { proposal, applied: false };
    }
    pendingProposal = createHookifyProposal({ workDir: options.workDir, description });
    return { proposal: pendingProposal, applied: false };
  };
  const commands = createHookManagementCommands({ management, hookify });

  return {
    service,
    executor,
    management,
    commands,
    bind: (dependencies) => executor.bind(dependencies),
    reload: async (changedPaths) => await reloader.reload(changedPaths),
    dispose: async () => reloader.stop(),
  };
}

async function safeLoadHookifyRules(workDir: string): Promise<readonly HookifyRule[]> {
  try {
    return await loadHookifyRules(workDir);
  } catch (error) {
    logger.warn({ error: errorMessage(error) }, "[Hook] Hookify 规则加载失败，本轮不启用");
    return [];
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type HookRuntimeBinding = Partial<
  Pick<HookHandlerExecutorOptions, "provider" | "mcpInvoker" | "agentVerifier" | "onAsyncRewake">
>;

export type HookRuntimeSnapshot = LoadHookSnapshotResult;

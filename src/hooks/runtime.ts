import { logger } from "../observability/logger.js";
import type { SlashCommand } from "../input/types.js";
import {
  loadHookSnapshot,
  type LoadHookSnapshotOptions,
  type LoadHookSnapshotResult,
  type HookConfigSourceSpec,
} from "./config.js";
import { HookConfigReloader } from "./config/reloader.js";
import { DefaultHookExecutor, type HookHandlerExecutorOptions } from "./executors/index.js";
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

export interface SessionHookRuntimeOptions extends Pick<
  LoadHookSnapshotOptions,
  "workDir" | "userHome"
> {
  sessionId: string;
}

export interface SessionHookRuntime {
  service: HookService;
  executor: DefaultHookExecutor;
  management: HookManagementService;
  commands: readonly SlashCommand[];
  bind(dependencies: Parameters<DefaultHookExecutor["bind"]>[0]): void;
  reload(changedPaths?: readonly string[]): Promise<boolean>;
  activateComponentSource(source: HookConfigSourceSpec): Promise<() => Promise<void>>;
  clearComponentSources(): Promise<void>;
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
  const componentSources = new Map<string, HookConfigSourceSpec>();
  let componentSourceSequence = 0;
  let componentSourceQueue = Promise.resolve();
  let componentTransition: "activate" | "deactivate" | undefined;
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
      if (componentTransition === "deactivate") return true;
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
      void service
        .dispatch("Notification", { level: "error", message })
        .catch((error) =>
          logger.warn({ error: errorMessage(error) }, "[Hook] Notification 事件执行失败"),
        );
    },
    dynamicSources: () => ({ componentSources: [...componentSources.values()] }),
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

  const serializeComponentSourceChange = async <T>(operation: () => Promise<T>): Promise<T> => {
    const running = componentSourceQueue.then(operation, operation);
    componentSourceQueue = running.then(
      () => undefined,
      () => undefined,
    );
    return await running;
  };

  const activateComponentSource = async (
    source: HookConfigSourceSpec,
  ): Promise<() => Promise<void>> => {
    if (source.kind !== "skill" && source.kind !== "agent") {
      throw new Error("组件 Hook source 只允许 skill/agent");
    }
    if (!source.componentId || source.inlineHooks === undefined) {
      throw new Error("组件 Hook source 缺少 componentId/inlineHooks");
    }
    const key = `${source.kind}:${source.componentId}:${source.path}:${++componentSourceSequence}`;
    await serializeComponentSourceChange(async () => {
      componentSources.set(key, source);
      componentTransition = "activate";
      const accepted = await reloader.reload([source.path]).finally(() => {
        componentTransition = undefined;
      });
      if (!accepted) {
        componentSources.delete(key);
        throw new Error(`组件 Hook source 激活被拒绝: ${source.componentId}`);
      }
    });
    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      await serializeComponentSourceChange(async () => {
        componentSources.delete(key);
        componentTransition = "deactivate";
        const accepted = await reloader.reload([source.path]).finally(() => {
          componentTransition = undefined;
        });
        if (!accepted) {
          logger.warn(
            { componentId: source.componentId },
            "[Hook] 组件 Hook source 释放后未能刷新快照",
          );
        }
      });
    };
  };

  const clearComponentSources = async (): Promise<void> =>
    await serializeComponentSourceChange(async () => {
      if (componentSources.size === 0) return;
      const paths = [...componentSources.values()].map((source) => source.path);
      componentSources.clear();
      componentTransition = "deactivate";
      const accepted = await reloader.reload(paths).finally(() => {
        componentTransition = undefined;
      });
      if (!accepted) {
        logger.warn("[Hook] 清空组件 Hook source 后未能刷新快照");
      }
    });

  return {
    service,
    executor,
    management,
    commands,
    bind: (dependencies) => executor.bind(dependencies),
    reload: async (changedPaths) => await reloader.reload(changedPaths),
    activateComponentSource,
    clearComponentSources,
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

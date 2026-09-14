import {
  ISOLATED_HEADLESS_COMPLETION_CONTRACT,
  PromptComposer as HostPromptComposer,
  type PromptLayers,
} from "@pico/pico-host/prompt-composer";
import type { GoalManager } from "@pico/runtime/goal-manager";
import { hostShellDialect } from "../os/shell.js";
import { logger } from "../observability/logger.js";
import { TodoStore } from "./todo-store.js";
import { SkillLoader } from "./skill.js";

export { ISOLATED_HEADLESS_COMPLETION_CONTRACT };
export type { PromptLayers };
export type {
  PromptComposerLogger,
  PromptGoalManager,
  PromptSkillLoader,
  PromptTodoStore,
} from "@pico/pico-host/prompt-composer";

/** Engine compatibility inputs for Pico Host's prompt assembly policy. */
export interface PromptComposerOptions {
  goalManager?: GoalManager;
  todoStore?: TodoStore;
  skillLoader?: SkillLoader;
  onInstructionsLoaded?: (paths: readonly string[]) => void | Promise<void>;
  isolatedHeadless?: boolean;
  picoHome?: string;
  graphToolsAvailable?: boolean;
  swarmMode?: boolean;
}

/**
 * Compatibility adapter for host-owned prompt composition.
 *
 * Legacy callers retain the source Todo/Skill adapters and product logging; the
 * reusable implementation only receives narrow ports for each dynamic layer.
 */
export class PromptComposer extends HostPromptComposer {
  constructor(workDir: string, planMode = false, options?: PromptComposerOptions) {
    const inputs = options ?? {};
    super(workDir, planMode, {
      ...inputs,
      skillLoader: inputs.skillLoader ?? new SkillLoader(workDir),
      todoStore: inputs.todoStore ?? new TodoStore(workDir),
      logger,
      hostShellDialect,
    });
  }
}

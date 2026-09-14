import {
  SubagentRunner as RuntimeSubagentRunner,
  type SubagentRunnerOptions as RuntimeSubagentRunnerOptions,
} from "@pico/runtime/subagent-runner";
import { SkillLoader } from "./product-skill-catalog.js";
import { logger } from "./logger.js";

export type {
  SubagentResult,
  SubagentRunOptions,
  SubagentExecutionRuntime,
} from "@pico/runtime/subagent-runner";

export type SubagentRunnerOptions = Omit<
  RuntimeSubagentRunnerOptions,
  "diagnostics" | "skillLoaderFactory"
> & {
  readonly skillLoaderFactory?: (workDir: string) => SkillLoader;
};

/** Direct Host embeddings preserve the default product catalog and structured logging. */
export class SubagentRunner extends RuntimeSubagentRunner {
  constructor(options: SubagentRunnerOptions) {
    super({
      ...options,
      diagnostics: logger,
      skillLoaderFactory: options.skillLoaderFactory ?? ((workDir) => new SkillLoader(workDir)),
    });
  }
}

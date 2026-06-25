import {
  BashTool,
  EditFileTool,
  ReadFileTool,
  ToolRegistry,
  WriteFileTool,
} from "./registry-impl.js";
import type { RequestMiddleware } from "./registry.js";
import { isDangerousCommand, isHardlineCommand } from "../approval/manager.js";
import { SkillLoader, SkillViewTool } from "../context/skill.js";
import type { AgentRunner, SubagentRegistryFactory, SubagentRegistryRequest } from "./subagent.js";
import { DelegateTaskTool } from "./subagent.js";
import { DelegateStatusTool, type DelegationManager } from "./delegation-manager.js";

export interface SubagentRegistryFactoryConfig {
  workDir: string;
  runner: AgentRunner;
  manager: DelegationManager;
  maxSpawnDepth?: number;
}

export function createSubagentRegistryFactory(
  config: SubagentRegistryFactoryConfig,
): SubagentRegistryFactory {
  return (request: SubagentRegistryRequest) => {
    const registry = new ToolRegistry();
    registry.register(new ReadFileTool(config.workDir));
    registry.register(new SkillViewTool(new SkillLoader(config.workDir)));

    const bash = new BashTool(config.workDir);
    if (request.mode === "explore") {
      (bash as BashTool & { readOnly?: boolean }).readOnly = true;
    }
    registry.register(bash);

    if (request.mode === "worker") {
      registry.register(new WriteFileTool(config.workDir));
      registry.register(new EditFileTool(config.workDir));
    }

    registry.use(buildSubagentSafetyMiddleware(request.mode));
    registry.register(new DelegateStatusTool(config.manager));

    const maxSpawnDepth = request.maxSpawnDepth ?? config.maxSpawnDepth ?? 2;
    if (request.role === "orchestrator" && request.depth < maxSpawnDepth) {
      registry.register(
        new DelegateTaskTool(config.runner, createSubagentRegistryFactory(config), config.manager, {
          depth: request.depth,
          maxSpawnDepth,
          role: request.role,
        }),
      );
    }

    return registry;
  };
}

function buildSubagentSafetyMiddleware(mode: "explore" | "worker"): RequestMiddleware {
  return async (call) => {
    if (mode === "explore" && call.name === "bash" && isBashMutation(call.arguments)) {
      return {
        allowed: false,
        reason: "子代理只读模式禁止 bash 写入或破坏性命令。",
      };
    }

    if (
      mode === "worker" &&
      (isHardlineCommand(call.name, call.arguments) ||
        isDangerousCommand(call.name, call.arguments))
    ) {
      return {
        allowed: false,
        reason: "worker 子代理禁止执行高危命令;请由主 Agent 或人工审批处理。",
      };
    }

    return { allowed: true };
  };
}

function isBashMutation(args: string): boolean {
  const command = extractBashCommand(args);
  return BASH_MUTATION_PATTERNS.some((pattern) => pattern.test(command));
}

function extractBashCommand(args: string): string {
  try {
    const parsed = JSON.parse(args) as { command?: string };
    return parsed.command ?? args;
  } catch {
    return args;
  }
}

const BASH_MUTATION_PATTERNS: RegExp[] = [
  />|>>|&>|2>/,
  /\btee\b/i,
  /\btouch\b/i,
  /\bmkdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\brm\b/i,
  /\brmdir\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bsed\s+-i\b/i,
  /\bperl\s+-pi\b/i,
  /\bpython(?:3)?\b.*\b(open|write_text|unlink|rmtree|remove)\b/i,
  /\bnode\b.*\b(writeFile|rmSync|unlinkSync|mkdirSync)\b/i,
  /\bgit\s+(commit|push|reset|checkout|switch|merge|rebase|clean|apply|am)\b/i,
  /\b(?:npm|pnpm|yarn)\s+(install|i|add|remove|uninstall|update|upgrade)\b/i,
];

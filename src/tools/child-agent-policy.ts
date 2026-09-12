import { isDangerousCommand, isHardlineCommand } from "../approval/manager.js";
import { bashCommandFromArgs } from "../approval/bash-paths.js";
import { classifyBashCommand, type BashSafetyClassification } from "../approval/bash-safety.js";
import {
  classifyPowerShellCommand,
  type PowerShellSafetyClassification,
} from "../approval/powershell-safety.js";
import { isSensitiveCredentialPath } from "../approval/session-permissions.js";
import { createCodeIntelligenceTools } from "./code-intelligence.js";
import type { CodeIntelligenceService } from "../code-intelligence/types.js";
import { SkillLoader, SkillViewTool } from "../context/skill.js";
import { hostShellDialect } from "../os/shell.js";
import type { SandboxProfile } from "../safety/process-sandbox/index.js";
import {
  evaluateWorkspaceToolCall,
  type WorkspaceSandboxConfig,
} from "../safety/workspace-sandbox.js";
import type { BaseTool, RequestMiddleware } from "./registry.js";
import {
  BashTool,
  EditFileTool,
  ReadFileTool,
  ToolRegistry,
  WriteFileTool,
} from "./registry-impl.js";
import { GlobTool } from "./glob.js";
import { GrepTool } from "./grep.js";
import { WebSearchTool } from "./web.js";
import { buildWorkspaceBoundaryMiddleware, WorkspaceRoots } from "./workspace-roots.js";

export interface ChildAgentProcessSandbox {
  readonly config?: Partial<WorkspaceSandboxConfig>;
  readonly scratchRoot?: string;
  readonly generation?: number;
}

type ChildAgentToolConstructor = (
  workDir: string,
  workspaceRoots?: WorkspaceRoots,
  processSandbox?: ChildAgentProcessSandbox,
  profile?: SandboxProfile,
) => BaseTool;

/** Tool constructors for the current configured child-session profiles. */
export const CHILD_AGENT_TOOL_CONSTRUCTORS: Readonly<Record<string, ChildAgentToolConstructor>> = {
  read_file: (workDir, roots) => new ReadFileTool(roots ?? workDir),
  write_file: (workDir, roots) => new WriteFileTool(roots ?? workDir),
  edit_file: (workDir, roots) => new EditFileTool(roots ?? workDir),
  bash: (workDir, roots, processSandbox, profile = "workspace-write") =>
    new BashTool(workDir, undefined, {
      allowBackground: false,
      origin: "subagent",
      env: process.env,
      ...(roots
        ? {
            sandbox: {
              workspaceRoots: roots,
              profile,
              ...(processSandbox?.config ? { config: processSandbox.config } : {}),
              ...(processSandbox?.scratchRoot ? { scratchRoot: processSandbox.scratchRoot } : {}),
              ...(processSandbox?.generation !== undefined
                ? { generation: processSandbox.generation }
                : {}),
            },
          }
        : {}),
    }),
  glob: (workDir, roots) => new GlobTool(roots ?? workDir),
  grep: (workDir, roots, processSandbox, profile = "read-only") =>
    new GrepTool(roots ?? workDir, {
      excludeSensitiveFiles: true,
      processSandbox: {
        profile,
        ...(processSandbox?.config ? { config: processSandbox.config } : {}),
        ...(processSandbox?.scratchRoot ? { scratchRoot: processSandbox.scratchRoot } : {}),
        ...(processSandbox?.generation !== undefined
          ? { generation: processSandbox.generation }
          : {}),
      },
    }),
  web_search: () => new WebSearchTool(),
};

/** Fixed read-only tool surface used by model-backed Hook verification. */
export function createHookVerifierRegistry(options: {
  readonly workDir: string;
  readonly workspaceRoots: WorkspaceRoots;
  readonly processSandbox: ChildAgentProcessSandbox;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly codeIntelligence?: CodeIntelligenceService;
}): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new ReadFileTool(options.workspaceRoots));
  registry.register(new SkillViewTool(new SkillLoader(options.workDir)));
  const bash = new BashTool(options.workDir, undefined, {
    allowBackground: false,
    origin: "subagent",
    env: { ...options.env },
    sandbox: {
      workspaceRoots: options.workspaceRoots,
      profile: "read-only",
      ...(options.processSandbox.config ? { config: options.processSandbox.config } : {}),
      ...(options.processSandbox.scratchRoot
        ? { scratchRoot: options.processSandbox.scratchRoot }
        : {}),
      ...(options.processSandbox.generation !== undefined
        ? { generation: options.processSandbox.generation }
        : {}),
    },
  });
  (bash as BashTool & { readOnly?: boolean }).readOnly = true;
  registry.register(bash);
  registry.register(new GlobTool(options.workspaceRoots));
  registry.register(
    new GrepTool(options.workspaceRoots, {
      excludeSensitiveFiles: true,
      processSandbox: {
        profile: "read-only",
        ...(options.processSandbox.config ? { config: options.processSandbox.config } : {}),
        ...(options.processSandbox.scratchRoot
          ? { scratchRoot: options.processSandbox.scratchRoot }
          : {}),
        ...(options.processSandbox.generation !== undefined
          ? { generation: options.processSandbox.generation }
          : {}),
        env: { ...options.env },
      },
    }),
  );
  if (options.codeIntelligence) {
    for (const tool of createCodeIntelligenceTools(options.workDir, options.codeIntelligence)) {
      registry.register(tool);
    }
  }
  registry.use(buildChildAgentSafetyMiddleware("explore", options));
  registry.useSafety(buildWorkspaceBoundaryMiddleware(options.workspaceRoots));
  return registry;
}

export function buildChildAgentSafetyMiddleware(
  mode: "explore" | "worker",
  config: {
    readonly workDir: string;
    readonly workspaceRoots: WorkspaceRoots;
    readonly processSandbox?: ChildAgentProcessSandbox;
  },
): RequestMiddleware {
  return async (call) => {
    if (call.name === "read_file" || call.name === "grep") {
      const path = jsonStringField(call.arguments, "path");
      if (
        path !== undefined &&
        isSensitiveCredentialPath(config.workspaceRoots.resolveUnchecked(path))
      ) {
        return { allowed: false, reason: "子代理不允许读取密钥、.env 或凭据路径。" };
      }
    }
    if (config.processSandbox) {
      const decision = evaluateWorkspaceToolCall(
        call,
        config.workDir,
        config.workspaceRoots,
        config.processSandbox.config,
      );
      if (!decision.allowed) {
        return { allowed: false, reason: decision.reason ?? "子代理沙箱边界拒绝。" };
      }
    }
    if (mode === "explore" && call.name === "bash") {
      const command = bashCommandFromArgs(call.arguments);
      let classification: PowerShellSafetyClassification | BashSafetyClassification | undefined;
      if (command !== undefined) {
        try {
          classification =
            hostShellDialect() === "powershell"
              ? classifyPowerShellCommand(command)
              : classifyBashCommand(command);
        } catch {
          classification = undefined;
        }
      }
      if (classification?.kind !== "read-only") {
        return {
          allowed: false,
          reason: `子代理只读模式只允许可证明只读的 Bash${classification ? `；${classification.reason}` : ""}。`,
        };
      }
    }
    if (
      mode === "worker" &&
      (isHardlineCommand(call.name, call.arguments, config.workDir) ||
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

function jsonStringField(args: string, field: string): string | undefined {
  try {
    const value = (JSON.parse(args) as Record<string, unknown>)[field];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

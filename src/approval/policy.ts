// 细粒度权限策略链：参考 Kimi Code 的 17 个 Policy 设计。
//
// 每个 Policy 返回 allow/deny/ask 三态决策。Policy 按顺序执行：
//   - 任何一个 deny → 直接拒绝
//   - 任何一个 ask → 需要人工审批
//   - 全部 allow → 放行
//
// 现有 manager.ts 的 isDangerousCommand + ApprovalPolicy 是这个设计的雏形，
// 本文件将其扩展为更完整的 Policy 链，新增敏感文件保护、Git 目录保护、Plan 守卫。

import type { ToolCall } from "../schema/message.js";
import { isDangerousCommand, isHardlineCommand } from "./manager.js";

// ──────────────────────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────────────────────

export type PermissionDecision = "allow" | "deny" | "ask";

export interface PolicyContext {
  /** 当前工具调用 */
  toolCall: ToolCall;
  /** 工作区目录 */
  workDir: string;
  /** 是否处于 Plan Mode */
  planMode: boolean;
  /** Session 级审批记忆："approve for session" 记录的 key 集合 */
  sessionApprovals: Set<string>;
}

export interface PolicyResult {
  decision: PermissionDecision;
  reason?: string;
  /** 如果 true，跳过后续所有 Policy（用于 SessionApproval 短路） */
  shortCircuit?: boolean;
}

export interface PermissionPolicy {
  /** Policy 名称，用于日志和调试 */
  name: string;
  /** 评估函数：返回 allow/deny/ask */
  evaluate(ctx: PolicyContext): PolicyResult;
}

// ──────────────────────────────────────────────────────────────
// Policy 1: 高危命令检测（搬运现有正则）
// ──────────────────────────────────────────────────────────────

export class DangerousCommandPolicy implements PermissionPolicy {
  name = "DangerousCommand";

  evaluate(ctx: PolicyContext): PolicyResult {
    const { toolCall } = ctx;
    const args = toolCall.arguments;

    // 硬拒绝：不可逆操作（rm -rf /, mkfs, dd of=/dev/, fork bomb, shutdown, reboot, force push main）
    if (isHardlineCommand(toolCall.name, args)) {
      return {
        decision: "deny",
        reason: "Hardline 高危命令，系统直接拒绝（不可逆操作）。",
      };
    }

    // 需审批：危险命令（rm, sudo, git push --force, kubectl delete 等）
    if (isDangerousCommand(toolCall.name, args)) {
      return {
        decision: "ask",
        reason: "检测到高危命令，需要人工审批。",
      };
    }

    return { decision: "allow" };
  }
}

// ──────────────────────────────────────────────────────────────
// Policy 2: 敏感文件保护
// ──────────────────────────────────────────────────────────────

/** 敏感文件模式：匹配到就需审批 */
const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /\.env$/i,              // .env（含 .env.local, .env.production 等）
  /\.env\b/i,             // .env.*
  /id_rsa/i,              // SSH 私钥
  /id_ed25519/i,          // SSH ed25519 私钥
  /id_ecdsa/i,            // SSH ecdsa 私钥
  /credentials/i,         // 通用 credentials 文件
  /\.aws\/credentials/i,  // AWS credentials
  /\.aws\/config/i,       // AWS config
  /\.ssh\//i,             // .ssh 目录下任何文件
  /\.gnupg\//i,           // GPG 密钥
  /\.npmrc$/i,            // npm token
  /\.pypirc$/i,           // PyPI token
  /\.docker\/config\.json/i, // Docker credentials
  /_rsa/i,                // RSA 私钥文件
  /\.pem$/i,              // PEM 证书
  /\.key$/i,              // 密钥文件
  /favicon\.ico$/i,       // favicon.ico 是一个特例，跳过
];

/** 豁免模式：即使是敏感文件名也不拦截 */
const SENSITIVE_FILE_EXEMPTIONS: RegExp[] = [
  /\.env\.example$/i,     // .env.example 是示例文件
  /\.env\.sample$/i,      // .env.sample
  /\.env\.template$/i,    // .env.template
  /\.env\.dist$/i,        // .env.dist
  /id_rsa\.pub/i,         // 公钥不敏感
  /id_ed25519\.pub/i,
  /id_ecdsa\.pub/i,
  /favicon\.ico$/i,       // 修正：favicon 不是敏感文件
];

function extractFilePath(toolName: string, args: string): string | null {
  if (toolName === "read_file" || toolName === "write_file" || toolName === "edit_file") {
    try {
      const parsed = JSON.parse(args) as { path?: string };
      return parsed.path ?? null;
    } catch {
      return null;
    }
  }
  // bash 命令中可能包含文件路径，但难以静态分析，跳过
  return null;
}

export class SensitiveFilePolicy implements PermissionPolicy {
  name = "SensitiveFile";

  evaluate(ctx: PolicyContext): PolicyResult {
    const filePath = extractFilePath(ctx.toolCall.name, ctx.toolCall.arguments);
    if (!filePath) return { decision: "allow" };

    // 先检查豁免
    for (const exempt of SENSITIVE_FILE_EXEMPTIONS) {
      if (exempt.test(filePath)) return { decision: "allow" };
    }

    // 再检查敏感
    for (const pattern of SENSITIVE_FILE_PATTERNS) {
      if (pattern.test(filePath)) {
        return {
          decision: "ask",
          reason: `敏感文件保护：${filePath} 可能包含密钥或凭证，需要人工审批。`,
        };
      }
    }

    return { decision: "allow" };
  }
}

// ──────────────────────────────────────────────────────────────
// Policy 3: Git 控制目录保护
// ──────────────────────────────────────────────────────────────

const GIT_DIR_PATTERN = /\.git\//i;

export class GitDirectoryPolicy implements PermissionPolicy {
  name = "GitDirectory";

  evaluate(ctx: PolicyContext): PolicyResult {
    // 只对写操作生效
    if (ctx.toolCall.name !== "write_file" && ctx.toolCall.name !== "edit_file" && ctx.toolCall.name !== "bash") {
      return { decision: "allow" };
    }

    const filePath = extractFilePath(ctx.toolCall.name, ctx.toolCall.arguments);
    if (filePath && GIT_DIR_PATTERN.test(filePath)) {
      return {
        decision: "ask",
        reason: `Git 目录保护：${filePath} 在 .git/ 目录下，写入可能破坏版本控制，需要人工审批。`,
      };
    }

    // bash 命令中检查是否操作 .git 目录
    if (ctx.toolCall.name === "bash") {
      const args = ctx.toolCall.arguments;
      // 检查 rm/mv/cp 等命令是否目标 .git/
      if (GIT_DIR_PATTERN.test(args) && /\b(rm|mv|cp|cat.*>|echo.*>)\b/i.test(args)) {
        return {
          decision: "ask",
          reason: "Git 目录保护：bash 命令操作 .git/ 目录，需要人工审批。",
        };
      }
    }

    return { decision: "allow" };
  }
}

// ──────────────────────────────────────────────────────────────
// Policy 4: Plan Mode 守卫
// ──────────────────────────────────────────────────────────────

/** Plan Mode 下允许写的文件 */
const PLAN_MODE_ALLOWED_FILES = ["PLAN.md", "TODO.md"];

export class PlanModeGuardPolicy implements PermissionPolicy {
  name = "PlanModeGuard";

  evaluate(ctx: PolicyContext): PolicyResult {
    if (!ctx.planMode) return { decision: "allow" };

    // Plan Mode 下只允许写 PLAN.md 和 TODO.md
    if (ctx.toolCall.name === "write_file" || ctx.toolCall.name === "edit_file") {
      const filePath = extractFilePath(ctx.toolCall.name, ctx.toolCall.arguments);
      if (filePath) {
        const basename = filePath.split("/").pop() ?? filePath;
        if (!PLAN_MODE_ALLOWED_FILES.includes(basename)) {
          return {
            decision: "deny",
            reason: `Plan Mode 守卫：当前处于 Plan Mode，只能修改 ${PLAN_MODE_ALLOWED_FILES.join(" / ")}。请先退出 Plan Mode 或修改计划文件。`,
          };
        }
      }
    }

    // bash 命令在 Plan Mode 下也限制写操作
    if (ctx.toolCall.name === "bash") {
      const args = ctx.toolCall.arguments;
      // 检查是否有重定向写文件（非 PLAN.md/TODO.md）
      const redirectMatch = args.match(/>\s*([^|>\s"']+)/g);
      if (redirectMatch) {
        for (const redirect of redirectMatch) {
          const target = redirect.replace(/^>\s*/, "").trim();
          const basename = target.split("/").pop() ?? target;
          if (!PLAN_MODE_ALLOWED_FILES.includes(basename)) {
            return {
              decision: "deny",
              reason: `Plan Mode 守卫：bash 重定向到 ${target}，但 Plan Mode 下只能写计划文件。`,
            };
          }
        }
      }
    }

    return { decision: "allow" };
  }
}

// ──────────────────────────────────────────────────────────────
// Policy 5: Session 审批记忆
// ──────────────────────────────────────────────────────────────

export class SessionApprovalPolicy implements PermissionPolicy {
  name = "SessionApproval";

  evaluate(ctx: PolicyContext): PolicyResult {
    // 检查用户之前是否选了"approve for session"
    const key = this.approvalKey(ctx.toolCall);
    if (ctx.sessionApprovals.has(key)) {
      return {
        decision: "allow",
        reason: "Session 审批记忆：用户之前已对此类操作授权（approve for session）。",
        shortCircuit: true, // 匹配到记忆，短路后续 Policy
      };
    }
    return { decision: "allow" }; // 不匹配也不拦截，只是跳过
  }

  /** 生成审批记忆的 key：工具名 + 文件路径（如果有） */
  private approvalKey(toolCall: ToolCall): string {
    const filePath = extractFilePath(toolCall.name, toolCall.arguments);
    if (filePath) {
      return `${toolCall.name}:${filePath}`;
    }
    // bash 命令用工具名 + 命令前缀（前 50 字符）
    return `${toolCall.name}:${toolCall.arguments.slice(0, 50)}`;
  }
}

// ──────────────────────────────────────────────────────────────
// PermissionManager：Policy 链调度器
// ──────────────────────────────────────────────────────────────

/**
 * PermissionManager：持有 Policy 链，按顺序执行。
 *
 * 执行顺序：
 *   1. SessionApprovalPolicy — 先检查是否已记忆授权（短路 allow）
 *   2. PlanModeGuardPolicy — Plan Mode 守卫（deny 优先级最高）
 *   3. SensitiveFilePolicy — 敏感文件保护
 *   4. GitDirectoryPolicy — Git 目录保护
 *   5. DangerousCommandPolicy — 高危命令检测
 *
 * 任何一个 Policy 返回 deny → 直接拒绝
 * 任何一个 Policy 返回 ask → 需要人工审批
 * 全部 allow → 放行
 */
export class PermissionManager {
  private readonly policies: PermissionPolicy[];
  readonly sessionApprovals: Set<string>;

  constructor(policies?: PermissionPolicy[]) {
    this.sessionApprovals = new Set<string>();
    this.policies = policies ?? [
      new SessionApprovalPolicy(),   // 先检查记忆（短路）
      new PlanModeGuardPolicy(),      // Plan 守卫（deny 优先）
      new SensitiveFilePolicy(),      // 敏感文件
      new GitDirectoryPolicy(),        // Git 目录
      new DangerousCommandPolicy(),   // 高危命令
    ];
  }

  /**
   * 评估工具调用是否需要审批。
   * @returns allow/deny/ask + reason
   */
  evaluate(ctx: PolicyContext): PolicyResult {
    for (const policy of this.policies) {
      const result = policy.evaluate(ctx);
      if (result.decision === "deny") {
        return result; // deny 立即短路
      }
      if (result.decision === "ask") {
        return result; // ask 也立即返回（需要审批）
      }
      // allow: 检查是否需要短路（如 SessionApproval 匹配记忆）
      if (result.shortCircuit) {
        return result; // 短路 allow，跳过后续 Policy
      }
      // 普通 allow，继续下一个 Policy
    }
    return { decision: "allow" };
  }

  /** 记录"approve for session"决策 */
  rememberApproval(toolCall: ToolCall): void {
    const filePath = extractFilePath(toolCall.name, toolCall.arguments);
    const key = filePath
      ? `${toolCall.name}:${filePath}`
      : `${toolCall.name}:${toolCall.arguments.slice(0, 50)}`;
    this.sessionApprovals.add(key);
  }

  /** 清除所有审批记忆 */
  clearApprovals(): void {
    this.sessionApprovals.clear();
  }
}

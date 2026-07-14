// HookRunner:执行用户配置的 Shell Hooks。
//
// 对应任务 2.6:PreToolUse / PostToolUse 钩子执行器。
//
// 协议(对齐 Claude Code / Codex / Kimi Code 三家):
//   - spawn shell 子进程,stdin 传 JSON(input)
//   - exit 0:解析 stdout JSON,若 {permissionDecision:"deny"/decision:"block"} → deny,否则 allow
//   - exit 2:deny,reason=stderr(反馈给模型)
//   - 其他 exit code:fail-open allow
//   - 超时 / spawn 失败 / 任何异常:fail-open allow
//
// **fail-open 铁律**:hook 是用户脚本,任何故障都不能阻断工具执行。
// 宁可放过也不可误杀——hook 挂了不该让 agent 瘫痪。

import { spawn, type ChildProcess } from "node:child_process";
import { logger } from "../observability/logger.js";
import type {
  HookEvent,
  HookHandler,
  HookInput,
  HookMatcherGroup,
  HookOutput,
  HooksConfig,
  HookEventPayloadMap,
} from "./types.js";

/** 默认 hook 超时(ms):60s。超时后 kill 子进程并 fail-open。 */
const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
const MAX_HOOK_OUTPUT_BYTES = 1024 * 1024;

/**
 * 钩子执行器。绑定到固定 workDir 与 HooksConfig(构造后不可变)。
 *
 * 用法:
 *   const runner = new HookRunner(workDir, config);
 *   const out = await runner.runPreToolUse(toolName, toolInput, sessionId);
 *   if (out.decision === "deny") { ... 阻断 ... }
 *   await runner.runPostToolUse(toolName, toolInput, toolResponse, sessionId);
 */
export class HookRunner {
  constructor(
    private readonly workDir: string,
    private readonly config: HooksConfig,
  ) {}

  /**
   * 执行 PreToolUse 钩子。
   * 遍历所有匹配的 matcher 组,逐个执行 handler:
   *   - 任一 handler 返回 deny → 立即短路返回 deny(不再执行后续)
   *   - 全部 allow → 返回 allow
   *   - modifiedInput:首个提供 modifiedInput 的 handler 生效,后续忽略
   *
   * @returns 钩子决策;任何故障均 fail-open 返回 allow
   */
  async runPreToolUse(
    toolName: string,
    toolInput: unknown,
    sessionId: string,
  ): Promise<HookOutput> {
    return this.runEvent("PreToolUse", toolName, toolInput, sessionId, undefined);
  }

  /**
   * 执行 PostToolUse 钩子(fire-and-forget,不阻断)。
   * 遍历所有匹配的 handler 执行,丢弃返回结果;任何故障均静默忽略。
   */
  async runPostToolUse(
    toolName: string,
    toolInput: unknown,
    toolResponse: string,
    sessionId: string,
  ): Promise<void> {
    // PostToolUse 永远不阻断:复用 runEvent 但忽略其 deny 决策
    await this.runEvent("PostToolUse", toolName, toolInput, sessionId, toolResponse);
  }

  /**
   * 执行某事件下所有匹配的 handler。
   *
   * @param event 钩子事件(PreToolUse / PostToolUse)
   * @param toolResponse 仅 PostToolUse 提供
   * @returns 聚合决策;PreToolUse 下 deny 短路,PostToolUse 永远 allow
   */
  private async runEvent(
    event: HookEvent,
    toolName: string,
    toolInput: unknown,
    sessionId: string,
    toolResponse: string | undefined,
  ): Promise<HookOutput> {
    const groups = this.config[event];
    if (!groups || groups.length === 0) {
      return { decision: "allow" };
    }

    let modifiedInput: unknown;
    for (const group of groups) {
      if (!matcherMatches(group, toolName)) continue;
      for (const handler of group.hooks) {
        const result = await this.executeHandler(
          handler,
          event,
          toolName,
          toolInput,
          sessionId,
          toolResponse,
        );
        // PreToolUse:deny 短路
        if (result.decision === "deny") {
          return result;
        }
        // 收集首个 modifiedInput
        if (modifiedInput === undefined && result.modifiedInput !== undefined) {
          modifiedInput = result.modifiedInput;
        }
      }
    }

    return modifiedInput !== undefined
      ? { decision: "allow", modifiedInput }
      : { decision: "allow" };
  }

  /**
   * 执行单个 handler:spawn 子进程 → 写 stdin → 等待 exit → 判定。
   * 全程 try-catch 包裹,任何异常 → fail-open allow。
   */
  private async executeHandler(
    handler: HookHandler,
    event: HookEvent,
    toolName: string,
    toolInput: unknown,
    sessionId: string,
    toolResponse: string | undefined,
  ): Promise<HookOutput> {
    if (handler.type !== "command") {
      logger.warn({ event, type: handler.type }, "[Hook] legacy runner 忽略非 command handler");
      return { decision: "allow" };
    }
    const payload = {
      tool_name: toolName,
      tool_input: toolInput,
      ...(toolResponse !== undefined ? { tool_response: toolResponse } : {}),
    } as HookEventPayloadMap[HookEvent];
    const input: HookInput = {
      session_id: sessionId,
      cwd: this.workDir,
      hook_event_name: event,
      payload,
      tool_name: toolName,
      tool_input: toolInput,
      ...(toolResponse !== undefined ? { tool_response: toolResponse } : {}),
    };
    const timeoutMs = handler.timeoutMs ?? handler.timeout ?? DEFAULT_HOOK_TIMEOUT_MS;

    try {
      return await this.spawnAndWait(handler.command, input, timeoutMs);
    } catch (err) {
      // 任何 spawn / IO / 解析异常:fail-open 放行,绝不阻断工具
      logger.warn({ err: String(err), event, tool: toolName }, `[Hook] 执行失败,fail-open 放行`);
      return { decision: "allow" };
    }
  }

  /**
   * spawn shell 子进程,写 stdin,等待 exit,判定结果。
   * 抛出的异常由上层 executeHandler 兜成 fail-open。
   */
  private spawnAndWait(command: string, input: HookInput, timeoutMs: number): Promise<HookOutput> {
    return new Promise<HookOutput>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(command, {
          shell: true,
          cwd: this.workDir,
          windowsHide: true,
          // 让子进程继承关闭的 stdio:stdin 可写、stdout/stderr 可读
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        // spawn 同步失败 → fail-open
        resolve({ decision: "allow" });
        return;
      }

      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let settled = false;
      const finish = (result: HookOutput) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      // 超时:kill 子进程后 fail-open
      const timer = setTimeout(() => {
        killProcessTree(child);
        logger.warn({ timeoutMs, command }, `[Hook] 超时,fail-open 放行`);
        finish({ decision: "allow" });
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        if (settled) return;
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_HOOK_OUTPUT_BYTES) {
          killProcessTree(child);
          logger.warn(
            { command, maxBytes: MAX_HOOK_OUTPUT_BYTES },
            `[Hook] 输出超过上限,fail-open 放行`,
          );
          finish({ decision: "allow" });
          return;
        }
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (settled) return;
        outputBytes += chunk.byteLength;
        if (outputBytes > MAX_HOOK_OUTPUT_BYTES) {
          killProcessTree(child);
          logger.warn(
            { command, maxBytes: MAX_HOOK_OUTPUT_BYTES },
            `[Hook] 输出超过上限,fail-open 放行`,
          );
          finish({ decision: "allow" });
          return;
        }
        stderr += chunk.toString("utf8");
      });

      child.on("error", (err) => {
        // spawn 触发但进程未能启动(如 shell 不存在)→ fail-open
        logger.warn({ err: String(err), command }, `[Hook] spawn error,fail-open 放行`);
        finish({ decision: "allow" });
      });

      child.on("close", (code: number | null) => {
        finish(interpretExit(code, stdout, stderr));
      });

      // Pipe failures are emitted asynchronously and cannot be caught by the
      // write() try/catch below. A hook that exits before reading stdin must
      // remain fail-open instead of becoming an unhandled EPIPE.
      child.stdin?.once("error", (err) => {
        logger.warn({ err: String(err), command }, `[Hook] stdin error,fail-open 放行`);
        killProcessTree(child);
        finish({ decision: "allow" });
      });

      // 写 stdin(JSON 输入)。同步写失败也按 fail-open 处理。
      try {
        child.stdin?.write(JSON.stringify(input));
        child.stdin?.end();
      } catch {
        killProcessTree(child);
        finish({ decision: "allow" });
      }
    });
  }
}

/**
 * 解释子进程 exit code + stdout + stderr → HookOutput。
 *
 * 协议:
 *   - exit 0:解析 stdout JSON。permissionDecision:"deny" / decision:"block" → deny;
 *     其余 → allow。modifiedInput 存在则透传。
 *   - exit 2:deny,reason = stderr(反馈给模型)。
 *   - 其他 exit:fail-open allow。
 */
function interpretExit(code: number | null, stdout: string, stderr: string): HookOutput {
  if (code === 0) {
    return parseAllowStdout(stdout);
  }
  if (code === 2) {
    return {
      decision: "deny",
      ...(stderr.trim() ? { reason: stderr.trim() } : { reason: "PreToolUse hook 阻断(exit 2)" }),
    };
  }
  // 其他 exit code:fail-open
  return { decision: "allow" };
}

/**
 * 解析 exit 0 的 stdout JSON,判定是否阻断 + 是否改写输入。
 *
 * 兼容三家协议字段:
 *   - {permissionDecision:"deny", permissionDecisionReason:"..."} → deny(Claude Code 风格)
 *   - {decision:"block", reason:"..."} → deny(Codex 风格)
 *   - {modifiedInput:{...}} → 改写工具输入(若存在)
 *
 * 无 stdout / 非法 JSON / 其他 → allow。
 */
function parseAllowStdout(stdout: string): HookOutput {
  const trimmed = stdout.trim();
  if (trimmed === "") return { decision: "allow" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // 非法 JSON:当作普通输出,放行
    return { decision: "allow" };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { decision: "allow" };
  }
  const obj = parsed as Record<string, unknown>;

  // 判定 deny:两种协议字段
  const isDeny = obj.permissionDecision === "deny" || obj.decision === "block";
  if (isDeny) {
    const reason =
      (typeof obj.permissionDecisionReason === "string" && obj.permissionDecisionReason) ||
      (typeof obj.reason === "string" && obj.reason) ||
      "PreToolUse hook 阻断";
    return { decision: "deny", reason };
  }

  // 改写输入:modifiedInput 字段存在则透传(无论其值,由 registry 替换 arguments)
  if ("modifiedInput" in obj) {
    return { decision: "allow", modifiedInput: obj.modifiedInput };
  }
  return { decision: "allow" };
}

// ==========================================
// matcher 过滤(三模式,照搬 Codex 源码)
// ==========================================

/**
 * 判断某 matcher 组是否命中指定工具名。
 *
 * 三模式(matcher 来自 HookMatcherGroup.matcher):
 *   1. 空 / 省略 / "*" → 全匹配
 *   2. 纯 [A-Za-z0-9_|] → 精确 `|` 分隔匹配(如 "Read|Write|Edit")
 *   3. 其他 → 作为正则匹配 tool_name(如 ".*" / "Write|Edit")
 *
 * 正则编译失败 → 不匹配(保守,避免误触发)。
 */
export function matcherMatches(group: HookMatcherGroup, toolName: string): boolean {
  const matcher = group.matcher;
  if (matcher === undefined || matcher === "" || matcher === "*") {
    return true; // 全匹配
  }

  // 模式 2:纯 [A-Za-z0-9_|] → 精确 | 分隔匹配
  if (/^[A-Za-z0-9_|]+$/.test(matcher)) {
    const names = matcher.split("|");
    return names.includes(toolName);
  }

  // 模式 3:正则匹配
  try {
    return new RegExp(matcher).test(toolName);
  } catch {
    // 非法正则:不匹配(保守)
    return false;
  }
}

// ==========================================
// 进程树 kill(跨平台,已知限制)
// ==========================================

/**
 * kill 子进程(含其进程树,尽力而为)。
 *
 * 已知限制(任务说明约定):Windows 上 shell:true 会拉起 cmd.exe → 目标 shell,
 * 直接 kill child 只杀到 cmd 层,孙进程可能残留。极简方案下接受此限制,
 * 仅 kill 直接子进程并记 warn。POSIX 上用负 pid 杀进程组(spawn 默认不新建进程组,
 * 此处退化为 kill 直接 pid)。
 */
function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      // Windows:杀进程树。taskkill /T 杀子树,/F 强制。
      // 注意:shell:true 下孙子进程可能残留(见函数注释限制)。
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      // POSIX:SIGKILL 直接 pid(spawn 默认不新建进程组,孙进程靠子进程自身回收)
      process.kill(child.pid, "SIGKILL");
    }
  } catch (err) {
    // kill 失败忽略:子进程最终会随 timeout 后自行退出或被 OS 回收
    logger.warn({ err: String(err), pid: child.pid }, `[Hook] kill 子进程失败`);
  }
}

import type { ToolCall } from "../schema/message.js";

export type RuntimePermissionMode = "ask" | "auto" | "full-access";

/**
 * 受信工具能力分类。
 *
 * 名称与 Maka 的公开能力分类对齐；`bounded_control` 是 Pico 对仅修改当前
 * Session 内部状态的额外细分。分类用于选择审批策略和解释原因，真正的文件、
 * 网络与进程权限仍由 Execution Boundary / OS sandbox 执行。
 */
export type ToolPermissionCategory =
  | "read"
  | "web_read"
  | "file_write"
  | "fs_destructive"
  | "shell_safe"
  | "shell_unsafe"
  | "git_destructive"
  | "network_send"
  | "privileged"
  | "browser"
  | "computer_use"
  | "client_capability"
  | "custom_tool"
  | "subagent"
  | "bounded_control";

export type PermissionPolicyDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "prompt"; readonly reason: string }
  | { readonly kind: "deny"; readonly reason: string };

const ASK_AUTOMATIC_CATEGORIES: ReadonlySet<ToolPermissionCategory> = new Set([
  "read",
  "subagent",
  "bounded_control",
]);

const AUTO_AUTOMATIC_CATEGORIES: ReadonlySet<ToolPermissionCategory> = new Set([
  ...ASK_AUTOMATIC_CATEGORIES,
  "file_write",
  "web_read",
]);

/**
 * 三种前台权限模式的唯一决策表。未知工具必须先由 Registry 归到
 * `custom_tool`，因此这里没有“默认允许”分支。
 */
export function evaluateToolPermission(
  mode: RuntimePermissionMode,
  category: ToolPermissionCategory,
): PermissionPolicyDecision {
  if (mode === "full-access") return { kind: "allow" };
  if (category === "client_capability") {
    return {
      kind: "deny",
      reason: "客户端开放能力无法由 Host 沙箱约束，仅能在完全访问权限下使用",
    };
  }
  const automatic = mode === "ask" ? ASK_AUTOMATIC_CATEGORIES : AUTO_AUTOMATIC_CATEGORIES;
  if (automatic.has(category)) return { kind: "allow" };
  return { kind: "prompt", reason: permissionReasonForCategory(category) };
}

/**
 * 将一次实际调用映射为类别。内置安全边界由名称兜底，不能被错误的工具元数据
 * 降权；Bash 的字符串分析只改善审批原因，任何返回类别在 ask/auto 下都不会
 * 自动放行。
 */
export function classifyToolPermission(
  call: Pick<ToolCall, "name" | "arguments">,
  getCategory?: (name: string) => ToolPermissionCategory,
): ToolPermissionCategory {
  if (call.name === "bash") return categorizeBashCommand(commandFromArguments(call.arguments));
  if (call.name === "write_file" || call.name === "edit_file") return "file_write";
  if (call.name === "fetch_url" || call.name === "web_search") return "web_read";
  if (call.name === "browser_get_state") return "read";
  if (call.name.startsWith("browser_")) return "browser";
  if (call.name.startsWith("mcp__")) return "network_send";
  return getCategory?.(call.name) ?? "custom_tool";
}

export function permissionReasonForCategory(category: ToolPermissionCategory): string {
  switch (category) {
    case "read":
      return "工具将读取当前已授权范围内的数据";
    case "web_read":
      return "工具将访问公网并读取数据";
    case "file_write":
      return "工具将修改当前工作区文件";
    case "fs_destructive":
      return "Shell 命令可能删除、覆盖或不可逆地破坏文件";
    case "shell_safe":
    case "shell_unsafe":
      return "Shell 可启动任意程序，无法仅靠命令字符串证明安全";
    case "git_destructive":
      return "Shell 命令可能不可逆地改写 Git 状态或远端历史";
    case "network_send":
      return "工具将向外部网络或服务发送数据";
    case "privileged":
      return "Shell 命令可能提权、控制系统服务或终止进程";
    case "browser":
      return "工具将操作当前登录态下的浏览器页面";
    case "computer_use":
      return "工具将观察或操作本机应用程序";
    case "client_capability":
      return "客户端开放能力无法由 Host 沙箱约束";
    case "custom_tool":
      return "工具未声明可自动放行的有界能力";
    case "subagent":
      return "工具将启动受限的子代理执行";
    case "bounded_control":
      return "工具将修改当前 Session 的有界内部状态";
  }
}

// Shell 是图灵完备的执行入口，不存在可靠的“安全命令前缀”。以下规则只为审批
// 卡片挑选更准确的原因；漏掉某个变体仍会落入 shell_unsafe 并要求批准。
const PRIVILEGED_PREFIXES: readonly string[] = [
  "sudo ",
  "su ",
  "chmod ",
  "chown ",
  "chgrp ",
  "mount ",
  "umount ",
  "kill ",
  "killall ",
  "systemctl ",
  "launchctl ",
  "shutdown",
  "reboot",
];

const PRIVILEGED_PATTERNS: readonly RegExp[] = [
  /^(kill|stop-process|spps|taskkill)\b/iu,
  /(^|\s)-verb\s+runas\b/iu,
  /^((start|stop|restart|set|new|remove|suspend|resume)-service|sasv|spsv)\b/iu,
  /^sc\s+(stop|start|pause|continue|delete|config|create|failure|sdset)\b/iu,
  /^net\s+(stop|start|pause|continue)\b/iu,
  /^(stop-computer|restart-computer)\b/iu,
  /^(icacls|takeown|set-acl|runas)\b/iu,
];

const FILESYSTEM_DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /^dd\s+/u,
  /^truncate\b/u,
  /^shred\b/u,
  /^mkfs\b/u,
  /^git\s+restore\s+(\.\s*$|--\s+\S+)/u,
  /^git\s+checkout\s+--\s+\S+/u,
  /^find\s+.*\s-delete\b/u,
  /^find\s+.*\s-exec\s+.*\b(rm|shred|truncate|dd)\b/u,
  /^xargs\s+.*\b(rm|shred|truncate|dd)\b/u,
  /^remove-item\b/iu,
  /^(rm|rmdir|ri|del|erase|rd)\b/iu,
  /^(clear-content|clc)\b/iu,
];

const PIPE_DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /\|\s*xargs\b[^\n;&|]*\b(rm|shred|truncate|dd)\b/u,
  /\|\s*(sh|bash|zsh)\b/u,
];

const GIT_DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /^git\s+reset\s+--hard\b/u,
  /^git\s+push\s+(--force|-f)\b/u,
  /^git\s+branch\s+-D\b/u,
  /^git\s+clean\s+-fd?\b/u,
  /^git\s+checkout\s+\.\s*$/u,
  /^git\s+rebase\s+-i\b/u,
];

const WRAPPER_COMMANDS = new Set(["nohup", "nice", "time", "timeout", "env", "command", "exec", "stdbuf"]);

const NESTED_SHELLS: ReadonlyArray<{ readonly head: RegExp; readonly flag: RegExp }> = [
  { head: /^(sh|bash|zsh)$/u, flag: /(?:^|\s)-\w*c\s+([\s\S]+)$/u },
  { head: /^(pwsh|powershell)$/iu, flag: /\s-c(?:ommand)?\s+([\s\S]+)$/iu },
  { head: /^cmd$/iu, flag: /\s\/[ck]\s+([\s\S]+)$/iu },
];

export function categorizeBashCommand(command: string): ToolPermissionCategory {
  const trimmed = command.trim();
  const segments = scanSegments(command, 2);
  if (command.includes("`")) segments.push(...scanSegments(command.replaceAll("`", ""), 2));
  if (segments.some(isPrivilegedSegment)) return "privileged";
  if (segments.some((segment) => FILESYSTEM_DESTRUCTIVE_PATTERNS.some((re) => re.test(segment)))) {
    return "fs_destructive";
  }
  if (PIPE_DESTRUCTIVE_PATTERNS.some((re) => re.test(trimmed))) return "fs_destructive";
  if (segments.some((segment) => GIT_DESTRUCTIVE_PATTERNS.some((re) => re.test(segment)))) {
    return "git_destructive";
  }
  return "shell_unsafe";
}

function commandFromArguments(argumentsJson: string): string {
  try {
    const value = JSON.parse(argumentsJson) as Record<string, unknown>;
    return typeof value.command === "string" ? value.command : "";
  } catch {
    return "";
  }
}

function commandSegments(command: string): string[] {
  return command
    .split(/[|;&\n(){}`]+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function scanSegments(command: string, depth: number): string[] {
  const output: string[] = [];
  for (const raw of commandSegments(command)) {
    const segment = normalizeSegmentHead(raw);
    output.push(segment);
    if (depth <= 0) continue;
    const nested = nestedShellPayload(segment);
    if (nested !== undefined) output.push(...scanSegments(nested, depth - 1));
  }
  return output;
}

function normalizeSegmentHead(segment: string): string {
  let rest = segment;
  for (let hops = 0; hops < 5; hops += 1) {
    const quoted = /^(['"])(.+?)\1(\s+|$)/u.exec(rest);
    const bare = quoted ? null : /^(\S+)(\s*)([\s\S]*)$/u.exec(rest);
    if (!quoted && !bare) return rest;
    let head = quoted ? quoted[2]! : bare![1]!;
    const tail = quoted ? rest.slice(quoted[0].length) : bare![3]!;
    head = head
      .replace(/['"^]/gu, "")
      .replace(/^\\/u, "")
      .replace(/^.*[\\/]/u, "")
      .replace(/\.exe$/iu, "");
    if (WRAPPER_COMMANDS.has(head.toLowerCase())) {
      rest = tail.replace(/^((-\S+|\S+=\S*|\d+[smhd]?)\s+)*/u, "");
      continue;
    }
    return tail ? `${head} ${tail}` : head;
  }
  return rest;
}

function nestedShellPayload(segment: string): string | undefined {
  const head = /^\S*/u.exec(segment)?.[0] ?? "";
  for (const shell of NESTED_SHELLS) {
    if (!shell.head.test(head)) continue;
    const match = shell.flag.exec(segment);
    if (!match) return undefined;
    const payload = match[1]!.trim();
    const unquoted = /^(['"])([\s\S]*)\1$/u.exec(payload);
    return unquoted ? unquoted[2] : payload;
  }
  return undefined;
}

function isPrivilegedSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  return (
    PRIVILEGED_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
    PRIVILEGED_PATTERNS.some((pattern) => pattern.test(segment))
  );
}

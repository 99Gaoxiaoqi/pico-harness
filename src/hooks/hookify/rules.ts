import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import type { HookEvent, HookEventPayloadMap, HookOutput } from "../types.js";
import { writeWorkspaceFileAtomic } from "../trust/secure-file.js";
import { resolvePicoPaths } from "../../paths/pico-paths.js";

export const HOOKIFY_EVENTS = ["bash", "file", "prompt", "stop", "all"] as const;
export const HOOKIFY_ACTIONS = ["warn", "block"] as const;
export const HOOKIFY_OPERATORS = ["regex", "contains", "equals"] as const;

export type HookifyEvent = (typeof HOOKIFY_EVENTS)[number];
export type HookifyAction = (typeof HOOKIFY_ACTIONS)[number];
export type HookifyOperator = (typeof HOOKIFY_OPERATORS)[number];

export interface HookifyRule {
  version: 1;
  id: string;
  description: string;
  event: HookifyEvent;
  action: HookifyAction;
  condition: { op: HookifyOperator; value: string };
  enabled: boolean;
}

export interface HookifyProposal {
  workDir: string;
  targetPath: string;
  content: string;
  diff: string;
  rule: HookifyRule;
}

export interface CreateHookifyProposalOptions {
  workDir: string;
  description: string;
  rule?: Partial<Pick<HookifyRule, "event" | "action" | "condition">>;
}

export interface ApplyHookifyProposalOptions {
  /** 所有 permission mode（包括 yolo）都必须由宿主展示完整 diff 并确认。 */
  confirm: (proposal: HookifyProposal) => boolean | Promise<boolean>;
  onApplied?: (path: string) => void | Promise<void>;
}

export function createHookifyProposal(options: CreateHookifyProposalOptions): HookifyProposal {
  const description = options.description.trim();
  if (!description) throw new Error("/hookify 需要一段规则描述");
  const id = slugify(description);
  const event = options.rule?.event ?? inferEvent(description);
  const action = options.rule?.action ?? inferAction(description);
  const condition = options.rule?.condition ?? inferCondition(description);
  validateCondition(condition);
  const rule: HookifyRule = {
    version: 1,
    id,
    description,
    event,
    action,
    condition,
    enabled: true,
  };
  const targetPath = resolve(
    resolvePicoPaths(options.workDir).project.root,
    `hookify.${id}.local.md`,
  );
  const content = renderHookifyRule(rule);
  return {
    workDir: resolve(options.workDir),
    targetPath,
    content,
    diff: addedFileDiff(targetPath, content),
    rule,
  };
}

export async function applyHookifyProposal(
  proposal: HookifyProposal,
  options: ApplyHookifyProposalOptions,
): Promise<boolean> {
  const expectedDirectory = resolvePicoPaths(proposal.workDir).project.root;
  if (
    dirname(proposal.targetPath) !== expectedDirectory ||
    !isHookifyFilename(basename(proposal.targetPath))
  ) {
    throw new Error("Hookify proposal 目标路径不受支持");
  }
  if (!(await options.confirm(proposal))) return false;
  await writeWorkspaceFileAtomic(proposal.targetPath, proposal.content);
  await options.onApplied?.(proposal.targetPath);
  return true;
}

export async function loadHookifyRules(workDir: string): Promise<readonly HookifyRule[]> {
  const paths = resolvePicoPaths(workDir);
  const legacy = await loadHookifyRulesFromDirectory(resolve(workDir, ".claw"));
  const native = await loadHookifyRulesFromDirectory(paths.project.root);
  const byId = new Map(legacy.map((rule) => [rule.id, rule]));
  for (const rule of native) byId.set(rule.id, rule);
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

async function loadHookifyRulesFromDirectory(directory: string): Promise<HookifyRule[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    throw error;
  }
  const rules: HookifyRule[] = [];
  for (const name of entries.filter(isHookifyFilename).sort()) {
    rules.push(parseHookifyRule(await readFile(resolve(directory, name), "utf8")));
  }
  return rules;
}

export function parseHookifyRule(markdown: string): HookifyRule {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(markdown.replace(/\r\n/g, "\n"));
  if (!match?.[1]) throw new Error("Hookify 规则缺少 frontmatter");
  const fields = Object.fromEntries(
    match[1].split("\n").map((line) => {
      const separator = line.indexOf(":");
      if (separator < 1) throw new Error(`Hookify frontmatter 行无效: ${line}`);
      const key = line.slice(0, separator).trim();
      const rawValue = line.slice(separator + 1).trim();
      return [key, parseScalar(rawValue)];
    }),
  );
  if (fields.version !== 1) throw new Error("Hookify 版本不受支持");
  if (!isOneOf(fields.event, HOOKIFY_EVENTS)) throw new Error("Hookify event 无效");
  if (!isOneOf(fields.action, HOOKIFY_ACTIONS)) throw new Error("Hookify action 无效");
  if (!isOneOf(fields.operator, HOOKIFY_OPERATORS)) throw new Error("Hookify operator 无效");
  if (typeof fields.id !== "string" || !/^[a-z0-9-]+$/.test(fields.id)) {
    throw new Error("Hookify id 无效");
  }
  if (typeof fields.description !== "string" || typeof fields.value !== "string") {
    throw new Error("Hookify description/value 无效");
  }
  if (typeof fields.enabled !== "boolean") throw new Error("Hookify enabled 无效");
  const condition = { op: fields.operator, value: fields.value };
  validateCondition(condition);
  return {
    version: 1,
    id: fields.id,
    description: fields.description,
    event: fields.event,
    action: fields.action,
    condition,
    enabled: fields.enabled,
  };
}

export function renderHookifyRule(rule: HookifyRule): string {
  validateCondition(rule.condition);
  return [
    "---",
    "version: 1",
    `id: ${JSON.stringify(rule.id)}`,
    `description: ${JSON.stringify(rule.description)}`,
    `event: ${rule.event}`,
    `action: ${rule.action}`,
    `operator: ${rule.condition.op}`,
    `value: ${JSON.stringify(rule.condition.value)}`,
    `enabled: ${String(rule.enabled)}`,
    "---",
    "",
    `# ${rule.description}`,
    "",
    "This file is a restricted Pico Hookify rule. It cannot execute shell commands.",
    "",
  ].join("\n");
}

export function evaluateHookifyRules<E extends HookEvent>(
  rules: readonly HookifyRule[],
  event: E,
  payload: HookEventPayloadMap[E],
): HookOutput {
  const matching = rules.filter(
    (rule) =>
      rule.enabled &&
      eventMatches(rule.event, event, payload) &&
      conditionMatches(rule.condition, eventSubject(event, payload)),
  );
  const blocked = matching.find((rule) => rule.action === "block");
  if (blocked) return { decision: "deny", reason: `Hookify: ${blocked.description}` };
  if (matching.length > 0) {
    return {
      decision: "allow",
      additionalContext: matching.map((rule) => `Hookify warning: ${rule.description}`).join("\n"),
    };
  }
  return { decision: "allow" };
}

function inferEvent(description: string): HookifyEvent {
  if (/\b(?:bash|shell|command)\b|(?:命令|终端|删除生产库)/i.test(description)) return "bash";
  if (/\bfiles?\b|(?:文件|路径|写入|修改)/i.test(description)) return "file";
  if (/\b(?:prompt|input)\b|(?:提示词|用户输入)/i.test(description)) return "prompt";
  if (/\bstop\b|(?:停止|结束回答)/i.test(description)) return "stop";
  return "all";
}

function inferAction(description: string): HookifyAction {
  return /\b(?:block|deny|prevent|forbid)\b|(?:阻止|禁止|拒绝|不允许)/i.test(description)
    ? "block"
    : "warn";
}

function inferCondition(description: string): HookifyRule["condition"] {
  const explicitRegex = /(?:regex|regexp|正则)\s*[:：]\s*(.+)$/i.exec(description)?.[1]?.trim();
  if (explicitRegex) return { op: "regex", value: stripDelimitedRegex(explicitRegex) };
  if (
    /(?:删除|清空).*(?:生产库|生产数据库)|(?:drop|truncate).*(?:prod|production)/i.test(description)
  ) {
    return {
      op: "regex",
      value: "(?:rm\\s+[^;\\n]*(?:/|prod)|drop\\s+database|truncate\\s+table)",
    };
  }
  const quoted = /["'“”「」]([^"'“”「」]+)["'“”「」]/.exec(description)?.[1];
  if (quoted && /(?:equals?|等于|完全匹配)/i.test(description))
    return { op: "equals", value: quoted };
  if (quoted) return { op: "contains", value: quoted };
  const stripped = description
    .replace(
      /\b(?:please|block|deny|prevent|forbid|warn|when|bash|shell|file|prompt|stop)\b/gi,
      " ",
    )
    .replace(/(?:请|阻止|禁止|拒绝|警告|当|命令|文件|提示词|停止)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) throw new Error("无法从描述提取安全条件，请用引号标出要匹配的文本");
  return { op: "contains", value: stripped };
}

function eventMatches<E extends HookEvent>(
  ruleEvent: HookifyEvent,
  event: E,
  payload: HookEventPayloadMap[E],
): boolean {
  if (ruleEvent === "all") return true;
  if (ruleEvent === "prompt")
    return event === "UserPromptSubmit" || event === "UserPromptExpansion";
  if (ruleEvent === "stop") return event === "Stop" || event === "StopFailure";
  if (ruleEvent === "file") {
    return (
      event === "FileChanged" ||
      ("tool_name" in payload && /(?:file|write|edit|patch)/i.test(String(payload.tool_name)))
    );
  }
  return "tool_name" in payload && /^(?:bash|shell)$/i.test(String(payload.tool_name));
}

function eventSubject<E extends HookEvent>(event: E, payload: HookEventPayloadMap[E]): string {
  if (event === "UserPromptSubmit" && "prompt" in payload) return String(payload.prompt);
  if (event === "UserPromptExpansion" && "expandedPrompt" in payload)
    return String(payload.expandedPrompt);
  if (event === "Stop" && "response" in payload) return String(payload.response ?? payload.reason);
  if ("tool_input" in payload) return stringifySubject(payload.tool_input);
  return stringifySubject(payload);
}

function stringifySubject(input: unknown): string {
  if (typeof input === "string") return input;
  if (typeof input === "object" && input !== null && "command" in input)
    return String(Reflect.get(input, "command"));
  return JSON.stringify(input);
}

function conditionMatches(condition: HookifyRule["condition"], subject: string): boolean {
  if (condition.op === "equals") return subject === condition.value;
  if (condition.op === "contains") return subject.includes(condition.value);
  return new RegExp(condition.value, "i").test(subject);
}

function validateCondition(condition: HookifyRule["condition"]): void {
  if (!HOOKIFY_OPERATORS.includes(condition.op)) throw new Error("Hookify operator 无效");
  if (!condition.value || condition.value.length > 2_000)
    throw new Error("Hookify condition value 无效");
  if (condition.op === "regex") {
    if (/\\[1-9]|\(\?<=[^)]|\(\?<!|(?:\([^)]*[+*][^)]*\))[+*{]/.test(condition.value)) {
      throw new Error("Hookify regex 包含高风险回溯结构");
    }
    new RegExp(condition.value);
  }
}

function slugify(input: string): string {
  const ascii = input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (ascii) return ascii;
  let hash = 2166136261;
  for (const char of input) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  return `rule-${(hash >>> 0).toString(16)}`;
}

function stripDelimitedRegex(input: string): string {
  return input.startsWith("/") && input.lastIndexOf("/") > 0
    ? input.slice(1, input.lastIndexOf("/"))
    : input;
}

function addedFileDiff(path: string, content: string): string {
  const lines = content.replace(/\n$/, "").split("\n");
  return [
    "--- /dev/null",
    `+++ ${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

function parseScalar(input: string): unknown {
  if (input === "true") return true;
  if (input === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(input)) return Number(input);
  if (input.startsWith('"')) return JSON.parse(input);
  return input;
}

function isOneOf<T extends string>(input: unknown, values: readonly T[]): input is T {
  return typeof input === "string" && values.includes(input as T);
}

function isHookifyFilename(name: string): boolean {
  return /^hookify\.[a-z0-9-]+\.local\.md$/.test(name) && !name.includes(sep);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

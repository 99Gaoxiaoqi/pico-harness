// 工具调用卡片:对标 Claude Code 的 AgentProgressLine(树形缩进 + 状态 + 参数着色)
// + 工具结果折叠(默认一行摘要,按 e 展开)。
//
// 渲染要点:
//   折叠态:⎿ <name> · <状态> · <结果摘要>       (一行,默认)
//   展开态:⎿ <name> · <状态>                   (首行)
//            参数 <着色参数>
//            结果 <完整 summary>
//
// 折叠/展开:组件自维护 expanded state,用 useInput 监听 `e` 键切换。
//
// 参数高亮:尝试 JSON.parse,成功则提取 path/command/url/query 等关键字段着色显示;
// 失败降级为原始字符串(截断)。

import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { formatOutputPreview } from "./diff-preview.js";

/** 参数里需要高亮(青色)的关键字段,按优先级排序 */
const HIGHLIGHT_KEYS = ["path", "command", "url", "query", "file", "pattern"] as const;
export type ToolCardStatus =
  | "queued"
  | "running"
  | "success"
  | "error"
  | "denied"
  // Legacy aliases accepted at the view boundary while reporters migrate.
  | "done"
  | "failed";

export function ToolCard(props: {
  name: string;
  args: string;
  status: ToolCardStatus;
  summary?: string;
  /** 是否为消息列表中最后一条:决定树形符号 */
  isLast?: boolean;
  /** 初始展开状态;未传时默认折叠 */
  initialExpanded?: boolean;
}): React.ReactNode {
  const { name, args, status, summary, isLast = false, initialExpanded } = props;
  if (isAgentToolName(name)) {
    return (
      <AgentToolProgressLine
        name={name}
        args={args}
        status={status}
        summary={summary}
        isLast={isLast}
        initialExpanded={initialExpanded}
      />
    );
  }

  return (
    <StandardToolCard
      name={name}
      args={args}
      status={status}
      summary={summary}
      initialExpanded={initialExpanded}
    />
  );
}

function StandardToolCard({
  name,
  args,
  status,
  summary,
  initialExpanded,
}: {
  name: string;
  args: string;
  status: ToolCardStatus;
  summary?: string;
  initialExpanded?: boolean;
}): React.ReactNode {
  const [expanded, setExpanded] = useState(initialExpanded ?? false);
  const target = toolTargetSummary(name, args);
  const failure = isFailureStatus(status);
  const displaySummary = summary && failure ? ensureErrorSummary(summary) : summary;
  const preview = displaySummary ? toolResultPreview(displaySummary, expanded) : undefined;

  useInput((_input, key) => {
    if (key.return) return;
    if (_input === "e" && !key.ctrl && !key.meta) {
      setExpanded((open) => !open);
    }
  });

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box>
        <Text dimColor>⎿ </Text>
        <Text color="cyan">{name}</Text>
        {target && <Text dimColor> ({target})</Text>}
        <Text dimColor> · </Text>
        <ToolStatus status={status} />
        {preview && (
          <>
            <Text dimColor> · </Text>
            <Text color={failure ? "red" : undefined} dimColor={!failure} wrap="truncate">
              {resultHint(preview)}
            </Text>
          </>
        )}
        <Text dimColor> {expanded ? "[e 折叠]" : "[e 展开]"}</Text>
      </Box>
      {expanded && (
        <Box flexDirection="column" marginLeft={2}>
          <Box>
            <Text dimColor>参数 </Text>
            <ArgsView args={args} />
          </Box>
          {summary && (
            <Box flexDirection="column">
              <Text dimColor>结果 </Text>
              <Text color={failure ? "red" : undefined} dimColor={!failure} wrap="wrap">
                {preview}
              </Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}

function AgentToolProgressLine({
  name,
  args,
  status,
  summary,
  isLast,
  initialExpanded,
}: {
  name: string;
  args: string;
  status: ToolCardStatus;
  summary?: string;
  isLast: boolean;
  initialExpanded?: boolean;
}): React.ReactNode {
  const [expanded, setExpanded] = useState(initialExpanded ?? false);
  const treeChar = isLast ? "└─" : "├─";
  const branchChar = isLast ? "   ⎿  " : "│  ⎿  ";
  const meta = agentToolMeta(name, args);
  const failure = isFailureStatus(status);
  const resultText = status === "running" ? meta.task : agentResultText(status, summary);
  const preview = agentResultHint(resultText);

  useInput((_input, key) => {
    if (key.return) return;
    if (_input === "e" && !key.ctrl && !key.meta) {
      setExpanded((open) => !open);
    }
  });

  return (
    <Box flexDirection="column" marginLeft={1}>
      <Box>
        <Text dimColor>{treeChar} </Text>
        <Text bold color={meta.color}>
          {meta.label}
        </Text>
        {meta.detail && (
          <Text dimColor>
            {" "}
            ({meta.detail})
          </Text>
        )}
        <Text dimColor> · </Text>
        <ToolStatus status={status} />
        {preview && (
          <>
            <Text dimColor> · </Text>
            <Text color={failure ? "red" : undefined} dimColor={!failure} wrap="truncate">
              {preview}
            </Text>
          </>
        )}
        <Text dimColor> {expanded ? "[e 折叠]" : "[e 展开]"}</Text>
      </Box>
      {expanded && (
        <>
          <Box>
            <Text dimColor>{branchChar}参数 </Text>
            <ArgsView args={args} />
          </Box>
          <Box>
            <Text dimColor>{branchChar}结果 </Text>
            <Text color={failure ? "red" : undefined} dimColor={!failure} wrap="wrap">
              {resultText}
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
}

export function isAgentToolName(name: string): boolean {
  return (
    name === "spawn_subagent" ||
    name === "delegate_task" ||
    name === "delegate_status" ||
    name.startsWith("[Subagent]")
  );
}

function agentToolMeta(name: string, args: string): {
  label: string;
  detail?: string;
  task: string;
  color: "cyan" | "magenta";
} {
  const parsed = parseArgs(args);

  if (name.startsWith("[Subagent]")) {
    return {
      label: "Subagent",
      detail: name.replace(/^\[Subagent\]\s*/, "") || undefined,
      task: firstString(parsed, ["path", "command", "query", "task_prompt", "goal"]) ?? "Working…",
      color: "magenta",
    };
  }

  if (name === "delegate_task") {
    const batch = delegateBatchMeta(parsed);
    return {
      label: "Agents",
      detail: firstString(parsed, ["agent_name", "mode"]) ?? batch?.detail,
      task:
        batch?.task ??
        firstString(parsed, ["goal", "task", "description"]) ??
        "Delegating tasks…",
      color: "cyan",
    };
  }

  if (name === "delegate_status") {
    return {
      label: "Agents",
      detail: "status",
      task: firstString(parsed, ["delegationId", "delegation_id"]) ?? "Checking progress…",
      color: "cyan",
    };
  }

  return {
    label: "Agent",
    detail: firstString(parsed, ["agent_name", "mode"]),
    task: firstString(parsed, ["task_prompt", "goal", "task", "description"]) ?? "Starting subagent…",
    color: "cyan",
  };
}

function parseArgs(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return undefined;
  }
}

function firstString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of keys) {
    const raw = obj[key];
    if (typeof raw === "string" && raw.trim()) return compactText(raw.trim(), 88);
  }
  return undefined;
}

function delegateBatchMeta(value: unknown): { detail: string; task: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const tasks = (value as Record<string, unknown>)["tasks"];
  if (!Array.isArray(tasks) || tasks.length === 0) return undefined;
  const firstTask = tasks.find((task) => task && typeof task === "object" && !Array.isArray(task));
  const firstGoal =
    firstTask && typeof firstTask === "object"
      ? firstString(firstTask, ["goal", "task", "description"])
      : undefined;
  return {
    detail: `${tasks.length} agents`,
    task: compactText(`1/${tasks.length} queued${firstGoal ? ` · ${firstGoal}` : ""}`, 96),
  };
}

function agentResultText(status: ToolCardStatus, summary: string | undefined): string {
  if (isFailureStatus(status)) return summary ? compactText(summary, 110) : "Subagent failed";
  return summary ? compactText(summary, 110) : "Success";
}

function compactText(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function ToolStatus({ status }: { status: ToolCardStatus }): React.ReactNode {
  const normalized = normalizeStatus(status);
  if (normalized === "queued") return <Text dimColor>Queued</Text>;
  if (normalized === "running") return <Text color="yellow">Running</Text>;
  if (normalized === "denied") return <Text color="red">Denied</Text>;
  if (normalized === "error") return <Text color="red">Error</Text>;
  return <Text color="green">Success</Text>;
}

function resultHint(summary: string): string {
  return compactText(summary, 72);
}

function agentResultHint(summary: string): string {
  return compactText(summary, 24);
}

function normalizeStatus(status: ToolCardStatus): "queued" | "running" | "success" | "error" | "denied" {
  if (status === "done") return "success";
  if (status === "failed") return "error";
  return status;
}

function isFailureStatus(status: ToolCardStatus): boolean {
  const normalized = normalizeStatus(status);
  return normalized === "error" || normalized === "denied";
}

function toolResultPreview(summary: string, expanded: boolean): string {
  const preview = formatOutputPreview(summary, { maxLines: expanded ? 5 : 1, expanded });
  return expanded ? preview : compactText(preview, 120);
}

function toolTargetSummary(name: string, args: string): string | undefined {
  if (!["edit_file", "write_file", "bash"].includes(name)) return undefined;
  const parsed = parseArgs(args);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  const value = name === "bash" ? obj["command"] : obj["path"];
  if (typeof value !== "string" || !value.trim()) return undefined;
  return compactText(value.trim(), 64);
}

export function formatErrorSummary(error: string): string {
  const firstUsefulLine = error
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return `可复制错误: ${compactText(firstUsefulLine ?? error, 166)}`;
}

function ensureErrorSummary(error: string): string {
  return error.startsWith("可复制错误:") ? error : formatErrorSummary(error);
}

/**
 * 参数渲染:解析 JSON 后对关键字段着色。
 * 解析失败或为空时降级显示原始字符串(截断到 80 字符)。
 */
function ArgsView({ args }: { args: string }): React.ReactNode {
  const trimmed = args.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // 降级:原始字符串(截断)
    const preview = trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
    return <Text dimColor>{preview}</Text>;
  }

  // 仅对对象做字段着色,其他类型(数组/原始值)直接字符串化
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const text = JSON.stringify(parsed) ?? trimmed;
    const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    return <Text dimColor>{preview}</Text>;
  }

  return <ParsedArgsView obj={parsed as Record<string, unknown>} />;
}

/** 把解析后的对象渲染成 `key:"value"` 序列,关键字段青色高亮 */
function ParsedArgsView({ obj }: { obj: Record<string, unknown> }): React.ReactNode {
  const entries = Object.entries(obj);
  return (
    <>
      {entries.map(([key, value], i) => (
        <React.Fragment key={key}>
          {i > 0 && <Text dimColor> </Text>}
          <ArgsField fieldKey={key} value={value} />
        </React.Fragment>
      ))}
    </>
  );
}

/** 单个字段:key 灰色,value 在关键字段时青色加粗 */
function ArgsField({ fieldKey, value }: { fieldKey: string; value: unknown }): React.ReactNode {
  const isHighlight = (HIGHLIGHT_KEYS as readonly string[]).includes(fieldKey);
  // value 简单字符串化(字符串去引号,其他 JSON 化,过长截断)
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const text = raw && raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;

  return (
    <>
      <Text dimColor>{fieldKey}:</Text>
      {isHighlight ? <Text color="cyan">{text}</Text> : <Text dimColor>{text}</Text>}
    </>
  );
}

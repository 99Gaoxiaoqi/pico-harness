import type { Reporter, SubagentActivityEvent } from "../engine/reporter.js";

export interface SubagentActivityScope {
  activityId: string;
  task: string;
  agentName?: string;
  mode: "explore" | "worker";
}

/**
 * 将子代理的引擎轨迹收敛为单张活动卡片的可替换快照。
 * 不向主 Reporter 转发子代理原始文本或工具输出，避免污染主对话。
 */
export class ScopedSubagentActivityReporter implements Reporter {
  private latestAction?: string;

  constructor(
    private readonly reporter: Reporter,
    private readonly scope: SubagentActivityScope,
  ) {}

  onThinking(): void {
    this.emit({ currentAction: `正在思考：${compact(this.scope.task, 48)}` });
  }

  onToolCall(toolName: string, args: string): void {
    this.latestAction = describeToolCall(toolName, args);
    this.emit({ currentAction: this.latestAction });
  }

  onToolResult(toolName: string, _result: string, isError: boolean): void {
    const action = this.latestAction ?? compact(toolName, 40);
    this.emit({ currentAction: `${isError ? "工具失败" : "已完成"}：${action}` });
  }

  onToolOutput(): void {}

  onMessage(content: string): void {
    const message = compact(content, 72);
    if (message) {
      this.latestAction = message;
      this.emit({ currentAction: message });
    }
  }

  onStart(): void {}

  onTurnStart(): void {}

  onFinish(): void {}

  onTextDelta(): void {}

  private emit(update: Pick<SubagentActivityEvent, "currentAction">): void {
    this.reporter.onSubagentActivity?.({
      ...this.scope,
      status: "running",
      ...update,
    });
  }
}

export function compactActivityText(value: string, maxLength = 80): string {
  return compact(value, maxLength);
}

function describeToolCall(toolName: string, rawArgs: string): string {
  const target = extractToolTarget(rawArgs);
  return compact(target ? `${toolName}：${target}` : `正在执行 ${toolName}`, 80);
}

function extractToolTarget(rawArgs: string): string | undefined {
  try {
    const args = JSON.parse(rawArgs) as Record<string, unknown>;
    for (const key of ["path", "file_path", "query", "pattern", "command", "cmd", "url"]) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  } catch {
    // 非 JSON 参数只显示工具名，不让展示层影响执行。
  }
  return undefined;
}

function compact(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1))}…`;
}

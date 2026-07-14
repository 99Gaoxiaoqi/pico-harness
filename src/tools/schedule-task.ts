import type {
  ScheduleDraftCoordinator,
  ScheduleDraftOutcome,
  ScheduleTaskProposal,
} from "../tasks/cron-draft.js";
import type { ToolDefinition } from "../schema/message.js";
import type { ToolAccesses } from "./tool-access.js";
import { ToolAccesses as ToolAccessesNs } from "./tool-access.js";
import type { BaseTool, ToolExecutionContext } from "./registry.js";
import { NO_FILE_SIDE_EFFECTS } from "./registry.js";

const REQUIRED_FIELDS = ["title", "prompt", "scheduleText", "cronExpression"] as const;
const ALLOWED_FIELDS: ReadonlySet<string> = new Set([...REQUIRED_FIELDS, "timeZone"]);

const CREATION_SIGNAL =
  /(?:创建|新建|新增|添加|设置|设定|安排|建立|开启|启用|提醒(?:我|我们)?|定时(?:执行|运行|提醒|检查|发送|生成|备份|同步|调用)|create|add|set\s+up|schedule|remind\s+(?:me|us))/iu;
const RECURRENCE_SIGNAL =
  /(?:每(?:隔)?(?:个)?(?:分钟|小时|天|日|周|星期|月|季度|年|工作日)|工作日|每天|每日|每周|每月|每年|每小时|每分钟|daily|weekly|monthly|yearly|hourly|every\s+(?:minute|hour|day|weekday|week|month|quarter|year)|each\s+(?:day|weekday|week|month|quarter|year))/iu;
const CRON_DISCUSSION =
  /(?:(?:解释|介绍|讨论|了解|学习|原理|语法|区别|是什么|如何工作|怎么工作).{0,16}(?:cron|定时任务)|(?:cron|定时任务).{0,16}(?:解释|介绍|讨论|了解|学习|原理|语法|区别|是什么|如何|怎么)|(?:explain|learn|understand|how\s+does).{0,24}(?:cron|scheduled?\s+(?:job|task))|(?:cron|scheduled?\s+(?:job|task)).{0,24}(?:syntax|principle|work|explain))/iu;

/**
 * 轻量候选判断，只用于决定是否提示模型考虑 schedule_task。
 * 最终参数与持久化约束仍由工具和 ScheduleDraftCoordinator 校验。
 */
export function looksLikeScheduleCreationIntent(prompt: string): boolean {
  const text = prompt.trim();
  if (text.length === 0 || CRON_DISCUSSION.test(text)) return false;
  return CREATION_SIGNAL.test(text) && RECURRENCE_SIGNAL.test(text);
}

/** 前台自然语言定时任务工具；协调器负责草案审阅与最终持久化。 */
export class ScheduleTaskTool implements BaseTool {
  readonly readOnly = false;
  readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;

  constructor(private readonly coordinator: ScheduleDraftCoordinator) {}

  name(): string {
    return "schedule_task";
  }

  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "为用户明确要求的周期性任务提交结构化草案，并等待前台用户审阅。仅用于创建或提醒类请求；不要用于解释 Cron，也不要自行添加确认参数。",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "便于用户识别的简短任务标题。" },
          prompt: { type: "string", description: "每次触发时交给 Agent 执行的完整任务指令。" },
          scheduleText: { type: "string", description: "面向用户展示的自然语言周期描述。" },
          cronExpression: { type: "string", description: "与周期描述对应的五段 Cron 表达式。" },
          timeZone: { type: "string", description: "可选 IANA 时区，例如 Asia/Shanghai。" },
        },
        required: [...REQUIRED_FIELDS],
        additionalProperties: false,
      },
    };
  }

  accesses(_args: string): ToolAccesses {
    return ToolAccessesNs.all();
  }

  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    context?.signal?.throwIfAborted();
    const proposal = parseScheduleTaskProposal(args);
    const outcome = await this.coordinator.propose(proposal, context);
    context?.signal?.throwIfAborted();
    return formatScheduleDraftOutcome(outcome);
  }
}

function parseScheduleTaskProposal(args: string): ScheduleTaskProposal {
  let value: unknown;
  try {
    value = JSON.parse(args);
  } catch {
    throw new Error("schedule_task 参数解析失败：期望 JSON 对象。");
  }
  if (!isRecord(value)) {
    throw new Error("schedule_task 参数无效：期望 JSON 对象。");
  }

  const unknownFields = Object.keys(value).filter((field) => !ALLOWED_FIELDS.has(field));
  if (unknownFields.length > 0) {
    throw new Error(`schedule_task 参数无效：不支持字段 ${unknownFields.join(", ")}。`);
  }

  const title = requiredText(value["title"], "title");
  const prompt = requiredText(value["prompt"], "prompt");
  const scheduleText = requiredText(value["scheduleText"], "scheduleText");
  const cronExpression = requiredText(value["cronExpression"], "cronExpression");
  const timeZone = optionalText(value["timeZone"], "timeZone");
  return {
    title,
    prompt,
    scheduleText,
    cronExpression,
    ...(timeZone ? { timeZone } : {}),
  };
}

function formatScheduleDraftOutcome(outcome: ScheduleDraftOutcome): string {
  switch (outcome.kind) {
    case "created": {
      const { receipt } = outcome;
      const lines = [
        "定时任务已创建。",
        `任务 ID：${receipt.cronJobId}`,
        `计划：${receipt.schedule}`,
        `时区：${receipt.timeZone}`,
        `状态：${receipt.enabled ? "已启用" : "未启用"}`,
      ];
      if (receipt.nextRun !== undefined) {
        lines.push(`下次运行：${new Date(receipt.nextRun).toISOString()}`);
      }
      lines.push(`运行服务：${receipt.daemonMessage}`);
      return lines.join("\n");
    }
    case "modify_requested":
      return "用户要求修改定时任务草案。请根据用户反馈重新整理参数，再次调用 schedule_task 提交新草案。";
    case "cancelled":
      return "用户已取消创建定时任务。本次未创建任何任务；除非用户重新提出要求，否则不要再次提交。";
    case "rejected":
      return `定时任务草案被拒绝：${outcome.reason}。请修正问题后再决定是否重新提交。`;
  }
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`schedule_task 参数无效：${field} 必须是非空字符串。`);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

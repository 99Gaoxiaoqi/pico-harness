import { describe, expect, it, vi } from "vitest";
import type {
  ScheduleDraftCoordinator,
  ScheduleDraftOutcome,
  ScheduleTaskProposal,
} from "../src/tasks/cron-draft.js";
import { looksLikeScheduleCreationIntent, ScheduleTaskTool } from "../src/tools/schedule-task.js";
import { getTier } from "../src/tools/tool-tiers.js";

describe("schedule_task foreground tool integration", () => {
  it("向协调器提交严格结构化草案，并清楚返回创建结果", async () => {
    const propose = vi.fn<ScheduleDraftCoordinator["propose"]>().mockResolvedValue({
      kind: "created",
      receipt: {
        cronJobId: "cron-42",
        enabled: true,
        schedule: "0 9 * * 1-5",
        timeZone: "Asia/Shanghai",
        nextRun: Date.parse("2026-07-15T01:00:00.000Z"),
        daemonMessage: "daemon 已登记工作区",
      },
    });
    const tool = new ScheduleTaskTool({ propose });
    const proposal: ScheduleTaskProposal = {
      title: "工作日报",
      prompt: "总结昨天的工作并生成日报",
      scheduleText: "每个工作日上午 9 点",
      cronExpression: "0 9 * * 1-5",
      timeZone: "Asia/Shanghai",
    };

    const output = await tool.execute(JSON.stringify(proposal));

    expect(propose).toHaveBeenCalledWith(proposal, undefined);
    expect(output).toContain("定时任务已创建");
    expect(output).toContain("cron-42");
    expect(output).toContain("2026-07-15T01:00:00.000Z");
    expect(output).toContain("daemon 已登记工作区");
    expect(getTier(tool.name())).toBe("core");
    const schema = tool.definition().inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.required).toEqual(["title", "prompt", "scheduleText", "cronExpression"]);
    expect(schema.properties).not.toHaveProperty("confirmed");
    expect(schema.additionalProperties).toBe(false);
  });

  it("拒绝模型自行传入 confirmed，且不调用协调器", async () => {
    const propose = vi.fn<ScheduleDraftCoordinator["propose"]>();
    const tool = new ScheduleTaskTool({ propose });

    await expect(
      tool.execute(
        JSON.stringify({
          title: "日报",
          prompt: "生成日报",
          scheduleText: "每天上午 9 点",
          cronExpression: "0 9 * * *",
          confirmed: true,
        }),
      ),
    ).rejects.toThrow(/不支持字段 confirmed/u);
    expect(propose).not.toHaveBeenCalled();
  });

  it.each([
    [{ extra: "unexpected" }, /不支持字段 extra/u],
    [{ title: "   " }, /title 必须是非空字符串/u],
    [{ prompt: "" }, /prompt 必须是非空字符串/u],
    [{ scheduleText: "\t" }, /scheduleText 必须是非空字符串/u],
    [{ cronExpression: "" }, /cronExpression 必须是非空字符串/u],
    [{ timeZone: " " }, /timeZone 必须是非空字符串/u],
  ])("拒绝未知或空字段：%o", async (override, expected) => {
    const propose = vi.fn<ScheduleDraftCoordinator["propose"]>();
    const tool = new ScheduleTaskTool({ propose });
    await expect(
      tool.execute(
        JSON.stringify({
          title: "日报",
          prompt: "生成日报",
          scheduleText: "每天上午 9 点",
          cronExpression: "0 9 * * *",
          ...override,
        }),
      ),
    ).rejects.toThrow(expected);
    expect(propose).not.toHaveBeenCalled();
  });

  it.each<[ScheduleDraftOutcome, string]>([
    [{ kind: "modify_requested" }, "重新整理参数"],
    [{ kind: "cancelled" }, "未创建任何任务"],
    [{ kind: "rejected", reason: "Cron 表达式无效" }, "Cron 表达式无效"],
  ])("把协调器的 %s 结果转换为可行动观察", async (outcome, expected) => {
    const tool = new ScheduleTaskTool({ propose: async () => outcome });
    const output = await tool.execute(
      JSON.stringify({
        title: "日报",
        prompt: "生成日报",
        scheduleText: "每天上午 9 点",
        cronExpression: "0 9 * * *",
      }),
    );
    expect(output).toContain(expected);
  });

  it("只把显式创建且包含周期的请求识别为候选，不命中 Cron 讨论", () => {
    expect(looksLikeScheduleCreationIntent("请创建一个每周一上午 9 点运行的代码检查任务")).toBe(
      true,
    );
    expect(looksLikeScheduleCreationIntent("请解释 Cron 每周任务的运行原理")).toBe(false);
    expect(looksLikeScheduleCreationIntent("Cron 表达式的语法是什么？")).toBe(false);
    expect(looksLikeScheduleCreationIntent("定时任务每天会触发一次")).toBe(false);
    expect(looksLikeScheduleCreationIntent("创建一个明天上午 9 点运行的任务")).toBe(false);
  });
});

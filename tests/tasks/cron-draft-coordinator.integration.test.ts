import { describe, expect, it, vi } from "vitest";
import type {
  CronCreationReceipt,
  CronDraft,
  CronDraftDecision,
  CronDraftId,
  ScheduleTaskProposal,
} from "../../src/tasks/cron-draft.js";
import { ScheduleDraftCoordinator } from "../../src/tasks/cron-draft-coordinator.js";

describe("ScheduleDraftCoordinator integration", () => {
  const draftId = "draft-fixed" as CronDraftId;
  const proposal: ScheduleTaskProposal = {
    title: "每日仓库检查",
    prompt: "检查仓库并汇报失败项",
    scheduleText: "每天上午九点",
    cronExpression: "0 9 * * *",
    timeZone: "Asia/Shanghai",
  };
  const receipt: CronCreationReceipt = {
    cronJobId: "cron-job-1",
    enabled: true,
    schedule: "0 9 * * *",
    timeZone: "Asia/Shanghai",
    nextRun: Date.UTC(2026, 0, 1, 1, 0),
    daemonMessage: "scheduled",
  };

  it("构建仅供前台审阅的草案，confirm 后才提交", async () => {
    let reviewed: CronDraft | undefined;
    const commit = vi.fn(async () => receipt);
    const coordinator = new ScheduleDraftCoordinator({
      now: () => Date.UTC(2026, 0, 1, 0, 30),
      generateDraftId: () => draftId,
      resolveContext: () => ({
        workspacePath: "/workspace/project",
        modelRouteId: "provider/model",
        allowedTools: ["read_file", "bash", "read_file"],
        credentialStatus: "available",
        daemonStatus: "connected",
      }),
      reviewer: {
        review: async (draft) => {
          reviewed = draft;
          expect(commit).not.toHaveBeenCalled();
          return { kind: "confirm", draftId: draft.draftId };
        },
      },
      commit,
    });

    await expect(coordinator.propose(proposal)).resolves.toEqual({ kind: "created", receipt });
    expect(reviewed).toEqual({
      draftId,
      ...proposal,
      workspacePath: "/workspace/project",
      modelRouteId: "provider/model",
      nextRuns: [
        Date.UTC(2026, 0, 1, 1, 0),
        Date.UTC(2026, 0, 2, 1, 0),
        Date.UTC(2026, 0, 3, 1, 0),
      ],
      allowedTools: ["read_file", "bash"],
      toolNetworkPolicy: "allow",
      credentialStatus: "available",
      daemonStatus: "connected",
    });
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(reviewed, undefined);
  });

  it.each([
    ["modify", { kind: "modify_requested" }],
    ["cancel", { kind: "cancelled" }],
  ] as const)("%s 决定不会提交", async (kind, expected) => {
    const commit = vi.fn(async () => receipt);
    const coordinator = makeCoordinator(
      (draft) => ({ kind, draftId: draft.draftId }) as CronDraftDecision,
      commit,
    );

    await expect(coordinator.propose(proposal)).resolves.toEqual(expected);
    expect(commit).not.toHaveBeenCalled();
  });

  it("审阅期间 abort 视为取消且不会提交", async () => {
    const controller = new AbortController();
    const commit = vi.fn(async () => receipt);
    const coordinator = makeCoordinator((draft) => {
      controller.abort();
      return { kind: "confirm", draftId: draft.draftId };
    }, commit);

    await expect(coordinator.propose(proposal, { signal: controller.signal })).resolves.toEqual({
      kind: "cancelled",
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it("空字段、一次性任务、非五段表达式和非法时区均明确拒绝", async () => {
    const resolveContext = vi.fn(() => ({
      workspacePath: "/workspace/project",
      modelRouteId: "provider/model",
      allowedTools: ["read_file"],
      credentialStatus: "available" as const,
      daemonStatus: "connected",
    }));
    const review = vi.fn();
    const commit = vi.fn(async () => receipt);
    const coordinator = new ScheduleDraftCoordinator({
      now: () => Date.UTC(2026, 0, 1),
      resolveContext,
      reviewer: { review },
      commit,
    });
    const invalid: ScheduleTaskProposal[] = [
      { ...proposal, title: "  " },
      { ...proposal, scheduleText: "明天上午九点" },
      { ...proposal, scheduleText: "7月15日上午九点", cronExpression: "0 9 15 7 *" },
      { ...proposal, cronExpression: "0 0 9 * * *" },
      { ...proposal, timeZone: "Mars/Olympus" },
    ];

    const outcomes = await Promise.all(invalid.map((item) => coordinator.propose(item)));
    expect(outcomes).toEqual([
      { kind: "rejected", reason: expect.stringMatching(/title/) },
      { kind: "rejected", reason: expect.stringMatching(/一次性/) },
      { kind: "rejected", reason: expect.stringMatching(/一次性/) },
      { kind: "rejected", reason: expect.stringMatching(/五段/) },
      { kind: "rejected", reason: expect.stringMatching(/时区/) },
    ]);
    expect(resolveContext).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });
});

function makeCoordinator(
  decision: (draft: CronDraft) => CronDraftDecision,
  commit: (draft: CronDraft, signal?: AbortSignal) => Promise<CronCreationReceipt>,
) {
  return new ScheduleDraftCoordinator({
    now: () => Date.UTC(2026, 0, 1, 0, 30),
    resolveContext: () => ({
      workspacePath: "/workspace/project",
      modelRouteId: "provider/model",
      allowedTools: ["read_file"],
      credentialStatus: "available",
      daemonStatus: "connected",
    }),
    reviewer: { review: async (draft) => decision(draft) },
    commit,
  });
}

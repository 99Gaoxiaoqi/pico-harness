import { renderToString } from "ink";
import { describe, expect, it, vi } from "vitest";
import type { CronDraft, CronDraftDecision } from "../../src/tasks/cron-draft.js";
import {
  bindScheduleDraftDialogs,
  createScheduleDraftDialogRequest,
  formatScheduleDraftDialog,
  resolveScheduleDraftDialogKey,
  scheduleDraftDialogId,
} from "../../src/tui/schedule-draft-dialog.js";
import { ScheduleDraftReviewHandler } from "../../src/tui/schedule-draft-review.js";

describe("schedule draft TUI review", () => {
  it.each([
    ["confirm", "y"],
    ["modify", "m"],
    ["cancel", "n"],
  ] as const)("settles the %s decision with the pending draftId", async (kind, input) => {
    const handler = new ScheduleDraftReviewHandler();
    const draft = createDraft(`draft-${kind}`);
    const pending = handler.review(draft);
    const request = createScheduleDraftDialogRequest(draft, handler);

    expect(resolveScheduleDraftDialogKey(input, {})).toBe(kind);
    expect(
      kind === "confirm"
        ? handler.confirm(draft.draftId)
        : kind === "modify"
          ? handler.modify(draft.draftId)
          : handler.cancel(draft.draftId),
    ).toBe(true);
    await expect(pending).resolves.toEqual({ kind, draftId: draft.draftId });
    expect(request).toMatchObject({
      id: scheduleDraftDialogId(draft.draftId),
      layer: "modal",
    });
  });

  it("maps Enter and Esc and ignores modified shortcuts", () => {
    expect(resolveScheduleDraftDialogKey("", { return: true })).toBe("confirm");
    expect(resolveScheduleDraftDialogKey("", { escape: true })).toBe("cancel");
    expect(resolveScheduleDraftDialogKey("y", { ctrl: true })).toBeNull();
  });

  it("closes and rejects an aborted review without leaving pending state", async () => {
    const handler = new ScheduleDraftReviewHandler();
    const openDialog = vi.fn();
    const closeDialog = vi.fn();
    bindScheduleDraftDialogs(handler, { openDialog, closeDialog });
    const controller = new AbortController();
    const draft = createDraft("draft-abort");
    const pending = handler.review(draft, controller.signal);

    expect(openDialog).toHaveBeenCalledOnce();
    controller.abort(new DOMException("run stopped", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(closeDialog).toHaveBeenCalledWith(scheduleDraftDialogId(draft.draftId));
    expect(handler.pendingCount).toBe(0);
  });

  it("cancelAll closes every dialog and settles every review", async () => {
    const handler = new ScheduleDraftReviewHandler();
    const closeDialog = vi.fn();
    bindScheduleDraftDialogs(handler, { openDialog: vi.fn(), closeDialog });
    const drafts = [createDraft("draft-a"), createDraft("draft-b")];
    const pending = drafts.map((draft) => handler.review(draft));

    expect(handler.cancelAll()).toBe(2);
    await expect(Promise.all(pending)).resolves.toEqual<CronDraftDecision[]>([
      { kind: "cancel", draftId: drafts[0]!.draftId },
      { kind: "cancel", draftId: drafts[1]!.draftId },
    ]);
    expect(closeDialog).toHaveBeenCalledTimes(2);
    expect(handler.pendingCount).toBe(0);
  });

  it("renders the review fields, three future runs, and keeps Cron in details", () => {
    const draft = createDraft("draft-copy");
    const output = renderToString(
      createScheduleDraftDialogRequest(draft, {
        confirm: () => true,
        modify: () => true,
        cancel: () => true,
      }).content,
    );
    const formatted = formatScheduleDraftDialog(draft);

    for (const text of [
      "定时任务草案",
      "每日 AI 摘要",
      "每天上午九点",
      "Asia/Shanghai",
      "/workspace/demo",
      "primary/gpt-5",
      "全部工具",
      "允许联网",
      "凭证状态: 可用",
      "Daemon 状态: running",
      "未来三次运行",
      "详情:",
      "任务 Prompt:",
      "汇总今天的 AI 新闻",
      "Cron: 0 9 * * *",
      "Enter/Y 确认",
    ]) {
      expect(output).toContain(text);
    }
    expect(formatted.match(/^ {2}\d\. /gmu)).toHaveLength(3);
    expect(formatted.indexOf("详情:")).toBeLessThan(formatted.indexOf("Cron:"));
  });
});

function createDraft(id: string): CronDraft {
  return {
    draftId: id as CronDraft["draftId"],
    title: "每日 AI 摘要",
    prompt: "汇总今天的 AI 新闻",
    scheduleText: "每天上午九点",
    cronExpression: "0 9 * * *",
    timeZone: "Asia/Shanghai",
    workspacePath: "/workspace/demo",
    modelRouteId: "primary/gpt-5",
    nextRuns: [
      Date.parse("2026-07-15T01:00:00.000Z"),
      Date.parse("2026-07-16T01:00:00.000Z"),
      Date.parse("2026-07-17T01:00:00.000Z"),
      Date.parse("2026-07-18T01:00:00.000Z"),
    ],
    allowedTools: ["read_file", "web"],
    toolNetworkPolicy: "allow",
    credentialStatus: "available",
    daemonStatus: "running",
  };
}

import { describe, expect, it, vi } from "vitest";
import { ApprovalManager } from "../../src/approval/manager.js";
import { DesktopInteractionBroker } from "../../src/daemon/desktop-interaction-broker.js";
import type { AskUserRequest, AskUserRequestId } from "../../src/tools/ask-user.js";

describe("DesktopInteractionBroker", () => {
  it("publishes an approval and accepts exactly one desktop decision", async () => {
    const approvalManager = new ApprovalManager(1_000);
    const broker = new DesktopInteractionBroker({ approvalManager, now: () => 42 });
    const listener = vi.fn();
    broker.subscribe(listener);

    const result = approvalManager.waitForApproval(
      "approval-1",
      "bash",
      '{"command":"npm test"}',
      broker.notifyApproval,
    );

    expect(broker.listPendingApprovals()).toHaveLength(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "approval.pending",
        resourceVersion: 1,
        at: 42,
      }),
    );
    expect(broker.resolveApproval({ taskId: "approval-1", decision: "approve" })).toBe(true);
    await expect(result).resolves.toMatchObject({ allowed: true });
    expect(broker.resolveApproval({ taskId: "approval-1", decision: "reject" })).toBe(false);
    broker.close();
  });

  it("keeps AskUser answers bound to the server-owned option", async () => {
    const broker = new DesktopInteractionBroker({ now: () => 7 });
    const request = {
      requestId: "ask-1" as AskUserRequestId,
      question: "选择执行方式",
      options: [
        { optionId: "safe", label: "安全模式" },
        { optionId: "fast", label: "快速模式" },
      ],
    } satisfies AskUserRequest;
    const answer = broker.askUserHandler.waitForAnswer(request);

    expect(broker.answerPrompt("ask-1", "missing")).toBe(false);
    expect(broker.answerPrompt("ask-1", "safe")).toBe(true);
    await expect(answer).resolves.toEqual({
      kind: "selected",
      requestId: "ask-1",
      optionId: "safe",
      label: "安全模式",
    });
    expect(broker.answerPrompt("ask-1", "fast")).toBe(false);
    broker.close();
  });
});

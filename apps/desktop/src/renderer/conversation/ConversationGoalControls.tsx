import { Button } from "@astryxdesign/core/Button";
import { Dialog } from "@astryxdesign/core/Dialog";
import { Pause, Play, Target, X } from "lucide-react";
import { useRef, useState } from "react";
import type { RuntimeGoal, RuntimeGoalSnapshot } from "@pico/protocol";
import { TextAreaField, TextField } from "../ui-controls.js";
import { goalStatusLabel } from "./goal-control.js";

export interface GoalDraft {
  readonly condition: string;
  readonly maxIterations: number;
  readonly tokenBudget?: number;
}

export type GoalAction = "pause" | "resume" | "clear";

export function isUnfinishedGoal(goal: RuntimeGoal | null | undefined): boolean {
  return Boolean(goal && ["active", "waiting", "paused"].includes(goal.status));
}

export function GoalStatusBar({
  goal,
  pending = false,
  disabled = false,
  costCNY,
  awaitingMessage = false,
  onAction,
}: {
  readonly goal: RuntimeGoal;
  readonly awaitingMessage?: boolean;
  readonly pending?: boolean;
  readonly disabled?: boolean;
  readonly costCNY?: number | undefined;
  readonly onAction: (action: GoalAction) => void;
}) {
  const reason = goal.lastReason ?? goal.lastEvaluation?.reason;
  return (
    <section
      className="conversation-goal"
      aria-label="当前 Goal"
      aria-busy={pending}
      data-status={goal.status}
    >
      <div className="conversation-goal__heading">
        <Target aria-hidden="true" size={15} />
        <strong>{goal.condition}</strong>
        <span>
          {awaitingMessage && goal.status === "active"
            ? "等待下一条消息"
            : goalStatusLabel(goal.status)}
        </span>
        <div className="conversation-goal__actions">
          {isUnfinishedGoal(goal) && (
            <Button
              label={goal.status === "paused" ? "继续 Goal" : "暂停 Goal"}
              icon={
                goal.status === "paused" ? (
                  <Play aria-hidden="true" />
                ) : (
                  <Pause aria-hidden="true" />
                )
              }
              isIconOnly
              variant="ghost"
              size="sm"
              isDisabled={pending || disabled}
              onClick={() => onAction(goal.status === "paused" ? "resume" : "pause")}
            />
          )}
          <Button
            label="清除 Goal"
            icon={<X aria-hidden="true" />}
            isIconOnly
            variant="ghost"
            size="sm"
            isDisabled={pending || disabled}
            onClick={() => onAction("clear")}
          />
        </div>
      </div>
      <p className="conversation-goal__usage">
        迭代 {goal.iterations}/{goal.maxIterations} · Goal token{" "}
        {Math.max(0, goal.tokensNow - goal.tokensAtStart).toLocaleString()}
        {goal.tokenBudget === undefined ? "（不限额）" : `/${goal.tokenBudget.toLocaleString()}`}
        {costCNY !== undefined && <> · 会话账单 ¥{costCNY.toFixed(4)}（含评估）</>}
      </p>
      <p className="conversation-goal__note">Goal token 从首次基线后计入主执行，不含评估。</p>
      {awaitingMessage && goal.status === "active" && (
        <p className="conversation-goal__note">Goal 已设置，发送下一条消息后开始执行。</p>
      )}
      {reason && <p className="conversation-goal__reason">{reason}</p>}
    </section>
  );
}

export function GoalDialog({
  open,
  pending,
  blocked,
  onOpenChange,
  onSubmit,
}: {
  readonly open: boolean;
  readonly pending: boolean;
  readonly blocked: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (draft: GoalDraft) => Promise<void>;
}) {
  const [condition, setCondition] = useState("");
  const [iterations, setIterations] = useState("50");
  const [budget, setBudget] = useState("");
  const maxIterations = Number(iterations);
  const tokenBudget = budget.trim() ? Number(budget) : undefined;
  const valid =
    condition.trim().length > 0 &&
    Number.isSafeInteger(maxIterations) &&
    maxIterations > 0 &&
    (tokenBudget === undefined || (Number.isSafeInteger(tokenBudget) && tokenBudget >= 1000));
  return (
    <Dialog
      isOpen={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
      aria-label="设置 Goal"
      purpose="info"
      width="min(480px, calc(100vw - 32px))"
    >
      <form
        className="conversation-goal-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !pending && !blocked)
            void onSubmit({
              condition: condition.trim(),
              maxIterations,
              ...(tokenBudget !== undefined ? { tokenBudget } : {}),
            });
        }}
      >
        <h2>设置 Goal</h2>
        <p>描述可验证的完成条件。Pico 会在后续执行中检查进展，直到达成目标或触及限额。</p>
        <div className="conversation-goal-dialog__field">
          完成条件
          <TextAreaField
            label="Goal 完成条件"
            value={condition}
            onValueChange={setCondition}
            rows={4}
            required
            autoFocus
            disabled={pending || blocked}
            placeholder="例如：修复登录问题，并确认相关集成测试通过"
          />
        </div>
        <div className="conversation-goal-dialog__limits">
          <div className="conversation-goal-dialog__field">
            最大迭代次数
            <TextField
              label="最大迭代次数"
              type="number"
              min={1}
              step={1}
              required
              value={iterations}
              onValueChange={setIterations}
              disabled={pending || blocked}
            />
          </div>
          <div className="conversation-goal-dialog__field">
            Token 限额（可选）
            <TextField
              label="Goal token 限额"
              type="number"
              min={1000}
              step={1}
              value={budget}
              onValueChange={setBudget}
              disabled={pending || blocked}
              placeholder="不限额"
            />
          </div>
        </div>
        <p>Token 限额至少 1,000，只计首次基线后的主执行；评估另计入会话账单。</p>
        {blocked && (
          <p role="alert">当前 Goal 尚未结束，请先清除后再设置。暂停或等待中的 Goal 也不能覆盖。</p>
        )}
        <div className="conversation-goal-dialog__actions">
          <Button
            label="取消"
            variant="ghost"
            isDisabled={pending}
            onClick={() => onOpenChange(false)}
          />
          <Button
            label={pending ? "正在设置…" : "设置 Goal"}
            type="submit"
            isDisabled={!valid || pending || blocked}
          />
        </div>
      </form>
    </Dialog>
  );
}

/** Both conversation surfaces use the same controls and duplicate-submit guard. */
export function useConversationGoal({
  snapshot,
  disabled = false,
  busy = false,
  costCNY,
  onArm,
  onAction,
}: {
  readonly snapshot?: RuntimeGoalSnapshot | null | undefined;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly costCNY?: number | undefined;
  readonly onArm: (draft: GoalDraft) => Promise<boolean>;
  readonly onAction: (action: GoalAction, goal: RuntimeGoal) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const goal = snapshot?.currentGoal;
  const blocked = isUnfinishedGoal(goal);
  const run = async (operation: () => Promise<boolean>) => {
    if (inFlight.current || busy || disabled) return false;
    inFlight.current = true;
    setPending(true);
    try {
      return await operation();
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return {
    openDialog: () => setOpen(true),
    canSetGoal: !disabled && !blocked && !pending && !busy,
    statusBar: goal ? (
      <GoalStatusBar
        goal={goal}
        awaitingMessage={goal.armedAt !== undefined}
        pending={pending || busy}
        disabled={disabled}
        costCNY={costCNY}
        onAction={(action) => {
          void run(() => onAction(action, goal));
        }}
      />
    ) : null,
    dialog: (
      <GoalDialog
        open={open}
        pending={pending || busy}
        blocked={blocked}
        onOpenChange={setOpen}
        onSubmit={async (draft) => {
          if (await run(() => onArm(draft))) setOpen(false);
        }}
      />
    ),
  };
}

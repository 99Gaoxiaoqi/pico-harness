import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import {
  ArrowDown,
  ArrowUp,
  CornerDownRight,
  ListOrdered,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import type { RuntimeQueuedInput, RuntimeUserInput } from "@pico/protocol";
import type { WorkspaceSessionRef } from "../workspace-session.js";
import type { RuntimeActions } from "../runtime.js";

export function ConversationQueue({
  actions,
  disabled,
  items,
  sessionRef,
  runId,
  steerSupported,
}: {
  readonly actions: Pick<
    RuntimeActions,
    | "updateQueuedInput"
    | "removeQueuedInput"
    | "reorderQueuedInputs"
    | "moveQueuedInputToNext"
    | "steerQueuedInput"
  >;
  readonly disabled: boolean;
  readonly items: readonly RuntimeQueuedInput[];
  readonly sessionRef: WorkspaceSessionRef;
  readonly runId?: string | undefined;
  readonly steerSupported: boolean;
}) {
  const [editingQueueId, setEditingQueueId] = useState<string>();
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const locked = disabled || pending;
  const editingItem = items.find((item) => item.queueId === editingQueueId);

  const mutate = async (operation: () => Promise<unknown>) => {
    if (locked || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      await operation();
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  const beginEdit = (item: RuntimeQueuedInput) => {
    setEditingQueueId(item.queueId);
    setDraft(queuedInputText(item.input));
  };
  const saveEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingItem) return;
    await mutate(async () => {
      const input = replaceQueuedInputText(editingItem.input, draft);
      if (await actions.updateQueuedInput(sessionRef, editingItem.queueId, input))
        setEditingQueueId(undefined);
    });
  };
  const reorder = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= items.length) return;
    const queueIds = items.map((item) => item.queueId);
    [queueIds[index], queueIds[target]] = [queueIds[target]!, queueIds[index]!];
    void mutate(() => actions.reorderQueuedInputs(sessionRef, queueIds));
  };

  return (
    <section
      className="conversation-queue"
      aria-label={`待发送队列 · ${items.length} 条`}
      aria-busy={pending}
    >
      <ol>
        {items.map((item, index) => {
          const reason = !steerSupported
            ? "当前 Runtime 不支持队列引导，请更新并重启 Pico。"
            : !runId
              ? "当前会话没有正在执行的运行，消息将在下一轮发送。"
              : !isSteerableQueuedInput(item.input)
                ? "包含附件、技能或子任务的消息需继续排队。"
                : "在当前运行的下一次模型调用前追加这条指令";
          return (
            <li key={item.queueId}>
              {editingQueueId === item.queueId ? (
                <form onSubmit={(event) => void saveEdit(event)}>
                  <label>
                    <span>{queuedInputLabel(item.input)} 内容</span>
                    <textarea
                      autoFocus
                      value={draft}
                      onChange={(event) => setDraft(event.currentTarget.value)}
                      rows={2}
                      disabled={locked}
                    />
                  </label>
                  <div className="conversation-queue__actions">
                    <button type="submit" disabled={locked || !draft.trim()}>
                      保存
                    </button>
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() => setEditingQueueId(undefined)}
                    >
                      取消
                    </button>
                  </div>
                </form>
              ) : (
                <>
                  <div className="conversation-queue__content" title={queuedInputText(item.input)}>
                    <ListOrdered aria-hidden="true" />
                    <span>
                      {item.input.kind !== "text" && `${queuedInputLabel(item.input)} · `}
                      {queuedInputText(item.input) || "（空内容）"}
                    </span>
                  </div>
                  <div className="conversation-queue__actions">
                    <button
                      type="button"
                      className="conversation-queue__steer"
                      title={reason}
                      aria-label={`引导第 ${index + 1} 条消息`}
                      disabled={
                        locked || !steerSupported || !runId || !isSteerableQueuedInput(item.input)
                      }
                      onClick={() => {
                        if (runId)
                          void mutate(() =>
                            actions.steerQueuedInput(sessionRef, item.queueId, runId),
                          );
                      }}
                    >
                      <CornerDownRight aria-hidden="true" />
                      引导
                    </button>
                    <button
                      type="button"
                      title="删除排队消息"
                      aria-label={`删除第 ${index + 1} 条排队消息`}
                      disabled={locked}
                      onClick={() =>
                        void mutate(() => actions.removeQueuedInput(sessionRef, item.queueId))
                      }
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                    <DropdownMenu
                      button={{
                        label: `第 ${index + 1} 条排队消息的更多操作`,
                        icon: <MoreHorizontal aria-hidden="true" />,
                        isIconOnly: true,
                        variant: "ghost",
                        size: "sm",
                        isDisabled: locked,
                        className: "conversation-queue__more",
                      }}
                      hasChevron={false}
                      placement="above"
                      alignment="end"
                      menuWidth={180}
                    >
                      <DropdownMenuItem
                        label="编辑"
                        icon={<Pencil aria-hidden="true" />}
                        onClick={() => beginEdit(item)}
                      />
                      <DropdownMenuItem
                        label="上移"
                        icon={<ArrowUp aria-hidden="true" />}
                        isDisabled={index === 0}
                        onClick={() => reorder(index, -1)}
                      />
                      <DropdownMenuItem
                        label="下移"
                        icon={<ArrowDown aria-hidden="true" />}
                        isDisabled={index === items.length - 1}
                        onClick={() => reorder(index, 1)}
                      />
                      <DropdownMenuItem
                        label="移至下一项"
                        icon={<CornerDownRight aria-hidden="true" />}
                        isDisabled={index === 0}
                        onClick={() =>
                          void mutate(() => actions.moveQueuedInputToNext(sessionRef, item.queueId))
                        }
                      />
                    </DropdownMenu>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ol>
      {!steerSupported && (
        <p className="conversation-queue__notice">
          当前 Runtime 不支持队列引导，请更新并重启 Pico。
        </p>
      )}
    </section>
  );
}

export function isSteerableQueuedInput(input: RuntimeUserInput): boolean {
  return (
    input.kind === "text" &&
    !input.attachments?.length &&
    !input.skills?.length &&
    !input.orchestrationMode
  );
}

function queuedInputLabel(input: RuntimeUserInput): string {
  if (input.kind === "skill") return `技能 · ${input.name}`;
  if (input.kind === "agent") return `子代理 · ${input.name}`;
  return "消息";
}

function queuedInputText(input: RuntimeUserInput): string {
  if (input.kind === "skill") return input.args ?? "";
  if (input.kind === "agent") return input.task;
  return input.text;
}

function replaceQueuedInputText(input: RuntimeUserInput, text: string): RuntimeUserInput {
  if (input.kind === "skill") return { ...input, args: text };
  if (input.kind === "agent") return { ...input, task: text };
  return { ...input, text };
}

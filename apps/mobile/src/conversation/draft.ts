import type {
  RuntimeInputAttachment,
  RuntimeSkillReference,
  RuntimeUserInput,
} from "@pico/protocol/mobile";
import { parseRemoteRequest, type RemoteParams } from "@pico/protocol/remote";
import { validateAttachments } from "../core.js";

export type ComposerMode = "auto" | "steer" | "queue" | "replace";
export type ComposerAgent = { name: string; subagentId?: string };
export type DraftScope = { hostId: string; workspaceId: string; sessionId: string };
export type ComposerDraft = {
  text: string;
  images: RuntimeInputAttachment[];
  mode: ComposerMode;
  skills: RuntimeSkillReference[];
  agent?: ComposerAgent;
  idempotencyKey: string;
  pending?: RemoteParams<"session.send">;
};
export interface DraftStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
export const draftKey = (scope: DraftScope) =>
  `pico.mobile.draft.v1:${JSON.stringify([scope.hostId, scope.workspaceId, scope.sessionId])}`;
export const emptyDraft = (idempotencyKey: string): ComposerDraft => ({
  text: "",
  images: [],
  mode: "auto",
  skills: [],
  idempotencyKey,
});
export function draftInput(draft: ComposerDraft): RuntimeUserInput {
  if (draft.skills.length > 16) throw new Error("最多选择 16 个 Skill");
  if (draft.agent && (draft.skills.length || draft.images.length))
    throw new Error("一个消息只能选择一个 Agent，请先移除 Skill 和图片");
  validateAttachments(draft.images);
  return draft.agent
    ? { kind: "agent", ...draft.agent, task: draft.text }
    : {
        kind: "text",
        text: draft.text,
        ...(draft.skills.length ? { skills: draft.skills } : {}),
        ...(draft.images.length ? { attachments: draft.images } : {}),
      };
}
export function draftSendReason(draft: ComposerDraft, activeRun: boolean): string | undefined {
  if (draft.pending) return undefined;
  if (draft.agent && !draft.text.trim()) return "请输入 Agent 任务";
  if (!draft.text.trim() && !draft.images.length && !draft.skills.length)
    return "请输入消息或选择 Skill";
  if (
    (draft.agent || draft.skills.length) &&
    activeRun &&
    !["queue", "replace"].includes(draft.mode)
  )
    return "Agent/Skill 需在新任务中应用，请选择排队或替换";
  return undefined;
}
function checkedRequest(scope: DraftScope, params: unknown): RemoteParams<"session.send"> {
  const request = parseRemoteRequest({
    version: 1,
    requestId: "stored-draft",
    workspaceId: scope.workspaceId,
    method: "session.send",
    params,
  });
  const paramsChecked = request.params as RemoteParams<"session.send">;
  if (request.method !== "session.send" || paramsChecked.sessionId !== scope.sessionId)
    throw new Error("草稿请求与当前会话不一致");
  return paramsChecked;
}
function checkedDraft(scope: DraftScope, value: unknown): ComposerDraft {
  if (!value || typeof value !== "object") throw new Error("本地草稿格式无效");
  const draft = value as ComposerDraft;
  if (
    typeof draft.text !== "string" ||
    !Array.isArray(draft.images) ||
    !Array.isArray(draft.skills) ||
    !["auto", "steer", "queue", "replace"].includes(draft.mode) ||
    typeof draft.idempotencyKey !== "string" ||
    !draft.idempotencyKey
  )
    throw new Error("本地草稿格式无效");
  checkedRequest(scope, {
    sessionId: scope.sessionId,
    input: draftInput(draft),
    behavior: draft.mode,
    idempotencyKey: draft.idempotencyKey,
  });
  if (draft.pending) {
    checkedRequest(scope, draft.pending);
    if (draft.pending.idempotencyKey !== draft.idempotencyKey)
      throw new Error("待确认请求的幂等键与草稿不一致");
  }
  return draft;
}

/** Each key drains independently; queued snapshots survive component unmounts. */
export class DraftRepository {
  readonly #queues = new Map<string, Promise<unknown>>();
  constructor(readonly storage: DraftStorage) {}
  #serial<T>(scope: DraftScope, action: () => Promise<T>): Promise<T> {
    const key = draftKey(scope);
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(action);
    this.#queues.set(key, operation);
    const cleanup = () => {
      if (this.#queues.get(key) === operation) this.#queues.delete(key);
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }
  async #read(scope: DraftScope): Promise<ComposerDraft | undefined> {
    const raw = await this.storage.getItem(draftKey(scope));
    if (!raw) return undefined;
    const record = JSON.parse(raw) as { version?: unknown; draft?: unknown };
    if (record.version !== 1) throw new Error("本地草稿版本不兼容，请明确清除后重试");
    return checkedDraft(scope, record.draft);
  }
  load(scope: DraftScope) {
    return this.#serial(scope, () => this.#read(scope));
  }
  async save(scope: DraftScope, draft: ComposerDraft): Promise<void> {
    // Serialize now, so later edits cannot mutate a queued write or admitted request.
    const raw = JSON.stringify({ version: 1, draft: checkedDraft(scope, draft) });
    return this.#serial(scope, () => this.storage.setItem(draftKey(scope), raw));
  }
  clear(scope: DraftScope) {
    return this.#serial(scope, () => this.storage.removeItem(draftKey(scope)));
  }
  finish(scope: DraftScope, idempotencyKey: string) {
    return this.#serial(scope, async () => {
      const current = await this.#read(scope);
      // A late response must not remove a newer draft created after explicit clearing.
      if (current?.pending?.idempotencyKey === idempotencyKey)
        await this.storage.removeItem(draftKey(scope));
    });
  }
  release(scope: DraftScope, idempotencyKey: string) {
    return this.#serial(scope, async () => {
      const current = await this.#read(scope);
      if (current?.pending?.idempotencyKey !== idempotencyKey) return;
      const { pending: _pending, ...editable } = current;
      await this.storage.setItem(draftKey(scope), JSON.stringify({ version: 1, draft: editable }));
    });
  }
}

/** Persist the exact retryable request before handing it to the transport. */
export async function submitDraft<T>(
  repository: DraftRepository,
  scope: DraftScope,
  draft: ComposerDraft,
  request: RemoteParams<"session.send">,
  send: (request: RemoteParams<"session.send">) => Promise<T>,
): Promise<T> {
  const original = checkedRequest(scope, JSON.parse(JSON.stringify(request)));
  const reason = draftSendReason(draft, !!original.expectedRunId);
  if (reason) throw new Error(reason);
  await repository.save(scope, {
    ...draft,
    idempotencyKey: original.idempotencyKey,
    pending: original,
  });
  try {
    const result = await send(original);
    await repository.finish(scope, original.idempotencyKey);
    return result;
  } catch (error) {
    if (error instanceof Error && "outcome" in error && error.outcome === "not_executed")
      await repository.release(scope, original.idempotencyKey);
    throw error;
  }
}

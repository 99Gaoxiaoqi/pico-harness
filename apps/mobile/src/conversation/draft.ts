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

export type DraftState = { ready: boolean; draft?: ComposerDraft; sending: boolean };
export type DraftAttempt = { readonly generation: number; readonly token: symbol };
type ScopeState = DraftState & {
  generation: number;
  revision: number;
  attempt?: DraftAttempt;
  listeners: Set<(state: DraftState) => void>;
};

/** Each scope owns its durable draft, send lease and live subscribers across mounts. */
export class DraftRepository {
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #states = new Map<string, ScopeState>();
  constructor(readonly storage: DraftStorage) {}
  #state(scope: DraftScope): ScopeState {
    const key = draftKey(scope);
    let state = this.#states.get(key);
    if (!state) {
      state = { ready: false, sending: false, generation: 0, revision: 0, listeners: new Set() };
      this.#states.set(key, state);
    }
    return state;
  }
  #publish(state: ScopeState) {
    const snapshot = { ready: state.ready, draft: state.draft, sending: state.sending };
    for (const listener of state.listeners) listener(snapshot);
  }
  subscribe(scope: DraftScope, listener: (state: DraftState) => void) {
    const state = this.#state(scope);
    state.listeners.add(listener);
    listener({ ready: state.ready, draft: state.draft, sending: state.sending });
    return () => {
      state.listeners.delete(listener);
    };
  }
  isSending(scope: DraftScope) {
    return this.#state(scope).sending;
  }
  acquire(scope: DraftScope): DraftAttempt | undefined {
    const state = this.#state(scope);
    if (state.sending) return undefined;
    const attempt = { generation: state.generation, token: Symbol("draft-send") };
    state.attempt = attempt;
    state.sending = true;
    this.#publish(state);
    return attempt;
  }
  owns(scope: DraftScope, attempt: DraftAttempt) {
    const state = this.#state(scope);
    return state.generation === attempt.generation && state.attempt?.token === attempt.token;
  }
  unlock(scope: DraftScope, attempt: DraftAttempt) {
    if (!this.owns(scope, attempt)) return;
    const state = this.#state(scope);
    state.attempt = undefined;
    state.sending = false;
    this.#publish(state);
  }
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
    const state = this.#state(scope);
    const revision = state.revision;
    return this.#serial(scope, async () => {
      const draft = await this.#read(scope);
      if (state.revision === revision) {
        state.ready = true;
        state.draft = draft;
        this.#publish(state);
      }
      return draft;
    });
  }
  async save(scope: DraftScope, draft: ComposerDraft): Promise<void> {
    // Snapshot immediately; later edits cannot mutate a queued write or admitted request.
    const raw = JSON.stringify({ version: 1, draft: checkedDraft(scope, draft) });
    const snapshot = (JSON.parse(raw) as { draft: ComposerDraft }).draft;
    const state = this.#state(scope);
    const previous = { ready: state.ready, draft: state.draft };
    const revision = ++state.revision;
    state.ready = true;
    state.draft = snapshot;
    this.#publish(state);
    try {
      await this.#serial(scope, () => this.storage.setItem(draftKey(scope), raw));
    } catch (error) {
      if (snapshot.pending && state.revision === revision) {
        Object.assign(state, previous);
        this.#publish(state);
      }
      throw error;
    }
  }
  clear(scope: DraftScope) {
    const state = this.#state(scope);
    // Explicit clearing creates a new logical draft; old callbacks lose their lease.
    ++state.generation;
    const revision = ++state.revision;
    state.attempt = undefined;
    state.sending = true;
    this.#publish(state);
    return this.#serial(scope, async () => {
      try {
        await this.storage.removeItem(draftKey(scope));
        if (state.revision === revision) {
          state.ready = true;
          state.draft = undefined;
        }
      } finally {
        state.sending = false;
        this.#publish(state);
      }
    });
  }
  finish(scope: DraftScope, attempt: DraftAttempt, idempotencyKey: string) {
    return this.#serial(scope, async () => {
      if (!this.owns(scope, attempt)) return;
      const current = await this.#read(scope);
      if (!this.owns(scope, attempt) || current?.pending?.idempotencyKey !== idempotencyKey) return;
      await this.storage.removeItem(draftKey(scope));
      if (!this.owns(scope, attempt)) return;
      const state = this.#state(scope);
      ++state.revision;
      state.ready = true;
      state.draft = undefined;
      this.#publish(state);
    });
  }
  release(scope: DraftScope, attempt: DraftAttempt, idempotencyKey: string) {
    return this.#serial(scope, async () => {
      if (!this.owns(scope, attempt)) return;
      const current = await this.#read(scope);
      if (!this.owns(scope, attempt) || current?.pending?.idempotencyKey !== idempotencyKey) return;
      const { pending: _pending, ...editable } = current;
      await this.storage.setItem(draftKey(scope), JSON.stringify({ version: 1, draft: editable }));
      if (!this.owns(scope, attempt)) return;
      const state = this.#state(scope);
      ++state.revision;
      state.draft = editable;
      this.#publish(state);
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
  lease?: DraftAttempt,
): Promise<T> {
  const original = checkedRequest(scope, JSON.parse(JSON.stringify(draft.pending ?? request)));
  const reason = draftSendReason(draft, !!original.expectedRunId);
  if (reason) throw new Error(reason);
  const attempt = lease ?? repository.acquire(scope);
  if (!attempt || !repository.owns(scope, attempt)) throw new Error("正在发送此会话的消息");
  try {
    await repository.save(scope, {
      ...draft,
      idempotencyKey: original.idempotencyKey,
      pending: original,
    });
    if (!repository.owns(scope, attempt)) throw new Error("草稿已变更，消息尚未发送");
    try {
      const result = await send(original);
      await repository.finish(scope, attempt, original.idempotencyKey);
      return result;
    } catch (error) {
      // A rejected retry proves only that attempt did not execute. The original
      // unknown logical request may already have reached the host.
      if (
        !draft.pending &&
        error instanceof Error &&
        "outcome" in error &&
        error.outcome === "not_executed"
      )
        await repository.release(scope, attempt, original.idempotencyKey);
      throw error;
    }
  } finally {
    if (!lease) repository.unlock(scope, attempt);
  }
}

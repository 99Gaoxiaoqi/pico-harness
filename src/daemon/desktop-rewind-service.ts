import { createHash } from "node:crypto";
import { StorageOperationJournal } from "../storage/operation-journal.js";
import type { Session } from "../engine/session.js";
import { createSessionForkRuntimePort } from "../runtime/session-fork-runtime-port-adapter.js";
import {
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  parseRuntimeResult,
  type RuntimeParams,
  type RuntimeResult,
} from "@pico/protocol";
import type { DesktopConversationStateStoreLike } from "./desktop-conversation-state.js";
import { canonicalizeWorkspacePath } from "./workspace-registry.js";
import { projectDesktopRewindFingerprints } from "./desktop-review.js";
import { logger } from "../observability/logger.js";

export interface DesktopRewindServiceOptions {
  readonly picoHome: string;
  readonly conversationStateStore: DesktopConversationStateStoreLike;
  readonly createSessionId: () => string;
  readonly requireIdleTrustedSession: (
    workspacePath: string,
    sessionId: string,
    operation: string,
  ) => Promise<string>;
  readonly withSession: <Result>(
    workspacePath: string,
    sessionId: string,
    operation: (session: Session) => Promise<Result>,
  ) => Promise<Result>;
  readonly notifyCommitted: (input: {
    readonly workspacePath: string;
    readonly sessionId: string;
    readonly sourceSessionId: string;
    readonly checkpointId: string;
  }) => Promise<void>;
}

/** Owns rewind idempotency and the non-destructive fork/file transaction lifecycle. */
export class DesktopRewindService {
  private readonly pending = new Map<
    string,
    {
      readonly requestFingerprint: string;
      readonly promise: Promise<RuntimeResult<"rewind.apply">>;
    }
  >();
  private readonly completed = new Map<
    string,
    { readonly requestFingerprint: string; readonly result: RuntimeResult<"rewind.apply"> }
  >();

  constructor(private readonly options: DesktopRewindServiceOptions) {}

  async apply(params: RuntimeParams<"rewind.apply">): Promise<RuntimeResult<"rewind.apply">> {
    const canonical = await canonicalizeWorkspacePath(params.workspacePath);
    const requestFingerprint = desktopRewindRequestFingerprint({
      ...params,
      workspacePath: canonical,
    });
    const idempotencyKey = `rewind.apply:${params.idempotencyKey}`;
    const pendingKey = `${canonical}\0${idempotencyKey}`;
    const completed = this.completed.get(pendingKey);
    if (completed) {
      if (completed.requestFingerprint !== requestFingerprint) {
        throw rewindConflict(params, "已绑定不同的 rewind 请求");
      }
      return completed.result;
    }
    const stored = await this.options.conversationStateStore.getIdempotent(
      canonical,
      idempotencyKey,
    );
    if (stored) {
      if (stored.requestFingerprint !== requestFingerprint) {
        throw rewindConflict(params, "已绑定不同的 rewind 请求");
      }
      return parseRuntimeResult("rewind.apply", stored.result);
    }

    const pending = this.pending.get(pendingKey);
    if (pending) {
      if (pending.requestFingerprint !== requestFingerprint) {
        throw rewindConflict(params, "正在处理不同的 rewind 请求");
      }
      return pending.promise;
    }

    // Persist the semantic request and all derived identities before any file/Fork side effect.
    const existingClaim = await this.options.conversationStateStore.getRewindClaim(
      canonical,
      idempotencyKey,
    );
    const claimed = await this.options.conversationStateStore.claimRewind(
      canonical,
      idempotencyKey,
      params.sessionId,
      existingClaim?.targetSessionId ??
        (params.mode === "code" ? params.sessionId : this.options.createSessionId()),
      desktopRewindOperationId(canonical, idempotencyKey),
      requestFingerprint,
    );
    if (
      claimed.requestFingerprint !== requestFingerprint ||
      claimed.sourceSessionId !== params.sessionId ||
      claimed.operationId !== desktopRewindOperationId(canonical, idempotencyKey) ||
      (params.mode === "code" && claimed.targetSessionId !== params.sessionId)
    ) {
      throw rewindConflict(params, "已绑定不同的 rewind 请求");
    }

    const operation = this.applyOnce(
      { ...params, workspacePath: canonical },
      claimed.targetSessionId,
      claimed.operationId,
    )
      .then(async (result) => {
        this.completed.set(pendingKey, { requestFingerprint, result });
        if (this.completed.size > 500) {
          const oldest = this.completed.keys().next().value;
          if (oldest !== undefined) this.completed.delete(oldest);
        }
        try {
          await this.options.conversationStateStore.rememberIdempotent(
            canonical,
            idempotencyKey,
            requestFingerprint,
            result,
          );
        } catch (error) {
          logger.warn(
            { error, sessionId: result.sessionId, sourceSessionId: params.sessionId },
            "rewind committed but idempotency result persistence failed",
          );
        }
        return result;
      })
      .finally(() => this.pending.delete(pendingKey));
    this.pending.set(pendingKey, { requestFingerprint, promise: operation });
    return operation;
  }

  private async applyOnce(
    params: RuntimeParams<"rewind.apply">,
    targetSessionId: string,
    operationId: string,
  ): Promise<RuntimeResult<"rewind.apply">> {
    const canonical = await this.options.requireIdleTrustedSession(
      params.workspacePath,
      params.sessionId,
      "回滚",
    );
    const result = parseRuntimeResult("rewind.apply", {
      applied: true,
      sessionId: targetSessionId,
      sourceSessionId: params.sessionId,
    });
    const forkedSessionId = await this.options.withSession(
      canonical,
      params.sessionId,
      async (session) => {
        const mode = params.mode;
        if (mode !== "code" && !session.getRuntimeStateSnapshot().settings) {
          throw new RuntimeProtocolError(
            RUNTIME_ERROR_CODES.RESET_REQUIRED,
            `Session ${session.id} 缺少当前版本 settings，不能 rewind`,
          );
        }
        const forkJournal =
          mode === "both"
            ? new StorageOperationJournal({ workDir: canonical, picoHome: this.options.picoHome })
            : undefined;
        const durableOperation = forkJournal ? await forkJournal.get(operationId) : undefined;
        let expectedFingerprints: Record<string, string> | undefined;
        if (mode !== "conversation" && !durableOperation) {
          try {
            expectedFingerprints = await projectDesktopRewindFingerprints(
              session,
              params.checkpointId,
              params.expectedFingerprint,
            );
          } catch (error) {
            if (!forkJournal || !(await forkJournal.get(operationId))) throw error;
          }
        }
        const fork = await session.forkFromCheckpoint(
          params.checkpointId,
          mode,
          createSessionForkRuntimePort(),
          () => targetSessionId,
          expectedFingerprints,
          {
            ...(mode === "code" ? {} : { operationId }),
          },
        );
        return fork.targetSessionId;
      },
    );
    if (forkedSessionId !== targetSessionId) {
      throw new Error(
        `rewind.apply 目标 Session 不一致: expected=${targetSessionId} actual=${forkedSessionId}`,
      );
    }
    try {
      await this.options.notifyCommitted({
        workspacePath: canonical,
        sessionId: forkedSessionId,
        sourceSessionId: params.sessionId,
        checkpointId: params.checkpointId,
      });
    } catch (error) {
      logger.warn(
        { error, sessionId: forkedSessionId, sourceSessionId: params.sessionId },
        "rewind committed but projection notification failed",
      );
    }
    return result;
  }
}

function rewindConflict(
  params: RuntimeParams<"rewind.apply">,
  message: string,
): RuntimeProtocolError {
  return new RuntimeProtocolError(
    RUNTIME_ERROR_CODES.CONFLICT,
    `idempotencyKey ${params.idempotencyKey} ${message}`,
  );
}

function desktopRewindRequestFingerprint(params: RuntimeParams<"rewind.apply">): string {
  const mode = params.mode;
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspacePath: params.workspacePath,
        sessionId: params.sessionId,
        checkpointId: params.checkpointId,
        ...(mode === "conversation" ? {} : { expectedFingerprint: params.expectedFingerprint }),
        mode,
      }),
    )
    .digest("hex");
}

function desktopRewindOperationId(workspacePath: string, idempotencyKey: string): string {
  return `rewind-${createHash("sha256")
    .update(`${workspacePath}\0${idempotencyKey}`)
    .digest("hex")}`;
}

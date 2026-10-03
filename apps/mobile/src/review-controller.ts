import {
  isTerminalRunStatus,
  type RuntimeGitReviewSource,
  type RuntimeResult,
} from "@pico/protocol/mobile";
import { errorText, type RuntimePort } from "./core.js";
import {
  memoryReviewStorage,
  ReviewRequestStorage,
  type PendingReviewRequest,
} from "./review-request-storage.js";

export type ReviewSource = "run" | "git";
export type ReviewState = {
  source: ReviewSource;
  gitSource: RuntimeGitReviewSource;
  runs: RuntimeResult<"runs.list">["runs"];
  runId?: string;
  changes?: RuntimeResult<"changes.list">;
  snapshot?: RuntimeResult<"git.review.snapshot">;
  path?: string;
  diff?: { path: string; patch: string; truncated: boolean };
  loading: boolean;
  diffLoading: boolean;
  pending?: "approve" | "request_changes" | "apply";
  stale: boolean;
  unknown: boolean;
  recovery?: PendingReviewRequest;
  error?: string;
  notice?: string;
};

/** Coordinates remote review targets. A connection fence alone cannot fence Run/file switches. */
export class MobileReview {
  state: ReviewState = {
    source: "run",
    gitSource: "unstaged",
    runs: [],
    loading: false,
    diffLoading: false,
    stale: false,
    unknown: false,
  };
  #readVersion = 0;
  #commandVersion = 0;
  #active = true;
  #listeners = new Set<(state: ReviewState) => void>();
  #restored?: Promise<void>;
  readonly recoveryStorage: ReviewRequestStorage;
  #disposeClear?: () => void;
  constructor(
    readonly port: RuntimePort,
    readonly workspaceId: string,
    readonly sessionId: string,
    readonly onReturnToConversation?: () => void,
    readonly options: {
      recoveryStorage?: ReviewRequestStorage;
      canRetry?: () => boolean;
    } = {},
  ) {
    this.recoveryStorage =
      options.recoveryStorage ??
      new ReviewRequestStorage(memoryReviewStorage, JSON.stringify([workspaceId, sessionId]));
  }
  async restore() {
    this.#restored ??= this.recoveryStorage
      .load()
      .then((recovery) => {
        if (recovery && this.recoveryStorage.current)
          this.#update({ recovery, unknown: true, runId: recovery.runId });
      })
      .catch((error: unknown) => {
        if (this.recoveryStorage.current) this.#update({ unknown: true, error: errorText(error) });
      });
    await this.#restored;
  }
  get active() {
    return this.#active && this.recoveryStorage.current;
  }
  subscribe(listener: (state: ReviewState) => void) {
    if (!this.#disposeClear)
      this.#disposeClear = this.recoveryStorage.onClear(() => {
        this.suspend();
        this.#update({
          recovery: undefined,
          unknown: false,
          runs: [],
          runId: undefined,
          path: undefined,
          error: undefined,
          notice: "这台电脑的本机审阅记录已清除。",
        });
      });
    this.#listeners.add(listener);
    listener(this.state);
    return () => {
      this.#listeners.delete(listener);
      if (!this.#listeners.size) {
        this.#disposeClear?.();
        this.#disposeClear = undefined;
      }
    };
  }
  #update(patch: Partial<ReviewState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.#listeners) listener(this.state);
  }
  suspend() {
    this.#active = false;
    this.#readVersion++;
    this.#commandVersion++;
    this.#update({
      loading: false,
      diffLoading: false,
      changes: undefined,
      snapshot: undefined,
      diff: undefined,
      unknown: this.state.unknown || !!this.state.pending,
      pending: undefined,
    });
  }
  resume() {
    this.#active = true;
  }
  #current(version: number) {
    return this.active && version === this.#readVersion;
  }
  async selectSource(source: ReviewSource) {
    if (!this.active || this.state.pending) return;
    this.#update({ source, error: undefined, notice: undefined });
    await this.refresh();
  }
  async selectGitSource(gitSource: RuntimeGitReviewSource) {
    if (!this.active || this.state.pending) return;
    this.#update({ gitSource });
    await this.refresh();
  }
  async refresh(manual = false) {
    if (!this.active || this.state.pending) return;
    await this.restore();
    if (!this.active || this.state.pending) return;
    const version = ++this.#readVersion;
    this.#update({
      loading: true,
      diffLoading: false,
      changes: undefined,
      snapshot: undefined,
      diff: undefined,
      path: undefined,
      stale: false,
      error: undefined,
      notice: undefined,
    });
    try {
      if (this.state.source === "git") {
        const snapshot = await this.port.request(
          "git.review.snapshot",
          { source: this.state.gitSource },
          this.workspaceId,
        );
        if (!this.#current(version)) return;
        this.#update({ snapshot, loading: false });
        if (snapshot.source !== "branch" && snapshot.files[0])
          await this.readFile(snapshot.files[0].path);
      } else {
        const { runs } = await this.port.request(
          "runs.list",
          { sessionId: this.sessionId },
          this.workspaceId,
        );
        if (!this.#current(version)) return;
        const owned = runs.filter((run) => run.sessionId === this.sessionId);
        const terminal = owned
          .filter((run) => isTerminalRunStatus(run.status))
          .sort((a, b) => b.startedAt - a.startedAt);
        const runId =
          terminal.find((run) => run.runId === this.state.runId)?.runId ?? terminal[0]?.runId;
        this.#update({
          runs: owned,
          runId,
          loading: false,
          notice:
            manual && this.state.unknown
              ? "状态已刷新，原审阅结果仍未确认。请使用原操作重试以获取持久回执。"
              : undefined,
        });
        if (runId) await this.selectRun(runId);
      }
    } catch (error) {
      if (this.#current(version)) this.#update({ loading: false, error: errorText(error) });
    }
  }
  async selectRun(runId: string) {
    if (!this.active || this.state.pending || this.state.source !== "run") return;
    const run = this.state.runs.find((candidate) => candidate.runId === runId);
    if (!run || run.sessionId !== this.sessionId || !isTerminalRunStatus(run.status)) return;
    const version = ++this.#readVersion;
    this.#update({
      runId,
      loading: true,
      diffLoading: false,
      changes: undefined,
      diff: undefined,
      path: undefined,
      error: undefined,
      stale: false,
    });
    try {
      // The wire Run deliberately omits checkpointId; Host verifies the actual association.
      const changes = await this.port.request("changes.list", { runId }, this.workspaceId);
      if (!this.#current(version)) return;
      this.#update({ changes, loading: false });
      const first = changes.changes[0];
      if (first) await this.readFile(String(first.path));
    } catch (error) {
      if (this.#current(version)) this.#update({ loading: false, error: errorText(error) });
    }
  }
  async readFile(path: string) {
    if (!this.active || this.state.pending || this.state.loading || this.state.stale) return;
    const { source, runId, changes, snapshot, gitSource } = this.state;
    if (source === "run" && (!runId || !changes)) return;
    if (source === "git" && (!snapshot || gitSource === "branch")) return;
    const version = ++this.#readVersion;
    this.#update({ path, diff: undefined, diffLoading: true, error: undefined });
    try {
      if (source === "run" && runId && changes) {
        const diff = await this.port.request("changes.diff", { runId, path }, this.workspaceId);
        if (!this.#current(version)) return;
        if (diff.fingerprint !== changes.fingerprint) {
          this.#update({
            diffLoading: false,
            stale: true,
            error: "工作区内容已变化，请刷新审阅后重试。",
          });
          return;
        }
        this.#update({ diff, diffLoading: false });
      } else if (snapshot) {
        const diff = await this.port.request(
          "git.review.diff",
          { path, source: gitSource, expectedRevision: snapshot.revision },
          this.workspaceId,
        );
        if (this.#current(version)) this.#update({ diff, diffLoading: false });
      }
    } catch (error) {
      if (this.#current(version))
        this.#update({ diffLoading: false, stale: true, error: errorText(error) });
    }
  }
  async submit(decision: "approve" | "request_changes" | "apply", message?: string) {
    await this.restore();
    const { runId, changes, source, loading, diffLoading, pending, unknown, stale, error } =
      this.state;
    if (
      !this.active ||
      source !== "run" ||
      !runId ||
      !changes ||
      loading ||
      diffLoading ||
      pending ||
      unknown ||
      stale ||
      error
    )
      return false;
    const normalized = message?.trim();
    if (decision === "request_changes" && !normalized) return false;
    if (decision === "apply") return this.#apply(runId, changes.fingerprint);
    const request: PendingReviewRequest = {
      runId,
      expectedFingerprint: changes.fingerprint,
      decision,
      idempotencyKey: this.recoveryStorage.createId(),
      ...(decision === "request_changes" ? { message: normalized! } : {}),
    };
    return this.#sendReview(request, false);
  }
  async retryUnknown() {
    await this.restore();
    if (!this.active || this.state.pending || !this.state.recovery) return false;
    if (!this.options.canRetry?.()) {
      this.#update({ error: "电脑未声明审阅幂等能力，请先升级电脑宿主并核对原对话。" });
      return false;
    }
    return this.#sendReview(this.state.recovery, true);
  }
  async #sendReview(request: PendingReviewRequest, recovering: boolean) {
    const version = ++this.#commandVersion;
    this.#update({ pending: request.decision, error: undefined, notice: undefined });
    let dispatched = false;
    try {
      // Save the exact payload before the transport can hand it to Host.
      await this.recoveryStorage.save(request);
      if (!this.active || version !== this.#commandVersion) return false;
      this.#update({ recovery: request });
      dispatched = true;
      const result = await this.port.request("changes.review", request, this.workspaceId);
      if (!result.accepted) throw new Error("电脑未确认此审阅操作，请使用原操作重试。");
      if (!this.active || version !== this.#commandVersion) return false;
      await this.recoveryStorage.clear(request.idempotencyKey);
      if (!this.active || version !== this.#commandVersion) return false;
      this.#update({
        pending: undefined,
        unknown: false,
        recovery: undefined,
        ...(request.decision === "request_changes" ? { changes: undefined, diff: undefined } : {}),
        notice:
          request.decision === "request_changes"
            ? "修改意见已提交，正在返回原对话。"
            : "审阅已批准。工作区文件不会再次写入。",
      });
      if (request.decision === "request_changes") this.onReturnToConversation?.();
      return true;
    } catch (error) {
      if (!this.active || version !== this.#commandVersion) return false;
      const notExecuted =
        error instanceof Error && "outcome" in error && error.outcome === "not_executed";
      let unknown = recovering || (dispatched && !notExecuted);
      if (dispatched && notExecuted && !recovering) {
        try {
          await this.recoveryStorage.clear(request.idempotencyKey);
        } catch {
          unknown = true;
        }
      }
      if (this.active && version === this.#commandVersion)
        this.#update({
          pending: undefined,
          unknown,
          recovery: unknown ? request : undefined,
          stale: !unknown,
          error: errorText(error),
        });
      return false;
    }
  }
  async #apply(runId: string, expectedFingerprint: string) {
    const version = ++this.#commandVersion;
    this.#update({ pending: "apply", notice: undefined });
    try {
      const result = await this.port.request(
        "changes.apply",
        { runId, expectedFingerprint },
        this.workspaceId,
      );
      if (!this.active || version !== this.#commandVersion) return false;
      if (!result.applied) throw new Error("电脑未确认此核验操作，请刷新状态。");
      this.#update({ pending: undefined, notice: "已核验当前更改。工作区文件不会再次写入。" });
      return true;
    } catch (error) {
      if (this.active && version === this.#commandVersion)
        this.#update({
          pending: undefined,
          stale: true,
          error: errorText(error),
        });
      return false;
    }
  }
}

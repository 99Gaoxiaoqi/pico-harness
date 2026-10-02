import {
  isTerminalRunStatus,
  type RuntimeGitReviewSource,
  type RuntimeResult,
} from "@pico/protocol/mobile";
import { errorText, type RuntimePort } from "./core.js";

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
  constructor(
    readonly port: RuntimePort,
    readonly workspaceId: string,
    readonly sessionId: string,
    readonly onReturnToConversation?: () => void,
  ) {}
  get active() {
    return this.#active;
  }
  subscribe(listener: (state: ReviewState) => void) {
    this.#listeners.add(listener);
    listener(this.state);
    return () => {
      this.#listeners.delete(listener);
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
    return this.#active && version === this.#readVersion;
  }
  async selectSource(source: ReviewSource) {
    if (!this.#active || this.state.pending) return;
    this.#update({ source, error: undefined, notice: undefined });
    await this.refresh();
  }
  async selectGitSource(gitSource: RuntimeGitReviewSource) {
    if (!this.#active || this.state.pending) return;
    this.#update({ gitSource });
    await this.refresh();
  }
  async refresh(manual = false) {
    if (!this.#active || this.state.pending) return;
    const version = ++this.#readVersion;
    const previousUnknown = this.state.unknown;
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
          ...(manual ? { unknown: false } : {}),
          notice:
            manual && previousUnknown
              ? "状态已刷新。请核对原对话是否已经续跑，再决定是否重新提交。"
              : undefined,
        });
        if (runId) await this.selectRun(runId);
      }
    } catch (error) {
      if (this.#current(version)) this.#update({ loading: false, error: errorText(error) });
    }
  }
  async selectRun(runId: string) {
    if (!this.#active || this.state.pending || this.state.source !== "run") return;
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
    if (!this.#active || this.state.pending || this.state.loading || this.state.stale) return;
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
    const { runId, changes, source, loading, diffLoading, pending, unknown, stale, error } =
      this.state;
    if (
      !this.#active ||
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
    const version = ++this.#commandVersion;
    this.#update({ pending: decision, notice: undefined });
    try {
      const target = { runId, expectedFingerprint: changes.fingerprint };
      const result =
        decision === "apply"
          ? await this.port.request("changes.apply", target, this.workspaceId)
          : await this.port.request(
              "changes.review",
              {
                ...target,
                decision,
                ...(decision === "request_changes" && normalized ? { message: normalized } : {}),
              },
              this.workspaceId,
            );
      if (!this.#active || version !== this.#commandVersion) return false;
      const accepted = "accepted" in result ? result.accepted : result.applied;
      if (!accepted) throw new Error("电脑未确认此审阅操作，请刷新状态。");
      this.#update({
        pending: undefined,
        ...(decision === "request_changes" ? { changes: undefined, diff: undefined } : {}),
        notice:
          decision === "request_changes"
            ? "修改意见已提交，正在返回原对话。"
            : decision === "approve"
              ? "审阅已批准。工作区文件不会再次写入。"
              : "已核验当前更改。工作区文件不会再次写入。",
      });
      if (decision === "request_changes") this.onReturnToConversation?.();
      return true;
    } catch (error) {
      if (this.#active && version === this.#commandVersion) {
        const outcomeUnknown =
          error instanceof Error && "outcome" in error && error.outcome === "unknown";
        this.#update({
          pending: undefined,
          unknown: outcomeUnknown,
          stale: !outcomeUnknown,
          error: errorText(error),
        });
      }
      return false;
    }
  }
}

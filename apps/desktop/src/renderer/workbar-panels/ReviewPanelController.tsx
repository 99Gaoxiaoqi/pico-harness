import type { RuntimeResult } from "@pico/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopRuntimeApi } from "../../preload/contract.js";
import {
  ReviewWorkbarPanel,
  type ReviewChangedFile,
  type ReviewDiffView,
  type ReviewSelection,
  type ReviewSnapshot,
} from "./ReviewWorkbarPanel.js";
import type { WorkbarPanelHostProps } from "./workbar-panel-contract.js";
import { invokeWorkbarRuntime, workbarErrorMessage } from "./workbar-runtime.js";

export class WorkbarReviewConflictError extends Error {
  constructor(
    readonly stagedRevision: string,
    readonly unstagedRevision: string,
  ) {
    super(`Git 快照版本冲突：staged ${stagedRevision}，unstaged ${unstagedRevision}`);
    this.name = "WorkbarReviewConflictError";
  }
}

export function ReviewPanelController({ workspacePath, active }: WorkbarPanelHostProps) {
  const runtime = window.pico.runtime;
  const [snapshot, setSnapshot] = useState<ReviewSnapshot>();
  const [selection, setSelection] = useState<ReviewSelection>();
  const [diff, setDiff] = useState<ReviewDiffView>();
  const [loading, setLoading] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [diffError, setDiffError] = useState<string>();
  const requestRef = useRef(0);
  const diffRequestRef = useRef(0);
  const snapshotRef = useRef<ReviewSnapshot | undefined>(undefined);
  const selectionRef = useRef<ReviewSelection | undefined>(undefined);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    ++diffRequestRef.current;
    setDiffLoading(false);
    setLoading(true);
    setError(undefined);
    try {
      const next = await loadConsistentReviewSnapshot(runtime, workspacePath);
      if (request !== requestRef.current) return;
      snapshotRef.current = next;
      setSnapshot(next);
      setDiff(undefined);
      setDiffError(undefined);
      const current = selectionRef.current;
      if (current && reviewContains(next, current)) {
        const diffRequest = ++diffRequestRef.current;
        setDiffLoading(true);
        try {
          const refreshedDiff = await loadReviewDiff(
            runtime,
            workspacePath,
            next.revision,
            current,
          );
          if (
            request === requestRef.current &&
            reviewDiffRequestIsCurrent(
              diffRequest,
              diffRequestRef.current,
              current,
              selectionRef.current,
              next.revision,
              snapshotRef.current?.revision,
            )
          ) {
            setDiff(refreshedDiff);
          }
        } catch (cause) {
          if (
            request === requestRef.current &&
            reviewDiffRequestIsCurrent(
              diffRequest,
              diffRequestRef.current,
              current,
              selectionRef.current,
              next.revision,
              snapshotRef.current?.revision,
            )
          ) {
            setDiffError(workbarErrorMessage(cause));
          }
        } finally {
          if (
            request === requestRef.current &&
            reviewDiffRequestIsCurrent(
              diffRequest,
              diffRequestRef.current,
              current,
              selectionRef.current,
              next.revision,
              snapshotRef.current?.revision,
            )
          ) {
            setDiffLoading(false);
          }
        }
      } else {
        selectionRef.current = undefined;
        setSelection(undefined);
        setDiff(undefined);
        setDiffError(undefined);
      }
    } catch (cause) {
      if (request === requestRef.current) setError(workbarErrorMessage(cause));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [runtime, workspacePath]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const select = useCallback(
    async (next: ReviewSelection) => {
      const diffRequest = ++diffRequestRef.current;
      selectionRef.current = next;
      setSelection(next);
      setDiff(undefined);
      setDiffError(undefined);
      const currentSnapshot = snapshotRef.current;
      if (!currentSnapshot) return;
      setDiffLoading(true);
      try {
        const nextDiff = await loadReviewDiff(
          runtime,
          workspacePath,
          currentSnapshot.revision,
          next,
        );
        if (
          reviewDiffRequestIsCurrent(
            diffRequest,
            diffRequestRef.current,
            next,
            selectionRef.current,
            currentSnapshot.revision,
            snapshotRef.current?.revision,
          )
        ) {
          setDiff(nextDiff);
        }
      } catch (cause) {
        if (
          reviewDiffRequestIsCurrent(
            diffRequest,
            diffRequestRef.current,
            next,
            selectionRef.current,
            currentSnapshot.revision,
            snapshotRef.current?.revision,
          )
        )
          setDiffError(workbarErrorMessage(cause));
      } finally {
        if (
          reviewDiffRequestIsCurrent(
            diffRequest,
            diffRequestRef.current,
            next,
            selectionRef.current,
            currentSnapshot.revision,
            snapshotRef.current?.revision,
          )
        )
          setDiffLoading(false);
      }
    },
    [runtime, workspacePath],
  );

  return (
    <ReviewWorkbarPanel
      snapshot={snapshot}
      selection={selection}
      diff={diff}
      loading={loading}
      diffLoading={diffLoading}
      error={error}
      diffError={diffError}
      onRefresh={() => void refresh()}
      onSelectFile={(next) => void select(next)}
    />
  );
}

export async function loadConsistentReviewSnapshot(
  runtime: DesktopRuntimeApi,
  workspacePath: string,
  attempts = 2,
): Promise<ReviewSnapshot> {
  let lastConflict: WorkbarReviewConflictError | undefined;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    const [staged, unstaged] = await Promise.all([
      invokeWorkbarRuntime(runtime, "git.review.snapshot", { workspacePath, source: "staged" }),
      invokeWorkbarRuntime(runtime, "git.review.snapshot", { workspacePath, source: "unstaged" }),
    ]);
    if (staged.revision === unstaged.revision) {
      return {
        revision: staged.revision,
        branch: staged.branch || unstaged.branch,
        staged: staged.files.map(reviewFileView),
        unstaged: unstaged.files.map(reviewFileView),
      };
    }
    lastConflict = new WorkbarReviewConflictError(staged.revision, unstaged.revision);
  }
  throw lastConflict ?? new Error("Git 快照不可用。");
}

export async function loadReviewDiff(
  runtime: DesktopRuntimeApi,
  workspacePath: string,
  expectedRevision: string,
  selection: ReviewSelection,
): Promise<ReviewDiffView> {
  const value = await invokeWorkbarRuntime(runtime, "git.review.diff", {
    workspacePath,
    path: selection.path,
    source: selection.source,
    expectedRevision,
  });
  if (value.revision !== expectedRevision) {
    throw new WorkbarReviewConflictError(expectedRevision, value.revision);
  }
  return {
    path: value.path,
    source: selection.source,
    revision: value.revision,
    content: value.patch,
    truncated: value.truncated,
  };
}

export function reviewDiffRequestIsCurrent(
  request: number,
  currentRequest: number,
  selection: ReviewSelection,
  currentSelection: ReviewSelection | undefined,
  expectedRevision: string,
  currentRevision: string | undefined,
): boolean {
  return (
    request === currentRequest &&
    selection.path === currentSelection?.path &&
    selection.source === currentSelection?.source &&
    expectedRevision === currentRevision
  );
}

function reviewFileView(
  file: RuntimeResult<"git.review.snapshot">["files"][number],
): ReviewChangedFile {
  return {
    path: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
  };
}

function reviewContains(snapshot: ReviewSnapshot, selection: ReviewSelection): boolean {
  const files = selection.source === "staged" ? snapshot.staged : snapshot.unstaged;
  return files.some((file) => file.path === selection.path);
}

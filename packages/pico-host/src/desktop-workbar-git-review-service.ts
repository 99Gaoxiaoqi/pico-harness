import {
  WorkbarGitReviewAuthority,
  WorkbarGitReviewError,
  type WorkbarGitChange,
} from "./workbar-git-review.js";

export type DesktopGitReviewSource = "branch" | "staged" | "unstaged";

export class DesktopWorkbarGitReviewService {
  async snapshot(input: {
    readonly workspacePath: string;
    readonly source?: DesktopGitReviewSource;
  }) {
    const authority = await WorkbarGitReviewAuthority.open(input.workspacePath);
    const snapshot = await authority.snapshot();
    const source = input.source ?? "branch";
    const changes =
      source === "staged"
        ? snapshot.staged
        : source === "unstaged"
          ? snapshot.unstaged
          : [...snapshot.staged, ...snapshot.unstaged];
    return {
      revision: snapshot.revision,
      branch: snapshot.branch ?? "",
      source,
      files: changes.map(runtimeFile),
      truncated: false,
    };
  }

  async diff(input: {
    readonly workspacePath: string;
    readonly path: string;
    readonly source: DesktopGitReviewSource;
    readonly expectedRevision: string;
  }) {
    if (input.source === "branch") {
      throw new WorkbarGitReviewError(
        "invalid_request",
        "Branch overview does not identify staged or unstaged diff authority",
      );
    }
    const authority = await WorkbarGitReviewAuthority.open(input.workspacePath);
    const diff = await authority.diff({
      path: input.path,
      stage: input.source,
      expectedRevision: input.expectedRevision,
    });
    return {
      path: diff.path,
      source: input.source,
      revision: diff.revision,
      patch: diff.patch,
      truncated: false,
    };
  }
}

function runtimeFile(change: WorkbarGitChange) {
  return {
    path: change.path,
    status: runtimeStatus(change),
    additions: 0,
    deletions: 0,
  };
}

function runtimeStatus(change: WorkbarGitChange) {
  if (change.status === "added" || change.status === "untracked") return "added" as const;
  if (change.status === "deleted") return "deleted" as const;
  if (change.status === "renamed" || change.status === "copied") return "renamed" as const;
  return "modified" as const;
}

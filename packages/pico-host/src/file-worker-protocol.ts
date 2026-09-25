export type FileWorkerOperation =
  | "read_file"
  | "write_file"
  | "edit_file"
  | "glob"
  | "grep"
  | "explore_repo";

export interface FileTargetIdentity {
  readonly kind: "missing" | "file" | "directory";
  readonly dev?: string;
  readonly ino?: string;
  readonly size?: string;
  readonly mtimeNs?: string;
  readonly ctimeNs?: string;
}

/** AppContainer ACL grant/cleanup changes Windows ctime without changing file content or identity. */
export function sameFileTargetIdentity(
  expected: FileTargetIdentity,
  actual: FileTargetIdentity,
): boolean {
  if (expected.kind !== actual.kind) return false;
  if (expected.kind === "missing") return true;
  const valid = (value: string | undefined): value is string =>
    value !== undefined && /^\d+$/u.test(value);
  // Creating a scratch entry or binding a sandbox mount changes a directory's
  // size and timestamps without replacing that directory. Its device/inode
  // pair remains the identity that matters for a path swap.
  if (expected.kind === "directory") {
    return (
      valid(expected.dev) &&
      valid(expected.ino) &&
      (process.platform !== "win32" || expected.ino !== "0") &&
      expected.dev === actual.dev &&
      expected.ino === actual.ino
    );
  }
  if (process.platform !== "win32") return JSON.stringify(expected) === JSON.stringify(actual);
  return (
    valid(expected.dev) &&
    valid(expected.ino) &&
    expected.ino !== "0" &&
    valid(expected.size) &&
    valid(expected.mtimeNs) &&
    valid(actual.dev) &&
    valid(actual.ino) &&
    actual.ino !== "0" &&
    valid(actual.size) &&
    valid(actual.mtimeNs) &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino &&
    expected.size === actual.size &&
    expected.mtimeNs === actual.mtimeNs
  );
}

export interface FileWorkerRequest {
  readonly operationId: string;
  readonly boundaryRevision: number;
  readonly operation: FileWorkerOperation;
  readonly args: string;
  readonly workDir: string;
  readonly workDirIdentity: FileTargetIdentity;
  readonly stagePath: string;
  readonly targets: readonly {
    path: string;
    identity: FileTargetIdentity;
    /** Required for a not-yet-existing exact write target. */
    parentIdentity?: FileTargetIdentity;
  }[];
  readonly excludeSensitiveFiles: boolean;
}

export interface FileWorkerResponse {
  readonly operationId: string;
  readonly boundaryRevision: number;
  readonly ok: boolean;
  readonly result?: string;
  readonly preparedDigest?: string;
  readonly preparedBytes?: number;
  /** Digest of the source bytes used to prepare an edit. */
  readonly sourceDigest?: string;
  readonly error?: string;
}

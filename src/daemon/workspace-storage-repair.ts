import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import { ALL_WORKSPACE_SQLITE_SCOPES } from "../storage/sqlite/workspace-scopes.js";
import {
  discardWorkspaceStorageRepair,
  prepareWorkspaceStorageRepairSync,
  repairWorkspaceStorageSync,
  type WorkspaceStorageRepairCandidate,
} from "../storage/sqlite/sqlite-workspace-storage.js";
import {
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  type RuntimeParams,
  type RuntimeResult,
} from "./protocol.js";

/** Candidates stay in the database-owning daemon; the Desktop main process obtains confirmation. */
export class WorkspaceStorageRepairService {
  private readonly pending = new Map<
    string,
    {
      workspacePath: string;
      candidate: WorkspaceStorageRepairCandidate;
      expiresAt: number;
    }
  >();

  constructor(private readonly picoHome: string) {}

  prepare(workspacePath: string): RuntimeResult<"workspace.storageRepair.prepare"> {
    if (!isAbsolute(workspacePath)) {
      throw new RuntimeProtocolError(
        RUNTIME_ERROR_CODES.INVALID_PARAMS,
        "工作区路径必须是绝对路径。",
      );
    }
    for (const [token, record] of this.pending) {
      if (record.expiresAt < Date.now() || record.workspacePath === workspacePath) {
        discardWorkspaceStorageRepair(record.candidate);
        this.pending.delete(token);
      }
    }
    const paths = resolvePicoPaths(workspacePath, { picoHome: this.picoHome });
    const candidate = prepareWorkspaceStorageRepairSync(
      paths.workspace.root,
      ALL_WORKSPACE_SQLITE_SCOPES,
    );
    if (!candidate) return { candidate: null };
    const token = randomUUID();
    this.pending.set(token, { workspacePath, candidate, expiresAt: Date.now() + 30 * 60_000 });
    return { candidate: { token, storagePath: candidate.storagePath } };
  }

  respond(
    input: RuntimeParams<"workspace.storageRepair.respond">,
  ): RuntimeResult<"workspace.storageRepair.respond"> {
    const record = this.pending.get(input.token);
    this.pending.delete(input.token);
    if (!record) throw this.stale();
    if (input.action === "cancel") {
      discardWorkspaceStorageRepair(record.candidate);
      return { repaired: false };
    }
    if (
      record.workspacePath !== input.workspacePath ||
      record.expiresAt < Date.now() ||
      resolvePicoPaths(input.workspacePath, { picoHome: this.picoHome }).workspace.root !==
        record.candidate.storagePath
    ) {
      discardWorkspaceStorageRepair(record.candidate);
      throw this.stale();
    }
    repairWorkspaceStorageSync(record.candidate);
    return { repaired: true };
  }

  private stale(): RuntimeProtocolError {
    return new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.CONFLICT,
      "修复请求已失效，请重新打开工作区。",
    );
  }
}

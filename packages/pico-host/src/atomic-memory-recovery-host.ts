import { stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import type { MemoryGateResult } from "@pico/core/atomic-memory-runtime-contracts";
import type { AtomicMemoryLifecycle } from "@pico/runtime";
import { projectRuntimeSessionState } from "@pico/runtime/session-runtime-projection";
import { operationalDatabasePath } from "@pico/storage";
import { decodeRuntimeEventJson } from "@pico/storage/runtime-event";
import {
  AtomicMemoryRuntime,
  type AtomicMemoryModelLease,
  type AtomicMemoryRuntimeOptions,
} from "./atomic-memory-runtime.js";
import { resolvePicoPaths } from "./pico-paths.js";
import { listCliSessionCatalogEntries } from "./session-resolver.js";
import type { WorkspaceRegistrationStore } from "./workspace-registration.js";
import type { WorkspaceTrustStore } from "./workspace-trust.js";

interface RecoveryModelRoute {
  readonly providerId: string;
  readonly modelId: string;
}
interface RecoveryRuntime {
  reconcileAdmittedBoundaries(): Promise<number>;
  recoverPendingJobs(): Promise<number>;
}
interface RecoveryHostOptions {
  readonly picoHome: string;
  /** The existing Host startup registration snapshot; every later gate reloads it. */
  readonly workspacePaths: readonly string[];
  readonly registrationStore: Pick<WorkspaceRegistrationStore, "list">;
  readonly trustStore: Pick<WorkspaceTrustStore, "canonicalize" | "isTrusted">;
  readonly lifecycle: AtomicMemoryLifecycle;
  readonly modelFactory: (
    workDir: string,
    route: RecoveryModelRoute,
    sessionId: string,
  ) => Promise<AtomicMemoryModelLease>;
  readonly onChanged?: (workspacePath: string) => void;
  /** Synthetic fixtures can observe dispatch without changing production admission. */
  readonly createRuntime?: (options: AtomicMemoryRuntimeOptions) => RecoveryRuntime;
  readonly onUnavailable?: () => void;
}

/** Startup discovery only: the Runtime owns durable admission, claims and bounded retries. */
export function recoverRegisteredAtomicMemory(options: RecoveryHostOptions): Promise<void> {
  // An empty startup snapshot owns no recovery work and must not pin the daemon.
  if (options.workspacePaths.length === 0) return Promise.resolve();
  const unavailable = () => {
    try {
      options.onUnavailable?.();
    } catch {
      /* Diagnostics cannot affect other registered workspaces. */
    }
  };
  return options.lifecycle.run(
    "extract",
    async () => {
      await Promise.allSettled(
        [...new Set(options.workspacePaths)].map(async (workspacePath) => {
          try {
            if (!(await workspaceAvailable(options, workspacePath))) return;
            const sessions = await listCliSessionCatalogEntries(workspacePath, {
              picoHome: options.picoHome,
            });
            await Promise.allSettled(
              sessions.map(async ({ summary, isArchived }) => {
                if (isArchived || options.lifecycle.isDraining) return;
                try {
                  const authority = await currentSessionAuthority(
                    options,
                    workspacePath,
                    summary.id,
                  );
                  if (!authority) return;
                  const gate = async (): Promise<MemoryGateResult> => {
                    const current = await currentSessionAuthority(
                      options,
                      workspacePath,
                      summary.id,
                    );
                    return current &&
                      current.providerId === authority.providerId &&
                      current.modelId === authority.modelId
                      ? { allowed: true }
                      : { allowed: false, reason: "recovery_authority_unavailable" };
                  };
                  const runtimeOptions: AtomicMemoryRuntimeOptions = {
                    workDir: workspacePath,
                    picoHome: options.picoHome,
                    sessionId: summary.id,
                    lifecycle: options.lifecycle,
                    supported: true,
                    // Recovery never invents missing foreground Tool definitions/permission state.
                    preserveSourceTools: false,
                    gate,
                    modelFactory: async () => {
                      if (!(await gate()).allowed)
                        throw new Error("recovery_authority_unavailable");
                      const lease = await options.modelFactory(
                        workspacePath,
                        authority,
                        summary.id,
                      );
                      return {
                        model: {
                          call: async (request) => {
                            if (!(await gate()).allowed)
                              throw new Error("recovery_authority_unavailable");
                            return lease.model.call(request);
                          },
                        },
                        ...(lease.dispose ? { dispose: () => lease.dispose!() } : {}),
                      };
                    },
                    onChanged: () => options.onChanged?.(workspacePath),
                  };
                  const runtime = options.createRuntime
                    ? options.createRuntime(runtimeOptions)
                    : new AtomicMemoryRuntime(runtimeOptions);
                  if (!(await gate()).allowed) return;
                  await runtime.reconcileAdmittedBoundaries();
                  if (!(await gate()).allowed) return;
                  await runtime.recoverPendingJobs();
                } catch {
                  unavailable();
                }
              }),
            );
          } catch {
            unavailable();
          }
        }),
      );
    },
    () => undefined,
  );
}

async function workspaceAvailable(
  options: RecoveryHostOptions,
  workspacePath: string,
): Promise<boolean> {
  if (options.lifecycle.isDraining) return false;
  const registered = await options.registrationStore.list();
  if (!registered.includes(workspacePath)) return false;
  const canonical = await options.trustStore.canonicalize(workspacePath);
  if (canonical !== workspacePath || !(await options.trustStore.isTrusted(canonical))) return false;
  const paths = resolvePicoPaths(workspacePath, { picoHome: options.picoHome });
  try {
    return (await stat(operationalDatabasePath(paths.workspace.root))).isFile();
  } catch {
    return false;
  }
}

/** Missing durable session policy is a pause, never inherited from the currently opened UI. */
async function currentSessionAuthority(
  options: RecoveryHostOptions,
  workspacePath: string,
  sessionId: string,
): Promise<RecoveryModelRoute | undefined> {
  try {
    if (!(await workspaceAvailable(options, workspacePath))) return;
    const entry = (
      await listCliSessionCatalogEntries(workspacePath, { picoHome: options.picoHome })
    ).find(({ summary }) => summary.id === sessionId);
    if (
      !entry ||
      entry.isArchived ||
      (await options.trustStore.canonicalize(entry.summary.cwd)) !== workspacePath
    )
      return;
    const paths = resolvePicoPaths(workspacePath, { picoHome: options.picoHome });
    const db = new DatabaseSync(operationalDatabasePath(paths.workspace.root), { readOnly: true });
    try {
      const rows = db
        .prepare(
          "SELECT payload_json FROM runtime_events WHERE session_id=? AND kind='session.state.committed' ORDER BY event_seq",
        )
        .all(sessionId);
      const state = projectRuntimeSessionState(
        rows.map((row) => decodeRuntimeEventJson(String(row.payload_json))),
      );
      const settings = state.settings;
      if (
        !settings ||
        settings.collaborationMode !== "agent" ||
        settings.sideConversation ||
        !state.boundary ||
        state.boundary.kind === "external"
      )
        return;
      if (options.lifecycle.isDraining) return;
      const routeId = settings.modelRouteId;
      if (!/^[^/\s]+\/\S+$/u.test(routeId)) return;
      const slash = routeId.indexOf("/");
      return { providerId: routeId.slice(0, slash), modelId: routeId.slice(slash + 1) };
    } finally {
      db.close();
    }
  } catch {
    return;
  }
}

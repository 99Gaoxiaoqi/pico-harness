import { resolve } from "node:path";
import type { TaskExperienceCandidate } from "@pico/core";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { SqliteRuntimeEventStore } from "./product-runtime-event-store.js";
import { atomicMemoryDatabasePath } from "./atomic-memory-runtime.js";
import { resolvePicoPaths } from "./pico-paths.js";
import { validateCanonicalExecutionSource } from "./execution-learning-runtime.js";
import {
  getExecutionLearningWorker,
  acquireExecutionLearningWorker,
  closeExecutionLearningWorker,
  type ExecutionLearningWorkerOptions,
} from "./execution-learning-worker.js";
import type { AtomicMemoryLifecycle } from "@pico/runtime";
import type { AtomicMemoryModelLease } from "./atomic-memory-runtime.js";
import { logger } from "./logger.js";
import { WorkspaceRoots } from "./workspace-roots.js";
import { projectRuntimeSessionState } from "@pico/runtime/session-runtime-projection";
import {
  canonicalTaskArguments,
  validateCanonicalTaskExperienceSource,
} from "./task-experience-runtime.js";
import {
  spreadsheetExperienceApplicability,
  taskInputArtifactIds,
  validateSpreadsheetTaskExperience,
} from "./task-experience-validation.js";
import { SqliteSessionWorkbarRepository } from "@pico/storage";
import { readSessionInputArtifact } from "./session-input-attachments.js";

type ModelRoute = NonNullable<TaskExperienceCandidate["modelRoute"]>;
const hostConfigurations = new Map<
  string,
  {
    modelFactory: (
      workDir: string,
      route: ModelRoute,
      sessionId: string,
    ) => Promise<AtomicMemoryModelLease>;
  }
>();
export function configureExecutionLearningHost(
  picoHome: string,
  configuration: {
    modelFactory: (
      workDir: string,
      route: ModelRoute,
      sessionId: string,
    ) => Promise<AtomicMemoryModelLease>;
  },
): void {
  hostConfigurations.set(picoHome, configuration);
}

/** Every read reloads the authoritative durable boundary, including later revocation. */
export function executionLearningPathAuthorizer(
  workDir: string,
  picoHome: string,
  sessionId: string,
): (path: string) => Promise<string> {
  return async (path) => {
    const paths = resolvePicoPaths(workDir, { picoHome });
    const events = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
    try {
      const { entries } = await events.readSessionEntriesOfKinds(sessionId, [
        "session.state.committed",
      ]);
      const current = projectRuntimeSessionState(entries.map(({ event }) => event));
      if (!current.boundary || current.boundary.kind === "external")
        throw new Error("Background learning read permission unavailable");
      const roots = await WorkspaceRoots.create(workDir);
      if (current.boundary.kind === "managed")
        roots.replaceBoundaryProfile(current.boundary.profile);
      return roots.assertAllowed(path, { access: "read", consumeAuthorization: false });
    } finally {
      events.close();
    }
  };
}

export function executionLearningHost(options: {
  picoHome: string;
  gate: (workDir: string) => Promise<boolean>;
  lifecycle?: AtomicMemoryLifecycle;
  onChanged?: (change: { workspacePath: string; workspaceKey: string; revision: number }) => void;
  workerOptions?: Pick<ExecutionLearningWorkerOptions, "idleMs" | "pollMs">;
}) {
  const old = getExecutionLearningWorker(options.picoHome);
  if (old) return old;
  const repository = new SqliteMemoryItemStore(atomicMemoryDatabasePath(options.picoHome));
  const worker = acquireExecutionLearningWorker({
    picoHome: options.picoHome,
    store: repository.executionLearning,
    taskExperiences: repository.taskExperiences,
    ...options.workerOptions,
    onClose: () => repository.close(),
    onError: (error) =>
      logger.debug(
        { errorKind: error instanceof Error ? error.name : typeof error },
        "[ExecutionLearning] background operation unavailable",
      ),
    onTaskExperienceChanged: (candidate) =>
      options.onChanged?.({
        workspacePath: candidate.workDir,
        workspaceKey: candidate.workspaceKey,
        revision: repository.executionLearning.readRevision(),
      }),
    onChanged: (candidate) =>
      options.onChanged?.({
        workspacePath: candidate.claim.admission.workDir,
        workspaceKey: candidate.claim.admission.workspaceKey,
        revision: repository.executionLearning.readRevision(),
      }),
    ...(options.lifecycle
      ? {
          track: (task: Promise<unknown>) => {
            void options.lifecycle!.run(
              "extract",
              () => task,
              () => undefined,
            );
          },
        }
      : {}),
    taskExperienceModelFactory: async ({ candidate }) => {
      const configured = hostConfigurations.get(options.picoHome);
      if (
        !candidate.modelRoute ||
        !configured ||
        !(await options.gate(candidate.workDir)) ||
        !repository.taskExperiences.taskExperienceAllowed(candidate)
      )
        throw new Error("Current task experience model route blocked");
      return configured.modelFactory(candidate.workDir, candidate.modelRoute, candidate.sessionId);
    },
    taskExperienceApplicability: async ({ candidate, observations, signal }) => {
      const method = spreadsheetExperienceApplicability(observations);
      if (!method || signal.aborted || !(await options.gate(candidate.workDir))) return undefined;
      const storageRoot = resolvePicoPaths(candidate.workDir, { picoHome: options.picoHome })
        .workspace.root;
      const events = new SqliteRuntimeEventStore({ storageRoot });
      try {
        const task = await repository.taskExperiences.readTaskExperienceTask(candidate.taskId);
        if (!task || task.taskVersion !== candidate.taskVersion) return undefined;
        const goal = await validateCanonicalTaskExperienceSource(events, task.goalSource, {
          workDir: candidate.workDir,
        });
        if (goal?.event.kind !== "message.committed") return undefined;
        const inputArtifactIds = taskInputArtifactIds(goal.event.data.message);
        const artifacts = new SqliteSessionWorkbarRepository({ storageRoot });
        for (const observation of observations) {
          const canonical = await validateCanonicalTaskExperienceSource(
            events,
            observation.source,
            { workDir: candidate.workDir },
          );
          const args = canonicalTaskArguments(canonical?.start);
          const event = canonical?.event;
          if (
            !args ||
            event?.kind !== "tool.result.recorded" ||
            event.data.body.storage !== "inline" ||
            typeof args.artifact_id !== "string"
          )
            continue;
          try {
            await executionLearningPathAuthorizer(
              candidate.workDir,
              options.picoHome,
              candidate.sessionId,
            )(candidate.workDir);
            const id = args.artifact_id.startsWith("pico://artifact/")
              ? decodeURIComponent(args.artifact_id.slice("pico://artifact/".length))
              : args.artifact_id;
            if (
              !inputArtifactIds.includes(id) ||
              signal.aborted ||
              !(await options.gate(candidate.workDir))
            )
              continue;
            const { artifact, bytes } = readSessionInputArtifact({
              repository: artifacts,
              sessionId: candidate.sessionId,
              artifactId: id,
              signal,
            });
            const verdict = await validateSpreadsheetTaskExperience({
              currentArtifactId: id,
              candidate: {
                ...candidate,
                review: "approved",
                enabled: true,
                applicability: {
                  taskFamily: "spreadsheet",
                  toolNames: ["document"],
                  conditions: [],
                  spreadsheet: method,
                },
              },
              task,
              observation,
              canonicalArguments: args,
              canonicalResult: event.data.body.content,
              artifactBytes: bytes,
              artifactDigest: artifact.digest,
              now: Date.now(),
            });
            if (verdict.validation === "pass") return method;
          } catch {
            /* Unsupported or revoked artifact reads cannot assign finite-number conditions. */
          }
        }
        return undefined;
      } finally {
        events.close();
      }
    },
    validateTaskExperienceSources: async ({ candidate, observations, signal }) => {
      if (signal.aborted || !(await options.gate(candidate.workDir))) return false;
      const events = new SqliteRuntimeEventStore({
        storageRoot: resolvePicoPaths(candidate.workDir, { picoHome: options.picoHome }).workspace
          .root,
      });
      try {
        for (const observation of observations) {
          if (
            signal.aborted ||
            !(await validateCanonicalTaskExperienceSource(events, observation.source, {
              workDir: candidate.workDir,
            }))
          )
            return false;
        }
        return true;
      } finally {
        events.close();
      }
    },
    taskExperienceNativeEvidence: async ({ candidate, sources, signal }) => {
      if (signal.aborted || !(await options.gate(candidate.workDir))) return undefined;
      const events = new SqliteRuntimeEventStore({
        storageRoot: resolvePicoPaths(candidate.workDir, { picoHome: options.picoHome }).workspace
          .root,
      });
      try {
        const matches = [];
        for (const native of await repository.executionLearning.listExecutionLearningCandidates(
          candidate.workspaceKey,
        )) {
          const claim = native.claim;
          if (signal.aborted) return undefined;
          if (
            !["waiting", "insufficient", "saved"].includes(native.state) ||
            resolve(claim.admission.workDir) !== resolve(candidate.workDir) ||
            (native.state !== "saved" && claim.createdAt + 30 * 86400000 <= Date.now()) ||
            !claim.recipe.length ||
            !claim.conditions.length ||
            !sources.some(
              (source) =>
                source.sessionId === claim.failure.sessionId &&
                source.runId === claim.failure.runId &&
                source.turnId === claim.failure.turnId &&
                source.eventId === claim.failure.eventId,
            )
          )
            continue;
          const failure = await validateCanonicalExecutionSource(events, claim.failure, {
            workDir: candidate.workDir,
            toolName: "bash",
          });
          if (
            !failure ||
            typeof failure.result.data.executionFacts?.exitCode !== "number" ||
            failure.result.data.executionFacts.exitCode === 0
          )
            continue;
          matches.push({
            candidateId: claim.candidateId,
            claimRevision: claim.revision,
            claimHash: claim.claimHash,
            scopeHash: claim.target.scopeHash,
          });
        }
        // Ambiguous evidence must never grant the model's prose a broader validation scope.
        return matches.length === 1 ? matches[0] : undefined;
      } finally {
        events.close();
      }
    },
  }).worker;
  options.lifecycle?.onClose(() => closeExecutionLearningWorker(options.picoHome));
  void repository.executionLearning.recoverSettledExecutionLearningJobs(Date.now()).then(
    () => worker.wake(),
    (error) =>
      logger.debug(
        { errorKind: error instanceof Error ? error.name : typeof error },
        "[ExecutionLearning] receipt recovery unavailable",
      ),
  );
  return worker;
}

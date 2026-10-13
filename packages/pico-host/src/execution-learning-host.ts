import { isAbsolute, relative } from "node:path";
import type { ExecutionAcceptanceClaim, TaskExperienceCandidate } from "@pico/core";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { SqliteRuntimeEventStore } from "./product-runtime-event-store.js";
import { atomicMemoryDatabasePath } from "./atomic-memory-runtime.js";
import { resolvePicoPaths } from "./pico-paths.js";
import {
  validateCanonicalExecutionSource,
  type ExecutionNativeCommandFact,
  type ExecutionNativeFileFact,
} from "./execution-learning-runtime.js";
import { evaluateAcceptance } from "./execution-learning-evidence.js";
import { createExecutionLearningIO } from "./execution-learning-recall.js";
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

const modelFactories = new Map<string, () => Promise<AtomicMemoryModelLease>>();
export function registerExecutionLearningModel(
  admissionId: string,
  factory: () => Promise<AtomicMemoryModelLease>,
): void {
  modelFactories.set(admissionId, factory);
  if (modelFactories.size > 100) modelFactories.delete(modelFactories.keys().next().value!);
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
    modelFactory: async ({ candidate }) => {
      const route = candidate.claim.admission.modelRoute;
      const configured = hostConfigurations.get(options.picoHome);
      const factory = configured
        ? route
          ? () =>
              configured.modelFactory(
                candidate.claim.admission.workDir,
                route,
                candidate.claim.admission.sessionId,
              )
          : undefined
        : modelFactories.get(candidate.claim.admission.admissionId);
      if (
        !factory ||
        !(await options.gate(candidate.claim.admission.workDir)) ||
        !repository.executionLearning.executionLearningAllowed(candidate.claim)
      )
        throw new Error("No current admission model route");
      return factory();
    },
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
        const goal = await validateCanonicalTaskExperienceSource(events, task.goalSource, {workDir: candidate.workDir});
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
            if (!inputArtifactIds.includes(id) || signal.aborted || !(await options.gate(candidate.workDir))) continue;
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
    validateEvidence: async ({ candidate, ticket, result, signal }) => {
      const claim = candidate.claim;
      if (signal.aborted || !(await options.gate(claim.admission.workDir)))
        return { status: "skip", reason: "workspace_untrusted" };
      const paths = resolvePicoPaths(claim.admission.workDir, { picoHome: options.picoHome });
      const events = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
      try {
        const current = await validateCanonicalExecutionSource(events, result.source, {
          workDir: claim.admission.workDir,
          toolName: "bash",
        });
        const failure = await validateCanonicalExecutionSource(events, claim.failure, {
          workDir: claim.admission.workDir,
          toolName: "bash",
        });
        if (
          !current ||
          !failure ||
          failure.result.data.executionFacts?.exitCode === 0 ||
          current.operation.preparedEventId !== ticket.preparedEventId ||
          current.operation.argumentsHash !== ticket.argumentsHash ||
          current.result.data.executionFacts?.exitCode !== 0
        )
          return { status: "insufficient", reason: "native_evidence_unavailable" };
        const run = await events.readRun(ticket.sessionId, ticket.runId);
        if (
          !run.some(
            (event) =>
              event.kind === "run.terminal" &&
              event.data.status === "completed" &&
              !event.data.recovered,
          )
        )
          return { status: "insufficient", reason: "run_not_completed" };
        for (const step of claim.recipe) {
          const source = await validateCanonicalExecutionSource(events, step.source, {
            workDir: claim.admission.workDir,
          });
          if (!source || source.result.data.status !== "succeeded")
            return { status: "insufficient", reason: "preparation_source_unavailable" };
          const admissions = await repository.executionLearning.listAdmissions();
          const admission = admissions.find(
            (a) => a.sessionId === step.source.sessionId && a.runId === step.source.runId,
          );
          if (!admission) return { status: "insufficient", reason: "preparation_not_admitted" };
          const facts = await repository.executionLearning.listNativeFacts(admission.admissionId);
          if (step.kind === "file") {
            const fact = facts.find(
              (f) => f.kind === "file" && f.preparedEventId === source.operation.preparedEventId,
            )?.fact as ExecutionNativeFileFact | undefined;
            if (
              !fact?.commits.some(
                (commit) =>
                  commit.path === step.path &&
                  commit.afterHash === step.afterHash &&
                  commit.content === step.content,
              ) ||
              fact.source?.eventId !== step.source.eventId
            )
              return { status: "insufficient", reason: "file_commit_unavailable" };
          }
          if (step.kind === "dependency") {
            const fact = facts.find(
              (f) => f.kind === "command" && f.preparedEventId === source.operation.preparedEventId,
            )?.fact as ExecutionNativeCommandFact | undefined;
            const installed = fact?.installedDependency;
            if (
              !installed ||
              installed.command !== step.command ||
              installed.manifestHash !== step.manifestHash ||
              fact.result?.source.eventId !== step.source.eventId ||
              fact.result.exitCode !== 0 ||
              !claim.conditions.some(
                (c) =>
                  c.kind === "node-package" &&
                  JSON.stringify(c) === JSON.stringify(installed.condition),
              )
            )
              return { status: "insufficient", reason: "dependency_commit_unavailable" };
          }
          if (step.kind === "cwd") {
            const fact = facts.find(
              (f) => f.kind === "command" && f.preparedEventId === source.operation.preparedEventId,
            )?.fact as ExecutionNativeCommandFact | undefined;
            if (
              fact?.result?.exitCode !== 0 ||
              (fact.cwdPreparation !== step.path && fact.target?.cwd !== step.path)
            )
              return { status: "insufficient", reason: "directory_commit_unavailable" };
          }
        }
        const fact = (await repository.executionLearning.listNativeFacts(ticket.admissionId)).find(
          (f) => f.kind === "command" && f.preparedEventId === ticket.preparedEventId,
        )?.fact as ExecutionNativeCommandFact | undefined;
        if (
          fact?.target?.scopeHash !== claim.target.scopeHash ||
          fact.argumentsJson !== current.start.data.argumentsJson ||
          fact.result?.source.eventId !== result.source.eventId
        )
          return { status: "insufficient", reason: "target_binding_changed" };
        const accepted = evaluateAcceptance(claim, ticket, result);
        if (
          claim.predicateId === "test-target-pass.v1" &&
          (!claim.runner?.fingerprint ||
            claim.runner.execPath !== result.report?.runner?.execPath ||
            claim.runner.version !== result.report?.runner?.version ||
            claim.runner.fingerprint !== result.report?.runner?.fingerprint)
        )
          return { status: "insufficient", reason: "runner_changed" };
        if (!accepted.accepted)
          return { status: "insufficient", reason: accepted.reason ?? "acceptance_unknown" };
        // Current scope is checked separately from preparation state; a missing config remains recallable.
        const io = createExecutionLearningIO(
          claim.admission.workDir,
          undefined,
          executionLearningPathAuthorizer(
            claim.admission.workDir,
            options.picoHome,
            ticket.sessionId,
          ),
        );
        const { resolveExecutionLearningTarget } = await import("./execution-learning-evidence.js");
        const target = await resolveExecutionLearningTarget(
          claim.target.command,
          claim.target.cwd,
          io,
        );
        if (target?.scopeHash !== claim.target.scopeHash)
          return { status: "insufficient", reason: "entry_changed" };
        const canonicalWorkspace = await io.realpath(claim.admission.workDir);
        if (!canonicalWorkspace) return { status: "insufficient", reason: "workspace_unavailable" };
        const content = compactLesson(claim, canonicalWorkspace);
        return content
          ? { status: "pass", content }
          : { status: "insufficient", reason: "lesson_budget" };
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
function compactLesson(
  claim: ExecutionAcceptanceClaim,
  canonicalWorkspace: string,
): string | undefined {
  const quote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;
  const path = (value: string) => {
    const local = relative(canonicalWorkspace, value);
    return local ? `./${local}` : ".";
  };
  const command = claim.target.argv
    .map((arg, index) => {
      if (!isAbsolute(arg) || !claim.target.entryFiles.some((file) => file.path === arg))
        return quote(arg);
      const local = relative(claim.target.cwd, arg);
      return quote(index === 0 && !local.startsWith(".") ? `./${local}` : local);
    })
    .join(" ");
  const lines = [
    `已验证执行方案：${command}`,
    `工作目录：${path(claim.target.cwd)}`,
    "适用于本工作区同一检查入口。准备文件或依赖缺失时，参考以下步骤。",
  ];
  for (const step of claim.recipe) {
    if (step.kind === "cwd") lines.push(`准备目录：${path(step.path)}`);
    else if (step.kind === "dependency") lines.push(`准备依赖：${step.command}`);
    else
      lines.push(
        `准备文件：${path(step.path)}${step.content === undefined ? "" : `；可复用内容 ${JSON.stringify(step.content)}`}`,
      );
  }
  for (const condition of claim.conditions) {
    if (condition.kind === "json")
      lines.push(
        `验收字段：${path(condition.path)} ${JSON.stringify(condition.field)} = ${JSON.stringify(condition.value)}`,
      );
    else if (condition.kind === "node-package")
      lines.push(
        `验收依赖：${condition.name}@${condition.version}；入口 ${path(condition.entryPath)}`,
      );
  }
  lines.push(
    claim.predicateId === "test-target-pass.v1"
      ? "固定目标测试已通过；这是操作方案验收，不是根因证明。"
      : "所列条件满足时，目标命令完整成功；不证明唯一根因。",
  );
  const content = lines.join("\n");
  return [...content].length <= 2000 ? content : undefined;
}

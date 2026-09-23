/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * Adapted from Apache Maka deep-research-run.ts and deep-research.ts,
 * revision 777a2363c141d2ca4cc212eb5c8a4b6b4bb3e63f (Apache-2.0).
 * Pico uses its canonical SQLite workspace and existing artifact preview authority.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export const DEEP_RESEARCH_RUN_SCHEMA_VERSION = 1 as const;

export const DEEP_RESEARCH_ACTIVE_STAGES = ["knowledge_base", "report_writing"] as const;
export type DeepResearchActiveStage = (typeof DEEP_RESEARCH_ACTIVE_STAGES)[number];

export const DEEP_RESEARCH_STAGES = [...DEEP_RESEARCH_ACTIVE_STAGES, "completed"] as const;
export type DeepResearchStage = (typeof DEEP_RESEARCH_STAGES)[number];

export const DEEP_RESEARCH_RUN_STATUSES = ["active", "blocked", "completed"] as const;
export type DeepResearchRunStatus = (typeof DEEP_RESEARCH_RUN_STATUSES)[number];

export const DEEP_RESEARCH_SCOPE_LEVELS = ["quick", "standard", "deep"] as const;
export type DeepResearchScopeLevel = (typeof DEEP_RESEARCH_SCOPE_LEVELS)[number];

export const DEEP_RESEARCH_ARTIFACT_ROLES = [
  "source",
  "evidence_note",
  "outline",
  "report_section",
  "report",
  "handoff",
] as const;
export type DeepResearchArtifactRole = (typeof DEEP_RESEARCH_ARTIFACT_ROLES)[number];

export const DEEP_RESEARCH_CHECKLIST_STATUSES = [
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "skipped",
] as const;
export type DeepResearchChecklistStatus = (typeof DEEP_RESEARCH_CHECKLIST_STATUSES)[number];

export const DEEP_RESEARCH_REPORT_SECTION_KEYS = [
  "conclusion",
  "source_evidence",
  "borrow_diverge_risk_gate",
  "implementation_recommendations",
  "verification",
] as const;
export type DeepResearchReportSectionKey = (typeof DEEP_RESEARCH_REPORT_SECTION_KEYS)[number];

export const DEEP_RESEARCH_REPORT_SECTION_STATUSES = ["pending", "drafted", "completed"] as const;
export type DeepResearchReportSectionStatus =
  (typeof DEEP_RESEARCH_REPORT_SECTION_STATUSES)[number];

export const DEEP_RESEARCH_STEP_KINDS = ["local_exploration", "web_research"] as const;
export type DeepResearchStepKind = (typeof DEEP_RESEARCH_STEP_KINDS)[number];

export const DEEP_RESEARCH_STEP_STATUSES = ["completed", "blocked", "stopped"] as const;
export type DeepResearchStepStatus = (typeof DEEP_RESEARCH_STEP_STATUSES)[number];

export const DEEP_RESEARCH_INSPECTED_REF_KINDS = [
  "file",
  "symbol",
  "config",
  "test",
  "runtime",
  "url",
] as const;
export type DeepResearchInspectedRefKind = (typeof DEEP_RESEARCH_INSPECTED_REF_KINDS)[number];

export const DEEP_RESEARCH_EVENT_TYPES = [
  "research_started",
  "research_artifact_recorded",
  "research_checklist_updated",
  "research_step_recorded",
  "research_checkpoint_recorded",
  "research_completed",
] as const;
export type DeepResearchEventType = (typeof DEEP_RESEARCH_EVENT_TYPES)[number];

export const DEEP_RESEARCH_OBJECTIVE_MAX_CHARS = 2_000;
export const DEEP_RESEARCH_ARTIFACT_NAME_MAX_CHARS = 240;
export const DEEP_RESEARCH_LOCATOR_MAX_CHARS = 4_096;
export const DEEP_RESEARCH_CHECKPOINT_TEXT_MAX_CHARS = 4_000;
export const DEEP_RESEARCH_CHECKPOINT_ITEM_MAX_CHARS = 1_000;
export const DEEP_RESEARCH_CHECKPOINT_ITEMS_MAX = 50;
export const DEEP_RESEARCH_REFS_MAX = 100;
export const DEEP_RESEARCH_ARTIFACTS_MAX = 2_000;
export const DEEP_RESEARCH_CHECKPOINTS_MAX = 500;
export const DEEP_RESEARCH_CHECKLIST_ITEMS_MAX = 50;
export const DEEP_RESEARCH_STEPS_MAX = 500;
export const DEEP_RESEARCH_STEP_TEXT_MAX_CHARS = 2_000;
export const DEEP_RESEARCH_STEP_LIST_ITEMS_MAX = 50;
export const DEEP_RESEARCH_INSPECTED_REFS_MAX = 200;
export const DEEP_RESEARCH_CLIENT_PROGRESS_MAX_BYTES = 46 * 1024;
export const DEEP_RESEARCH_CLIENT_RECENT_ITEMS_MAX = 8;
export const DEEP_RESEARCH_CLIENT_OBJECTIVE_MAX_BYTES = 4 * 1024;
export const DEEP_RESEARCH_CLIENT_TEXT_MAX_BYTES = 256;
export const DEEP_RESEARCH_CLIENT_IMPLEMENTATION_PROMPT_MAX_BYTES = 16 * 1024;

export const DEEP_RESEARCH_DEFAULT_CHECKLIST = [
  { itemId: "project_entrypoints", title: "Map project entrypoints and execution setup" },
  { itemId: "core_flow", title: "Trace the core implementation and data flow" },
  { itemId: "boundaries", title: "Verify permissions, privacy, failure, and runtime boundaries" },
  {
    itemId: "verification_evidence",
    title: "Collect tests, fixtures, and reproducible verification evidence",
  },
] as const;

export interface DeepResearchEventRefs {
  runId?: string;
  turnId?: string;
  toolCallId?: string;
}

export interface DeepResearchArtifactRef {
  artifactId: string;
  role: DeepResearchArtifactRole;
  name: string;
  /** Exact caller-provided summary used for semantic retry validation. */
  summary?: string;
  createdAt: number;
  /** URL, repository path, file path, or another human-inspectable source locator. */
  locator?: string;
  /** sha256:<lowercase hex>, computed from the exact persisted artifact body. */
  contentHash: string;
  /** Direct source artifacts supporting this derived note/report artifact. */
  sourceArtifactIds: string[];
  reportSectionKey?: DeepResearchReportSectionKey;
  reportSectionStatus?: Exclude<DeepResearchReportSectionStatus, "pending">;
}

export interface DeepResearchChecklistItem {
  itemId: string;
  title: string;
  status: DeepResearchChecklistStatus;
  evidenceArtifactIds: string[];
  blockedReason?: string;
  updatedAt: number;
}

export interface DeepResearchReportSectionState {
  key: DeepResearchReportSectionKey;
  status: DeepResearchReportSectionStatus;
  artifactId?: string;
  updatedAt: number;
}

export interface DeepResearchInspectedRef {
  kind: DeepResearchInspectedRefKind;
  locator: string;
  label?: string;
  sourceArtifactId?: string;
}

export interface DeepResearchStep {
  stepId: string;
  kind: DeepResearchStepKind;
  status: DeepResearchStepStatus;
  objective: string;
  summary: string;
  roots: string[];
  keywords: string[];
  ignoredPaths: string[];
  stoppingCondition: string;
  expectedEvidence: string;
  evidenceArtifactIds: string[];
  inspectedRefs: DeepResearchInspectedRef[];
  workerRunIds: string[];
  blockedReason?: string;
  createdAt: number;
}

export interface DeepResearchHandoff {
  artifactId: string;
  implementationTasks: string[];
  recommendedIssues: string[];
  recommendedPullRequests: string[];
  verificationCommands: string[];
}

export interface DeepResearchCheckpoint {
  checkpointId: string;
  round: number;
  stage: DeepResearchActiveStage;
  status: Exclude<DeepResearchRunStatus, "completed">;
  summary: string;
  openQuestions: string[];
  nextSteps: string[];
  /** Existing Task Ledger ids/keys; the research ledger links rather than duplicates tasks. */
  taskIds: string[];
  /** Existing research artifact ids needed to resume this checkpoint. */
  artifactIds: string[];
  createdAt: number;
}

interface DeepResearchEventBase {
  eventId: string;
  type: DeepResearchEventType;
  sessionId: string;
  ts: number;
  refs?: DeepResearchEventRefs;
}

export interface DeepResearchStartedEvent extends DeepResearchEventBase {
  type: "research_started";
  objective: string;
  scopeLevel: DeepResearchScopeLevel;
}

export interface DeepResearchArtifactRecordedEvent extends DeepResearchEventBase {
  type: "research_artifact_recorded";
  artifact: DeepResearchArtifactRef;
}

export interface DeepResearchChecklistUpdatedEvent extends DeepResearchEventBase {
  type: "research_checklist_updated";
  item: DeepResearchChecklistItem;
}

export interface DeepResearchStepRecordedEvent extends DeepResearchEventBase {
  type: "research_step_recorded";
  step: DeepResearchStep;
}

export interface DeepResearchCheckpointRecordedEvent extends DeepResearchEventBase {
  type: "research_checkpoint_recorded";
  checkpoint: DeepResearchCheckpoint;
}

export interface DeepResearchCompletedEvent extends DeepResearchEventBase {
  type: "research_completed";
  reportArtifactId: string;
  handoff: DeepResearchHandoff;
}

export type DeepResearchEvent =
  | DeepResearchStartedEvent
  | DeepResearchArtifactRecordedEvent
  | DeepResearchChecklistUpdatedEvent
  | DeepResearchStepRecordedEvent
  | DeepResearchCheckpointRecordedEvent
  | DeepResearchCompletedEvent;

export interface DeepResearchRun {
  schemaVersion: typeof DEEP_RESEARCH_RUN_SCHEMA_VERSION;
  sessionId: string;
  objective: string;
  scopeLevel: DeepResearchScopeLevel;
  status: DeepResearchRunStatus;
  stage: DeepResearchStage;
  round: number;
  createdAt: number;
  updatedAt: number;
  artifacts: DeepResearchArtifactRef[];
  checklist: DeepResearchChecklistItem[];
  steps: DeepResearchStep[];
  reportSections: DeepResearchReportSectionState[];
  checkpoints: DeepResearchCheckpoint[];
  reportArtifactId?: string;
  handoff?: DeepResearchHandoff;
  completedAt?: number;
}

/** Bounded product-facing progress shared by local and Host-backed clients. */
export interface DeepResearchClientProgress {
  sessionId: string;
  objective: string;
  scopeLevel: DeepResearchScopeLevel;
  status: DeepResearchRunStatus;
  stage: DeepResearchStage;
  round: number;
  createdAt: number;
  updatedAt: number;
  artifactsCount: number;
  stepsCount: number;
  checklist: Array<
    Pick<DeepResearchChecklistItem, "itemId" | "title" | "status" | "blockedReason">
  >;
  reportSections: Array<Pick<DeepResearchReportSectionState, "key" | "status">>;
  recentInspectedRefs: Array<Pick<DeepResearchInspectedRef, "kind" | "locator" | "label">>;
  workerRunIds: string[];
  blockers: string[];
  reportArtifactId?: string;
  implementationPrompt?: string;
}

export interface DeepResearchProjection {
  run?: DeepResearchRun;
  diagnostics: string[];
}

export interface DeepResearchMutationContext {
  runId?: string;
  turnId?: string;
  toolCallId?: string;
}

export interface DeepResearchChangedEvent {
  sessionId: string;
  ts: number;
}

export interface DeepResearchStore {
  read(sessionId: string): Promise<DeepResearchRun | undefined>;
  readEvents(sessionId: string): Promise<DeepResearchEvent[]>;
  start(
    sessionId: string,
    objective: string,
    scopeLevel: DeepResearchScopeLevel,
    context?: DeepResearchMutationContext,
  ): Promise<DeepResearchRun>;
  recordArtifact(
    sessionId: string,
    artifact: DeepResearchArtifactRef,
    context?: DeepResearchMutationContext,
  ): Promise<DeepResearchRun>;
  updateChecklist(
    sessionId: string,
    item: Omit<DeepResearchChecklistItem, "title" | "updatedAt">,
    context?: DeepResearchMutationContext,
  ): Promise<DeepResearchRun>;
  recordStep(
    sessionId: string,
    step: Omit<DeepResearchStep, "stepId" | "createdAt">,
    context?: DeepResearchMutationContext,
  ): Promise<DeepResearchRun>;
  recordCheckpoint(
    sessionId: string,
    checkpoint: Omit<DeepResearchCheckpoint, "checkpointId" | "createdAt">,
    context?: DeepResearchMutationContext,
  ): Promise<DeepResearchRun>;
  complete(
    sessionId: string,
    reportArtifactId: string,
    handoff: DeepResearchHandoff,
    context?: DeepResearchMutationContext,
  ): Promise<DeepResearchRun>;
  subscribe(listener: (event: DeepResearchChangedEvent) => void): () => void;
}

export function isDeepResearchActiveStage(value: unknown): value is DeepResearchActiveStage {
  return (
    typeof value === "string" && (DEEP_RESEARCH_ACTIVE_STAGES as readonly string[]).includes(value)
  );
}

export function isDeepResearchArtifactRole(value: unknown): value is DeepResearchArtifactRole {
  return (
    typeof value === "string" && (DEEP_RESEARCH_ARTIFACT_ROLES as readonly string[]).includes(value)
  );
}

export function isDeepResearchScopeLevel(value: unknown): value is DeepResearchScopeLevel {
  return (
    typeof value === "string" && (DEEP_RESEARCH_SCOPE_LEVELS as readonly string[]).includes(value)
  );
}

export function isDeepResearchChecklistStatus(
  value: unknown,
): value is DeepResearchChecklistStatus {
  return (
    typeof value === "string" &&
    (DEEP_RESEARCH_CHECKLIST_STATUSES as readonly string[]).includes(value)
  );
}

export function isDeepResearchReportSectionKey(
  value: unknown,
): value is DeepResearchReportSectionKey {
  return (
    typeof value === "string" &&
    (DEEP_RESEARCH_REPORT_SECTION_KEYS as readonly string[]).includes(value)
  );
}

export function isDeepResearchReportSectionStatus(
  value: unknown,
): value is DeepResearchReportSectionStatus {
  return (
    typeof value === "string" &&
    (DEEP_RESEARCH_REPORT_SECTION_STATUSES as readonly string[]).includes(value)
  );
}

export function isDeepResearchStepKind(value: unknown): value is DeepResearchStepKind {
  return (
    typeof value === "string" && (DEEP_RESEARCH_STEP_KINDS as readonly string[]).includes(value)
  );
}

export function isDeepResearchStepStatus(value: unknown): value is DeepResearchStepStatus {
  return (
    typeof value === "string" && (DEEP_RESEARCH_STEP_STATUSES as readonly string[]).includes(value)
  );
}

export function normalizeDeepResearchObjective(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFC").replace(/\s+/g, " ").trim();
  if (
    normalized.length === 0 ||
    Array.from(normalized).length > DEEP_RESEARCH_OBJECTIVE_MAX_CHARS
  ) {
    return undefined;
  }
  return normalized;
}

export function isDeepResearchEvent(value: unknown): value is DeepResearchEvent {
  if (
    !isRecord(value) ||
    !isStableId(value.eventId) ||
    !(DEEP_RESEARCH_EVENT_TYPES as readonly unknown[]).includes(value.type) ||
    !isStableId(value.sessionId) ||
    !isFiniteNumber(value.ts) ||
    !isEventRefs(value.refs)
  ) {
    return false;
  }
  switch (value.type) {
    case "research_started":
      return (
        normalizeDeepResearchObjective(value.objective) === value.objective &&
        isDeepResearchScopeLevel(value.scopeLevel)
      );
    case "research_artifact_recorded":
      return isDeepResearchArtifactRef(value.artifact);
    case "research_checklist_updated":
      return isDeepResearchChecklistItem(value.item);
    case "research_step_recorded":
      return isDeepResearchStep(value.step);
    case "research_checkpoint_recorded":
      return isDeepResearchCheckpoint(value.checkpoint);
    case "research_completed":
      return isStableId(value.reportArtifactId) && isDeepResearchHandoff(value.handoff);
    default:
      return false;
  }
}

export function projectDeepResearchEvents(
  events: readonly DeepResearchEvent[],
): DeepResearchProjection {
  let run: DeepResearchRun | undefined;
  const diagnostics: string[] = [];
  const eventIds = new Set<string>();
  const artifactIds = new Set<string>();
  const checkpointIds = new Set<string>();
  const stepIds = new Set<string>();

  for (const event of events) {
    if (!isDeepResearchEvent(event)) {
      diagnostics.push("invalid deep research event shape");
      continue;
    }
    if (eventIds.has(event.eventId)) {
      diagnostics.push(`duplicate deep research event id ${event.eventId}`);
      continue;
    }
    eventIds.add(event.eventId);

    if (event.type === "research_started") {
      if (run) {
        diagnostics.push(`duplicate research_started for session ${event.sessionId}`);
        continue;
      }
      run = {
        schemaVersion: DEEP_RESEARCH_RUN_SCHEMA_VERSION,
        sessionId: event.sessionId,
        objective: event.objective,
        scopeLevel: event.scopeLevel,
        status: "active",
        stage: "knowledge_base",
        round: 0,
        createdAt: event.ts,
        updatedAt: event.ts,
        artifacts: [],
        checklist: defaultDeepResearchChecklist(event.ts),
        steps: [],
        reportSections: defaultReportSections(event.ts),
        checkpoints: [],
      };
      continue;
    }

    if (!run) {
      diagnostics.push(`${event.type} appeared before research_started`);
      continue;
    }
    if (event.sessionId !== run.sessionId) {
      diagnostics.push(`${event.type} belongs to another session`);
      continue;
    }
    if (run.status === "completed") {
      diagnostics.push(`${event.type} appeared after research_completed`);
      continue;
    }

    switch (event.type) {
      case "research_artifact_recorded": {
        if (run.artifacts.length >= DEEP_RESEARCH_ARTIFACTS_MAX) {
          diagnostics.push(`deep research artifact cap ${DEEP_RESEARCH_ARTIFACTS_MAX} exceeded`);
          break;
        }
        const artifact = event.artifact;
        if (artifactIds.has(artifact.artifactId)) {
          diagnostics.push(`duplicate research artifact ${artifact.artifactId}`);
          break;
        }
        const sourceDiagnostic = validateSourceReferences(artifact, run.artifacts);
        if (sourceDiagnostic) {
          diagnostics.push(sourceDiagnostic);
          break;
        }
        if (artifact.role === "report_section") {
          const currentSection = run.reportSections.find(
            (section) => section.key === artifact.reportSectionKey,
          );
          if (
            currentSection?.status === "completed" &&
            artifact.reportSectionStatus === "drafted"
          ) {
            diagnostics.push(
              `report section ${artifact.reportSectionKey} cannot regress to drafted`,
            );
            break;
          }
        }
        artifactIds.add(artifact.artifactId);
        const reportSections =
          artifact.role === "report_section"
            ? applyReportSectionArtifact(run.reportSections, artifact)
            : run.reportSections;
        run = {
          ...run,
          artifacts: [
            ...run.artifacts,
            { ...artifact, sourceArtifactIds: [...artifact.sourceArtifactIds] },
          ],
          reportSections,
          updatedAt: Math.max(run.updatedAt, event.ts),
        };
        break;
      }
      case "research_checklist_updated": {
        const item = event.item;
        const current = run.checklist.find((candidate) => candidate.itemId === item.itemId);
        if (!current || current.title !== item.title) {
          diagnostics.push(`research checklist references unknown item ${item.itemId}`);
          break;
        }
        if (
          (current.status === "completed" || current.status === "skipped") &&
          current.status !== item.status
        ) {
          diagnostics.push(`research checklist item ${item.itemId} is already terminal`);
          break;
        }
        const missingArtifact = item.evidenceArtifactIds.find((id) => !artifactIds.has(id));
        if (missingArtifact) {
          diagnostics.push(
            `research checklist item ${item.itemId} references unknown artifact ${missingArtifact}`,
          );
          break;
        }
        if (item.status === "completed" && item.evidenceArtifactIds.length === 0) {
          diagnostics.push(`completed research checklist item ${item.itemId} requires evidence`);
          break;
        }
        if (item.status === "blocked" && !item.blockedReason) {
          diagnostics.push(`blocked research checklist item ${item.itemId} requires a reason`);
          break;
        }
        const checklist = run.checklist.map((candidate) =>
          candidate.itemId === item.itemId ? cloneChecklistItem(item) : candidate,
        );
        run = {
          ...run,
          status: checklist.some((candidate) => candidate.status === "blocked")
            ? "blocked"
            : "active",
          checklist,
          updatedAt: Math.max(run.updatedAt, event.ts),
        };
        break;
      }
      case "research_step_recorded": {
        if (run.steps.length >= DEEP_RESEARCH_STEPS_MAX) {
          diagnostics.push(`deep research step cap ${DEEP_RESEARCH_STEPS_MAX} exceeded`);
          break;
        }
        const step = event.step;
        if (stepIds.has(step.stepId)) {
          diagnostics.push(`duplicate research step ${step.stepId}`);
          break;
        }
        const missingEvidence = step.evidenceArtifactIds.find((id) => !artifactIds.has(id));
        if (missingEvidence) {
          diagnostics.push(
            `research step ${step.stepId} references unknown artifact ${missingEvidence}`,
          );
          break;
        }
        const recordedArtifacts = run.artifacts;
        const invalidInspectedSource = step.inspectedRefs.find((ref) => {
          if (!ref.sourceArtifactId) return false;
          return (
            recordedArtifacts.find((artifact) => artifact.artifactId === ref.sourceArtifactId)
              ?.role !== "source"
          );
        });
        if (invalidInspectedSource?.sourceArtifactId) {
          diagnostics.push(
            `research step ${step.stepId} references non-source artifact ${invalidInspectedSource.sourceArtifactId}`,
          );
          break;
        }
        if (step.status === "completed" && step.evidenceArtifactIds.length === 0) {
          diagnostics.push(`completed research step ${step.stepId} requires evidence artifacts`);
          break;
        }
        if (step.status === "blocked" && !step.blockedReason) {
          diagnostics.push(`blocked research step ${step.stepId} requires a reason`);
          break;
        }
        stepIds.add(step.stepId);
        run = {
          ...run,
          status: step.status === "blocked" ? "blocked" : run.status,
          steps: [...run.steps, cloneStep(step)],
          updatedAt: Math.max(run.updatedAt, event.ts),
        };
        break;
      }
      case "research_checkpoint_recorded": {
        if (run.checkpoints.length >= DEEP_RESEARCH_CHECKPOINTS_MAX) {
          diagnostics.push(
            `deep research checkpoint cap ${DEEP_RESEARCH_CHECKPOINTS_MAX} exceeded`,
          );
          break;
        }
        const checkpoint = event.checkpoint;
        if (checkpointIds.has(checkpoint.checkpointId)) {
          diagnostics.push(`duplicate research checkpoint ${checkpoint.checkpointId}`);
          break;
        }
        if (checkpoint.round < run.round) {
          diagnostics.push(`research round regressed from ${run.round} to ${checkpoint.round}`);
          break;
        }
        if (run.stage === "report_writing" && checkpoint.stage === "knowledge_base") {
          diagnostics.push(
            "deep research stage cannot regress from report_writing to knowledge_base",
          );
          break;
        }
        const missingArtifact = checkpoint.artifactIds.find((id) => !artifactIds.has(id));
        if (missingArtifact) {
          diagnostics.push(`checkpoint references unknown artifact ${missingArtifact}`);
          break;
        }
        checkpointIds.add(checkpoint.checkpointId);
        run = {
          ...run,
          status: checkpoint.status,
          stage: checkpoint.stage,
          round: checkpoint.round,
          checkpoints: [...run.checkpoints, cloneCheckpoint(checkpoint)],
          updatedAt: Math.max(run.updatedAt, event.ts),
        };
        break;
      }
      case "research_completed": {
        const report = run.artifacts.find(
          (artifact) => artifact.artifactId === event.reportArtifactId,
        );
        if (!report || report.role !== "report") {
          diagnostics.push(
            `research_completed references missing report artifact ${event.reportArtifactId}`,
          );
          break;
        }
        if (!run.artifacts.some((artifact) => artifact.role === "source")) {
          diagnostics.push("research_completed requires at least one archived source artifact");
          break;
        }
        const handoffArtifact = run.artifacts.find(
          (artifact) => artifact.artifactId === event.handoff.artifactId,
        );
        if (!handoffArtifact || handoffArtifact.role !== "handoff") {
          diagnostics.push(
            `research_completed references missing handoff artifact ${event.handoff.artifactId}`,
          );
          break;
        }
        const incompleteChecklist = run.checklist.find(
          (item) => item.status !== "completed" && item.status !== "skipped",
        );
        if (incompleteChecklist) {
          diagnostics.push(
            `research_completed requires checklist item ${incompleteChecklist.itemId} to be settled`,
          );
          break;
        }
        const incompleteSection = run.reportSections.find(
          (section) => section.status !== "completed",
        );
        if (incompleteSection) {
          diagnostics.push(`research_completed requires report section ${incompleteSection.key}`);
          break;
        }
        run = {
          ...run,
          status: "completed",
          stage: "completed",
          reportArtifactId: event.reportArtifactId,
          handoff: cloneHandoff(event.handoff),
          completedAt: event.ts,
          updatedAt: Math.max(run.updatedAt, event.ts),
        };
        break;
      }
    }
  }

  return { ...(run ? { run } : {}), diagnostics };
}

function validateSourceReferences(
  artifact: DeepResearchArtifactRef,
  existing: readonly DeepResearchArtifactRef[],
): string | undefined {
  if (artifact.role === "source") {
    if (!artifact.locator) return `source artifact ${artifact.artifactId} requires a locator`;
    return artifact.sourceArtifactIds.length === 0
      ? undefined
      : `source artifact ${artifact.artifactId} cannot cite another source artifact`;
  }
  if (artifact.sourceArtifactIds.length === 0) {
    return `${artifact.role} artifact ${artifact.artifactId} requires source artifact references`;
  }
  const invalid = artifact.sourceArtifactIds.find((id) => {
    const source = existing.find((item) => item.artifactId === id);
    return source?.role !== "source";
  });
  return invalid
    ? `${artifact.role} artifact ${artifact.artifactId} references non-source artifact ${invalid}`
    : undefined;
}

function isDeepResearchArtifactRef(value: unknown): value is DeepResearchArtifactRef {
  if (!isRecord(value)) return false;
  if (
    !isStableId(value.artifactId) ||
    !isDeepResearchArtifactRole(value.role) ||
    !isBoundedText(value.name, DEEP_RESEARCH_ARTIFACT_NAME_MAX_CHARS) ||
    !(
      value.summary === undefined ||
      isBoundedText(value.summary, DEEP_RESEARCH_CHECKPOINT_TEXT_MAX_CHARS)
    ) ||
    !isFiniteNumber(value.createdAt) ||
    !(
      value.locator === undefined || isBoundedText(value.locator, DEEP_RESEARCH_LOCATOR_MAX_CHARS)
    ) ||
    typeof value.contentHash !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.contentHash) ||
    !isStableIdArray(value.sourceArtifactIds, DEEP_RESEARCH_REFS_MAX)
  ) {
    return false;
  }
  if (value.role === "report_section") {
    return (
      isDeepResearchReportSectionKey(value.reportSectionKey) &&
      (value.reportSectionStatus === "drafted" || value.reportSectionStatus === "completed")
    );
  }
  return value.reportSectionKey === undefined && value.reportSectionStatus === undefined;
}

function isDeepResearchChecklistItem(value: unknown): value is DeepResearchChecklistItem {
  return (
    isRecord(value) &&
    isStableId(value.itemId) &&
    isBoundedText(value.title, DEEP_RESEARCH_ARTIFACT_NAME_MAX_CHARS) &&
    isDeepResearchChecklistStatus(value.status) &&
    isStableIdArray(value.evidenceArtifactIds, DEEP_RESEARCH_REFS_MAX) &&
    (value.blockedReason === undefined ||
      isBoundedText(value.blockedReason, DEEP_RESEARCH_CHECKPOINT_TEXT_MAX_CHARS)) &&
    (value.status === "blocked" || value.status === "skipped"
      ? value.blockedReason !== undefined
      : value.blockedReason === undefined) &&
    isFiniteNumber(value.updatedAt)
  );
}

function isDeepResearchStep(value: unknown): value is DeepResearchStep {
  return (
    isRecord(value) &&
    isStableId(value.stepId) &&
    isDeepResearchStepKind(value.kind) &&
    isDeepResearchStepStatus(value.status) &&
    isBoundedText(value.objective, DEEP_RESEARCH_STEP_TEXT_MAX_CHARS) &&
    isBoundedText(value.summary, DEEP_RESEARCH_STEP_TEXT_MAX_CHARS) &&
    isBoundedTextArray(
      value.roots,
      DEEP_RESEARCH_STEP_LIST_ITEMS_MAX,
      DEEP_RESEARCH_LOCATOR_MAX_CHARS,
    ) &&
    (value.kind !== "local_exploration" || value.roots.length > 0) &&
    isBoundedTextArray(
      value.keywords,
      DEEP_RESEARCH_STEP_LIST_ITEMS_MAX,
      DEEP_RESEARCH_CHECKPOINT_ITEM_MAX_CHARS,
    ) &&
    (value.kind !== "web_research" || value.keywords.length > 0) &&
    isBoundedTextArray(
      value.ignoredPaths,
      DEEP_RESEARCH_STEP_LIST_ITEMS_MAX,
      DEEP_RESEARCH_LOCATOR_MAX_CHARS,
    ) &&
    isBoundedText(value.stoppingCondition, DEEP_RESEARCH_STEP_TEXT_MAX_CHARS) &&
    isBoundedText(value.expectedEvidence, DEEP_RESEARCH_STEP_TEXT_MAX_CHARS) &&
    isStableIdArray(value.evidenceArtifactIds, DEEP_RESEARCH_REFS_MAX) &&
    Array.isArray(value.inspectedRefs) &&
    value.inspectedRefs.length <= DEEP_RESEARCH_INSPECTED_REFS_MAX &&
    value.inspectedRefs.every(isDeepResearchInspectedRef) &&
    isStableIdArray(value.workerRunIds, DEEP_RESEARCH_REFS_MAX) &&
    (value.blockedReason === undefined ||
      isBoundedText(value.blockedReason, DEEP_RESEARCH_STEP_TEXT_MAX_CHARS)) &&
    (value.status === "blocked"
      ? value.blockedReason !== undefined
      : value.blockedReason === undefined) &&
    isFiniteNumber(value.createdAt)
  );
}

function isDeepResearchInspectedRef(value: unknown): value is DeepResearchInspectedRef {
  return (
    isRecord(value) &&
    typeof value.kind === "string" &&
    (DEEP_RESEARCH_INSPECTED_REF_KINDS as readonly string[]).includes(value.kind) &&
    isBoundedText(value.locator, DEEP_RESEARCH_LOCATOR_MAX_CHARS) &&
    (value.label === undefined ||
      isBoundedText(value.label, DEEP_RESEARCH_CHECKPOINT_ITEM_MAX_CHARS)) &&
    (value.sourceArtifactId === undefined || isStableId(value.sourceArtifactId))
  );
}

function isDeepResearchHandoff(value: unknown): value is DeepResearchHandoff {
  return (
    isRecord(value) &&
    isStableId(value.artifactId) &&
    isBoundedTextArray(
      value.implementationTasks,
      DEEP_RESEARCH_CHECKPOINT_ITEMS_MAX,
      DEEP_RESEARCH_CHECKPOINT_ITEM_MAX_CHARS,
    ) &&
    value.implementationTasks.length > 0 &&
    isBoundedTextArray(
      value.recommendedIssues,
      DEEP_RESEARCH_CHECKPOINT_ITEMS_MAX,
      DEEP_RESEARCH_CHECKPOINT_ITEM_MAX_CHARS,
    ) &&
    isBoundedTextArray(
      value.recommendedPullRequests,
      DEEP_RESEARCH_CHECKPOINT_ITEMS_MAX,
      DEEP_RESEARCH_CHECKPOINT_ITEM_MAX_CHARS,
    ) &&
    value.recommendedIssues.length + value.recommendedPullRequests.length > 0 &&
    isBoundedTextArray(
      value.verificationCommands,
      DEEP_RESEARCH_CHECKPOINT_ITEMS_MAX,
      DEEP_RESEARCH_CHECKPOINT_ITEM_MAX_CHARS,
    ) &&
    value.verificationCommands.length > 0
  );
}

function isDeepResearchCheckpoint(value: unknown): value is DeepResearchCheckpoint {
  return (
    isRecord(value) &&
    isStableId(value.checkpointId) &&
    Number.isSafeInteger(value.round) &&
    (value.round as number) >= 1 &&
    isDeepResearchActiveStage(value.stage) &&
    (value.status === "active" || value.status === "blocked") &&
    isBoundedText(value.summary, DEEP_RESEARCH_CHECKPOINT_TEXT_MAX_CHARS) &&
    isBoundedTextArray(
      value.openQuestions,
      DEEP_RESEARCH_CHECKPOINT_ITEMS_MAX,
      DEEP_RESEARCH_CHECKPOINT_ITEM_MAX_CHARS,
    ) &&
    isBoundedTextArray(
      value.nextSteps,
      DEEP_RESEARCH_CHECKPOINT_ITEMS_MAX,
      DEEP_RESEARCH_CHECKPOINT_ITEM_MAX_CHARS,
    ) &&
    isStableIdArray(value.taskIds, DEEP_RESEARCH_REFS_MAX) &&
    isStableIdArray(value.artifactIds, DEEP_RESEARCH_REFS_MAX) &&
    isFiniteNumber(value.createdAt)
  );
}

function isEventRefs(value: unknown): value is DeepResearchEventRefs | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => !["runId", "turnId", "toolCallId"].includes(key))) return false;
  return [value.runId, value.turnId, value.toolCallId].every(
    (item) => item === undefined || isBoundedReference(item),
  );
}

function isBoundedReference(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 512;
}

function isStableId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  );
}

function isStableIdArray(value: unknown, max: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    new Set(value).size === value.length &&
    value.every(isStableId)
  );
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= max;
}

function isBoundedTextArray(value: unknown, maxItems: number, maxChars: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => isBoundedText(item, maxChars))
  );
}

function cloneCheckpoint(checkpoint: DeepResearchCheckpoint): DeepResearchCheckpoint {
  return {
    ...checkpoint,
    openQuestions: [...checkpoint.openQuestions],
    nextSteps: [...checkpoint.nextSteps],
    taskIds: [...checkpoint.taskIds],
    artifactIds: [...checkpoint.artifactIds],
  };
}

function defaultDeepResearchChecklist(ts: number): DeepResearchChecklistItem[] {
  return DEEP_RESEARCH_DEFAULT_CHECKLIST.map((item) => ({
    ...item,
    status: "pending",
    evidenceArtifactIds: [],
    updatedAt: ts,
  }));
}

function defaultReportSections(ts: number): DeepResearchReportSectionState[] {
  return DEEP_RESEARCH_REPORT_SECTION_KEYS.map((key) => ({
    key,
    status: "pending",
    updatedAt: ts,
  }));
}

function applyReportSectionArtifact(
  sections: readonly DeepResearchReportSectionState[],
  artifact: DeepResearchArtifactRef,
): DeepResearchReportSectionState[] {
  if (
    artifact.role !== "report_section" ||
    !artifact.reportSectionKey ||
    !artifact.reportSectionStatus
  ) {
    return [...sections];
  }
  return sections.map((section) =>
    section.key === artifact.reportSectionKey
      ? {
          key: section.key,
          status: artifact.reportSectionStatus!,
          artifactId: artifact.artifactId,
          updatedAt: artifact.createdAt,
        }
      : section,
  );
}

function cloneChecklistItem(item: DeepResearchChecklistItem): DeepResearchChecklistItem {
  return {
    ...item,
    evidenceArtifactIds: [...item.evidenceArtifactIds],
  };
}

function cloneStep(step: DeepResearchStep): DeepResearchStep {
  return {
    ...step,
    roots: [...step.roots],
    keywords: [...step.keywords],
    ignoredPaths: [...step.ignoredPaths],
    evidenceArtifactIds: [...step.evidenceArtifactIds],
    inspectedRefs: step.inspectedRefs.map((ref) => ({ ...ref })),
    workerRunIds: [...step.workerRunIds],
  };
}

function cloneHandoff(handoff: DeepResearchHandoff): DeepResearchHandoff {
  return {
    ...handoff,
    implementationTasks: [...handoff.implementationTasks],
    recommendedIssues: [...handoff.recommendedIssues],
    recommendedPullRequests: [...handoff.recommendedPullRequests],
    verificationCommands: [...handoff.verificationCommands],
  };
}

export const DEEP_RESEARCH_SESSION_NAME = "Deep Research";
export const DEEP_RESEARCH_SESSION_LABEL = "deep_research";

export const DEEP_RESEARCH_WORKFLOW_STEPS = [
  {
    title: "先定位入口",
    body: "读目录、配置、启动链路和测试入口，建立项目地图。",
  },
  {
    title: "再追数据流",
    body: "沿关键模块、IPC、存储、权限和运行时边界追到真实实现。",
  },
  {
    title: "然后对照参考",
    body: "把可借鉴点拆成 borrow / diverge / risk / gate。",
  },
  {
    title: "最后给可合入方案",
    body: "输出文件清单、风险边界和验证命令，不在只读模式里动手改。",
  },
] as const;

export const DEEP_RESEARCH_REPORT_SECTIONS = [
  {
    title: "结论先行",
    body: "用 3-5 条讲清楚真实现状、主要差距和优先建议。",
  },
  {
    title: "源码证据",
    body: "列出文件、函数、配置、测试和运行时路径，避免只给印象判断。",
  },
  {
    title: "借鉴拆解",
    body: "每个可借鉴点都写 borrow / diverge / risk / gate。",
  },
  {
    title: "落地改进",
    body: "给出按小步改进拆分的文件清单、边界和验证命令。",
  },
] as const;

export const DEEP_RESEARCH_SCOPE_OPTIONS = [
  {
    label: "快速",
    body: "只扫入口、关键文件和最可能的数据流，适合已知范围的小问题。",
  },
  {
    label: "标准",
    body: "默认深度：梳理核心链路、相关测试和主要风险，再给落地建议。",
  },
  {
    label: "深挖",
    body: "跨模块、参考项目和边界条件多轮追踪；只在用户明确要求时使用。",
  },
] as const;

export const DEEP_RESEARCH_EVIDENCE_CHECKLIST = [
  {
    title: "项目入口",
    body: "先看 README、package/config、启动脚本和目录分层，确认真实运行方式。",
  },
  {
    title: "核心链路",
    body: "追 UI 入口、IPC/服务、存储、运行时调用和错误处理，不只看表面组件。",
  },
  {
    title: "边界条件",
    body: "检查权限、隐身模式、token/路径暴露、失败重试和用户可见反馈。",
  },
  {
    title: "验证证据",
    body: "找对应测试、fixture、smoke 文档和可复现命令；缺口要明确标出来。",
  },
] as const;

export const DEEP_RESEARCH_PROGRESS_CHECKPOINTS = [
  {
    title: "先建清单",
    body: "研究范围超过三个相互关联的点时，先列出可核验的检查项再开始追代码。",
  },
  {
    title: "标当前项",
    body: "推进时明确当前正在验证哪一项，拿到证据后再进入下一项。",
  },
  {
    title: "记阻塞点",
    body: "找不到源码、运行时或测试证据时标成 blocked，不用猜测补空白。",
  },
  {
    title: "收敛方案",
    body: "完成项必须汇总到 borrow / diverge / risk / gate 和可落地改进里。",
  },
] as const;

export const DEEP_RESEARCH_STARTER_PROMPTS = [
  {
    label: "研究一个参考项目",
    prompt:
      "请只读研究这个项目：先梳理目录结构、核心模块、启动链路、数据流和测试入口，然后列出我们可以借鉴的功能设计、需要规避的风险，以及可落地到 Pico 的改进顺序。",
  },
  {
    label: "完整读一遍参考项目",
    prompt:
      "请按深挖范围只读研究这个参考项目：先建立目录和模块地图，再逐层读核心功能、运行时、存储、权限、UI、测试和文档；每个可借鉴点都按 borrow / diverge / risk / gate 输出，并给出 Pico 的落地改进顺序。",
  },
  {
    label: "对比一个功能实现",
    prompt:
      "请只读对比这个功能在参考项目和 Pico 里的实现差异：指出关键文件、运行时边界、UI 入口、持久化方式、测试覆盖，以及最小可合入的改进方案。",
  },
  {
    label: "做一次安全边界审计",
    prompt:
      "请只读审计这个功能的安全边界：权限、token/密钥流、IPC/renderer 暴露、文件路径、隐私模式、日志与 telemetry。输出 blocking 风险和对应 contract test。",
  },
] as const;

export function isDeepResearchSession(labels: readonly string[] | undefined): boolean {
  return Array.isArray(labels) && labels.includes(DEEP_RESEARCH_SESSION_LABEL);
}

export const DEEP_RESEARCH_IMPLEMENTATION_PROMPT_MAX_CHARS = 12_000;

export function buildDeepResearchImplementationPrompt(run: DeepResearchRun): string {
  if (run.status !== "completed" || !run.handoff || !run.reportArtifactId) {
    throw new Error("Deep Research implementation handoff requires a completed run");
  }
  const lines: string[] = [
    "This is a new implementation task created from a completed read-only Deep Research session.",
    "The original research session remains read-only. Inspect the current code and present an implementation plan before changing project files.",
    "",
    `Research objective: ${run.objective}`,
    `Source session: ${run.sessionId}`,
    `Final report artifact: ${run.reportArtifactId}`,
    `Handoff artifact: ${run.handoff.artifactId}`,
    "",
    "Implementation tasks:",
    ...run.handoff.implementationTasks.map((item) => `- ${item}`),
    "",
    "Recommended issues:",
    ...(run.handoff.recommendedIssues.length > 0
      ? run.handoff.recommendedIssues.map((item) => `- ${item}`)
      : ["- None specified."]),
    "",
    "Recommended pull requests:",
    ...(run.handoff.recommendedPullRequests.length > 0
      ? run.handoff.recommendedPullRequests.map((item) => `- ${item}`)
      : ["- None specified."]),
    "",
    "Verification commands:",
    ...run.handoff.verificationCommands.map((item) => `- ${item}`),
  ];
  const content = lines.join("\n");
  const characters = Array.from(content);
  if (characters.length <= DEEP_RESEARCH_IMPLEMENTATION_PROMPT_MAX_CHARS) return content;
  const marker = "\n[Handoff truncated to the safe composer limit.]";
  return (
    characters
      .slice(0, DEEP_RESEARCH_IMPLEMENTATION_PROMPT_MAX_CHARS - Array.from(marker).length)
      .join("") + marker
  );
}

export function buildDeepResearchSystemPromptFragment(): string {
  return [
    "Deep research mode is active for this session.",
    "",
    "Mode contract:",
    "- Inspect first. Prefer read_file, glob, grep, and web_search.",
    "- Do not write, edit, delete, move, or rename user project files; do not install, run migrations, start services, or send mutating network requests unless the user explicitly leaves research mode.",
    "- The deep_research_* tools are the one write exception: they only update Pico-owned research artifacts and an append-only workspace ledger, never the user project.",
    "- If implementation is needed, produce a concrete plan with files, risks, and verification commands instead of modifying files.",
    "- Keep findings source-grounded: name files, functions, configs, tests, and observed behavior.",
    "- Summarize borrow / diverge / risk / gate when comparing a reference project to Pico.",
    "",
    "Durable workspace protocol:",
    "- Call deep_research_start once with the concrete objective and scope level. After interruption or context compaction, call deep_research_status, then deep_research_read_artifact for the exact saved evidence needed to continue.",
    "- Knowledge-base stage: archive each important raw source first with deep_research_save_artifact role=source, then save evidence notes that cite those source artifact ids.",
    "- After each bounded local exploration or web-research substep, call deep_research_record_step with roots or query terms, ignored paths, a stopping condition, expected evidence, inspected files/symbols/URLs, worker run ids, persisted evidence ids, and any blocker.",
    "- Keep the four durable checklist items current with deep_research_update_checklist. Completed items require evidence artifacts; blocked items require an explicit reason.",
    "- Checkpoint every meaningful research round with deep_research_checkpoint, including open questions, next steps, related task ids, and the artifacts needed to resume.",
    "- Report-writing stage: save an outline, then source-backed report_section artifacts for conclusion, source_evidence, borrow_diverge_risk_gate, implementation_recommendations, and verification. Mark each section completed only when it is ready.",
    "- Save one final role=report artifact and one role=handoff artifact. The handoff must turn findings into implementation tasks, recommended issues and/or PRs, and verification commands without performing project writes.",
    "- Call deep_research_complete only after every checklist item is completed or explicitly skipped, all five report sections are completed, and both report and handoff artifacts are persisted.",
    "",
    "Research workflow:",
    ...DEEP_RESEARCH_WORKFLOW_STEPS.map((step) => `- ${step.title}: ${step.body}`),
    "",
    "Research scope budget:",
    ...DEEP_RESEARCH_SCOPE_OPTIONS.map((option) => `- ${option.label}: ${option.body}`),
    "- If the user does not specify a scope, use 标准. Use 深挖 only when the user explicitly asks for deep / exhaustive / full-project research.",
    "",
    "Evidence checklist:",
    ...DEEP_RESEARCH_EVIDENCE_CHECKLIST.map((item) => `- ${item.title}: ${item.body}`),
    "- If any checklist area cannot be verified from available files or runtime context, call that out explicitly instead of guessing.",
    "",
    "Progress checkpoints:",
    ...DEEP_RESEARCH_PROGRESS_CHECKPOINTS.map((item) => `- ${item.title}: ${item.body}`),
    "- Treat the checklist as a control loop for multi-step research, not as a hidden task system. Keep it visible in the answer or status update when the research spans multiple modules.",
    "",
    "Final report contract:",
    ...DEEP_RESEARCH_REPORT_SECTIONS.map((section) => `- ${section.title}: ${section.body}`),
  ].join("\n");
}

export const buildDeepResearchSystemPrompt = buildDeepResearchSystemPromptFragment;

export interface DeepResearchProgress extends DeepResearchClientProgress {
  schemaVersion: typeof DEEP_RESEARCH_RUN_SCHEMA_VERSION;
  artifacts: DeepResearchArtifactRef[];
  steps: DeepResearchStep[];
  checkpoints: DeepResearchCheckpoint[];
  checkpointsCount: number;
}

/** A transport/model projection, never the authority used for completion checks. */
export function projectDeepResearchProgress(run: DeepResearchRun): DeepResearchProgress {
  const clip = (value: string, limit = 256): string => {
    const encoder = new TextEncoder();
    if (encoder.encode(JSON.stringify(value)).length <= limit) return value;
    let result = "";
    let size = 2;
    for (const character of value) {
      const bytes = encoder.encode(JSON.stringify(character)).length - 2;
      if (size + bytes > limit - 3) break;
      result += character;
      size += bytes;
    }
    return result + "…";
  };
  const texts = (values: string[]) => values.slice(0, 4).map((value) => clip(value));
  const artifacts = run.artifacts.slice(-8).map((item) => ({
    ...item,
    name: clip(item.name),
    ...(item.summary ? { summary: clip(item.summary) } : {}),
    ...(item.locator ? { locator: clip(item.locator) } : {}),
    sourceArtifactIds: item.sourceArtifactIds.slice(0, 8),
  }));
  const steps = run.steps.slice(-3).map((item) => ({
    ...item,
    objective: clip(item.objective),
    summary: clip(item.summary),
    roots: texts(item.roots),
    keywords: texts(item.keywords),
    ignoredPaths: texts(item.ignoredPaths),
    stoppingCondition: clip(item.stoppingCondition),
    expectedEvidence: clip(item.expectedEvidence),
    evidenceArtifactIds: item.evidenceArtifactIds.slice(0, 4),
    inspectedRefs: item.inspectedRefs.slice(-4).map((ref) => ({
      ...ref,
      locator: clip(ref.locator),
      ...(ref.label ? { label: clip(ref.label) } : {}),
    })),
    workerRunIds: item.workerRunIds.slice(0, 4),
    ...(item.blockedReason ? { blockedReason: clip(item.blockedReason) } : {}),
  }));
  const checkpoints = run.checkpoints.slice(-3).map((item) => ({
    ...item,
    summary: clip(item.summary),
    openQuestions: texts(item.openQuestions),
    nextSteps: texts(item.nextSteps),
    taskIds: item.taskIds.slice(0, 4),
    artifactIds: item.artifactIds.slice(0, 4),
  }));
  const progress: DeepResearchProgress = {
    schemaVersion: run.schemaVersion,
    sessionId: run.sessionId,
    objective: clip(run.objective, 4096),
    scopeLevel: run.scopeLevel,
    status: run.status,
    stage: run.stage,
    round: run.round,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    artifactsCount: run.artifacts.length,
    stepsCount: run.steps.length,
    checkpointsCount: run.checkpoints.length,
    checklist: run.checklist.map(({ itemId, title, status, blockedReason }) => ({
      itemId,
      title,
      status,
      ...(blockedReason ? { blockedReason: clip(blockedReason) } : {}),
    })),
    reportSections: run.reportSections.map(({ key, status }) => ({ key, status })),
    recentInspectedRefs: steps.flatMap((step) => step.inspectedRefs).slice(-8),
    workerRunIds: [...new Set(steps.flatMap((step) => step.workerRunIds))].slice(-8),
    blockers: [
      ...run.checklist
        .filter((item) => item.status === "blocked")
        .map((item) => item.blockedReason ?? ""),
      ...steps.filter((item) => item.status === "blocked").map((item) => item.blockedReason ?? ""),
    ]
      .slice(-8)
      .map((value) => clip(value)),
    artifacts,
    steps,
    checkpoints,
    ...(run.reportArtifactId ? { reportArtifactId: run.reportArtifactId } : {}),
    ...(run.status === "completed"
      ? { implementationPrompt: clip(buildDeepResearchImplementationPrompt(run), 16000) }
      : {}),
  };
  // Large multibyte input must still fit the transport budget. Preserve actionable handoff.
  const size = () => new TextEncoder().encode(JSON.stringify(progress)).length;
  while (size() > DEEP_RESEARCH_CLIENT_PROGRESS_MAX_BYTES && progress.steps.length)
    progress.steps.shift();
  while (size() > DEEP_RESEARCH_CLIENT_PROGRESS_MAX_BYTES && progress.checkpoints.length)
    progress.checkpoints.shift();
  while (size() > DEEP_RESEARCH_CLIENT_PROGRESS_MAX_BYTES && progress.artifacts.length > 1)
    progress.artifacts.shift();
  return progress;
}

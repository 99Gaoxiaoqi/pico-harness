import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { SqliteExperienceLedgerStore, scrubExperienceLedger } from "./experience-feedback-store.js";
import { MemoryItemStoreConflictError, normalizeLongTermMemoryContent } from "@pico/core";
import type {
  ExecutionAcceptanceClaim,
  ExecutionLearningAdmission,
  ExecutionLearningCandidate,
  ExecutionLearningJob,
  ExecutionLearningStatus,
  ExecutionLearningStore,
  ExecutionTaskAcceptance,
  ExecutionVerificationTicket,
  ExecutionVerificationResult,
  TaskExperienceStore,
  TaskExperienceCandidate,
  TaskExperienceTask,
  TaskExperienceObservation,
  TaskExperienceReuse,
  TaskExperienceReviewInput,
  TaskExperienceFeedbackInput,
  TaskExperienceSummary,
  TaskExperienceRunBinding,
  MemoryItemSource,
  ExperienceUse,
} from "@pico/core";

export const EXECUTION_LEARNING_SCHEMA_SQL = `
CREATE TABLE execution_learning_control(scope TEXT PRIMARY KEY,input_epoch INTEGER NOT NULL DEFAULT 0,management_revision INTEGER NOT NULL DEFAULT 0,resource_revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE execution_learning_admissions(admission_id TEXT PRIMARY KEY,workspace_key TEXT NOT NULL,session_id TEXT NOT NULL,run_id TEXT NOT NULL,record_json TEXT NOT NULL,UNIQUE(session_id,run_id));
CREATE TABLE execution_learning_native_facts(admission_id TEXT NOT NULL,tool_call_id TEXT NOT NULL,prepared_event_id TEXT NOT NULL,kind TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(admission_id,tool_call_id,kind));
CREATE TABLE execution_learning_candidates(candidate_id TEXT PRIMARY KEY,workspace_key TEXT NOT NULL,session_id TEXT NOT NULL,run_id TEXT NOT NULL,failure_key TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,item_id TEXT,updated_at INTEGER NOT NULL,record_json TEXT NOT NULL);
CREATE INDEX execution_learning_candidates_scope ON execution_learning_candidates(workspace_key,state,updated_at);
CREATE TABLE execution_learning_tickets(ticket_id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL,record_json TEXT NOT NULL,result_json TEXT,FOREIGN KEY(candidate_id) REFERENCES execution_learning_candidates(candidate_id));
CREATE TABLE execution_learning_jobs(job_id TEXT PRIMARY KEY,workspace_key TEXT NOT NULL,candidate_id TEXT NOT NULL,state TEXT NOT NULL,lease_until INTEGER NOT NULL,fencing_token INTEGER NOT NULL,updated_at INTEGER NOT NULL,record_json TEXT NOT NULL,FOREIGN KEY(candidate_id) REFERENCES execution_learning_candidates(candidate_id));
CREATE INDEX execution_learning_jobs_ready ON execution_learning_jobs(state,lease_until,updated_at);
CREATE TABLE execution_learning_tombstones(failure_key TEXT PRIMARY KEY,created_at INTEGER NOT NULL);
CREATE TABLE execution_learning_attempts(failure_key TEXT NOT NULL,workspace_key TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX execution_learning_attempts_scope ON execution_learning_attempts(workspace_key,created_at);
CREATE TABLE execution_learning_items(item_id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL,item_content_hash TEXT NOT NULL,source_type TEXT NOT NULL DEFAULT 'execution-validated',metadata_json TEXT,FOREIGN KEY(item_id) REFERENCES memory_items(item_id) ON DELETE CASCADE);
`;
const DAY = 86_400_000;
type Row = Record<string, unknown>;
const decode = <T>(row: Row | undefined, key = "record_json"): T | undefined =>
  row ? (JSON.parse(String(row[key])) as T) : undefined;

/** Uses the memory store's connection so publication and its provenance have one commit point. */
export class ExecutionLearningSqliteStore implements ExecutionLearningStore, TaskExperienceStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly options: {
      experienceLedger: SqliteExperienceLedgerStore;
      settings: (workspaceKey: string) => {
        version: number;
        enabled: boolean;
        autoExtract: boolean;
      };
      deletionRevision: () => number;
      createExperienceItem: (
        candidate: TaskExperienceCandidate,
        now: number,
      ) => { itemId: string; contentHash: string };
    },
  ) {}
  private tx<T>(fn: () => T): T {
    const oldTimeout = Number(this.db.prepare("PRAGMA busy_timeout").get()!.timeout);
    this.db.exec("PRAGMA busy_timeout=100");
    try {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      this.db.exec(`PRAGMA busy_timeout=${oldTimeout}`);
    }
  }
  private managementRevision(): number {
    return Number(
      this.db
        .prepare("SELECT management_revision FROM execution_learning_control WHERE scope='*'")
        .get()?.management_revision ?? 0,
    );
  }
  private assertPolicy(admission: ExecutionLearningAdmission): void {
    const settings = this.options.settings(admission.workspaceKey);
    if (
      !settings.enabled ||
      !settings.autoExtract ||
      settings.version !== admission.settingsVersion ||
      this.options.deletionRevision() !== admission.deletionRevision ||
      this.managementRevision() !== admission.managementRevision
    )
      throw new Error("Execution learning policy changed");
  }
  executionLearningAllowed(claim: ExecutionAcceptanceClaim): boolean {
    try {
      this.assertPolicy(claim.admission);
      const current = this.candidate(claim.candidateId);
      return (
        !!current &&
        ["waiting", "insufficient"].includes(current.state) &&
        current.claim.claimHash === claim.claimHash &&
        current.claim.revision === claim.revision &&
        !this.db
          .prepare("SELECT 1 FROM execution_learning_tombstones WHERE failure_key=?")
          .get(claim.failureKey)
      );
    } catch {
      return false;
    }
  }
  bumpManagementRevision(): void {
    this.db
      .prepare(
        "INSERT INTO execution_learning_control(scope,management_revision) VALUES('*',1) ON CONFLICT(scope) DO UPDATE SET management_revision=management_revision+1",
      )
      .run();
  }
  /** Repair only explicit discard states or a matching durable delete receipt, never mere absence. */
  repairDeletedExperiences(): void {
    this.tx(() => {
      const deletedHashes = new Set(
        this.db
          .prepare("SELECT request_hash FROM memory_write_operations WHERE operation_type='delete'")
          .all()
          .map((row) => String(row.request_hash)),
      );
      const versions = new Map<string, Set<number>>();
      for (const row of this.db
        .prepare("SELECT result_json FROM memory_write_operations WHERE operation_type<>'delete'")
        .all()) {
        let results: unknown;
        try {
          results = JSON.parse(String(row.result_json));
        } catch {
          continue;
        }
        if (!Array.isArray(results)) continue;
        for (const result of results)
          if (typeof result?.itemId === "string" && Number.isSafeInteger(result.version)) {
            const known = versions.get(result.itemId) ?? new Set<number>();
            known.add(result.version);
            versions.set(result.itemId, known);
          }
      }
      const deleted = (itemId: string, extraVersions = 0) => {
        if (this.db.prepare("SELECT 1 FROM memory_items WHERE item_id=?").get(itemId)) return false;
        const possible = new Set(versions.get(itemId));
        for (const row of this.db
          .prepare("SELECT record_json FROM experience_uses WHERE item_id=?")
          .all(itemId))
          possible.add(decode<ExperienceUse>(row)!.itemVersion);
        for (let version = 1; version <= Math.min(extraVersions, 10000); version++)
          possible.add(version);
        return [...possible].some((expectedVersion) =>
          deletedHashes.has(
            createHash("sha256").update(JSON.stringify({ itemId, expectedVersion })).digest("hex"),
          ),
        );
      };
      for (const row of this.db
        .prepare("SELECT record_json FROM execution_learning_candidates")
        .all()) {
        const candidate = decode<TaskExperienceCandidate | ExecutionLearningCandidate>(row)!;
        if ("kind" in candidate) {
          if (
            (candidate.state === "discarded" && (candidate.goal || candidate.content)) ||
            (candidate.itemId && deleted(candidate.itemId, candidate.recordRevision))
          ) {
            this.clearExperience(candidate, "discarded", candidate.updatedAt, false);
            this.bumpManagementRevision();
          }
        } else {
          const receipt = this.db
            .prepare("SELECT result_json FROM memory_write_operations WHERE operation_id=?")
            .get(`execution-acceptance:${candidate.claim.candidateId}`);
          let oldItemId: string | undefined = candidate.itemId;
          if (!oldItemId && receipt) {
            try {
              const result = JSON.parse(String(receipt.result_json))[0];
              if (typeof result?.itemId === "string") oldItemId = result.itemId;
            } catch {
              /* Corrupt receipts are not deletion evidence. */
            }
          }
          const derivedUses = this.db
            .prepare(
              "SELECT 1 FROM experience_uses WHERE candidate_id=? AND json_extract(record_json,'$.deleted')=0 LIMIT 1",
            )
            .get(candidate.claim.candidateId);
          const needsRepair =
            candidate.claim.target.command ||
            candidate.claim.target.label ||
            candidate.hypothesis ||
            candidate.claim.recipe.length ||
            candidate.claim.conditions.length ||
            candidate.claim.admission.workDir ||
            derivedUses;
          if (
            (candidate.state === "discarded" &&
              (candidate.claim.target.command ||
                candidate.claim.target.label ||
                candidate.hypothesis)) ||
            (needsRepair && oldItemId && deleted(oldItemId))
          ) {
            this.clearCandidate(
              candidate,
              candidate.state === "discarded" ? "discarded" : "invalidated",
              candidate.updatedAt,
            );
            this.bumpManagementRevision();
          }
        }
      }
    });
  }
  async advanceExecutionLearningInput(workspaceKey: string) {
    return this.tx(() => {
      this.db
        .prepare(
          "INSERT INTO execution_learning_control(scope,input_epoch) VALUES(?,1) ON CONFLICT(scope) DO UPDATE SET input_epoch=input_epoch+1",
        )
        .run(workspaceKey);
      return {
        inputEpoch: Number(
          this.db
            .prepare("SELECT input_epoch FROM execution_learning_control WHERE scope=?")
            .get(workspaceKey)!.input_epoch,
        ),
        managementRevision: this.managementRevision(),
      };
    });
  }
  async readExecutionLearningInputEpoch(workspaceKey: string): Promise<number> {
    return Number(
      this.db
        .prepare("SELECT input_epoch FROM execution_learning_control WHERE scope=?")
        .get(workspaceKey)?.input_epoch ?? 0,
    );
  }
  async admitExecutionLearning(admission: ExecutionLearningAdmission): Promise<void> {
    this.tx(() => {
      this.assertPolicy(admission);
      const old = decode<ExecutionLearningAdmission>(
        this.db
          .prepare("SELECT record_json FROM execution_learning_admissions WHERE admission_id=?")
          .get(admission.admissionId),
      );
      if (old) {
        if (JSON.stringify(old) !== JSON.stringify(admission))
          throw new Error("Admission identity reused");
        return;
      }
      this.db
        .prepare("INSERT INTO execution_learning_admissions VALUES(?,?,?,?,?)")
        .run(
          admission.admissionId,
          admission.workspaceKey,
          admission.sessionId,
          admission.runId,
          JSON.stringify(admission),
        );
    });
  }
  async listAdmissions(): Promise<readonly ExecutionLearningAdmission[]> {
    return this.db
      .prepare(
        "SELECT record_json FROM execution_learning_admissions ORDER BY rowid DESC LIMIT 100",
      )
      .all()
      .map((row) => decode<ExecutionLearningAdmission>(row)!);
  }
  async recordNativeFact(
    admissionId: string,
    toolCallId: string,
    preparedEventId: string,
    kind: "file" | "command",
    fact: unknown,
  ): Promise<void> {
    this.tx(() => {
      const admission = decode<ExecutionLearningAdmission>(
        this.db
          .prepare("SELECT record_json FROM execution_learning_admissions WHERE admission_id=?")
          .get(admissionId),
      );
      if (!admission) throw new Error("Missing native admission");
      this.assertPolicy(admission);
      this.db
        .prepare(
          "INSERT INTO execution_learning_native_facts VALUES(?,?,?,?,?) ON CONFLICT(admission_id,tool_call_id,kind) DO UPDATE SET record_json=excluded.record_json WHERE prepared_event_id=excluded.prepared_event_id",
        )
        .run(admissionId, toolCallId, preparedEventId, kind, JSON.stringify(fact));
    });
  }
  async listNativeFacts(
    admissionId: string,
  ): Promise<
    readonly { toolCallId: string; preparedEventId: string; kind: string; fact: unknown }[]
  > {
    return this.db
      .prepare("SELECT * FROM execution_learning_native_facts WHERE admission_id=? LIMIT 256")
      .all(admissionId)
      .map((row) => ({
        toolCallId: String(row.tool_call_id),
        preparedEventId: String(row.prepared_event_id),
        kind: String(row.kind),
        fact: JSON.parse(String(row.record_json)),
      }));
  }
  private candidate(id: string): ExecutionLearningCandidate | undefined {
    const record = decode<ExecutionLearningCandidate | TaskExperienceCandidate>(
      this.db
        .prepare("SELECT record_json FROM execution_learning_candidates WHERE candidate_id=?")
        .get(id),
    );
    return record && !("kind" in record) ? record : undefined;
  }
  private writeCandidate(candidate: ExecutionLearningCandidate): void {
    this.db
      .prepare(
        "INSERT INTO execution_learning_control(scope,resource_revision) VALUES('*',1) ON CONFLICT(scope) DO UPDATE SET resource_revision=resource_revision+1",
      )
      .run();
    const { claim } = candidate;
    this.db
      .prepare(
        "INSERT INTO execution_learning_candidates VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET state=excluded.state,revision=excluded.revision,item_id=excluded.item_id,updated_at=excluded.updated_at,record_json=excluded.record_json",
      )
      .run(
        claim.candidateId,
        claim.admission.workspaceKey,
        claim.admission.sessionId,
        claim.admission.runId,
        claim.failureKey,
        candidate.state,
        claim.revision,
        candidate.itemId ?? null,
        candidate.updatedAt,
        JSON.stringify(candidate),
      );
  }
  readRevision(): number {
    return Number(
      this.db
        .prepare("SELECT resource_revision FROM execution_learning_control WHERE scope='*'")
        .get()?.resource_revision ?? 0,
    );
  }
  async saveExecutionLearningClaim(
    claim: ExecutionAcceptanceClaim,
  ): Promise<ExecutionLearningCandidate> {
    return this.tx(() => {
      this.assertPolicy(claim.admission);
      const admitted = decode<ExecutionLearningAdmission>(
        this.db
          .prepare("SELECT record_json FROM execution_learning_admissions WHERE admission_id=?")
          .get(claim.admission.admissionId),
      );
      if (!admitted || JSON.stringify(admitted) !== JSON.stringify(claim.admission))
        throw new Error("Missing original admission");
      if (
        this.db
          .prepare("SELECT 1 FROM execution_learning_tombstones WHERE failure_key=?")
          .get(claim.failureKey)
      )
        throw new Error("Execution learning was discarded");
      const old = this.candidate(claim.candidateId);
      if (old) {
        if (old.claim.failureKey !== claim.failureKey) throw new Error("Candidate identity reused");
        if (old.claim.claimHash === claim.claimHash) return old;
        if (
          this.db
            .prepare(
              "SELECT 1 FROM execution_learning_candidates WHERE json_extract(record_json,'$.kind')='task-lesson' AND json_extract(record_json,'$.nativeEvidence.candidateId')=? AND state NOT IN ('discarded','invalidated','expired') LIMIT 1",
            )
            .get(claim.candidateId)
        )
          throw new Error("Attached native evidence is frozen");
        if (old.state !== "waiting" && old.state !== "insufficient")
          throw new Error("Candidate cannot be revised");
        if (claim.revision !== old.claim.revision + 1)
          throw new Error("Candidate revision conflict");
      }
      const next: ExecutionLearningCandidate = {
        claim,
        state: "waiting",
        updatedAt: claim.createdAt,
      };
      this.writeCandidate(next);
      return next;
    });
  }
  async readExecutionLearningCandidate(id: string) {
    return this.candidate(id);
  }
  async listExecutionLearningCandidates(workspaceKey: string) {
    return this.db
      .prepare(
        "SELECT record_json FROM execution_learning_candidates WHERE workspace_key=? AND json_extract(record_json,'$.kind') IS NULL ORDER BY updated_at DESC LIMIT 100",
      )
      .all(workspaceKey)
      .map((row) => decode<ExecutionLearningCandidate>(row)!);
  }
  async registerExecutionVerification(ticket: ExecutionVerificationTicket): Promise<void> {
    this.tx(() => {
      const candidate = this.candidate(ticket.candidateId);
      if (
        !candidate ||
        candidate.claim.revision !== ticket.claimRevision ||
        candidate.claim.claimHash !== ticket.claimHash ||
        !["waiting", "insufficient"].includes(candidate.state)
      )
        throw new Error("Verification candidate changed");
      this.assertPolicy(candidate.claim.admission);
      const current = decode<ExecutionLearningAdmission>(
        this.db
          .prepare("SELECT record_json FROM execution_learning_admissions WHERE admission_id=?")
          .get(ticket.admissionId),
      );
      if (
        !current ||
        current.sessionId !== ticket.sessionId ||
        current.runId !== ticket.runId ||
        current.workspaceKey !== candidate.claim.admission.workspaceKey ||
        current.inputEpoch !== ticket.inputEpoch ||
        ticket.createdAt < candidate.claim.createdAt
      )
        throw new Error("Verification has no admitted dispatch");
      this.assertPolicy(current);
      const old = decode<ExecutionVerificationTicket>(
        this.db
          .prepare("SELECT record_json FROM execution_learning_tickets WHERE ticket_id=?")
          .get(ticket.ticketId),
      );
      if (old && JSON.stringify(old) !== JSON.stringify(ticket))
        throw new Error("Verification identity reused");
      this.db
        .prepare("INSERT OR IGNORE INTO execution_learning_tickets VALUES(?,?,?,NULL)")
        .run(ticket.ticketId, ticket.candidateId, JSON.stringify(ticket));
    });
  }
  async settleExecutionVerification(result: ExecutionVerificationResult): Promise<void> {
    this.tx(() => {
      const row = this.db
        .prepare("SELECT * FROM execution_learning_tickets WHERE ticket_id=?")
        .get(result.ticketId);
      const ticket = decode<ExecutionVerificationTicket>(row);
      if (
        !ticket ||
        result.source.runId !== ticket.runId ||
        result.source.sessionId !== ticket.sessionId ||
        result.settledAt < ticket.createdAt
      )
        throw new Error("Verification result is not bound");
      if (row!.result_json !== null && String(row!.result_json) !== JSON.stringify(result))
        throw new Error("Verification result changed");
      this.db
        .prepare("UPDATE execution_learning_tickets SET result_json=? WHERE ticket_id=?")
        .run(JSON.stringify(result), result.ticketId);
    });
  }
  async readExecutionVerification(ticketId: string) {
    const row = this.db
      .prepare("SELECT * FROM execution_learning_tickets WHERE ticket_id=?")
      .get(ticketId);
    return row
      ? {
          ticket: decode<ExecutionVerificationTicket>(row)!,
          ...(row.result_json !== null
            ? { result: decode<ExecutionVerificationResult>(row, "result_json")! }
            : {}),
        }
      : undefined;
  }
  async listPendingVerifications() {
    return this.db
      .prepare(
        "SELECT record_json,result_json FROM execution_learning_tickets WHERE result_json IS NULL LIMIT 100",
      )
      .all()
      .map((row) => ({ ticket: decode<ExecutionVerificationTicket>(row)! }));
  }
  /** Recover generic reflections only; native receipts remain internal evidence. */
  async recoverSettledExecutionLearningJobs(now: number): Promise<void> {
    // A pre-v2 writer may have committed a generic candidate immediately before its enqueue.
    this.tx(() => {
      for (const row of this.db
        .prepare(
          "SELECT c.record_json FROM execution_learning_candidates c WHERE json_extract(c.record_json,'$.kind')='task-lesson' AND c.state='waiting' AND NOT EXISTS(SELECT 1 FROM execution_learning_jobs j WHERE j.candidate_id=c.candidate_id) ORDER BY c.updated_at LIMIT 100",
        )
        .all())
        this.ensureExperienceJob(decode<TaskExperienceCandidate>(row)!, now);
    });
  }
  async enqueueExecutionLearningJob(job: ExecutionLearningJob): Promise<void> {
    this.tx(() => {
      const old = decode<ExecutionLearningJob>(
        this.db
          .prepare("SELECT record_json FROM execution_learning_jobs WHERE job_id=?")
          .get(job.jobId),
      );
      if (old) {
        if (
          old.candidateId !== job.candidateId ||
          old.ticketId !== job.ticketId ||
          old.kind !== job.kind
        )
          throw new Error("Job identity reused");
        return;
      }
      const candidate = this.candidate(job.candidateId);
      const experience = this.experience(job.candidateId);
      if (
        (!candidate || candidate.claim.admission.workspaceKey !== job.workspaceKey) &&
        (!experience ||
          experience.workspaceKey !== job.workspaceKey ||
          experience.sessionId !== job.sessionId ||
          experience.runId !== job.runId ||
          job.kind !== "reflect")
      )
        throw new Error("Job scope mismatch");
      const count = Number(
        this.db
          .prepare(
            "SELECT count(*) AS n FROM execution_learning_jobs WHERE workspace_key=? AND state IN ('ready','working')",
          )
          .get(job.workspaceKey)!.n,
      );
      if (count >= 100) throw new Error("Execution learning queue limit");
      this.writeJob(job);
      if (
        candidate &&
        job.kind === "verify" &&
        ["waiting", "insufficient"].includes(candidate.state)
      )
        this.writeCandidate({ ...candidate, state: "ready", updatedAt: job.updatedAt });
    });
  }
  private writeJob(job: ExecutionLearningJob): void {
    this.db
      .prepare(
        "INSERT INTO execution_learning_jobs VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET state=excluded.state,lease_until=excluded.lease_until,fencing_token=excluded.fencing_token,updated_at=excluded.updated_at,record_json=excluded.record_json",
      )
      .run(
        job.jobId,
        job.workspaceKey,
        job.candidateId,
        job.state,
        job.leaseUntil,
        job.fencingToken,
        job.updatedAt,
        JSON.stringify(job),
      );
  }
  async claimExecutionLearningJob(ownerId: string, now: number, leaseMs: number) {
    return this.tx(() => {
      this.prune(now);
      if (
        this.db
          .prepare(
            "SELECT 1 FROM execution_learning_jobs WHERE state='working' AND lease_until>? LIMIT 1",
          )
          .get(now)
      )
        return undefined;
      const row = this.db
        .prepare(
          "SELECT record_json FROM execution_learning_jobs WHERE state='ready' OR (state='working' AND lease_until<=?) ORDER BY updated_at ASC LIMIT 1",
        )
        .get(now);
      const old = decode<ExecutionLearningJob>(row);
      if (!old) return undefined;
      const next: ExecutionLearningJob = {
        ...old,
        state: "working",
        ownerId,
        leaseUntil: now + leaseMs,
        fencingToken: old.fencingToken + 1,
        updatedAt: now,
      };
      this.writeJob(next);
      const candidate = this.candidate(next.candidateId);
      if (
        next.kind === "verify" &&
        candidate &&
        ["waiting", "ready", "working", "insufficient"].includes(candidate.state)
      )
        this.writeCandidate({ ...candidate, state: "working", updatedAt: now });
      return next;
    });
  }
  async completeExecutionLearningJob(input: {
    jobId: string;
    fencingToken: number;
    candidateRevision: number;
    content?: string;
    reason?: string;
    hypothesis?: string;
    now: number;
  }) {
    return this.tx(() => {
      const job = decode<ExecutionLearningJob>(
        this.db
          .prepare("SELECT record_json FROM execution_learning_jobs WHERE job_id=?")
          .get(input.jobId),
      );
      if (!job || job.fencingToken !== input.fencingToken)
        throw new Error("Stale execution learning fence");
      const candidate = this.candidate(job.candidateId);
      if (!candidate) throw new Error("Execution learning candidate missing");
      // Native jobs are retired. Even a valid, late receipt cannot publish model prose.
      // candidate() excludes task lessons, so generic reflection jobs are never consumed here.
      if (job.state !== "completed" && job.state !== "skipped")
        this.writeJob({ ...job, state: "skipped", leaseUntil: 0, updatedAt: input.now });
      const next = ["ready", "working"].includes(candidate.state)
        ? { ...candidate, state: "waiting" as const, updatedAt: input.now }
        : candidate;
      if (next !== candidate) this.writeCandidate(next);
      return next;
    });
  }
  async reserveExecutionLearningModelAttempt(
    failureKey: string,
    workspaceKey: string,
    now: number,
  ) {
    return this.tx(() => {
      const candidate = decode<ExecutionLearningCandidate | TaskExperienceCandidate>(
        this.db
          .prepare(
            "SELECT record_json FROM execution_learning_candidates WHERE failure_key=? AND workspace_key=?",
          )
          .get(failureKey, workspaceKey),
      );
      if (
        !candidate ||
        !["waiting", "insufficient"].includes(candidate.state) ||
        this.db
          .prepare("SELECT 1 FROM execution_learning_tombstones WHERE failure_key=?")
          .get(failureKey)
      )
        return false;
      try {
        if ("kind" in candidate) this.assertExperiencePolicy(candidate);
        else this.assertPolicy(candidate.claim.admission);
      } catch {
        return false;
      }
      if (
        Number(
          this.db
            .prepare("SELECT input_epoch FROM execution_learning_control WHERE scope=?")
            .get(workspaceKey)?.input_epoch ?? 0,
        ) !== ("kind" in candidate ? candidate.inputEpoch : candidate.claim.admission.inputEpoch)
      )
        return false;
      const count = Number(
        this.db
          .prepare("SELECT count(*) AS n FROM execution_learning_attempts WHERE failure_key=?")
          .get(failureKey)!.n,
      );
      const hour = Number(
        this.db
          .prepare(
            "SELECT count(*) AS n FROM execution_learning_attempts WHERE workspace_key=? AND created_at>?",
          )
          .get(workspaceKey, now - 3_600_000)!.n,
      );
      if (count >= 2 || hour >= 4) return false;
      this.db
        .prepare("INSERT INTO execution_learning_attempts VALUES(?,?,?)")
        .run(failureKey, workspaceKey, now);
      return true;
    });
  }
  async listExecutionLearning(
    workspaceKey: string,
    sessionId?: string,
  ): Promise<readonly ExecutionLearningStatus[]> {
    const rows = this.db
      .prepare(
        `SELECT c.record_json FROM execution_learning_candidates c JOIN memory_items i ON i.item_id=c.item_id
       WHERE c.workspace_key=? AND c.state='saved' AND json_extract(c.record_json,'$.claim') IS NOT NULL
       ${sessionId ? "AND c.session_id=?" : ""} ORDER BY c.updated_at DESC LIMIT 100`,
      )
      .all(...(sessionId ? [workspaceKey, sessionId] : [workspaceKey]));
    return rows
      .map((row) => decode<ExecutionLearningCandidate>(row)!)
      .map((c) => ({
        candidateId: c.claim.candidateId,
        revision: c.claim.revision,
        workspaceKey,
        sessionId: c.claim.admission.sessionId,
        runId: c.claim.admission.runId,
        state: c.state,
        predicateId: c.claim.predicateId,
        targetId: c.claim.target.targetId,
        targetLabel: c.claim.target.label,
        updatedAt: c.updatedAt,
        ...(c.itemId ? { itemId: c.itemId } : {}),
        ...(c.reason ? { reason: c.reason } : {}),
        sources: [c.claim.failure, ...c.claim.recipe.map((r) => r.source)],
      }));
  }
  async discardExecutionLearning(
    candidateId: string,
    workspaceKey: string,
    revision: number,
  ): Promise<void> {
    this.tx(() => {
      const candidate = this.candidate(candidateId);
      if (
        !candidate ||
        candidate.claim.admission.workspaceKey !== workspaceKey ||
        candidate.claim.revision !== revision
      )
        throw new Error("Candidate scope or revision mismatch");
      if (candidate.state === "saved")
        throw new Error("Delete or archive the saved memory instead");
      this.bumpManagementRevision();
      this.clearCandidate(candidate, "discarded", Date.now());
    });
  }
  private clearCandidate(
    candidate: ExecutionLearningCandidate,
    state: "discarded" | "invalidated" | "expired",
    now: number,
  ) {
    this.db
      .prepare("INSERT OR IGNORE INTO execution_learning_tombstones VALUES(?,?)")
      .run(candidate.claim.failureKey, now);
    // Do not retain discarded templates or model prose in candidates, tickets or queued jobs.
    const claim = {
      ...candidate.claim,
      recipe: [],
      conditions: [],
      failedTestIds: [],
      admission: { ...candidate.claim.admission, workDir: "" },
      target: {
        ...candidate.claim.target,
        label: "",
        command: "",
        argv: [],
        cwd: "",
        entryFiles: [],
        testFiles: [],
      },
    };
    this.writeCandidate({ claim, state, updatedAt: now });
    if (
      !candidate.itemId ||
      !this.db.prepare("SELECT 1 FROM memory_items WHERE item_id=?").get(candidate.itemId)
    )
      scrubExperienceLedger(this.db, { candidateId: claim.candidateId }, now);
    this.db
      .prepare("DELETE FROM execution_learning_tickets WHERE candidate_id=?")
      .run(claim.candidateId);
    const removedSources = new Set(
      [candidate.claim.failure, ...candidate.claim.recipe.map((step) => step.source)].map(
        sourceIdentity,
      ),
    );
    const retainedSources = new Set(
      this.db
        .prepare(
          "SELECT record_json FROM execution_learning_candidates WHERE candidate_id<>? AND state NOT IN ('discarded','invalidated','expired')",
        )
        .all(claim.candidateId)
        .flatMap((row) => {
          const other = decode<ExecutionLearningCandidate | TaskExperienceCandidate>(row)!;
          if ("kind" in other) return other.sources.map(sourceIdentity);
          return [other.claim.failure, ...other.claim.recipe.map((step) => step.source)].map(
            sourceIdentity,
          );
        }),
    );
    // Repairs can originate in a later Run. Remove only this candidate's templates,
    // preserving evidence still referenced by another live native candidate.
    for (const row of this.db.prepare("SELECT * FROM execution_learning_native_facts").all()) {
      const fact = JSON.parse(String(row.record_json));
      const ids = [
        fact.source,
        fact.result?.source,
        ...(fact.commits ?? []).map((commit: { source?: MemoryItemSource }) => commit.source),
      ]
        .filter((source): source is MemoryItemSource => !!source)
        .map(sourceIdentity);
      if (ids.some((id) => removedSources.has(id)) && !ids.some((id) => retainedSources.has(id)))
        this.db
          .prepare(
            "DELETE FROM execution_learning_native_facts WHERE admission_id=? AND tool_call_id=? AND kind=?",
          )
          .run(String(row.admission_id), String(row.tool_call_id), String(row.kind));
    }
    this.db
      .prepare(
        "UPDATE execution_learning_jobs SET state='skipped',lease_until=0 WHERE candidate_id=?",
      )
      .run(claim.candidateId);
    const jobs = this.db
      .prepare("SELECT record_json FROM execution_learning_jobs WHERE candidate_id=?")
      .all(claim.candidateId);
    for (const row of jobs) {
      const job = decode<ExecutionLearningJob>(row)!;
      this.writeJob({ ...job, state: "skipped", leaseUntil: 0, updatedAt: now });
    }
  }
  invalidateItem(itemId: string, now: number, manualCorrection = false): void {
    const row = this.db
      .prepare("SELECT candidate_id FROM execution_learning_items WHERE item_id=?")
      .get(itemId);
    if (row) {
      const experience = this.experience(String(row.candidate_id));
      if (experience) {
        if (!this.db.prepare("SELECT 1 FROM memory_items WHERE item_id=?").get(itemId)) {
          this.clearExperience(experience, "discarded", now);
          return;
        }
        const next = {
          ...experience,
          enabled: false,
          validation: "stale" as const,
          recordRevision: experience.recordRevision + 1,
          updatedAt: now,
        };
        this.writeExperience(next);
        this.db
          .prepare("UPDATE execution_learning_items SET metadata_json=NULL WHERE item_id=?")
          .run(itemId);
        this.bumpManagementRevision();
        return;
      }
      const candidate = this.candidate(String(row.candidate_id));
      if (candidate) this.clearCandidate(candidate, "invalidated", now);
      this.db
        .prepare("UPDATE execution_learning_items SET metadata_json=NULL WHERE item_id=?")
        .run(itemId);
      if (manualCorrection)
        this.db.prepare("DELETE FROM execution_learning_items WHERE item_id=?").run(itemId);
    }
    this.bumpManagementRevision();
  }
  readItemAcceptance(
    itemId: string,
    contentHash: string,
  ): {
    sourceType?: "execution-validated" | "reviewed-reference";
    taskAcceptance?: ExecutionTaskAcceptance;
    taskExperience?: TaskExperienceSummary;
  } {
    const row = this.db
      .prepare("SELECT * FROM execution_learning_items WHERE item_id=?")
      .get(itemId);
    if (!row) return {};
    if (row.source_type === "reviewed-reference") {
      const sourceType = "reviewed-reference" as const;
      const candidate = this.experience(String(row.candidate_id));
      let metadata: TaskExperienceSummary | undefined;
      try {
        metadata =
          row.metadata_json === null
            ? undefined
            : decode<TaskExperienceSummary>(row, "metadata_json");
      } catch {
        return { sourceType };
      }
      if (
        !candidate ||
        !metadata ||
        row.item_content_hash !== contentHash ||
        createHash("sha256").update(candidate.content).digest("hex") !== contentHash ||
        !Number.isSafeInteger(candidate.contentVersion) ||
        candidate.contentVersion < 1 ||
        !Number.isSafeInteger(candidate.recordRevision) ||
        candidate.recordRevision < 1 ||
        candidate.itemId !== itemId ||
        candidate.state !== "saved" ||
        JSON.stringify(metadata) !== JSON.stringify(experienceSummary(candidate))
      )
        return { sourceType };
      return { sourceType, taskExperience: metadata };
    }
    const candidate = this.candidate(String(row.candidate_id));
    let metadata: ExecutionTaskAcceptance | undefined;
    try {
      metadata =
        row.metadata_json === null
          ? undefined
          : decode<ExecutionTaskAcceptance>(row, "metadata_json");
    } catch {
      return { sourceType: "execution-validated" };
    }
    if (
      !metadata ||
      row.item_content_hash !== contentHash ||
      candidate?.state !== "saved" ||
      candidate.itemId !== itemId ||
      metadata.candidateId !== candidate.claim.candidateId ||
      metadata.predicateId !== candidate.claim.predicateId ||
      metadata.targetId !== candidate.claim.target.targetId ||
      metadata.targetLabel !== candidate.claim.target.label ||
      !Number.isSafeInteger(metadata.acceptedAt) ||
      metadata.acceptedAt < 0 ||
      metadata.claimHash !== candidate.claim.claimHash ||
      metadata.scopeHash !== candidate.claim.target.scopeHash
    )
      return { sourceType: "execution-validated" };
    return { sourceType: "execution-validated", taskAcceptance: metadata };
  }
  private prune(now: number): void {
    for (const row of this.db
      .prepare(
        "SELECT record_json FROM execution_learning_candidates WHERE state IN ('waiting','ready','working','insufficient') AND updated_at<=? LIMIT 100",
      )
      .all(now - 30 * DAY)) {
      const candidate = decode<ExecutionLearningCandidate | TaskExperienceCandidate>(row)!;
      if ("kind" in candidate) this.clearExperience(candidate, "expired", now);
      else this.clearCandidate(candidate, "expired", now);
    }
    this.db
      .prepare(
        "DELETE FROM execution_learning_jobs WHERE state IN ('completed','skipped') AND updated_at<=?",
      )
      .run(now - 7 * DAY);
    for (const row of this.db
      .prepare("SELECT admission_id,record_json FROM execution_learning_admissions")
      .all()) {
      const admission = decode<ExecutionLearningAdmission>(row)!;
      if (admission.createdAt > now - 30 * DAY) continue;
      this.db
        .prepare("DELETE FROM execution_learning_native_facts WHERE admission_id=?")
        .run(admission.admissionId);
    }
  }

  private experience(id: string): TaskExperienceCandidate | undefined {
    const value = decode<TaskExperienceCandidate | ExecutionLearningCandidate>(
      this.db
        .prepare("SELECT record_json FROM execution_learning_candidates WHERE candidate_id=?")
        .get(id),
    );
    return value && "kind" in value && value.kind === "task-lesson" ? value : undefined;
  }
  private writeExperience(candidate: TaskExperienceCandidate): void {
    this.db
      .prepare(
        "INSERT INTO execution_learning_control(scope,resource_revision) VALUES('*',1) ON CONFLICT(scope) DO UPDATE SET resource_revision=resource_revision+1",
      )
      .run();
    this.db
      .prepare(
        "INSERT INTO execution_learning_candidates VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET state=excluded.state,revision=excluded.revision,item_id=excluded.item_id,updated_at=excluded.updated_at,record_json=excluded.record_json",
      )
      .run(
        candidate.candidateId,
        candidate.workspaceKey,
        candidate.sessionId,
        candidate.runId,
        candidate.failureKey,
        candidate.state,
        candidate.recordRevision,
        candidate.itemId ?? null,
        candidate.updatedAt,
        JSON.stringify(candidate),
      );
  }
  private ensureExperienceJob(candidate: TaskExperienceCandidate, now: number): void {
    const jobId = `task-experience-job:${createHash("sha256")
      .update(JSON.stringify([candidate.candidateId, candidate.contentVersion]))
      .digest("hex")}`;
    if (this.db.prepare("SELECT 1 FROM execution_learning_jobs WHERE job_id=?").get(jobId)) return;
    const count = Number(
      this.db
        .prepare(
          "SELECT count(*) n FROM execution_learning_jobs WHERE workspace_key=? AND state IN ('ready','working')",
        )
        .get(candidate.workspaceKey)!.n,
    );
    if (count >= 100) throw new Error("Execution learning queue limit");
    this.writeJob({
      jobId,
      workspaceKey: candidate.workspaceKey,
      sessionId: candidate.sessionId,
      runId: candidate.runId,
      candidateId: candidate.candidateId,
      kind: "reflect",
      state: "ready",
      inputEpoch: candidate.inputEpoch,
      createdAt: now,
      updatedAt: now,
      leaseUntil: 0,
      fencingToken: 0,
    });
  }
  private assertExperiencePolicy(candidate: TaskExperienceCandidate): void {
    const settings = this.options.settings(candidate.workspaceKey);
    if (
      !settings.enabled ||
      !settings.autoExtract ||
      settings.version !== candidate.settingsVersion ||
      this.options.deletionRevision() !== candidate.deletionRevision ||
      this.db
        .prepare("SELECT 1 FROM execution_learning_tombstones WHERE failure_key=?")
        .get(candidate.failureKey)
    )
      throw new Error("Task experience policy changed");
  }
  taskExperienceAllowed(candidate: TaskExperienceCandidate): boolean {
    try {
      this.assertExperiencePolicy(candidate);
      const current = this.experience(candidate.candidateId);
      return (
        !!current &&
        current.recordRevision === candidate.recordRevision &&
        current.contentVersion === candidate.contentVersion &&
        ["waiting", "insufficient"].includes(current.state) &&
        ["unneeded", "pending"].includes(current.review)
      );
    } catch {
      return false;
    }
  }
  async saveTaskExperienceRunBinding(binding: TaskExperienceRunBinding): Promise<void> {
    const record = normalizeRunBinding(binding);
    const operationId = runBindingOperationId(
      record.workspaceKey,
      record.sessionId,
      record.executionRunId,
    );
    const requestHash = runBindingHash(record);
    this.tx(() => {
      const existing = this.db
        .prepare("SELECT * FROM task_experience_actions WHERE operation_id=?")
        .get(operationId);
      if (existing) {
        const old = decodeRunBinding(
          existing,
          record.workspaceKey,
          record.sessionId,
          record.executionRunId,
        );
        if (!old || runBindingHash(old) !== requestHash)
          throw new MemoryItemStoreConflictError(
            "operation_reused",
            "Host Run binding identity reused",
          );
        return;
      }
      this.db
        .prepare("INSERT INTO task_experience_actions VALUES(?,?,?,?,?,?)")
        .run(
          operationId,
          record.workspaceKey,
          `run-binding:${record.executionRunId}`,
          requestHash,
          JSON.stringify({ kind: "host-run-binding", binding: record }),
          record.createdAt,
        );
    });
  }
  async readTaskExperienceRunBinding(
    workspaceKey: string,
    sessionId: string,
    executionRunId: string,
  ): Promise<TaskExperienceRunBinding | undefined> {
    for (const id of [workspaceKey, sessionId, executionRunId]) assertRunBindingIdentifier(id);
    const row = this.db
      .prepare("SELECT * FROM task_experience_actions WHERE operation_id=?")
      .get(runBindingOperationId(workspaceKey, sessionId, executionRunId));
    return row ? decodeRunBinding(row, workspaceKey, sessionId, executionRunId) : undefined;
  }
  private writeTask(task: TaskExperienceTask): void {
    const old = decode<TaskExperienceTask>(
      this.db
        .prepare("SELECT record_json FROM task_experience_tasks WHERE task_id=?")
        .get(task.taskId),
    );
    if (
      old &&
      (old.workspaceKey !== task.workspaceKey ||
        old.sessionId !== task.sessionId ||
        old.taskVersion > task.taskVersion ||
        old.throughSequence > task.throughSequence)
    )
      throw new Error("Task experience task changed");
    this.db
      .prepare(
        "INSERT INTO task_experience_tasks VALUES(?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET task_version=excluded.task_version,through_sequence=excluded.through_sequence,updated_at=excluded.updated_at,record_json=excluded.record_json",
      )
      .run(
        task.taskId,
        task.workspaceKey,
        task.sessionId,
        task.taskVersion,
        task.throughSequence,
        task.updatedAt,
        JSON.stringify(task),
      );
  }
  async saveTaskExperienceTask(task: TaskExperienceTask): Promise<void> {
    this.tx(() => this.writeTask(task));
  }
  async readTaskExperienceTask(taskId: string): Promise<TaskExperienceTask | undefined> {
    return decode<TaskExperienceTask>(
      this.db.prepare("SELECT record_json FROM task_experience_tasks WHERE task_id=?").get(taskId),
    );
  }
  async latestTaskExperienceTask(
    workspaceKey: string,
    sessionId: string,
  ): Promise<TaskExperienceTask | undefined> {
    return decode<TaskExperienceTask>(
      this.db
        .prepare(
          "SELECT record_json FROM task_experience_tasks WHERE workspace_key=? AND session_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 1",
        )
        .get(workspaceKey, sessionId),
    );
  }
  async appendTaskExperienceObservations(
    task: TaskExperienceTask,
    observations: readonly TaskExperienceObservation[],
  ): Promise<void> {
    this.tx(() => {
      this.writeTask(task);
      for (const observation of observations) {
        if (
          observation.taskId !== task.taskId ||
          observation.taskVersion !== task.taskVersion ||
          observation.sequence > task.throughSequence ||
          observation.source.sessionId !== task.sessionId
        )
          throw new Error("Observation task binding mismatch");
        const old = decode<TaskExperienceObservation>(
          this.db
            .prepare("SELECT record_json FROM task_experience_observations WHERE observation_id=?")
            .get(observation.observationId),
        );
        if (old && JSON.stringify(old) !== JSON.stringify(observation))
          throw new Error("Observation identity reused");
        this.db
          .prepare("INSERT OR IGNORE INTO task_experience_observations VALUES(?,?,?,?)")
          .run(
            observation.observationId,
            observation.taskId,
            observation.taskVersion,
            JSON.stringify(observation),
          );
      }
    });
  }
  async listTaskExperienceObservations(
    taskId: string,
  ): Promise<readonly TaskExperienceObservation[]> {
    return this.db
      .prepare(
        "SELECT record_json FROM task_experience_observations WHERE task_id=? ORDER BY rowid",
      )
      .all(taskId)
      .map((row) => decode<TaskExperienceObservation>(row)!);
  }
  async createTaskExperienceCandidate(
    candidate: TaskExperienceCandidate,
  ): Promise<TaskExperienceCandidate> {
    return this.tx(() => {
      this.assertExperiencePolicy(candidate);
      const old = this.experience(candidate.candidateId);
      if (old) {
        if (old.failureKey !== candidate.failureKey || old.taskId !== candidate.taskId)
          throw new Error("Candidate identity reused");
        return old;
      }
      if (this.candidate(candidate.candidateId)) throw new Error("Candidate identity reused");
      const task = decode<TaskExperienceTask>(
        this.db
          .prepare("SELECT record_json FROM task_experience_tasks WHERE task_id=?")
          .get(candidate.taskId),
      );
      if (
        !task ||
        task.workspaceKey !== candidate.workspaceKey ||
        task.sessionId !== candidate.sessionId ||
        task.taskVersion !== candidate.taskVersion ||
        candidate.contentVersion !== 1 ||
        candidate.recordRevision !== 1 ||
        candidate.enabled ||
        candidate.validation !== "unknown" ||
        candidate.content !== "" ||
        candidate.nativeEvidence !== undefined
      )
        throw new Error("Candidate task binding mismatch");
      const observations = this.db
        .prepare(
          "SELECT record_json FROM task_experience_observations WHERE task_id=? AND task_version<=?",
        )
        .all(candidate.taskId, candidate.taskVersion)
        .map((row) => decode<TaskExperienceObservation>(row)!);
      if (
        !candidate.observationIds.length ||
        !candidate.sources.length ||
        candidate.observationIds.some(
          (id) => !observations.some((observation) => observation.observationId === id),
        ) ||
        candidate.sources.some(
          (source) =>
            !observations.some(
              (observation) =>
                candidate.observationIds.includes(observation.observationId) &&
                sameSource(source, observation.source),
            ),
        )
      )
        throw new Error("Candidate evidence is not frozen");
      this.writeExperience(candidate);
      this.ensureExperienceJob(candidate, candidate.createdAt);
      return candidate;
    });
  }
  async readTaskExperienceCandidate(
    candidateId: string,
  ): Promise<TaskExperienceCandidate | undefined> {
    return this.experience(candidateId);
  }
  async queryTaskExperiences(
    workspaceKey: string,
    options: {
      sessionId?: string;
      review?: TaskExperienceCandidate["review"];
      recallable?: boolean;
      limit?: number;
    } = {},
  ): Promise<readonly TaskExperienceCandidate[]> {
    const limit = Math.min(1000, Math.max(1, options.limit ?? 100));
    const clauses = ["workspace_key=?", "json_extract(record_json,'$.kind')='task-lesson'"];
    const args: (string | number)[] = [workspaceKey];
    if (options.sessionId) {
      clauses.push("session_id=?");
      args.push(options.sessionId);
    }
    if (options.review) {
      clauses.push("json_extract(record_json,'$.review')=?");
      args.push(options.review);
    }
    if (options.recallable) {
      clauses.push(
        "state='saved'",
        "json_extract(record_json,'$.enabled')=1",
        "json_extract(record_json,'$.lifecycleState')='active'",
        "json_extract(record_json,'$.validation') NOT IN ('fail','stale')",
        "(json_extract(record_json,'$.review')='approved' OR (json_extract(record_json,'$.review')='unneeded' AND json_extract(record_json,'$.risk')='low' AND json_extract(record_json,'$.maturity') IN ('trial','active')))",
      );
    }
    return this.db
      .prepare(
        `SELECT record_json FROM execution_learning_candidates WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...args, limit)
      .map((row) => decode<TaskExperienceCandidate>(row)!);
  }
  async completeTaskExperienceJob(
    input: Parameters<TaskExperienceStore["completeTaskExperienceJob"]>[0],
  ): Promise<TaskExperienceCandidate | undefined> {
    return this.tx(() => {
      const candidate = this.experience(input.job.candidateId);
      if (!candidate) return undefined;
      const job = decode<ExecutionLearningJob>(
        this.db
          .prepare("SELECT record_json FROM execution_learning_jobs WHERE job_id=?")
          .get(input.job.jobId),
      );
      if (
        !job ||
        job.fencingToken !== input.job.fencingToken ||
        job.ownerId !== input.job.ownerId ||
        job.candidateId !== candidate.candidateId
      )
        throw new Error("Stale task experience fence");
      if (["completed", "skipped"].includes(job.state)) return candidate;
      if (job.state !== "working" || job.leaseUntil <= input.now)
        throw new Error("Task experience lease expired");
      const finish = (value: TaskExperienceCandidate, state: "completed" | "skipped") => {
        if (value !== candidate) this.writeExperience(value);
        this.writeJob({ ...job, state, leaseUntil: 0, updatedAt: input.now });
        return value;
      };
      // Review/CAS wins over any model result from a prior record version.
      if (
        candidate.recordRevision !== input.expectedRecordRevision ||
        !["unneeded", "pending"].includes(candidate.review) ||
        !["waiting", "insufficient"].includes(candidate.state) ||
        Number(
          this.db
            .prepare("SELECT input_epoch FROM execution_learning_control WHERE scope=?")
            .get(job.workspaceKey)?.input_epoch ?? 0,
        ) !== job.inputEpoch
      )
        return finish(candidate, "skipped");
      try {
        this.assertExperiencePolicy(candidate);
      } catch {
        return finish(
          {
            ...candidate,
            state: "invalidated",
            enabled: false,
            reason: "policy_changed",
            recordRevision: candidate.recordRevision + 1,
            updatedAt: input.now,
          },
          "skipped",
        );
      }
      if (candidate.createdAt + 30 * DAY <= input.now)
        return finish(
          {
            ...candidate,
            state: "expired",
            enabled: false,
            content: "",
            recordRevision: candidate.recordRevision + 1,
            updatedAt: input.now,
          },
          "skipped",
        );
      if (input.content) {
        const content = normalizeExperienceContent(input.content);
        if (
          !input.applicability ||
          !input.sources?.length ||
          input.sources.some(
            (source) => !candidate.sources.some((frozen) => sameSource(source, frozen)),
          )
        )
          throw new Error("Invalid task experience reflection evidence");
        if (input.nativeEvidence) {
          const evidence = input.nativeEvidence;
          const native = this.candidate(evidence.candidateId);
          if (
            !native ||
            ["discarded", "expired", "invalidated"].includes(native.state) ||
            native.claim.admission.workspaceKey !== candidate.workspaceKey ||
            native.claim.revision !== evidence.claimRevision ||
            native.claim.claimHash !== evidence.claimHash ||
            native.claim.target.scopeHash !== evidence.scopeHash ||
            !input.sources.some((source) => sameSource(source, native.claim.failure))
          )
            throw new Error("Invalid task experience native evidence");
          // Private identity-only link survives edits so deletion can scrub derived templates.
          this.db
            .prepare("INSERT INTO task_experience_actions VALUES(?,?,?,?,?,?)")
            .run(
              `native-evidence:${candidate.candidateId}`,
              candidate.workspaceKey,
              candidate.candidateId,
              experienceActionHash(evidence),
              JSON.stringify({ kind: "native-evidence-link", candidateId: evidence.candidateId }),
              input.now,
            );
        }
        const { reason: _reason, nativeEvidence: _nativeEvidence, ...withoutReason } = candidate;
        const assessment = assessExperienceDraft({
          content,
          applicability: input.applicability,
          sources: input.sources,
          hasNativeEvidence: !!input.nativeEvidence,
          observations: this.db
            .prepare(
              "SELECT record_json FROM task_experience_observations WHERE task_id=? AND task_version<=?",
            )
            .all(candidate.taskId, candidate.taskVersion)
            .map((row) => decode<TaskExperienceObservation>(row)!),
        });
        const lowRisk = assessment.risk === "low";
        const next: TaskExperienceCandidate = {
          ...withoutReason,
          content,
          applicability: input.applicability,
          ...(input.nativeEvidence ? { nativeEvidence: input.nativeEvidence } : {}),
          sources: input.sources,
          review: lowRisk ? "unneeded" : "pending",
          validation: "unknown",
          enabled: lowRisk,
          maturity: lowRisk ? "trial" : "unassessed",
          risk: assessment.risk,
          promotionReason: "none",
          positiveReuseCount: 0,
          ...(assessment.reviewReason ? { reviewReason: assessment.reviewReason } : {}),
          state: "ready",
          recordRevision: candidate.recordRevision + 1,
          updatedAt: input.now,
        };
        return finish(
          lowRisk
            ? this.publishExperience(next, input.now, {
                review: "unneeded",
                maturity: "trial",
                promotionReason: "none",
              })
            : next,
          "completed",
        );
      }
      return finish(
        {
          ...candidate,
          state: "insufficient",
          reason: input.reason ?? "reflection_unavailable",
          recordRevision: candidate.recordRevision + 1,
          updatedAt: input.now,
        },
        "completed",
      );
    });
  }
  private action<T extends TaskExperienceReviewInput | TaskExperienceFeedbackInput>(
    input: T,
    run: (candidate: TaskExperienceCandidate) => TaskExperienceCandidate,
  ): TaskExperienceCandidate {
    const { now, ...request } = input;
    const hash = experienceActionHash(request);
    const legacyHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const receipt = this.db
      .prepare("SELECT * FROM task_experience_actions WHERE operation_id=?")
      .get(input.operationId);
    if (receipt) {
      if (
        (receipt.request_hash !== hash && receipt.request_hash !== legacyHash) ||
        receipt.workspace_key !== input.workspaceKey ||
        receipt.candidate_id !== input.candidateId
      )
        throw new Error("Task experience operation reused");
      const current = this.experience(input.candidateId);
      return current ?? decode<TaskExperienceCandidate>(receipt, "result_json")!;
    }
    const candidate = this.experience(input.candidateId);
    if (
      !candidate ||
      candidate.workspaceKey !== input.workspaceKey ||
      candidate.contentVersion !== input.expectedContentVersion ||
      ("expectedRecordRevision" in input &&
        candidate.recordRevision !== input.expectedRecordRevision)
    )
      throw new MemoryItemStoreConflictError(
        "version_conflict",
        "Task experience version conflict",
      );
    const next = run(candidate);
    this.writeExperience(next);
    this.db
      .prepare("INSERT INTO task_experience_actions VALUES(?,?,?,?,?,?)")
      .run(
        input.operationId,
        input.workspaceKey,
        input.candidateId,
        hash,
        JSON.stringify(next),
        now,
      );
    return next;
  }
  private publishExperience(
    candidate: TaskExperienceCandidate,
    now: number,
    options: {
      readonly review?: TaskExperienceCandidate["review"];
      readonly maturity?: TaskExperienceCandidate["maturity"];
      readonly promotionReason?: TaskExperienceCandidate["promotionReason"];
    } = {},
  ): TaskExperienceCandidate {
    const normalized = { ...candidate, content: normalizeExperienceContent(candidate.content) };
    const saved = this.options.createExperienceItem(normalized, now);
    const next: TaskExperienceCandidate = {
      ...normalized,
      state: "saved",
      lifecycleState: "active",
      review: options.review ?? "approved",
      enabled: true,
      ...(options.maturity ? { maturity: options.maturity } : {}),
      ...(options.promotionReason ? { promotionReason: options.promotionReason } : {}),
      itemId: saved.itemId,
    };
    this.db
      .prepare("INSERT INTO execution_learning_items VALUES(?,?,?,'reviewed-reference',?)")
      .run(
        saved.itemId,
        next.candidateId,
        saved.contentHash,
        JSON.stringify(experienceSummary(next)),
      );
    return next;
  }
  private refreshExperienceMetadata(candidate: TaskExperienceCandidate): void {
    if (candidate.itemId)
      this.db
        .prepare(
          "UPDATE execution_learning_items SET metadata_json=? WHERE item_id=? AND candidate_id=?",
        )
        .run(JSON.stringify(experienceSummary(candidate)), candidate.itemId, candidate.candidateId);
  }
  private clearExperience(
    candidate: TaskExperienceCandidate,
    state: "discarded" | "invalidated" | "expired",
    now: number,
    recordDelete = true,
  ): TaskExperienceCandidate {
    if (candidate.itemId) {
      this.db.prepare("DELETE FROM memory_items WHERE item_id=?").run(candidate.itemId);
      if (recordDelete)
        this.db
          .prepare("INSERT OR IGNORE INTO memory_write_operations VALUES(?,'delete',?,'[]',?)")
          .run(
            `task-experience-delete:${candidate.candidateId}`,
            createHash("sha256")
              .update(
                JSON.stringify({ candidateId: candidate.candidateId, itemId: candidate.itemId }),
              )
              .digest("hex"),
            now,
          );
    }
    this.db
      .prepare("INSERT OR IGNORE INTO execution_learning_tombstones VALUES(?,?)")
      .run(candidate.failureKey, now);
    const link = decode<{ kind: string; candidateId: string }>(
      this.db
        .prepare("SELECT result_json FROM task_experience_actions WHERE operation_id=?")
        .get(`native-evidence:${candidate.candidateId}`),
      "result_json",
    );
    const nativeId =
      candidate.nativeEvidence?.candidateId ??
      (link?.kind === "native-evidence-link" ? link.candidateId : undefined);
    // Scrub the generic record first: it must not count as a surviving evidence consumer.
    this.db
      .prepare("UPDATE execution_learning_candidates SET state=? WHERE candidate_id=?")
      .run(state, candidate.candidateId);
    if (nativeId) {
      const native = this.candidate(nativeId);
      const shared = this.db
        .prepare(
          "SELECT 1 FROM task_experience_actions a JOIN execution_learning_candidates c ON c.candidate_id=a.candidate_id WHERE a.candidate_id<>? AND c.state NOT IN ('discarded','invalidated','expired') AND json_extract(a.result_json,'$.kind')='native-evidence-link' AND json_extract(a.result_json,'$.candidateId')=? LIMIT 1",
        )
        .get(candidate.candidateId, nativeId);
      if (native && native.state !== "saved" && !native.itemId && !shared)
        this.clearCandidate(native, "discarded", now);
    }
    scrubExperienceLedger(this.db, { candidateId: candidate.candidateId }, now);
    const protectedIds = new Set(
      this.db
        .prepare(
          "SELECT record_json FROM execution_learning_candidates WHERE candidate_id<>? AND json_extract(record_json,'$.kind')='task-lesson' AND state<>'discarded'",
        )
        .all(candidate.candidateId)
        .flatMap((row) => decode<TaskExperienceCandidate>(row)!.observationIds),
    );
    for (const id of candidate.observationIds)
      if (!protectedIds.has(id))
        this.db.prepare("DELETE FROM task_experience_observations WHERE observation_id=?").run(id);
    for (const row of this.db
      .prepare("SELECT record_json FROM execution_learning_jobs WHERE candidate_id=?")
      .all(candidate.candidateId))
      this.writeJob({
        ...decode<ExecutionLearningJob>(row)!,
        state: "skipped",
        leaseUntil: 0,
        updatedAt: now,
      });
    const {
      itemId: _itemId,
      reason: _reason,
      nativeEvidence: _nativeEvidence,
      ...withoutItem
    } = candidate;
    const next = {
      ...withoutItem,
      state,
      enabled: false,
      content: "",
      goal: "",
      workDir: "",
      applicability: { taskFamily: "general" as const, toolNames: [], conditions: [] },
      sources: [],
      observationIds: [],
      recordRevision: candidate.recordRevision + 1,
      updatedAt: now,
    };
    this.writeExperience(next);
    // Operation hashes remain replayable, but historical action results cannot restore prose.
    this.db
      .prepare("UPDATE task_experience_actions SET result_json=? WHERE candidate_id=?")
      .run(JSON.stringify(next), candidate.candidateId);
    return next;
  }
  async reviewTaskExperience(input: TaskExperienceReviewInput): Promise<TaskExperienceCandidate> {
    return this.tx(() =>
      this.action(input, (candidate) => {
        if (candidate.state === "discarded") throw new Error("Task experience deleted");
        let next: TaskExperienceCandidate = {
          ...candidate,
          recordRevision: candidate.recordRevision + 1,
          updatedAt: input.now,
        };
        switch (input.action) {
          case "accept":
            if (
              !["pending", "deferred"].includes(candidate.review) &&
              candidate.maturity !== "trial"
            )
              throw new Error("Task experience is not pending");
            if (candidate.maturity === "trial" && candidate.itemId) {
              const { reviewReason: _reviewReason, ...withoutReviewReason } = next;
              next = {
                ...withoutReviewReason,
                review: "approved",
                maturity: "active",
                promotionReason: "human_approved",
                enabled: true,
              };
            } else {
              if (candidate.itemId) throw new Error("Pending task experience already has an item");
              const { reviewReason: _reviewReason, ...withoutReviewReason } = next;
              next = this.publishExperience(
                {
                  ...withoutReviewReason,
                  maturity: "active",
                  promotionReason: "human_approved",
                },
                input.now,
              );
            }
            break;
          case "edit_accept": {
            const content = normalizeExperienceContent(input.content ?? "");
            const { spreadsheet: _spreadsheet, ...applicability } =
              input.applicability ?? candidate.applicability;
            if (candidate.itemId)
              this.db.prepare("DELETE FROM memory_items WHERE item_id=?").run(candidate.itemId);
            const {
              itemId: _itemId,
              nativeEvidence: _nativeEvidence,
              reviewReason: _reviewReason,
              ...withoutItem
            } = next;
            next = this.publishExperience(
              {
                ...withoutItem,
                content,
                contentVersion: candidate.contentVersion + 1,
                validation: "unknown",
                positiveReuseCount: 0,
                applicability,
                maturity: "active",
                promotionReason: "human_approved",
              },
              input.now,
            );
            break;
          }
          case "defer":
            if (candidate.review === "approved")
              throw new Error("Approved task experience cannot be deferred");
            next = { ...next, review: "deferred", enabled: false };
            break;
          case "reject":
            next = {
              ...this.clearExperience(candidate, "discarded", input.now),
              review: "rejected",
            };
            break;
          case "delete":
            next = this.clearExperience(candidate, "discarded", input.now);
            break;
          case "disable":
            next = { ...next, enabled: false };
            break;
          case "archive":
            if (!candidate.itemId) throw new Error("Task experience has no reviewed item");
            this.db
              .prepare(
                "UPDATE memory_items SET lifecycle_state='archived',version=version+1,updated_at=? WHERE item_id=?",
              )
              .run(input.now, candidate.itemId);
            next = { ...next, enabled: false, lifecycleState: "archived" };
            break;
          case "restore":
            if (candidate.maturity === "suspended" && candidate.validation === "fail")
              throw new Error("Contradicted task experience must be edited before re-enabling");
            if (
              !candidate.itemId ||
              !(
                candidate.review === "approved" ||
                (candidate.review === "unneeded" &&
                  candidate.risk === "low" &&
                  (candidate.maturity === "trial" || candidate.maturity === "active"))
              )
            )
              throw new Error("Task experience has no reusable item");
            this.db
              .prepare(
                "UPDATE memory_items SET lifecycle_state='active',version=version+1,updated_at=? WHERE item_id=?",
              )
              .run(input.now, candidate.itemId);
            next = {
              ...next,
              enabled: true,
              lifecycleState: "active",
              maturity: candidate.maturity === "trial" ? "trial" : "active",
            };
            break;
        }
        this.refreshExperienceMetadata(next);
        this.bumpManagementRevision();
        return next;
      }),
    );
  }
  async feedbackTaskExperience(
    input: TaskExperienceFeedbackInput,
  ): Promise<TaskExperienceCandidate> {
    return this.tx(() =>
      this.action(input, (candidate) => {
        const matching = this.db
          .prepare(
            "SELECT record_json FROM experience_uses WHERE candidate_id=? AND source_kind='reviewed-reference'",
          )
          .all(candidate.candidateId)
          .map((row) => decode<ExperienceUse>(row)!)
          .filter(
            (use) =>
              use.source.kind === "reviewed-reference" &&
              use.source.contentVersion === candidate.contentVersion &&
              use.taskId === input.taskId &&
              use.taskVersion === input.taskVersion &&
              use.workspaceKey === input.workspaceKey &&
              !use.deleted,
          );
        if (!matching.length) throw new Error("Feedback has no matching reuse");
        for (const use of matching)
          this.options.experienceLedger.writeUse({
            ...use,
            excluded: input.action === "not_applicable" || use.excluded,
            updatedAt: input.now,
          });
        if (input.action !== "not_applicable") this.bumpManagementRevision();
        const { nativeEvidence, ...withoutEvidence } = candidate;
        const next = {
          ...withoutEvidence,
          ...(input.action !== "correct" && nativeEvidence ? { nativeEvidence } : {}),
          enabled:
            input.action === "disable" || input.action === "correct" ? false : candidate.enabled,
          ...(input.action === "correct"
            ? {
                reason: "user_correction",
                validation: "unknown" as const,
                maturity: "suspended" as const,
              }
            : {}),
          recordRevision: candidate.recordRevision + 1,
          updatedAt: input.now,
        };
        this.refreshExperienceMetadata(next);
        return next;
      }),
    );
  }
  async recordTaskExperienceReuse(reuse: TaskExperienceReuse): Promise<void> {
    const item = this.db
      .prepare("SELECT content_hash FROM memory_items WHERE item_id=?")
      .get(reuse.itemId);
    const fence = this.options.experienceLedger.fence(reuse.workspaceKey);
    await this.options.experienceLedger.recordExperienceUse({
      useId: reuse.reuseId,
      workspaceKey: reuse.workspaceKey,
      source: {
        kind: "reviewed-reference",
        candidateId: reuse.candidateId,
        contentVersion: reuse.contentVersion,
      },
      itemId: reuse.itemId,
      itemVersion: reuse.itemVersion,
      contentHash: item ? String(item.content_hash) : "",
      taskId: reuse.taskId,
      taskVersion: reuse.taskVersion,
      sessionId: reuse.sessionId,
      runId: reuse.runId,
      referenceHash: reuse.referenceHash,
      ...(reuse.referenceContent !== undefined ? { referenceContent: reuse.referenceContent } : {}),
      delivery: "unknown",
      historical: true,
      ...fence,
      adoption: reuse.adoption,
      validation: reuse.validation,
      validationScope: "unknown",
      excluded: reuse.excluded,
      deleted: false,
      sources: reuse.sources,
      createdAt: reuse.createdAt,
      updatedAt: reuse.updatedAt,
    });
  }
  async listTaskExperienceReuse(
    workspaceKey: string,
    sessionId?: string,
  ): Promise<readonly TaskExperienceReuse[]> {
    return this.db
      .prepare(
        `SELECT record_json FROM experience_uses WHERE workspace_key=? AND source_kind='reviewed-reference'${sessionId ? " AND session_id=?" : ""} ORDER BY rowid DESC LIMIT 1000`,
      )
      .all(...(sessionId ? [workspaceKey, sessionId] : [workspaceKey]))
      .map((row) => reuseProjection(decode<ExperienceUse>(row)!));
  }
  async settleTaskExperienceReuse(
    input: Parameters<TaskExperienceStore["settleTaskExperienceReuse"]>[0],
  ): Promise<void> {
    this.tx(() => {
      const use = this.options.experienceLedger.use(input.reuseId);
      if (
        !use ||
        use.source.kind !== "reviewed-reference" ||
        use.source.candidateId !== input.candidateId ||
        use.source.contentVersion !== input.contentVersion ||
        use.taskVersion !== input.taskVersion ||
        use.deleted ||
        use.excluded
      )
        return;
      const observations = this.db
        .prepare(
          "SELECT record_json FROM task_experience_observations WHERE task_id=? AND task_version=?",
        )
        .all(use.taskId, use.taskVersion)
        .map((row) => decode<TaskExperienceObservation>(row)!);
      if (
        input.sources.some(
          (source) =>
            !observations.some(
              (observation) =>
                sameSource(source, observation.source) &&
                observation.kind === "tool-result" &&
                observation.status === "succeeded",
            ),
        ) ||
        (["pass", "fail"].includes(input.validation) &&
          (input.adoption !== "observed" || !input.sources.length))
      )
        throw new Error("Reuse validation source mismatch");
      this.options.experienceLedger.settleHistoricalUse(use, {
        adoption: input.adoption,
        validation: input.validation,
        sources: input.sources,
        updatedAt: input.now,
      });
    });
  }
}
function experienceActionHash(value: unknown): string {
  const canonical = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(canonical)
      : input && typeof input === "object"
        ? Object.fromEntries(
            Object.entries(input)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, entry]) => [key, canonical(entry)]),
          )
        : input;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
function reuseProjection(use: ExperienceUse): TaskExperienceReuse {
  if (use.source.kind !== "reviewed-reference") throw new Error("Task reuse source mismatch");
  return {
    reuseId: use.useId,
    workspaceKey: use.workspaceKey,
    candidateId: use.source.candidateId,
    contentVersion: use.source.contentVersion,
    itemId: use.itemId,
    itemVersion: use.itemVersion,
    taskId: use.taskId,
    taskVersion: use.taskVersion,
    sessionId: use.sessionId,
    runId: use.hostRunId ?? use.runId,
    referenceHash: use.referenceHash,
    ...(use.referenceContent !== undefined
      ? { referenceContent: legacyReferenceExcerpt(use.referenceContent) }
      : {}),
    adoption: use.adoption,
    validation: use.validation,
    excluded: use.excluded,
    sources: use.sources,
    createdAt: use.createdAt,
    updatedAt: use.updatedAt,
  };
}
function sourceIdentity(source: MemoryItemSource): string {
  return JSON.stringify([source.sessionId, source.runId, source.turnId, source.eventId]);
}
function sameSource(a: MemoryItemSource, b: MemoryItemSource): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.runId === b.runId &&
    a.turnId === b.turnId &&
    a.eventId === b.eventId
  );
}
function normalizeExperienceContent(content: string): string {
  const normalized = normalizeLongTermMemoryContent(content);
  if (
    !normalized.ok ||
    /pico:\/\/artifact\/|(?:artifact_id|sha256)\s*[:=]/iu.test(normalized.value)
  )
    throw new Error("Task experience content invalid");
  return normalized.value;
}
function assertRunBindingIdentifier(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    value.normalize("NFC") !== value ||
    Array.from(value).length > 512 ||
    /[\p{Cc}\p{Cs}\u200B-\u200D\uFEFF]/u.test(value)
  )
    throw new Error("Invalid Host Run binding identity");
}
function normalizeRunBinding(value: TaskExperienceRunBinding): TaskExperienceRunBinding {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "createdAt,executionRunId,hostRunId,sessionId,workspaceKey"
  )
    throw new Error("Invalid Host Run binding shape");
  for (const id of [value.workspaceKey, value.sessionId, value.executionRunId, value.hostRunId])
    assertRunBindingIdentifier(id);
  if (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0)
    throw new Error("Invalid Host Run binding timestamp");
  return {
    workspaceKey: value.workspaceKey,
    sessionId: value.sessionId,
    executionRunId: value.executionRunId,
    hostRunId: value.hostRunId,
    createdAt: value.createdAt,
  };
}
function runBindingOperationId(
  workspaceKey: string,
  sessionId: string,
  executionRunId: string,
): string {
  return `task-experience-host-run-binding:${createHash("sha256")
    .update(JSON.stringify([workspaceKey, sessionId, executionRunId]))
    .digest("hex")}`;
}
function runBindingHash(binding: TaskExperienceRunBinding): string {
  return createHash("sha256").update(JSON.stringify(binding)).digest("hex");
}
function decodeRunBinding(
  row: Row,
  workspaceKey: string,
  sessionId: string,
  executionRunId: string,
): TaskExperienceRunBinding | undefined {
  try {
    const envelope = decode<{ kind: unknown; binding: TaskExperienceRunBinding }>(
      row,
      "result_json",
    );
    if (
      !envelope ||
      envelope.kind !== "host-run-binding" ||
      Object.keys(envelope).sort().join(",") !== "binding,kind"
    )
      return undefined;
    const binding = normalizeRunBinding(envelope.binding);
    if (
      binding.workspaceKey !== workspaceKey ||
      binding.sessionId !== sessionId ||
      binding.executionRunId !== executionRunId ||
      row.operation_id !== runBindingOperationId(workspaceKey, sessionId, executionRunId) ||
      row.workspace_key !== workspaceKey ||
      row.candidate_id !== `run-binding:${executionRunId}` ||
      row.request_hash !== runBindingHash(binding) ||
      row.created_at !== binding.createdAt
    )
      return undefined;
    return binding;
  } catch {
    return undefined;
  }
}
function experienceSummary(candidate: TaskExperienceCandidate): TaskExperienceSummary {
  const {
    candidateId,
    contentVersion,
    recordRevision,
    review,
    validation,
    enabled,
    applicability,
  } = candidate;
  return {
    candidateId,
    contentVersion,
    recordRevision,
    review,
    validation,
    enabled,
    applicability,
    ...(candidate.maturity ? { maturity: candidate.maturity } : {}),
    ...(candidate.risk ? { risk: candidate.risk } : {}),
    ...(candidate.promotionReason ? { promotionReason: candidate.promotionReason } : {}),
    ...(candidate.positiveReuseCount !== undefined
      ? { positiveReuseCount: candidate.positiveReuseCount }
      : {}),
    ...(candidate.reviewReason ? { reviewReason: candidate.reviewReason } : {}),
  };
}

function assessExperienceDraft(input: {
  readonly content: string;
  readonly applicability: TaskExperienceCandidate["applicability"];
  readonly sources: readonly MemoryItemSource[];
  readonly observations: readonly TaskExperienceObservation[];
  readonly hasNativeEvidence: boolean;
}): { readonly risk: "low" | "high" | "unclear"; readonly reviewReason?: string } {
  const highRisk =
    /(?:\bdelete\b|\bremove\b|\berase\b|\brm\s+-rf\b|\bdrop\s+(?:table|database)\b|删除|清空|销毁|\bpublish\b|\brelease\b|\bdeploy\b|发布|部署|外部发送|\bsend\s+(?:an?\s+)?(?:email|message|request)|发(?:送|邮件)|转账|付款|\btransfer\b|\bpayment\b|\bpermission(?:s)?\b|\bsecurity\b|\bcredential(?:s)?\b|\bsudo\b|\bchmod\b|权限|授权|凭据|绕过(?:审批|确认|权限)|\b(?:bypass|skip)\s+(?:approval|review|permission|confirmation)\b)/iu.test(
      `${input.content}\n${input.applicability.conditions.join("\n")}`,
    );
  if (highRisk)
    return {
      risk: "high",
      reviewReason: "经验涉及删除、发布、外部发送、资金、权限或安全相关操作，需要人工审核。",
    };

  const selected = input.sources.map(
    (source) =>
      input.observations
        .filter((observation) => sameSource(source, observation.source))
        .sort((left, right) => right.sequence - left.sequence)[0],
  );
  const sourceStatuses = new Map<string, Set<NonNullable<TaskExperienceObservation["status"]>>>();
  for (const observation of input.observations) {
    if (
      !input.sources.some((source) => sameSource(source, observation.source)) ||
      !observation.status
    )
      continue;
    const sourceKey = JSON.stringify([
      observation.source.sessionId,
      observation.source.runId,
      observation.source.turnId,
      observation.source.eventId,
    ]);
    const statuses = sourceStatuses.get(sourceKey) ?? new Set();
    statuses.add(observation.status);
    sourceStatuses.set(sourceKey, statuses);
  }
  const conflictingSource = [...sourceStatuses.values()].some((statuses) => statuses.size > 1);
  const latestRelevant = [...input.observations]
    .filter(
      (observation) =>
        observation.kind === "tool-result" ||
        observation.correction ||
        (observation.kind === "terminal" && observation.status !== "succeeded"),
    )
    .sort((left, right) => right.sequence - left.sequence)[0];
  const includesLatestEvidence =
    !!latestRelevant && input.sources.some((source) => sameSource(source, latestRelevant.source));
  const completeEvidence =
    input.sources.length >= 2 &&
    selected.every((observation) => observation?.coverage === "complete") &&
    includesLatestEvidence;
  const failure = selected.some(
    (observation) =>
      !!observation &&
      (observation.correction ||
        observation.status === "failed" ||
        observation.status === "rejected"),
  );
  const recovery = selected.some((observation) => observation?.status === "succeeded");
  const latestFailure = [...input.observations]
    .filter(
      (observation) =>
        observation.correction ||
        observation.status === "failed" ||
        observation.status === "rejected",
    )
    .sort((left, right) => right.sequence - left.sequence)[0];
  const failureBeforeRecovery =
    !!latestFailure &&
    input.sources.some((source) => sameSource(source, latestFailure.source)) &&
    latestRelevant?.kind === "tool-result" &&
    latestRelevant.status === "succeeded" &&
    latestRelevant.sequence > latestFailure.sequence;
  const boundedScope =
    input.applicability.toolNames.length > 0 &&
    (input.hasNativeEvidence ||
      !!input.applicability.spreadsheet ||
      input.applicability.conditions.length > 0);
  if (
    !completeEvidence ||
    !failure ||
    !recovery ||
    !failureBeforeRecovery ||
    conflictingSource ||
    !boundedScope
  )
    return {
      risk: "unclear",
      reviewReason: conflictingSource
        ? "同一来源事件记录了互相冲突的结果，需人工核对。"
        : !boundedScope
          ? "适用范围还不够明确，需审核经验内容和适用条件。"
          : !includesLatestEvidence
            ? "候选来源没有包含本轮最新结果，可能遗漏冲突或后续修正。"
            : !failureBeforeRecovery
              ? "最新失败或纠正之后还缺少完整的成功证据，暂不能判断经验是否解决了问题。"
              : "缺少完整的失败与成功对照证据，暂不能确认经验原因。",
    };
  return { risk: "low" };
}

function legacyReferenceExcerpt(content: string): string {
  const rendered = /^<memory\b[^>]*>([\s\S]*)<\/memory>$/u.exec(content);
  if (!rendered) return content;
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return rendered[1]!.replace(
    /&(amp|lt|gt|quot|apos);/gu,
    (_match, entity: string) => entities[entity]!,
  );
}

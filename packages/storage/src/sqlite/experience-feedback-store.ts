import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { MemoryItemStoreConflictError } from "@pico/core";
import type {
  ExperienceDiagnostic,
  ExperienceLedgerStore,
  ExperienceUse,
  ExperienceEffect,
  ExperienceFeedbackInput,
  ExperienceUsePage,
  TaskExperienceCandidate,
  TaskExperienceTask,
  ExecutionLearningCandidate,
} from "@pico/core";

type Row = Record<string, unknown>;
const decode = <T>(row: Row | undefined, key = "record_json"): T | undefined =>
  row ? (JSON.parse(String(row[key])) as T) : undefined;
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => [key, canonical(entry)]),
        )
      : value;
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");

/** One durable source for all three kinds of experience delivery and feedback. */
export class SqliteExperienceLedgerStore implements ExperienceLedgerStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly options: {
      settings: (workspaceKey: string) => {
        version: number;
        enabled: boolean;
        recallEnabled: boolean;
      };
      deletionRevision: () => number;
      itemAcceptance: (
        itemId: string,
        contentHash: string,
      ) => {
        taskExperience?: unknown;
        taskAcceptance?: unknown;
      };
      cursorError: (message: string) => Error;
    },
  ) {}

  private tx<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  fence(workspaceKey: string) {
    return {
      settingsVersion: this.options.settings(workspaceKey).version,
      deletionRevision: this.options.deletionRevision(),
      managementRevision: Number(
        this.db
          .prepare("SELECT management_revision FROM execution_learning_control WHERE scope='*'")
          .get()?.management_revision ?? 0,
      ),
    };
  }
  async recordExperienceDiagnostic(diagnostic: ExperienceDiagnostic): Promise<void> {
    for (const value of [
      diagnostic.diagnosticId,
      diagnostic.workspaceKey,
      diagnostic.sessionId,
      diagnostic.runId,
    ])
      identifier(value);
    if (
      !["identity", "proposal", "reference", "effect", "worker"].includes(diagnostic.phase) ||
      !/^[a-z][a-z0-9_-]{0,95}$/u.test(diagnostic.reason)
    )
      throw new Error("Invalid experience diagnostic code");
    integer(diagnostic.createdAt);
    this.tx(() => {
      const prior = decode<ExperienceDiagnostic>(
        this.db
          .prepare("SELECT record_json FROM experience_diagnostics WHERE diagnostic_id=?")
          .get(diagnostic.diagnosticId),
      );
      if (
        prior &&
        (prior.workspaceKey !== diagnostic.workspaceKey ||
          prior.sessionId !== diagnostic.sessionId ||
          prior.runId !== diagnostic.runId ||
          prior.phase !== diagnostic.phase ||
          prior.reason !== diagnostic.reason)
      )
        throw new Error("Experience diagnostic identity reused");
      this.db
        .prepare(
          "INSERT INTO experience_diagnostics VALUES(?,?,?,?,?) ON CONFLICT(diagnostic_id) DO UPDATE SET created_at=excluded.created_at,record_json=excluded.record_json",
        )
        .run(
          diagnostic.diagnosticId,
          diagnostic.workspaceKey,
          diagnostic.sessionId,
          diagnostic.createdAt,
          JSON.stringify(diagnostic),
        );
      // Diagnostics never carry task prose and are bounded independently of candidate/model budgets.
      this.db
        .prepare(
          "DELETE FROM experience_diagnostics WHERE workspace_key=? AND diagnostic_id NOT IN (SELECT diagnostic_id FROM experience_diagnostics WHERE workspace_key=? ORDER BY created_at DESC,rowid DESC LIMIT 100)",
        )
        .run(diagnostic.workspaceKey, diagnostic.workspaceKey);
    });
  }
  async listExperienceDiagnostics(
    workspaceKey: string,
    sessionId?: string,
  ): Promise<readonly ExperienceDiagnostic[]> {
    identifier(workspaceKey);
    if (sessionId !== undefined) identifier(sessionId);
    const rows =
      sessionId === undefined
        ? this.db
            .prepare(
              "SELECT record_json FROM experience_diagnostics WHERE workspace_key=? ORDER BY created_at DESC,rowid DESC LIMIT 10",
            )
            .all(workspaceKey)
        : this.db
            .prepare(
              "SELECT record_json FROM experience_diagnostics WHERE workspace_key=? AND session_id=? ORDER BY created_at DESC,rowid DESC LIMIT 10",
            )
            .all(workspaceKey, sessionId);
    return rows.map((row) => decode<ExperienceDiagnostic>(row)!);
  }
  async readExperienceFence(workspaceKey: string) {
    identifier(workspaceKey);
    return this.fence(workspaceKey);
  }
  use(useId: string): ExperienceUse | undefined {
    return decode<ExperienceUse>(
      this.db.prepare("SELECT record_json FROM experience_uses WHERE use_id=?").get(useId),
    );
  }
  writeUse(use: ExperienceUse): void {
    this.db
      .prepare(
        "INSERT INTO experience_uses VALUES(?,?,?,?,?,?,?) ON CONFLICT(use_id) DO UPDATE SET record_json=excluded.record_json",
      )
      .run(
        use.useId,
        use.workspaceKey,
        use.sessionId,
        use.itemId,
        use.source.kind,
        use.source.candidateId,
        JSON.stringify(use),
      );
  }
  async readExperienceUse(useId: string) {
    identifier(useId);
    return this.use(useId);
  }

  private sourceCurrent(use: ExperienceUse, requireEnabled: boolean): boolean {
    if (use.deleted) return false;
    const item = this.db.prepare("SELECT * FROM memory_items WHERE item_id=?").get(use.itemId);
    if (
      !item ||
      item.version !== use.itemVersion ||
      item.content_hash !== use.contentHash ||
      (requireEnabled && item.lifecycle_state !== "active") ||
      item.scope_type !== "workspace" ||
      item.scope_key !== use.workspaceKey
    )
      return false;
    const source = use.source;
    // Retired sources remain readable only as body-free audit receipts.
    if (source.kind === "execution-evidence") return false;
    const mapping = this.db
      .prepare("SELECT * FROM execution_learning_items WHERE item_id=?")
      .get(use.itemId);
    if (
      !mapping ||
      mapping.candidate_id !== source.candidateId ||
      mapping.source_type !== source.kind ||
      mapping.item_content_hash !== use.contentHash
    )
      return false;
    const acceptance = this.options.itemAcceptance(use.itemId, use.contentHash);
    if (source.kind === "reviewed-reference") {
      const candidate = decode<TaskExperienceCandidate>(
        this.db
          .prepare("SELECT record_json FROM execution_learning_candidates WHERE candidate_id=?")
          .get(source.candidateId),
      );
      return (
        !!candidate &&
        candidate.kind === "task-lesson" &&
        candidate.workspaceKey === use.workspaceKey &&
        candidate.state === "saved" &&
        (candidate.review === "approved" ||
          (candidate.review === "unneeded" &&
            candidate.maturity === "trial" &&
            candidate.risk === "low")) &&
        candidate.itemId === use.itemId &&
        candidate.contentVersion === source.contentVersion &&
        !!acceptance.taskExperience &&
        (!requireEnabled || (candidate.enabled && candidate.lifecycleState === "active"))
      );
    }
    const candidate = decode<ExecutionLearningCandidate>(
      this.db
        .prepare("SELECT record_json FROM execution_learning_candidates WHERE candidate_id=?")
        .get(source.candidateId),
    );
    return (
      !!candidate?.claim &&
      candidate.state === "saved" &&
      candidate.itemId === use.itemId &&
      candidate.claim.admission.workspaceKey === use.workspaceKey &&
      candidate.claim.revision === source.claimRevision &&
      candidate.claim.claimHash === source.claimHash &&
      candidate.claim.target.scopeHash === source.scopeHash &&
      !!acceptance.taskAcceptance
    );
  }
  private currentFence(use: ExperienceUse): boolean {
    const current = this.fence(use.workspaceKey);
    const settings = this.options.settings(use.workspaceKey);
    return (
      settings.enabled &&
      settings.recallEnabled &&
      current.settingsVersion === use.settingsVersion &&
      current.managementRevision === use.managementRevision &&
      current.deletionRevision === use.deletionRevision
    );
  }
  private effectFence(use: ExperienceUse): boolean {
    const current = this.fence(use.workspaceKey);
    return (
      this.options.settings(use.workspaceKey).enabled &&
      current.managementRevision === use.managementRevision &&
      current.deletionRevision === use.deletionRevision
    );
  }
  excluded(input: {
    workspaceKey: string;
    itemId: string;
    taskId: string;
    taskVersion: number;
  }): boolean {
    return this.db
      .prepare("SELECT record_json FROM experience_uses WHERE workspace_key=? AND item_id=?")
      .all(input.workspaceKey, input.itemId)
      .some((row) => {
        const use = decode<ExperienceUse>(row)!;
        return (
          use.taskId === input.taskId &&
          use.taskVersion === input.taskVersion &&
          use.excluded &&
          !use.deleted
        );
      });
  }
  async isExperienceExcluded(input: {
    workspaceKey: string;
    itemId: string;
    taskId: string;
    taskVersion: number;
  }) {
    return this.excluded(input);
  }
  async recordExperienceUse(use: ExperienceUse): Promise<void> {
    validateUse(use);
    this.tx(() => {
      const old = this.use(use.useId);
      if (old) {
        if (hash(identity(old)) !== hash(identity(use)))
          throw new Error("Experience use identity reused");
        return;
      }
      const task = decode<TaskExperienceTask>(
        this.db
          .prepare("SELECT record_json FROM task_experience_tasks WHERE task_id=?")
          .get(use.taskId),
      );
      if (
        !this.sourceCurrent(use, true) ||
        !this.currentFence(use) ||
        this.excluded(use) ||
        (use.source.kind === "reviewed-reference" && !task) ||
        (task &&
          (task.workspaceKey !== use.workspaceKey ||
            task.sessionId !== use.sessionId ||
            task.taskVersion !== use.taskVersion ||
            (task.executionRunId ?? task.runId) !== use.runId))
      )
        throw new Error("Experience use binding or policy changed");
      this.writeUse(use);
    });
  }
  async queryExperienceUses(
    workspaceKey: string,
    options: { sessionId?: string; itemId?: string; cursor?: string; limit?: number } = {},
  ): Promise<ExperienceUsePage> {
    identifier(workspaceKey);
    if (options.sessionId !== undefined) identifier(options.sessionId);
    if (options.itemId !== undefined) identifier(options.itemId);
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid experience page limit");
    const binding = hash([workspaceKey, options.sessionId ?? null, options.itemId ?? null]);
    let before: number | undefined;
    if (options.cursor !== undefined) {
      try {
        if (options.cursor.length > 2048) throw new Error();
        const value = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
        if (
          value.version !== 1 ||
          value.binding !== binding ||
          !Number.isSafeInteger(value.rowid) ||
          value.rowid < 1
        )
          throw new Error();
        before = value.rowid;
      } catch {
        throw this.options.cursorError("Experience cursor scope mismatch or invalid cursor");
      }
    }
    const parameters: (string | number)[] = [workspaceKey];
    let where = "workspace_key=?";
    if (options.sessionId !== undefined) {
      where += " AND session_id=?";
      parameters.push(options.sessionId);
    }
    if (options.itemId !== undefined) {
      where += " AND item_id=?";
      parameters.push(options.itemId);
    }
    if (before !== undefined) {
      where += " AND rowid<?";
      parameters.push(before);
    }
    const size = Math.min(limit, 100);
    const rows = this.db
      .prepare(
        `SELECT rowid,record_json FROM experience_uses WHERE ${where} ORDER BY rowid DESC LIMIT ?`,
      )
      .all(...parameters, size + 1);
    const page = rows.slice(0, size);
    return {
      uses: page.map((row) => decode<ExperienceUse>(row)!),
      ...(rows.length > size
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({ version: 1, binding, rowid: Number(page.at(-1)!.rowid) }),
            ).toString("base64url"),
          }
        : {}),
    };
  }
  async deliverExperienceUse(input: {
    useId: string;
    providerCallId: string;
    physicalAttemptId?: string;
    deliverySequence: number;
    now: number;
  }): Promise<void> {
    identifier(input.useId);
    identifier(input.providerCallId);
    integer(input.deliverySequence, 1);
    integer(input.now);
    if (input.physicalAttemptId !== undefined) identifier(input.physicalAttemptId);
    this.tx(() => {
      const use = this.use(input.useId);
      if (!use) throw new Error("Experience use not found");
      if (use.delivery === "carried") {
        if (use.deliverySequence === input.deliverySequence) {
          if (
            use.providerCallId !== input.providerCallId ||
            use.physicalAttemptId !== input.physicalAttemptId
          )
            throw new Error("Experience delivery identity reused");
          return;
        }
        if (input.deliverySequence <= use.deliverySequence!)
          throw new Error("Experience delivery sequence stale");
      }
      if (
        use.historical ||
        !["pending", "carried"].includes(use.delivery) ||
        use.deleted ||
        use.excluded ||
        input.deliverySequence <= (use.recallSequence ?? 0) ||
        !this.currentFence(use) ||
        !this.sourceCurrent(use, true)
      )
        throw new Error("Experience delivery binding or policy changed");
      this.writeUse({
        ...use,
        delivery: "carried",
        providerCallId: input.providerCallId,
        ...(input.physicalAttemptId !== undefined
          ? { physicalAttemptId: input.physicalAttemptId }
          : {}),
        deliverySequence: input.deliverySequence,
        updatedAt: input.now,
      });
    });
  }
  async appendExperienceEffect(
    effect: ExperienceEffect,
    options?: { allowStateChange: boolean },
  ): Promise<void> {
    validateEffect(effect);
    this.tx(() => {
      const use = this.use(effect.useId);
      if (!use) throw new Error("Experience use not found");
      const old = decode<ExperienceEffect>(
        this.db
          .prepare(
            "SELECT record_json FROM experience_effects WHERE use_id=? AND outcome_event_id=?",
          )
          .get(effect.useId, effect.outcomeEventId),
      );
      if (old) return;
      if (
        this.db.prepare("SELECT 1 FROM experience_effects WHERE effect_id=?").get(effect.effectId)
      )
        throw new Error("Experience effect identity reused");
      if (
        use.deleted ||
        use.historical ||
        use.delivery !== "carried" ||
        use.excluded ||
        use.deliverySequence === undefined ||
        effect.preparedSequence <= use.deliverySequence ||
        effect.outcomeSequence <= effect.preparedSequence ||
        !effect.sources.some(
          (source) =>
            source.eventId === effect.outcomeEventId && source.sessionId === use.sessionId,
        ) ||
        effect.sources.some((source) => source.sessionId !== use.sessionId)
      )
        return;
      const accepted =
        use.source.kind === "execution-evidence"
          ? {
              ...effect,
              validation: "unknown" as const,
              validationScope: "unknown" as const,
              trustedContradiction: false,
            }
          : effect;
      this.db
        .prepare("INSERT INTO experience_effects VALUES(?,?,?,?)")
        .run(effect.effectId, effect.useId, effect.outcomeEventId, JSON.stringify(accepted));
      // Keep every effect; the latest outcome is only a convenient projection.
      const latest = this.db
        .prepare(
          "SELECT record_json FROM experience_effects WHERE use_id=? ORDER BY CAST(json_extract(record_json,'$.outcomeSequence') AS INTEGER) DESC,rowid DESC LIMIT 1",
        )
        .get(use.useId);
      const verdict = decode<ExperienceEffect>(latest)!;
      this.writeUse({
        ...use,
        adoption: verdict.adoption,
        validation: verdict.validation,
        validationScope: verdict.validationScope,
        sources: verdict.sources,
        updatedAt: Math.max(use.updatedAt, verdict.createdAt),
      });
      if (
        !options?.allowStateChange ||
        verdict.outcomeEventId !== effect.outcomeEventId ||
        !this.effectFence(use) ||
        !this.sourceCurrent(use, true) ||
        this.excluded(use) ||
        effect.adoption !== "observed"
      )
        return;
      // Native/command outcomes remain scoped ledger evidence; they cannot validate
      // arbitrary reviewed prose or disable the reference automatically.
      if (
        use.source.kind === "reviewed-reference" &&
        ["spreadsheet-range", "native-claim", "command"].includes(effect.validationScope) &&
        ["pass", "fail"].includes(effect.validation)
      ) {
        if (
          effect.validationScope === "native-claim" &&
          !this.hasNativeEvidence(use.source.candidateId)
        )
          return;
        if (effect.validation === "fail" && !effect.trustedContradiction) return;
        this.updateGeneric(use, effect.validation === "fail", effect.createdAt, effect.validation);
      } else if (
        use.source.kind === "execution-validated" &&
        effect.validationScope === "native-claim" &&
        effect.validation === "fail" &&
        effect.trustedContradiction
      ) {
        this.archive(use, effect.createdAt);
      }
    });
  }
  async listExperienceEffects(useId: string): Promise<readonly ExperienceEffect[]> {
    identifier(useId);
    return this.db
      .prepare("SELECT record_json FROM experience_effects WHERE use_id=? ORDER BY rowid")
      .all(useId)
      .map((row) => decode<ExperienceEffect>(row)!);
  }
  /** Compatibility callers lack delivery chronology and cannot control current memory. */
  settleHistoricalUse(
    use: ExperienceUse,
    verdict: Pick<ExperienceUse, "adoption" | "validation" | "sources" | "updatedAt">,
  ): void {
    if (!use.historical || use.deleted || use.excluded) return;
    this.writeUse({ ...use, ...verdict });
  }
  private bumpManagement(): void {
    this.db
      .prepare(
        "INSERT INTO execution_learning_control(scope,management_revision,resource_revision) VALUES('*',1,1) ON CONFLICT(scope) DO UPDATE SET management_revision=management_revision+1,resource_revision=resource_revision+1",
      )
      .run();
  }
  private bumpResourceRevision(): void {
    this.db
      .prepare(
        "INSERT INTO execution_learning_control(scope,resource_revision) VALUES('*',1) ON CONFLICT(scope) DO UPDATE SET resource_revision=resource_revision+1",
      )
      .run();
  }
  private updateGeneric(
    use: ExperienceUse,
    disable: boolean,
    now: number,
    validation?: ExperienceUse["validation"],
  ): void {
    const candidate = decode<TaskExperienceCandidate>(
      this.db
        .prepare("SELECT record_json FROM execution_learning_candidates WHERE candidate_id=?")
        .get(use.source.candidateId),
    )!;
    const positiveReuseCount = this.positiveTaskExperienceReuseCount(candidate);
    const validationScope = this.useValidationScope(use.useId);
    const deterministicPass =
      !disable &&
      validation === "pass" &&
      ["spreadsheet-range", "native-claim"].includes(validationScope);
    const twoPositiveReuses =
      !disable && validation === "pass" && validationScope === "command" && positiveReuseCount >= 2;
    const autoPromoted =
      (deterministicPass || twoPositiveReuses) &&
      candidate.maturity === "trial" &&
      candidate.risk === "low";
    const { reviewReason: _reviewReason, ...candidateWithoutReviewReason } = candidate;
    const next: TaskExperienceCandidate = {
      ...candidateWithoutReviewReason,
      enabled: disable ? false : candidate.enabled,
      ...(validation ? { validation } : {}),
      ...(candidate.reviewReason !== undefined ? { reviewReason: candidate.reviewReason } : {}),
      ...(candidate.positiveReuseCount !== undefined || positiveReuseCount > 0
        ? { positiveReuseCount }
        : {}),
      ...(disable ? { maturity: "suspended" as const } : {}),
      ...(autoPromoted
        ? {
            maturity: "active" as const,
            promotionReason: deterministicPass
              ? ("deterministic_validation" as const)
              : ("two_positive_reuses" as const),
          }
        : {}),
      ...(disable
        ? { reason: validation === "fail" ? "trusted_reuse_contradiction" : "user_disable" }
        : {}),
      recordRevision: candidate.recordRevision + 1,
      updatedAt: now,
    };
    this.db
      .prepare(
        "UPDATE execution_learning_candidates SET revision=?,updated_at=?,record_json=? WHERE candidate_id=?",
      )
      .run(next.recordRevision, now, JSON.stringify(next), next.candidateId);
    const metadata = {
      candidateId: next.candidateId,
      contentVersion: next.contentVersion,
      recordRevision: next.recordRevision,
      review: next.review,
      validation: next.validation,
      enabled: next.enabled,
      applicability: next.applicability,
      ...(next.maturity ? { maturity: next.maturity } : {}),
      ...(next.risk ? { risk: next.risk } : {}),
      ...(next.promotionReason ? { promotionReason: next.promotionReason } : {}),
      ...(next.positiveReuseCount !== undefined
        ? { positiveReuseCount: next.positiveReuseCount }
        : {}),
      ...(next.reviewReason ? { reviewReason: next.reviewReason } : {}),
    };
    this.db
      .prepare("UPDATE execution_learning_items SET metadata_json=? WHERE item_id=?")
      .run(JSON.stringify(metadata), use.itemId);
    if (disable || autoPromoted) this.bumpManagement();
    else this.bumpResourceRevision();
  }
  private useValidationScope(useId: string): ExperienceUse["validationScope"] {
    const use = decode<ExperienceUse>(
      this.db.prepare("SELECT record_json FROM experience_uses WHERE use_id=?").get(useId),
    );
    return use?.validationScope ?? "unknown";
  }
  private hasNativeEvidence(candidateId: string): boolean {
    const candidate = decode<TaskExperienceCandidate>(
      this.db
        .prepare("SELECT record_json FROM execution_learning_candidates WHERE candidate_id=?")
        .get(candidateId),
    );
    return candidate?.kind === "task-lesson" && !!candidate.nativeEvidence;
  }
  private positiveTaskExperienceReuseCount(candidate: TaskExperienceCandidate): number {
    const identities = new Set<string>();
    const uses = this.db
      .prepare(
        "SELECT record_json FROM experience_uses WHERE candidate_id=? AND source_kind='reviewed-reference'",
      )
      .all(candidate.candidateId)
      .map((row) => decode<ExperienceUse>(row)!)
      .filter(
        (use) =>
          use.source.kind === "reviewed-reference" &&
          use.source.contentVersion === candidate.contentVersion &&
          use.itemId === candidate.itemId &&
          use.delivery === "carried" &&
          !use.historical &&
          !use.deleted &&
          !use.excluded &&
          use.adoption === "observed" &&
          use.validation === "pass" &&
          ["spreadsheet-range", "native-claim", "command"].includes(use.validationScope),
      );
    for (const use of uses) {
      const effects = this.db
        .prepare("SELECT record_json FROM experience_effects WHERE use_id=?")
        .all(use.useId)
        .map((row) => decode<ExperienceEffect>(row)!);
      if (
        effects.some(
          (effect) =>
            effect.adoption === "observed" &&
            effect.validation === "pass" &&
            ["spreadsheet-range", "native-claim", "command"].includes(effect.validationScope) &&
            !effect.trustedContradiction,
        )
      )
        identities.add(JSON.stringify([use.taskId, use.taskVersion]));
    }
    return identities.size;
  }
  private archive(use: ExperienceUse, now: number): void {
    this.db
      .prepare(
        "UPDATE memory_items SET lifecycle_state='archived',version=version+1,updated_at=MAX(updated_at,?) WHERE item_id=? AND version=?",
      )
      .run(now, use.itemId, use.itemVersion);
    this.bumpManagement();
  }
  async feedbackExperienceUse(input: ExperienceFeedbackInput): Promise<ExperienceUse> {
    identifier(input.workspaceKey);
    identifier(input.useId);
    identifier(input.operationId);
    integer(input.expectedItemVersion, 1);
    integer(input.now);
    if (!["disable", "not_applicable"].includes(input.action))
      throw new Error("Invalid experience feedback action");
    return this.tx(() => {
      const { now: _now, ...request } = input;
      const requestHash = hash(request);
      const receipt = this.db
        .prepare("SELECT * FROM experience_feedback WHERE operation_id=?")
        .get(input.operationId);
      if (receipt) {
        if (
          receipt.request_hash !== requestHash ||
          receipt.workspace_key !== input.workspaceKey ||
          receipt.use_id !== input.useId
        )
          throw new MemoryItemStoreConflictError(
            "operation_reused",
            "Experience feedback operation reused",
          );
        return this.use(input.useId) ?? decode<ExperienceUse>(receipt, "result_json")!;
      }
      const use = this.use(input.useId);
      if (
        !use ||
        use.workspaceKey !== input.workspaceKey ||
        use.deleted ||
        use.itemVersion !== input.expectedItemVersion ||
        !this.sourceCurrent(use, false)
      )
        throw new MemoryItemStoreConflictError(
          "version_conflict",
          "Experience feedback version conflict",
        );
      if (input.action === "not_applicable") {
        for (const row of this.db
          .prepare("SELECT record_json FROM experience_uses WHERE workspace_key=? AND item_id=?")
          .all(use.workspaceKey, use.itemId)) {
          const matching = decode<ExperienceUse>(row)!;
          if (
            matching.taskId === use.taskId &&
            matching.taskVersion === use.taskVersion &&
            !matching.deleted
          )
            this.writeUse({ ...matching, excluded: true, updatedAt: input.now });
        }
      } else if (use.source.kind === "reviewed-reference") this.updateGeneric(use, true, input.now);
      else this.archive(use, input.now);
      const next = this.use(use.useId)!;
      this.db
        .prepare("INSERT INTO experience_feedback VALUES(?,?,?,?,?,?)")
        .run(
          input.operationId,
          input.workspaceKey,
          input.useId,
          requestHash,
          JSON.stringify(next),
          input.now,
        );
      return next;
    });
  }
}

/** Called inside the owning deletion transaction; identities, hashes and receipts survive. */
export function scrubExperienceLedger(
  db: DatabaseSync,
  match: { itemId?: string; candidateId?: string },
  now: number,
): void {
  const uses = db
    .prepare(
      `SELECT record_json FROM experience_uses WHERE ${match.candidateId !== undefined ? "candidate_id=?" : "item_id=?"}`,
    )
    .all(match.candidateId ?? match.itemId!);
  for (const row of uses) {
    const use = decode<ExperienceUse>(row)!;
    const { referenceContent: _referenceContent, ...withoutBody } = use;
    const next: ExperienceUse = { ...withoutBody, deleted: true, sources: [], updatedAt: now };
    db.prepare("UPDATE experience_uses SET record_json=? WHERE use_id=?").run(
      JSON.stringify(next),
      use.useId,
    );
    for (const effectRow of db
      .prepare("SELECT record_json FROM experience_effects WHERE use_id=?")
      .all(use.useId)) {
      const effect = decode<ExperienceEffect>(effectRow)!;
      db.prepare("UPDATE experience_effects SET record_json=? WHERE effect_id=?").run(
        JSON.stringify({ ...effect, reason: "", sources: [], trustedContradiction: false }),
        effect.effectId,
      );
    }
    db.prepare("UPDATE experience_feedback SET result_json=? WHERE use_id=?").run(
      JSON.stringify(next),
      use.useId,
    );
  }
}
function identity(use: ExperienceUse) {
  return {
    useId: use.useId,
    workspaceKey: use.workspaceKey,
    source: use.source,
    itemId: use.itemId,
    itemVersion: use.itemVersion,
    contentHash: use.contentHash,
    taskId: use.taskId,
    taskVersion: use.taskVersion,
    sessionId: use.sessionId,
    runId: use.runId,
    hostRunId: use.hostRunId,
    referenceHash: use.referenceHash,
    recallEventId: use.recallEventId,
    recallSequence: use.recallSequence,
    historical: use.historical,
    managementRevision: use.managementRevision,
    settingsVersion: use.settingsVersion,
    deletionRevision: use.deletionRevision,
  };
}
function identifier(value: string): void {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 512 ||
    /[\u0000-\u001f]/u.test(value)
  )
    throw new Error("Invalid experience identifier");
}
function integer(value: number, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error("Invalid experience integer");
}
function validateUse(use: ExperienceUse): void {
  if (use.hostRunId !== undefined) identifier(use.hostRunId);
  for (const value of [
    use.useId,
    use.workspaceKey,
    use.itemId,
    use.taskId,
    use.sessionId,
    use.runId,
    use.source.candidateId,
  ])
    identifier(value);
  for (const value of [use.itemVersion, use.taskVersion, use.settingsVersion]) integer(value, 1);
  for (const value of [use.managementRevision, use.deletionRevision, use.createdAt, use.updatedAt])
    integer(value);
  if (use.source.kind === "reviewed-reference") integer(use.source.contentVersion, 1);
  else if (use.source.kind === "execution-validated") {
    integer(use.source.claimRevision, 1);
    if (
      !/^[a-f0-9]{64}$/u.test(use.source.claimHash) ||
      !/^[a-f0-9]{64}$/u.test(use.source.scopeHash)
    )
      throw new Error("Invalid experience source hash");
  } else if (use.source.kind === "execution-evidence") {
    integer(use.source.candidateVersion, 1);
    if (use.source.contentHash !== use.contentHash)
      throw new Error("Invalid experience source hash");
  } else throw new Error("Invalid experience source kind");
  if (
    !/^[a-f0-9]{64}$/u.test(use.contentHash) ||
    !/^[a-f0-9]{64}$/u.test(use.referenceHash) ||
    use.excluded ||
    use.deleted ||
    use.sources.length ||
    use.adoption !== "unknown" ||
    use.validation !== "unknown" ||
    use.validationScope !== "unknown" ||
    (use.historical ? use.delivery !== "unknown" : use.delivery !== "pending") ||
    (!use.historical &&
      (!use.recallEventId ||
        !Number.isSafeInteger(use.recallSequence) ||
        use.recallSequence! < 1)) ||
    (use.referenceContent !== undefined &&
      (!use.referenceContent.trim() || use.referenceContent.length > 8000)) ||
    (!use.historical &&
      use.referenceContent !== undefined &&
      createHash("sha256").update(use.referenceContent).digest("hex") !== use.referenceHash) ||
    use.deliverySequence !== undefined ||
    use.providerCallId !== undefined ||
    use.physicalAttemptId !== undefined
  )
    throw new Error("Invalid initial experience use");
}
function validateEffect(effect: ExperienceEffect): void {
  for (const value of [
    effect.effectId,
    effect.useId,
    effect.preparedEventId,
    effect.outcomeEventId,
  ])
    identifier(value);
  integer(effect.preparedSequence, 1);
  integer(effect.outcomeSequence, 1);
  integer(effect.createdAt);
  if (
    !["unknown", "observed", "not_applied"].includes(effect.adoption) ||
    !["unknown", "pass", "fail", "stale"].includes(effect.validation) ||
    !["unknown", "native-claim", "spreadsheet-range", "command"].includes(effect.validationScope) ||
    typeof effect.reason !== "string" ||
    effect.reason.length > 8000 ||
    (["pass", "fail"].includes(effect.validation) &&
      (effect.adoption !== "observed" || !effect.sources.length))
  )
    throw new Error("Invalid experience effect");
}

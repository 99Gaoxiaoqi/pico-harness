import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  projectDeepResearchEvents,
  normalizeDeepResearchObjective,
  type DeepResearchRun,
  type DeepResearchEvent,
  type DeepResearchArtifactRef,
  type DeepResearchScopeLevel,
  type DeepResearchChecklistItem,
  type DeepResearchStep,
  type DeepResearchCheckpoint,
  type DeepResearchHandoff,
} from "@pico/core/deep-research";
import { withWorkspaceSqliteLease } from "./workspace-scopes.js";

export interface DeepResearchCommandContext {
  toolCallId?: string;
  idempotencyKey?: string;
}
export interface SaveDeepResearchArtifact extends Omit<
  DeepResearchArtifactRef,
  "artifactId" | "createdAt" | "contentHash"
> {
  content: string;
}
const hash = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

/** Research ledger and previewable artifacts commit atomically in the canonical workspace DB. */
export class SqliteDeepResearchStore {
  constructor(private readonly options: { storageRoot: string }) {}

  readEvents(sessionId: string): DeepResearchEvent[] {
    return withWorkspaceSqliteLease(this.options.storageRoot, ({ database }) =>
      this.events(database, sessionId),
    );
  }
  read(sessionId: string): DeepResearchRun | undefined {
    const projection = projectDeepResearchEvents(this.readEvents(sessionId));
    if (projection.diagnostics.length) throw new Error(projection.diagnostics.join("; "));
    return projection.run;
  }
  start(
    sessionId: string,
    objective: string,
    scopeLevel: DeepResearchScopeLevel = "standard",
    context?: DeepResearchCommandContext,
  ): DeepResearchRun {
    const normalized = normalizeDeepResearchObjective(objective);
    if (!normalized)
      throw new Error("Research objective must be nonempty and at most 2000 characters");
    return this.mutate(
      sessionId,
      "start",
      { objective: normalized, scopeLevel },
      context,
      (base, run) => {
        if (run) {
          if (run.objective !== normalized || run.scopeLevel !== scopeLevel)
            throw new Error("Research already started with a different objective or scope");
          return undefined;
        }
        return { ...base, type: "research_started", objective: normalized, scopeLevel };
      },
    );
  }
  saveArtifact(
    sessionId: string,
    input: SaveDeepResearchArtifact,
    context?: DeepResearchCommandContext,
  ): DeepResearchRun {
    if (
      typeof input.content !== "string" ||
      !input.content.trim() ||
      Array.from(input.content).length > 512 * 1024
    )
      throw new Error("Artifact content must be nonempty and at most 512k characters");
    return this.mutate(
      sessionId,
      "artifact",
      input,
      context,
      (base) => {
        const { content, ...metadata } = input;
        return {
          ...base,
          type: "research_artifact_recorded",
          artifact: {
            ...metadata,
            artifactId: randomUUID(),
            createdAt: base.ts,
            contentHash: `sha256:${hash(content)}`,
          },
        };
      },
      input.content,
    );
  }
  updateChecklist(
    sessionId: string,
    item: Omit<DeepResearchChecklistItem, "title" | "updatedAt">,
    context?: DeepResearchCommandContext,
  ): DeepResearchRun {
    return this.mutate(sessionId, "checklist", item, context, (base, run) => {
      const previous = run?.checklist.find((entry) => entry.itemId === item.itemId);
      if (!previous) throw new Error("Unknown research checklist item");
      if (item.status === "skipped" && !item.blockedReason?.trim())
        throw new Error("Skipped checklist item requires an explicit reason");
      return {
        ...base,
        type: "research_checklist_updated",
        item: { ...item, title: previous.title, updatedAt: base.ts },
      };
    });
  }
  recordStep(
    sessionId: string,
    step: Omit<DeepResearchStep, "stepId" | "createdAt">,
    context?: DeepResearchCommandContext,
  ): DeepResearchRun {
    return this.mutate(sessionId, "step", step, context, (base) => ({
      ...base,
      type: "research_step_recorded",
      step: { ...step, stepId: randomUUID(), createdAt: base.ts },
    }));
  }
  recordCheckpoint(
    sessionId: string,
    checkpoint: Omit<DeepResearchCheckpoint, "checkpointId" | "createdAt">,
    context?: DeepResearchCommandContext,
  ): DeepResearchRun {
    return this.mutate(sessionId, "checkpoint", checkpoint, context, (base) => ({
      ...base,
      type: "research_checkpoint_recorded",
      checkpoint: { ...checkpoint, checkpointId: randomUUID(), createdAt: base.ts },
    }));
  }
  complete(
    sessionId: string,
    reportArtifactId: string,
    handoff: DeepResearchHandoff,
    context?: DeepResearchCommandContext,
  ): DeepResearchRun {
    if (handoff.recommendedIssues.length + handoff.recommendedPullRequests.length === 0)
      throw new Error("Handoff requires at least one recommended issue or pull request");
    return this.mutate(sessionId, "complete", { reportArtifactId, handoff }, context, (base) => ({
      ...base,
      type: "research_completed",
      reportArtifactId,
      handoff,
    }));
  }
  readArtifact(
    sessionId: string,
    artifactId: string,
    offset = 0,
    limit = 32000,
  ): { content: string; offset: number; nextOffset?: number; totalCharacters: number } {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 64000
    )
      throw new Error("Read offset must be nonnegative; limit must be 1..64000");
    return withWorkspaceSqliteLease(this.options.storageRoot, ({ database }) => {
      const run = projectDeepResearchEvents(this.events(database, sessionId)).run;
      if (!run?.artifacts.some((artifact) => artifact.artifactId === artifactId))
        throw new Error("Research artifact does not belong to this session");
      const row = database
        .prepare(
          "SELECT b.content FROM session_artifacts a JOIN artifact_blobs b ON a.digest = b.digest WHERE a.session_id = ? AND a.artifact_id = ?",
        )
        .get(sessionId, artifactId) as { content: Uint8Array } | undefined;
      if (!row) throw new Error("Research artifact content is missing");
      const characters = Array.from(Buffer.from(row.content).toString("utf8"));
      const end = Math.min(characters.length, offset + limit);
      return {
        content: characters.slice(offset, end).join(""),
        offset,
        totalCharacters: characters.length,
        ...(end < characters.length ? { nextOffset: end } : {}),
      };
    });
  }
  private events(database: DatabaseSync, sessionId: string): DeepResearchEvent[] {
    return (
      database
        .prepare(
          "SELECT event_json FROM deep_research_events WHERE session_id = ? ORDER BY sequence",
        )
        .all(sessionId) as { event_json: string }[]
    ).map((row) => JSON.parse(row.event_json) as DeepResearchEvent);
  }
  private mutate(
    sessionId: string,
    kind: string,
    request: unknown,
    context: DeepResearchCommandContext | undefined,
    make: (
      base: { eventId: string; sessionId: string; ts: number },
      run?: DeepResearchRun,
    ) => DeepResearchEvent | undefined,
    content?: string,
  ): DeepResearchRun {
    return withWorkspaceSqliteLease(this.options.storageRoot, (lease) =>
      lease.transaction("write", () => {
        const database = lease.database;
        const session = database
          .prepare("SELECT archived_at FROM sessions WHERE session_id = ?")
          .get(sessionId) as { archived_at: number | null } | undefined;
        if (!session || session.archived_at !== null)
          throw new Error("Research requires an existing, unarchived session");
        const key = context?.idempotencyKey ?? context?.toolCallId ?? randomUUID();
        const fingerprint = hash(JSON.stringify({ kind, request }));
        const replay = database
          .prepare(
            "SELECT request_hash FROM deep_research_events WHERE session_id = ? AND command_key = ?",
          )
          .get(sessionId, key) as { request_hash: string } | undefined;
        const events = this.events(database, sessionId);
        const current = projectDeepResearchEvents(events);
        if (current.diagnostics.length) throw new Error(current.diagnostics.join("; "));
        if (replay) {
          if (replay.request_hash !== fingerprint)
            throw new Error("Idempotency key was used for a different research command");
          return current.run!;
        }
        const event = make({ eventId: randomUUID(), sessionId, ts: Date.now() }, current.run);
        if (!event) return current.run!;
        const projected = projectDeepResearchEvents([...events, event]);
        if (projected.diagnostics.length || !projected.run)
          throw new Error(projected.diagnostics.join("; ") || "Research must be started first");
        if (event.type === "research_completed") {
          for (const artifact of projected.run.artifacts) {
            const row = database
              .prepare(
                "SELECT digest FROM session_artifacts WHERE session_id = ? AND artifact_id = ?",
              )
              .get(sessionId, artifact.artifactId) as { digest: string } | undefined;
            if (!row || `sha256:${row.digest}` !== artifact.contentHash)
              throw new Error(
                "Research completion requires all saved artifacts to remain available",
              );
          }
        }
        if (event.type === "research_artifact_recorded") {
          if (content === undefined) throw new Error("Missing artifact body");
          const bytes = Buffer.from(content);
          const digest = hash(bytes);
          const artifact = event.artifact;
          database
            .prepare(
              "INSERT OR IGNORE INTO artifact_blobs (digest,size_bytes,content,created_at) VALUES (?,?,?,?)",
            )
            .run(digest, bytes.length, bytes, event.ts);
          database
            .prepare(
              "INSERT INTO session_artifacts (artifact_id,session_id,title,mime_type,digest,size_bytes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
            )
            .run(
              artifact.artifactId,
              sessionId,
              artifact.name,
              "text/markdown",
              digest,
              bytes.length,
              event.ts,
              event.ts,
            );
          database
            .prepare(
              "INSERT INTO session_artifact_ledgers (session_id,revision,updated_at) VALUES (?,1,?) ON CONFLICT(session_id) DO UPDATE SET revision=revision+1,updated_at=excluded.updated_at",
            )
            .run(sessionId, event.ts);
        }
        database
          .prepare(
            "INSERT INTO deep_research_events (session_id,sequence,command_key,request_hash,event_json) VALUES (?,?,?,?,?)",
          )
          .run(sessionId, events.length + 1, key, fingerprint, JSON.stringify(event));
        return projected.run;
      }),
    );
  }
}

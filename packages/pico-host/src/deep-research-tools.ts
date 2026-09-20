import { Ajv } from "ajv";
import type { ToolDefinition } from "@pico/core";
import {
  DEEP_RESEARCH_ARTIFACT_ROLES,
  DEEP_RESEARCH_CHECKLIST_STATUSES,
  DEEP_RESEARCH_REPORT_SECTION_KEYS,
  DEEP_RESEARCH_SCOPE_LEVELS,
  projectDeepResearchProgress,
  type DeepResearchRun,
  type DeepResearchScopeLevel,
  type DeepResearchChecklistItem,
  type DeepResearchStep,
  type DeepResearchCheckpoint,
  type DeepResearchHandoff,
} from "@pico/core/deep-research";
import { SqliteDeepResearchStore, type SaveDeepResearchArtifact } from "@pico/storage";
import { NO_FILE_SIDE_EFFECTS, type BaseTool } from "./tool-registry-contract.js";

export interface DeepResearchToolOptions {
  sessionId: string;
  storageRoot: string;
  onChanged?: (run: DeepResearchRun) => void;
}
const text = { type: "string", minLength: 1, maxLength: 4000 };
const ids = { type: "array", maxItems: 100, uniqueItems: true, items: { ...text, maxLength: 128 } };
const texts = { type: "array", maxItems: 50, items: text };
const enumeration = (values: readonly string[]) => ({ type: "string", enum: values });
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const schemas = {
  start: object(
    {
      objective: { ...text, maxLength: 2000 },
      scope_level: enumeration(DEEP_RESEARCH_SCOPE_LEVELS),
    },
    ["objective"],
  ),
  save_artifact: object(
    {
      role: enumeration(DEEP_RESEARCH_ARTIFACT_ROLES),
      name: { ...text, maxLength: 240 },
      content: { type: "string", minLength: 1, maxLength: 524288 },
      summary: text,
      locator: text,
      source_artifact_ids: ids,
      report_section_key: enumeration(DEEP_RESEARCH_REPORT_SECTION_KEYS),
      report_section_status: enumeration(["drafted", "completed"]),
    },
    ["role", "name", "content"],
  ),
  read_artifact: object(
    {
      artifact_id: text,
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 64000 },
    },
    ["artifact_id"],
  ),
  update_checklist: object(
    {
      item_id: text,
      status: enumeration(DEEP_RESEARCH_CHECKLIST_STATUSES),
      evidence_artifact_ids: ids,
      blocked_reason: text,
    },
    ["item_id", "status"],
  ),
  record_step: object(
    {
      kind: enumeration(["local_exploration", "web_research"]),
      status: enumeration(["completed", "blocked", "stopped"]),
      objective: text,
      summary: text,
      roots: texts,
      keywords: texts,
      ignored_paths: texts,
      stopping_condition: text,
      expected_evidence: text,
      evidence_artifact_ids: ids,
      inspected_refs: {
        type: "array",
        maxItems: 200,
        items: object(
          {
            kind: enumeration(["file", "symbol", "config", "test", "runtime", "url"]),
            locator: text,
            label: text,
            source_artifact_id: text,
          },
          ["kind", "locator"],
        ),
      },
      worker_run_ids: ids,
      blocked_reason: text,
    },
    ["kind", "status", "objective", "summary", "stopping_condition", "expected_evidence"],
  ),
  checkpoint: object(
    {
      round: { type: "integer", minimum: 1 },
      stage: enumeration(["knowledge_base", "report_writing"]),
      status: enumeration(["active", "blocked"]),
      summary: text,
      open_questions: texts,
      next_steps: texts,
      task_ids: ids,
      artifact_ids: ids,
    },
    ["round", "stage", "summary"],
  ),
  status: object({
    artifact_offset: { type: "integer", minimum: 0 },
    artifact_limit: { type: "integer", minimum: 1, maximum: 50 },
  }),
  complete: object(
    {
      report_artifact_id: text,
      handoff_artifact_id: text,
      implementation_tasks: { ...texts, minItems: 1 },
      recommended_issues: texts,
      recommended_pull_requests: texts,
      verification_commands: { ...texts, minItems: 1 },
    },
    ["report_artifact_id", "handoff_artifact_id", "implementation_tasks", "verification_commands"],
  ),
};
const descriptions: Record<keyof typeof schemas, string> = {
  start:
    "Start the current session’s durable read-only research. Repeating the same objective resumes it.",
  save_artifact:
    "Archive a source or derived research document into the owned workspace. Sources require locator; every derived artifact must cite source_artifact_ids. Report sections require key and status.",
  read_artifact:
    "Read a bounded Unicode character slice of an artifact belonging to this research session. Resume with nextOffset.",
  update_checklist:
    "Update one of project_entrypoints, core_flow, boundaries, verification_evidence. Completed requires evidence; blocked/skipped requires blocked_reason.",
  record_step:
    "Record a bounded exploration or web-research substep with scope, stopping condition, inspected references and durable evidence.",
  checkpoint:
    "Persist a research round with resume artifacts, open questions, next steps and existing task references.",
  status:
    "Read durable research progress after interruption or restart. To recover older artifact IDs, pass artifact_offset=0 and optional artifact_limit (1..50); follow artifactPage.nextOffset until absent. Pagination returns a bounded artifact index with complete source IDs instead of progress. Read bodies with read_artifact.",
  complete:
    "Complete research only after four checklist items settle and all five sections are completed. Requires saved report and handoff plus actionable tasks, at least one recommended issue or pull request, and verification commands.",
};
function camelize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
        camelize(item),
      ]),
    );
  return value;
}

export function createDeepResearchTools(options: DeepResearchToolOptions): readonly BaseTool[] {
  const store = new SqliteDeepResearchStore(options);
  const ajv = new Ajv({ allErrors: true });
  return (Object.keys(schemas) as (keyof typeof schemas)[]).map((operation): BaseTool => {
    const schema = schemas[operation];
    const validate = ajv.compile(schema);
    return {
      name: () => `deep_research_${operation}`,
      definition: (): ToolDefinition => ({
        name: `deep_research_${operation}`,
        description: descriptions[operation],
        inputSchema: schema,
      }),
      readOnly: operation === "status" || operation === "read_artifact",
      permissionCategory: "read",
      // Mutations synchronously commit one SQLite transaction before yielding; independent calls may share a step.
      executionSemantics: "parallel",
      toolset: "deep-research",
      fileSideEffects: NO_FILE_SIDE_EFFECTS,
      execute: async (raw, context) => {
        const parsed: unknown = JSON.parse(raw);
        if (!validate(parsed))
          throw new Error(`Invalid research arguments: ${ajv.errorsText(validate.errors)}`);
        const args = camelize(parsed) as Record<string, unknown>;
        const sessionId = options.sessionId;
        const command = context?.toolCallId ? { toolCallId: context.toolCallId } : undefined;
        let run: DeepResearchRun;
        switch (operation) {
          case "status": {
            const current = store.read(sessionId);
            if (args["artifactOffset"] !== undefined || args["artifactLimit"] !== undefined) {
              const offset = (args["artifactOffset"] as number | undefined) ?? 0;
              const limit = (args["artifactLimit"] as number | undefined) ?? 20;
              const candidates = current?.artifacts ?? [];
              // Full source IDs are needed to recover evidence relationships. Large summaries
              // belong to the artifact body; the index deliberately excludes them.
              const artifacts: Array<
                Pick<
                  DeepResearchRun["artifacts"][number],
                  | "artifactId"
                  | "role"
                  | "name"
                  | "createdAt"
                  | "sourceArtifactIds"
                  | "reportSectionKey"
                  | "reportSectionStatus"
                >
              > = [];
              let bytes = 0;
              for (const artifact of candidates.slice(offset, offset + limit)) {
                const entry = {
                  artifactId: artifact.artifactId,
                  role: artifact.role,
                  name: artifact.name,
                  createdAt: artifact.createdAt,
                  sourceArtifactIds: artifact.sourceArtifactIds,
                  ...(artifact.reportSectionKey
                    ? { reportSectionKey: artifact.reportSectionKey }
                    : {}),
                  ...(artifact.reportSectionStatus
                    ? { reportSectionStatus: artifact.reportSectionStatus }
                    : {}),
                };
                const entryBytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
                if (bytes + entryBytes > 32 * 1024) break;
                artifacts.push(entry);
                bytes += entryBytes;
              }
              const end = offset + artifacts.length;
              return JSON.stringify({
                artifactPage: {
                  artifacts,
                  offset,
                  totalArtifacts: candidates.length,
                  ...(end < candidates.length ? { nextOffset: end } : {}),
                },
              });
            }
            return JSON.stringify({ run: current ? projectDeepResearchProgress(current) : null });
          }
          case "read_artifact":
            return JSON.stringify(
              store.readArtifact(
                sessionId,
                args["artifactId"] as string,
                args["offset"] as number | undefined,
                args["limit"] as number | undefined,
              ),
            );
          case "start":
            run = store.start(
              sessionId,
              args["objective"] as string,
              (args["scopeLevel"] as DeepResearchScopeLevel | undefined) ?? "standard",
              command,
            );
            break;
          case "save_artifact":
            run = store.saveArtifact(
              sessionId,
              { sourceArtifactIds: [], ...args } as unknown as SaveDeepResearchArtifact,
              command,
            );
            break;
          case "update_checklist":
            run = store.updateChecklist(
              sessionId,
              { evidenceArtifactIds: [], ...args } as unknown as Omit<
                DeepResearchChecklistItem,
                "title" | "updatedAt"
              >,
              command,
            );
            break;
          case "record_step":
            run = store.recordStep(
              sessionId,
              {
                roots: [],
                keywords: [],
                ignoredPaths: [],
                evidenceArtifactIds: [],
                inspectedRefs: [],
                workerRunIds: [],
                ...args,
              } as unknown as Omit<DeepResearchStep, "stepId" | "createdAt">,
              command,
            );
            break;
          case "checkpoint":
            run = store.recordCheckpoint(
              sessionId,
              {
                status: "active",
                openQuestions: [],
                nextSteps: [],
                taskIds: [],
                artifactIds: [],
                ...args,
              } as unknown as Omit<DeepResearchCheckpoint, "checkpointId" | "createdAt">,
              command,
            );
            break;
          case "complete":
            run = store.complete(
              sessionId,
              args["reportArtifactId"] as string,
              {
                artifactId: args["handoffArtifactId"],
                implementationTasks: args["implementationTasks"],
                recommendedIssues: args["recommendedIssues"] ?? [],
                recommendedPullRequests: args["recommendedPullRequests"] ?? [],
                verificationCommands: args["verificationCommands"],
              } as DeepResearchHandoff,
              command,
            );
            break;
        }
        // Commit has succeeded; observers must not turn a durable mutation into a failed call.
        try {
          options.onChanged?.(run);
        } catch {
          /* observer is best effort */
        }
        return JSON.stringify({ run: projectDeepResearchProgress(run) });
      },
    };
  });
}

export const DEEP_RESEARCH_TOOL_NAMES = Object.keys(schemas).map((name) => `deep_research_${name}`);
export function isDeepResearchToolAllowed(name: string): boolean {
  return DEEP_RESEARCH_TOOL_NAMES.includes(name);
}

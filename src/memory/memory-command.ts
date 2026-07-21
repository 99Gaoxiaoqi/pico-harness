import { createHash } from "node:crypto";
import type { SlashCommand } from "../input/types.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import { WorkspaceTrustStore } from "../security/workspace-trust.js";
import { MemoryRepository } from "./memory-repository.js";
import { evaluateMemoryReviewBudgetForJobs } from "./memory-review-policy.js";
import { sanitizeMemoryProposalCandidate } from "./proposal-sanitizer.js";

export interface MemoryCommandOptions {
  readonly workDir: string;
  readonly picoHome?: string;
  readonly trustStore?: WorkspaceTrustStore;
}

interface UndoPayload {
  readonly factId: string;
  readonly version: number;
}

export function createMemoryCommand(options: MemoryCommandOptions): SlashCommand {
  return {
    name: "memory",
    description: "Remember a workspace fact or control workspace memory",
    usage: "/memory remember <text>|status|off|on",
    argumentHint: "remember <text>|status|off|on",
    category: "workspace",
    kind: "local",
    availability: "idle",
    execute: async (input) => {
      try {
        const repository = await openTrustedRepository(options);
        try {
          const [operation, ...rest] = input.argv;
          switch (operation?.toLowerCase()) {
            case "remember":
              return remember(repository, rest.join(" "));
            case "status":
              return status(repository);
            case "off":
              return setEnabled(repository, false);
            case "on":
              return setEnabled(repository, true);
            case "undo":
              return undo(repository, rest[0]);
            default:
              return message("Usage: /memory remember <text>|status|off|on");
          }
        } finally {
          repository.close();
        }
      } catch (error) {
        return message(
          `Memory unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

function remember(repository: MemoryRepository, raw: string) {
  const text = raw.normalize("NFKC").replaceAll(/\s+/gu, " ").trim();
  if (!text) return message("Usage: /memory remember <text>");
  const sanitized = sanitizeMemoryProposalCandidate({
    kind: "project_fact",
    title: memoryTitle(text),
    content: text,
    reason: "User explicitly requested direct workspace memory storage.",
    confidence: 1,
    evidenceEventIds: ["manual-memory-command"],
  });
  if (sanitized.disposition !== "allow") {
    return message(
      `Memory rejected by the safety scan: ${sanitized.safetyCodes.join(", ") || "unsafe content"}`,
    );
  }
  const digest = createHash("sha256").update(text).digest("hex");
  let fact = repository.createFact({
    factId: `manual-fact:${digest}`,
    kind: sanitized.kind,
    title: sanitized.title,
    content: sanitized.content,
    confidence: sanitized.confidence,
    state: "active",
    idempotencyKey: `memory-remember:${digest}`,
  });
  if (fact.state !== "active") {
    fact = repository.updateFact({
      factId: fact.factId,
      expectedVersion: fact.version,
      state: "active",
      idempotencyKey: `memory-remember-reactivate:${fact.factId}:${fact.version}`,
    });
  }
  const token = encodeUndo({ factId: fact.factId, version: fact.version });
  return message(`Remembered workspace fact ${fact.factId}. Undo: /memory undo ${token}`);
}

function status(repository: MemoryRepository) {
  const settings = repository.getSettings();
  const reviewBudget = evaluateMemoryReviewBudgetForJobs(
    settings.reviewMode,
    repository.listJobs({
      type: "terminal-extraction",
      statuses: ["succeeded", "failed", "cancelled"],
      withModelUsage: true,
      limit: 500,
    }),
  );
  const activeFacts = repository.listFacts({ states: ["active"], limit: 500 }).length;
  const pendingProposals = repository.listProposals({ statuses: ["pending"], limit: 500 }).length;
  const pendingJobs = repository.listJobs({
    statuses: ["queued", "running", "failed"],
    limit: 500,
  }).length;
  return message(
    [
      `Memory: ${settings.enabled ? "on" : "off"}`,
      `Injection: ${settings.injectionEnabled ? "on" : "off"}`,
      `Review mode: ${settings.reviewMode}`,
      reviewBudget.reason === "eco-mode"
        ? "Review budget (rolling 24h): Eco mode guarantees zero model review calls."
        : `Review budget (rolling 24h): ${reviewBudget.allowed ? "available" : "exhausted"}`,
      `Review usage: ${reviewBudget.usage.calls}/${reviewBudget.budget.maxCalls} calls, ${reviewBudget.usage.inputTokens}/${reviewBudget.budget.maxInputTokens} input tokens, ${reviewBudget.usage.outputTokens}/${reviewBudget.budget.maxOutputTokens} output tokens, $${reviewBudget.usage.costUsd.toFixed(4)}/$${reviewBudget.budget.maxCostUsd.toFixed(4)}`,
      ...(reviewBudget.nextRecoveryAt
        ? [`Review budget recovers at: ${reviewBudget.nextRecoveryAt}`]
        : []),
      `Active facts: ${activeFacts}`,
      `Pending proposals: ${pendingProposals}`,
      `Review jobs: ${pendingJobs}`,
    ].join("\n"),
  );
}

function setEnabled(repository: MemoryRepository, enabled: boolean) {
  const current = repository.getSettings();
  if (current.enabled === enabled && current.injectionEnabled === enabled) {
    return message(`Memory is already ${enabled ? "on" : "off"}.`);
  }
  const updated = repository.updateSettings({
    expectedVersion: current.version,
    enabled,
    injectionEnabled: enabled,
    idempotencyKey: `memory-toggle:${enabled ? "on" : "off"}:${current.version}`,
  });
  return message(
    enabled
      ? updated.autoPropose
        ? "Memory enabled; controlled recall and post-run proposal review are active."
        : "Memory enabled; controlled recall is active, while post-run proposal review remains off."
      : "Memory disabled; recall injection and post-run proposal extraction are off.",
  );
}

function undo(repository: MemoryRepository, encoded: string | undefined) {
  if (!encoded) return message("Usage: /memory undo <token>");
  const payload = decodeUndo(encoded);
  const fact = repository.getFact(payload.factId);
  if (!fact) return message(`Undo unavailable: unknown fact ${payload.factId}.`);
  if (fact.version !== payload.version || fact.state !== "active") {
    return message("Undo unavailable: the fact changed after this undo token was issued.");
  }
  const updated = repository.updateFact({
    factId: fact.factId,
    expectedVersion: payload.version,
    state: "disabled",
    idempotencyKey: `memory-undo:${fact.factId}:${payload.version}`,
  });
  return message(`Undone: workspace fact ${updated.factId} is disabled.`);
}

async function openTrustedRepository(options: MemoryCommandOptions): Promise<MemoryRepository> {
  const trustStore =
    options.trustStore ?? new WorkspaceTrustStore({ userStateDirectory: options.picoHome });
  const canonical = await trustStore.canonicalize(options.workDir);
  if (!(await trustStore.isTrusted(canonical))) {
    throw new Error(`workspace is not trusted: ${canonical}`);
  }
  const paths = resolvePicoPaths(canonical, { picoHome: options.picoHome });
  return new MemoryRepository({
    databasePath: paths.workspace.memoryDatabase,
    workspaceId: paths.workspace.id,
  });
}

function memoryTitle(text: string): string {
  return text.length <= 80 ? text : `${text.slice(0, 77)}...`;
}

function encodeUndo(payload: UndoPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeUndo(value: string): UndoPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("invalid memory undo token");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof Reflect.get(parsed, "factId") !== "string" ||
    !Number.isSafeInteger(Reflect.get(parsed, "version")) ||
    Number(Reflect.get(parsed, "version")) <= 0
  ) {
    throw new Error("invalid memory undo token");
  }
  return {
    factId: String(Reflect.get(parsed, "factId")),
    version: Number(Reflect.get(parsed, "version")),
  };
}

function message(text: string) {
  return { type: "local" as const, action: "message" as const, message: text };
}

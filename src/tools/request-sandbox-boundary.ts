import {
  MAX_SANDBOX_BOUNDARY_FILESYSTEM_ENTRIES,
  MAX_SANDBOX_BOUNDARY_PATH_CHARS,
  validateSandboxBoundaryExpansion,
  type SandboxBoundaryExpansion,
} from "../safety/permission-profile.js";
import type { ToolDefinition } from "../schema/message.js";
import { ToolAccesses } from "./tool-access.js";
import { NO_FILE_SIDE_EFFECTS, type BaseTool, type ToolExecutionContext } from "./registry.js";

export const MAX_SANDBOX_BOUNDARY_JUSTIFICATION_CHARS = 4_096;

export type RequestSandboxBoundaryStatus = "applied" | "noop" | "denied" | "conflict";

/** Stable host settlement returned to the model after the boundary request finishes. */
export interface RequestSandboxBoundarySettlement {
  readonly status: RequestSandboxBoundaryStatus;
  readonly requestId?: string;
  readonly boundaryRevision?: number;
  readonly reason?: string;
}

export type RequestSandboxBoundaryHandler = (
  expansion: SandboxBoundaryExpansion,
  justification: string,
  context: ToolExecutionContext | undefined,
) => Promise<RequestSandboxBoundarySettlement>;

interface RequestSandboxBoundaryInput {
  readonly expansion: SandboxBoundaryExpansion;
  readonly justification: string;
}

/**
 * Requests a host-owned expansion of the current managed execution boundary.
 *
 * The tool owns no permission state. A trusted host must inject the complete
 * request/approval/apply transaction and return its terminal settlement.
 */
export class RequestSandboxBoundaryTool implements BaseTool {
  readonly readOnly = false;
  readonly permissionCategory = "bounded_control" as const;
  readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;
  readonly nesting = "direct_only" as const;
  readonly executionSemantics = "exclusive_step" as const;
  readonly recoveryMode = "never_auto_retry" as const;

  constructor(private readonly handler?: RequestSandboxBoundaryHandler) {}

  name(): string {
    return "request_sandbox_boundary";
  }

  definition(): ToolDefinition {
    return {
      name: this.name(),
      description: [
        "Request an explicit expansion of the current managed sandbox boundary.",
        "Use this only when the current task cannot proceed within the existing filesystem or network boundary.",
        "Send this tool alone in its assistant Step and explain why the requested access is necessary.",
        "A denied or conflicting request does not grant access; do not assume approval until status is applied or noop.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          expansion: {
            type: "object",
            properties: {
              filesystem: {
                type: "object",
                properties: {
                  entries: {
                    type: "array",
                    minItems: 1,
                    maxItems: MAX_SANDBOX_BOUNDARY_FILESYSTEM_ENTRIES,
                    items: {
                      type: "object",
                      properties: {
                        path: {
                          type: "string",
                          minLength: 1,
                          maxLength: MAX_SANDBOX_BOUNDARY_PATH_CHARS,
                        },
                        access: { type: "string", enum: ["read", "write"] },
                        scope: { type: "string", enum: ["exact", "subtree"] },
                      },
                      required: ["path", "access", "scope"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["entries"],
                additionalProperties: false,
              },
              network: {
                type: "object",
                properties: { enabled: { type: "boolean", const: true } },
                required: ["enabled"],
                additionalProperties: false,
              },
            },
            anyOf: [{ required: ["filesystem"] }, { required: ["network"] }],
            additionalProperties: false,
          },
          justification: {
            type: "string",
            minLength: 1,
            maxLength: MAX_SANDBOX_BOUNDARY_JUSTIFICATION_CHARS,
            pattern: "\\S",
          },
        },
        required: ["expansion", "justification"],
        additionalProperties: false,
      },
    };
  }

  accesses(): ToolAccesses {
    return ToolAccesses.all();
  }

  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    context?.signal?.throwIfAborted();
    const input = parseRequestSandboxBoundaryInput(args);
    if (!this.handler) {
      throw new Error(
        "request_sandbox_boundary is unavailable: the host did not provide a handler.",
      );
    }
    const settlement = await this.handler(input.expansion, input.justification, context);
    return JSON.stringify(normalizeSettlement(settlement));
  }
}

function parseRequestSandboxBoundaryInput(args: string): RequestSandboxBoundaryInput {
  let value: unknown;
  try {
    value = JSON.parse(args);
  } catch {
    throw new Error("request_sandbox_boundary arguments must be a JSON object.");
  }
  if (!isRecord(value) || hasUnexpectedKeys(value, ["expansion", "justification"])) {
    throw new Error(
      "request_sandbox_boundary arguments must contain only expansion and justification.",
    );
  }

  const justification = value["justification"];
  if (typeof justification !== "string" || justification.trim() === "") {
    throw new Error("request_sandbox_boundary justification must be a non-empty string.");
  }
  const normalizedJustification = justification.trim();
  if (normalizedJustification.length > MAX_SANDBOX_BOUNDARY_JUSTIFICATION_CHARS) {
    throw new Error(
      `request_sandbox_boundary justification must not exceed ${MAX_SANDBOX_BOUNDARY_JUSTIFICATION_CHARS} characters.`,
    );
  }

  const validation = validateSandboxBoundaryExpansion(value["expansion"]);
  if (!validation.ok) {
    throw new Error(
      `request_sandbox_boundary expansion is invalid (${validation.reason}): ${validation.message}`,
    );
  }
  return { expansion: validation.expansion, justification: normalizedJustification };
}

function normalizeSettlement(input: unknown): RequestSandboxBoundarySettlement {
  if (
    !isRecord(input) ||
    hasUnexpectedKeys(input, ["status", "requestId", "boundaryRevision", "reason"])
  ) {
    throw new Error("request_sandbox_boundary handler returned an invalid settlement.");
  }
  const status = input["status"];
  if (status !== "applied" && status !== "noop" && status !== "denied" && status !== "conflict") {
    throw new Error("request_sandbox_boundary handler returned an invalid settlement status.");
  }
  const requestId = optionalNonEmptyString(input["requestId"], "requestId");
  const reason = optionalNonEmptyString(input["reason"], "reason");
  const boundaryRevision = input["boundaryRevision"];
  if (
    boundaryRevision !== undefined &&
    (!Number.isSafeInteger(boundaryRevision) || (boundaryRevision as number) < 0)
  ) {
    throw new Error("request_sandbox_boundary handler returned an invalid boundaryRevision.");
  }
  return {
    status,
    ...(requestId === undefined ? {} : { requestId }),
    ...(boundaryRevision === undefined ? {} : { boundaryRevision: boundaryRevision as number }),
    ...(reason === undefined ? {} : { reason }),
  };
}

function optionalNonEmptyString(input: unknown, field: string): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error(`request_sandbox_boundary handler returned an invalid ${field}.`);
  }
  return input.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasUnexpectedKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(record).some((key) => !allowedKeys.has(key));
}

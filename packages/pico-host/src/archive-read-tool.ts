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

// Adapted to Pico's BaseTool and session-bound inline RuntimeEvent archive.
import type { ToolDefinition } from "@pico/core";
import type { BoundToolResultArchiveReader } from "@pico/runtime/tool-result-archive";
import {
  readToolResultArchiveResource,
  TOOL_RESULT_ARCHIVE_MAX_LIMIT,
  TOOL_RESULT_ARCHIVE_MAX_RESPONSE_CHARS,
  type ToolResultArchiveResourceRequest,
} from "@pico/runtime/tool-result-archive-resource";
import { ToolAccesses } from "@pico/runtime/tool-access";
import {
  NO_FILE_SIDE_EFFECTS,
  type BaseTool,
  type ToolExecutionContext,
} from "./tool-registry-contract.js";

export const ARCHIVE_READ_TOOL_NAME = "archive_read";
export class ArchiveReadTool implements BaseTool {
  readonly readOnly = true;
  readonly readsToolResultArchives = true;
  readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;
  readonly nesting = "nestable" as const;
  readonly recoveryMode = "replay_safe" as const;
  readonly recoveryKey = "pico.archive_read.v1";
  constructor(private readonly reader: BoundToolResultArchiveReader) {}
  name(): string {
    return ARCHIVE_READ_TOOL_NAME;
  }
  accesses(): ToolAccesses {
    return ToolAccesses.none();
  }
  definition(): ToolDefinition {
    return {
      name: this.name(),
      description:
        "Inspect, search, or page through a tool-result archive returned as a pico://archive/... ref. Start with inspect for a preview and the char/line coordinate space. Use search with a literal case-insensitive pattern, read with unit line for terminal output, or query with an itemId for a structured item. Results are bounded. Offsets are zero-based.",
      inputSchema: {
        type: "object",
        properties: {
          ref: {
            type: "string",
            maxLength: 1500,
            description: "pico://archive/... ref from a tool-result placeholder",
          },
          operation: {
            type: "string",
            enum: ["inspect", "read", "query", "search"],
            default: "inspect",
          },
          unit: {
            type: "string",
            enum: ["char", "line"],
            default: "char",
            description: "For read: whether offset/limit count characters or whole lines",
          },
          offset: {
            type: "integer",
            minimum: 0,
            description:
              "Zero-based character or line offset; search resumes at a character offset",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: TOOL_RESULT_ARCHIVE_MAX_LIMIT,
            description: "Maximum characters or lines; default 4000, maximum 6000",
          },
          itemId: {
            type: "string",
            minLength: 1,
            maxLength: 256,
            description: "Structured item id from inspect; required for query",
          },
          pattern: {
            type: "string",
            minLength: 1,
            maxLength: 256,
            description: "Literal case-insensitive substring; required for search",
          },
        },
        required: ["ref"],
      },
    };
  }
  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    const request = cleanArchiveReadInput(JSON.parse(args));
    if (!request || typeof request !== "object" || Array.isArray(request))
      throw new Error("archive_read requires an object");
    const input = request as Record<string, unknown>;
    if (typeof input.ref !== "string" || input.ref.length > 1500)
      throw new Error("archive_read requires a bounded ref");
    const operation = input.operation ?? "inspect";
    if (!["inspect", "read", "query", "search"].includes(String(operation)))
      throw new Error("Unsupported archive operation");
    if (input.unit !== undefined && input.unit !== "char" && input.unit !== "line")
      throw new Error("unit must be char or line");
    if (
      input.offset !== undefined &&
      (!Number.isSafeInteger(input.offset) || (input.offset as number) < 0)
    )
      throw new Error("offset must be a non-negative integer");
    if (
      input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) ||
        (input.limit as number) < 1 ||
        (input.limit as number) > TOOL_RESULT_ARCHIVE_MAX_LIMIT)
    )
      throw new Error("limit must be between 1 and 6000");
    for (const key of ["itemId", "pattern"] as const) {
      if (
        input[key] !== undefined &&
        (typeof input[key] !== "string" || input[key].length < 1 || input[key].length > 256)
      )
        throw new Error(`${key} must contain 1 to 256 characters`);
    }
    if (operation === "query" && !input.itemId) throw new Error("itemId is required for query");
    if (operation === "search" && !input.pattern) throw new Error("pattern is required for search");
    const result = await readToolResultArchiveResource(
      this.reader,
      input as unknown as ToolResultArchiveResourceRequest,
      context?.signal,
    );
    const encoded = JSON.stringify(result);
    // Pico's URI embeds Session and event identity and can exceed Maka's URI length.
    // Keep the complete envelope bounded even for pathological metadata and error lists.
    return encoded.length <= TOOL_RESULT_ARCHIVE_MAX_RESPONSE_CHARS
      ? encoded
      : JSON.stringify({
          ok: false,
          kind: "tool_result_archive",
          reason: "response_too_large",
          readHint: 'Retry operation "read" with a smaller limit.',
        });
  }
}
function cleanArchiveReadInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const cleaned = { ...(input as Record<string, unknown>) };
  const operation = cleaned.operation ?? "inspect";
  if (operation !== "query") delete cleaned.itemId;
  if (operation !== "search") delete cleaned.pattern;
  if (operation !== "read") delete cleaned.unit;
  if (operation === "inspect") {
    delete cleaned.offset;
    delete cleaned.limit;
  }
  return cleaned;
}

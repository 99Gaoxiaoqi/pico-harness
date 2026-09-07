import type { BaseTool, ToolExecutionContext } from "../tools/registry.js";
import { NO_FILE_SIDE_EFFECTS } from "../tools/registry.js";
import type { ToolDefinition } from "../schema/message.js";
import { ToolAccesses } from "../tools/tool-access.js";
import type { AtomicMemoryResult } from "./atomic/runtime-contracts.js";

/** Legacy scheduler input retained for stored-job recovery tooling only. */
export interface MemoryTriggerSlot {
  trigger: "remember" | "extract" | undefined;
}
export interface AtomicMemoryToolPort {
  remember(signal?: AbortSignal): Promise<AtomicMemoryResult>;
  requestExtract(): Promise<{ status: "accepted" | "unavailable" }>;
}

export function buildMemoryTriggerTools(port: AtomicMemoryToolPort): readonly BaseTool[] {
  return [
    new MemoryTriggerTool("memory_remember", port),
    new MemoryTriggerTool("memory_extract", port),
  ];
}

class MemoryTriggerTool implements BaseTool {
  readonly readOnly = true;
  readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;
  constructor(
    private readonly toolName: "memory_remember" | "memory_extract",
    private readonly port: AtomicMemoryToolPort,
  ) {}
  name(): string {
    return this.toolName;
  }
  definition(): ToolDefinition {
    return {
      name: this.toolName,
      description:
        this.toolName === "memory_remember"
          ? "Use only when the user explicitly asks you to remember long-term information. Call this tool alone in its own step. It stores the requested memory and returns exactly what was saved."
          : "Use when the conversation contains durable long-term information worth preserving and the user did not explicitly ask to remember it. Extraction runs after this turn.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    };
  }
  accesses() {
    return ToolAccesses.none();
  }
  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    const input: unknown = JSON.parse(args);
    if (!input || Array.isArray(input) || typeof input !== "object" || Object.keys(input).length)
      throw new Error("Memory triggers accept an empty object only");
    return JSON.stringify(
      this.toolName === "memory_remember"
        ? await this.port.remember(context?.signal)
        : await this.port.requestExtract(),
    );
  }
}

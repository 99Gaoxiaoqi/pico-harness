import type {
  MemoryRecallRequestFacts,
  MemoryRecallTrace,
  Message,
  PreparedProviderRequest,
} from "@pico/core";
import { memoryRecallTextHash, MEMORY_RECALL_TRACE_MAX_BYTES } from "./memory-recall-trace.js";

export interface RecordedMemoryRecall {
  readonly eventId: string;
  readonly trace: MemoryRecallTrace;
}

/** Per-Host-run state; never shared mutable state on a Provider or workspace singleton. */
export class MemoryRecallRequestTracker {
  private automatic: RecordedMemoryRecall | undefined;
  private readonly searches = new Map<string, RecordedMemoryRecall>();
  private coverage: MemoryRecallRequestFacts["coverage"] = "recorded";
  private history: Promise<void> | undefined;

  constructor(
    private readonly options: {
      readonly record: (trace: MemoryRecallTrace) => Promise<string | undefined>;
      readonly readHistory?: () => Promise<readonly RecordedMemoryRecall[]>;
      readonly onUnavailable?: () => void;
    },
  ) {}

  async record(trace: MemoryRecallTrace): Promise<void> {
    if (trace.mode === "automatic") this.automatic = undefined;
    try {
      const eventId = await this.options.record(trace);
      if (!eventId) {
        this.unavailable();
        return;
      }
      const recorded = { eventId, trace: structuredClone(trace) };
      if (trace.mode === "automatic") this.automatic = recorded;
      else if (trace.queryRef?.toolCallId) this.searches.set(trace.queryRef.toolCallId, recorded);
    } catch {
      this.unavailable();
    }
  }

  unavailable(mode?: MemoryRecallTrace["mode"]): void {
    if (mode === "automatic") this.automatic = undefined;
    this.coverage = "unrecorded";
    try {
      this.options.onUnavailable?.();
    } catch {
      /* diagnostics cannot affect model work */
    }
  }

  async context(messages: readonly Message[]): Promise<MemoryRecallRequestFacts> {
    this.history ??= this.loadHistory();
    await this.history;
    const searchCallIds = new Set(
      messages.flatMap((message) =>
        (message.toolCalls ?? [])
          .filter((call) => call.name === "memory_search")
          .map((call) => call.id),
      ),
    );
    const candidates: RecordedMemoryRecall[] = [];
    if (this.automatic) candidates.push(this.automatic);
    // Prefer recent carriers if the metadata budget cannot cover the entire tool history.
    for (const message of [...messages].reverse()) {
      if (!message.toolCallId) continue;
      const recall = this.searches.get(message.toolCallId);
      if (!recall && searchCallIds.has(message.toolCallId)) this.unavailable();
      if (recall && !candidates.some((candidate) => candidate.eventId === recall.eventId))
        candidates.push(recall);
    }
    const facts: {
      version: 1;
      coverage: MemoryRecallRequestFacts["coverage"];
      recalls: MemoryRecallRequestFacts["recalls"][number][];
    } = {
      version: 1,
      coverage: this.coverage,
      recalls: [],
    };
    for (const { eventId, trace } of candidates) {
      facts.recalls.push({
        recallEventId: eventId,
        ...(trace.blockHash ? { blockHash: trace.blockHash } : {}),
        references: trace.selected.map((item) => ({
          itemId: item.itemId,
          referenceHash: item.referenceHash,
        })),
      });
      if (Buffer.byteLength(JSON.stringify(facts), "utf8") > MEMORY_RECALL_TRACE_MAX_BYTES) {
        facts.recalls.pop();
        facts.coverage = "unrecorded";
        break;
      }
    }
    return facts;
  }

  private async loadHistory(): Promise<void> {
    try {
      for (const recall of [...((await this.options.readHistory?.()) ?? [])].reverse()) {
        const toolCallId =
          recall.trace.mode === "search" ? recall.trace.queryRef?.toolCallId : undefined;
        // A fresh result recorded during this run always wins over a historical weak pointer.
        if (toolCallId && !this.searches.has(toolCallId)) this.searches.set(toolCallId, recall);
      }
    } catch {
      this.unavailable();
    }
  }
}

export interface PreparedMemoryRecallDiagnostic {
  readonly version: 1;
  readonly coverage: MemoryRecallRequestFacts["coverage"];
  readonly recalls: readonly {
    readonly recallEventId: string;
    readonly blockPresent?: boolean;
    readonly references: readonly {
      readonly itemId: string;
      readonly referenceHash: string;
      readonly present: boolean;
    }[];
  }[];
}

export function isPreparedMemoryRecallDiagnostic(
  value: unknown,
): value is PreparedMemoryRecallDiagnostic {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["version", "coverage", "recalls"].includes(key))
  )
    return false;
  const identifier = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 1024;
  const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
  return (
    value["version"] === 1 &&
    ["recorded", "unrecorded"].includes(value["coverage"] as string) &&
    Array.isArray(value["recalls"]) &&
    value["recalls"].every(
      (recall) =>
        isRecord(recall) &&
        Object.keys(recall).every((key) =>
          ["recallEventId", "blockPresent", "references"].includes(key),
        ) &&
        identifier(recall["recallEventId"]) &&
        (recall["blockPresent"] === undefined || typeof recall["blockPresent"] === "boolean") &&
        Array.isArray(recall["references"]) &&
        recall["references"].length <= 10 &&
        recall["references"].every(
          (reference) =>
            isRecord(reference) &&
            Object.keys(reference).every((key) =>
              ["itemId", "referenceHash", "present"].includes(key),
            ) &&
            identifier(reference["itemId"]) &&
            hash(reference["referenceHash"]) &&
            typeof reference["present"] === "boolean",
        ),
    )
  );
}

/** Match exact semantic text after protocol translation; markers alone are not evidence. */
export function capturePreparedMemoryRecall(
  request: PreparedProviderRequest,
  facts: MemoryRecallRequestFacts,
): PreparedMemoryRecallDiagnostic {
  const blocks = new Set<string>();
  const references = new Set<string>();
  for (const text of requestTextStrings(request)) {
    for (const match of text.matchAll(
      /<atomic-memory-reference\b[^>]*>[\s\S]*?<\/atomic-memory-reference>/gu,
    )) {
      blocks.add(memoryRecallTextHash(match[0]));
    }
    // Tool projection may remove the outer footer while keeping complete references.
    for (const reference of text.matchAll(/<memory\b[^>]*>[\s\S]*?<\/memory>/gu))
      references.add(memoryRecallTextHash(reference[0]));
  }
  return {
    version: 1,
    coverage: facts.coverage,
    recalls: facts.recalls.map((recall) => ({
      recallEventId: recall.recallEventId,
      ...(recall.blockHash ? { blockPresent: blocks.has(recall.blockHash) } : {}),
      references: recall.references.map((reference) => ({
        itemId: reference.itemId,
        referenceHash: reference.referenceHash,
        present: references.has(reference.referenceHash),
      })),
    })),
  };
}

function requestTextStrings(request: PreparedProviderRequest): string[] {
  const texts: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") texts.push(value);
    else if (Array.isArray(value)) for (const part of value) collect(part);
    else if (isRecord(value)) {
      if (typeof value["text"] === "string") texts.push(value["text"]);
      if (value["content"] !== undefined) collect(value["content"]);
      // Anthropic tool_result and OpenAI Responses function_call_output carriers.
      if (value["output"] !== undefined) collect(value["output"]);
    }
  };
  collect(request.body["system"]);
  collect(request.body["instructions"]);
  collect(request.provider === "responses" ? request.body["input"] : request.body["messages"]);
  return texts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

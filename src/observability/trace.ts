// Trace captures the agent run as a small span tree that can be replayed after
// the fact when logs alone are too noisy.
//
// The span model mirrors OpenTelemetry-style tracing, but the nodes are agent
// decisions instead of network calls:
// - Root Span:一次完整 Run 任务
// - Child Spans:ReAct 循环的每个 Turn
// - Leaf Spans:Turn 内细分操作(Generate/Execute/Compaction)
//
// Main loop spans use explicit parent references. Tracer still keeps a
// startSpan/endSpan stack for simple sequential callers. JSON exports are saved
// under .claw/traces/.

import { writeFileSync, mkdirSync } from "node:fs";
// pathe keeps trace paths stable in tests by using POSIX separators.
import { join } from "pathe";

export type TraceAttributes = Record<string, unknown>;

/** A timed operation node in the trace tree. */
export class Span {
  readonly name: string;
  readonly startTime: number;
  endTime?: number;
  durationMs?: number;
  readonly attributes: Record<string, unknown> = {};
  readonly children: Span[] = [];
  /** Parent node. Null only for the root span. */
  readonly parent: Span | null;
  private readonly now: () => number;

  constructor(
    name: string,
    parent: Span | null,
    now: () => number = Date.now,
    attributes: TraceAttributes = {},
  ) {
    this.name = name;
    this.parent = parent;
    this.now = now;
    this.startTime = this.now();
    this.addAttributes(attributes);
  }

  /** Start an explicit child span without relying on ambient context. */
  startChild(name: string, attributes: TraceAttributes = {}): Span {
    const span = new Span(name, this, this.now, attributes);
    this.children.push(span);
    return span;
  }

  /** Finish the span and record elapsed time. */
  end(): void {
    if (this.endTime !== undefined) {
      return;
    }
    this.endTime = this.now();
    this.durationMs = this.endTime - this.startTime;
  }

  /** Record one metadata field. */
  addAttribute(key: string, value: unknown): void {
    if (value === undefined) {
      return;
    }
    this.attributes[key] = value;
  }

  /** Record multiple metadata fields. */
  addAttributes(attributes: TraceAttributes): void {
    for (const [key, value] of Object.entries(attributes)) {
      this.addAttribute(key, value);
    }
  }

  /** Serialize without parent to avoid circular JSON. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      startTime: new Date(this.startTime).toISOString(),
      endTime: this.endTime ? new Date(this.endTime).toISOString() : undefined,
      durationMs: this.durationMs,
      attributes: this.attributes,
      children: this.children.map((c) => c.toJSON()),
    };
  }
}

/**
 * Stack-based tracer for simple sequential instrumentation.
 * startSpan attaches to the current span; endSpan returns to the parent.
 */
export interface TracerOptions {
  now?: () => number;
}

export class Tracer {
  private rootSpan: Span | null = null;
  private currentSpan: Span | null = null;

  constructor(private readonly options: TracerOptions = {}) {}

  /** Start the root span for one agent run. */
  startRoot(name: string, attributes: TraceAttributes = {}): Span {
    this.rootSpan = new Span(name, null, this.options.now ?? Date.now, attributes);
    this.currentSpan = this.rootSpan;
    return this.rootSpan;
  }

  /** Start a child span and make it current. */
  startSpan(name: string, attributes: TraceAttributes = {}): Span {
    if (!this.currentSpan) {
      // No active span: treat this call as a root span.
      return this.startRoot(name, attributes);
    }
    const span = this.currentSpan.startChild(name, attributes);
    this.currentSpan = span;
    return span;
  }

  /** End the span and restore its parent as current. */
  endSpan(span: Span): void {
    span.end();
    if (this.currentSpan === span) {
      this.currentSpan = span.parent;
    }
  }

  /** Return the root span for export or inspection. */
  getRoot(): Span | null {
    return this.rootSpan;
  }

  /** Serialize the current root span. */
  snapshot(): Record<string, unknown> {
    if (!this.rootSpan) {
      throw new Error("Tracer has no root span.");
    }
    return this.rootSpan.toJSON();
  }

  /** Export the current root span to a trace file. */
  exportToFile(workDir: string, sessionId: string): string {
    if (!this.rootSpan) {
      throw new Error("Tracer has no root span.");
    }
    return exportTraceToFile(this.rootSpan, workDir, sessionId, this.options.now?.());
  }

  /** Reset internal state. Used by tests. */
  reset(): void {
    this.rootSpan = null;
    this.currentSpan = null;
  }
}

/** Serialize and save the root span as local JSON. */
export function exportTraceToFile(
  rootSpan: Span,
  workDir: string,
  sessionId: string,
  timestamp: number = Date.now(),
): string {
  const traceDir = join(workDir, ".claw", "traces");
  mkdirSync(traceDir, { recursive: true });
  const filename = `trace_${sanitizeFilePart(sessionId)}_${timestamp}.json`;
  const filepath = join(traceDir, filename);
  const data = JSON.stringify(rootSpan.toJSON(), null, 2);
  writeFileSync(filepath, data, "utf8");
  return filepath;
}

/** Keep high-cardinality fields small in trace attributes. */
export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

/** Keep session ids safe inside trace filenames. */
function sanitizeFilePart(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/gu, "_");
}

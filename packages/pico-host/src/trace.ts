import { chmodSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "pathe";
import { resolvePicoPaths } from "./pico-paths.js";
import { Tracer as RuntimeTracer, type TracerOptions, type Span } from "@pico/runtime/trace";
export * from "@pico/runtime/trace";
export class Tracer extends RuntimeTracer {
  constructor(options: TracerOptions = {}) {
    super({ ...options, exportTrace: options.exportTrace ?? exportTraceToFile });
  }
}
/** Serialize and save the root span as local JSON. */
export function exportTraceToFile(
  rootSpan: Span,
  workDir: string,
  sessionId: string,
  timestamp: number = Date.now(),
  picoHome?: string,
): string {
  const traceDir = resolvePicoPaths(workDir, { ...(picoHome !== undefined ? { picoHome } : {}) })
    .workspace.traces;
  mkdirSync(traceDir, { recursive: true, mode: 0o700 });
  chmodSync(traceDir, 0o700);
  const filename = `trace_${sanitizeFilePart(sessionId)}_${timestamp}.json`;
  const filepath = join(traceDir, filename);
  const data = JSON.stringify(rootSpan.toJSON(), null, 2);
  writeFileSync(filepath, data, { encoding: "utf8", mode: 0o600 });
  chmodSync(filepath, 0o600);
  return filepath;
}

/** Keep session ids safe inside trace filenames. */
function sanitizeFilePart(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/gu, "_");
}

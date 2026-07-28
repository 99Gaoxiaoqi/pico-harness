import type { SessionHydrationSnapshot } from "../engine/session-runtime.js";
import {
  projectTranscriptEntriesForRendering,
  projectTranscriptEvents,
  type TranscriptEvent,
} from "../presentation/transcript-event-store.js";
import { hydrateCanonicalTranscriptEvents } from "../presentation/transcript-tool-result-hydration.js";
import type { TuiEntry, TuiReporter } from "./tui-reporter.js";

/**
 * 恢复/热切换只重放结构化 transcript，并用 canonical tool.result.recorded
 * envelope 覆盖或补齐 completion。旧 Message/providerData 不再是 UI 数据源。
 */
export function hydrateTuiEntries(snapshot: SessionHydrationSnapshot): TuiEntry[] {
  const events = canonicalHydrationEvents(snapshot);
  return projectTranscriptEntriesForRendering(projectTranscriptEvents(events));
}

export function hydrateTuiReporter(
  reporter: Pick<TuiReporter, "hydrateTranscriptEvents" | "replaceTranscriptEvents">,
  snapshot: SessionHydrationSnapshot,
  options: { readonly replace?: boolean } = {},
): void {
  const events = canonicalHydrationEvents(snapshot);
  if (options.replace) {
    reporter.replaceTranscriptEvents(events);
    return;
  }
  if (events.length > 0) reporter.hydrateTranscriptEvents(events);
}

function canonicalHydrationEvents(snapshot: SessionHydrationSnapshot): TranscriptEvent[] {
  if (!Array.isArray(snapshot.toolResults)) {
    throw new Error(
      `Session ${snapshot.sessionId} does not contain canonical ToolResult hydration data`,
    );
  }
  return hydrateCanonicalTranscriptEvents({
    sessionId: snapshot.sessionId,
    updatedAt: snapshot.updatedAt,
    transcriptEvents: snapshot.transcriptEvents,
    transcriptEventSequences: snapshot.transcriptEventSequences,
    toolResults: snapshot.toolResults,
    rejectUnmatchedResults: true,
  });
}

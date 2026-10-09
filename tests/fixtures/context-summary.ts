import {
  COMPACTION_SUMMARY_OPEN_TAG,
  COMPACTION_SUMMARY_CLOSE_TAG,
  type Message,
} from "@pico/core";
import {
  HANDOFF_EVIDENCE_METADATA_KEY,
  compactionSummarySha256,
} from "@pico/runtime/runtime-compaction-checkpoint";

/** Current sectioned contract with no claimed event evidence. */
export function contextSummaryBody(detail = "Preserve the verified task state."): string {
  return `## Goal\n${detail}\n## Progress\nThe recorded work is complete.\n## Key Decisions\nPreserve the recorded task state.\n## Constraints\n(none)\n## Next Steps\nContinue from the retained task anchor.\n## Critical Context\n${detail}\n## Evidence\n(none)`;
}

export function contextSummaryMessage(
  detail: string,
  boundary: {
    readonly sessionId: string;
    readonly throughEventId: string;
    readonly previousCheckpointId?: string;
  },
): Message {
  const body = contextSummaryBody(detail);
  return {
    role: "assistant",
    content: `${COMPACTION_SUMMARY_OPEN_TAG}\n${body}\n${COMPACTION_SUMMARY_CLOSE_TAG}`,
    providerData: {
      picoSummaryFormat: "sections_v2",
      [HANDOFF_EVIDENCE_METADATA_KEY]: {
        version: 1,
        ...boundary,
        summarySha256: compactionSummarySha256(body),
        references: [],
      },
    },
  };
}

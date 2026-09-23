import {
  COMPACTION_SUMMARY_OPEN_TAG,
  COMPACTION_SUMMARY_CLOSE_TAG,
  type Message,
} from "@pico/core";

/** Current contract fixture; bootstrap/reset seeds must use their explicit identities. */
export function contextSummaryBody(detail = "Preserve the verified task state."): string {
  return `## Goal\n${detail}\n## Progress\nThe recorded work is complete.\n## Next Steps\nContinue from the retained task anchor.\n## Critical Context\n${detail}`;
}

export function contextSummaryMessage(detail?: string): Message {
  return {
    role: "assistant",
    content: `${COMPACTION_SUMMARY_OPEN_TAG}\n${contextSummaryBody(detail)}\n${COMPACTION_SUMMARY_CLOSE_TAG}`,
    providerData: { picoSummaryFormat: "sections_v1" },
  };
}

/** Wire-visible prefix used only to recognize a full-compaction summary without storing its text. */
export const FULL_COMPACTION_SUMMARY_MARKER = "[上下文压缩 — 仅供参考]";

/** Structured tags that delimit a compaction summary body. */
export const COMPACTION_SUMMARY_OPEN_TAG = "<pico_compaction_summary>";
export const COMPACTION_SUMMARY_CLOSE_TAG = "</pico_compaction_summary>";

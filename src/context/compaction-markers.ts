/** Wire-visible prefix used only to recognize a full-compaction summary without storing its text. */
export const FULL_COMPACTION_SUMMARY_MARKER = "[上下文压缩 — 仅供参考]";

/** 结构化 XML 标签:包裹摘要正文,detectExistingCompactionSummary 和 findLastCompactionCheckpoint 用此做精确边界匹配。 */
export const COMPACTION_SUMMARY_OPEN_TAG = "<pico_compaction_summary>";
export const COMPACTION_SUMMARY_CLOSE_TAG = "</pico_compaction_summary>";

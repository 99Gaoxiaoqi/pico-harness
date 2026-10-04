import type { RuntimeTranscriptItemRecord } from "@pico/protocol/mobile";

export type TranscriptRow = {
  readonly key: string;
  readonly records: readonly RuntimeTranscriptItemRecord[];
};

function processIdentity(record: RuntimeTranscriptItemRecord): string | undefined {
  const item = record.item;
  if (item.kind !== "thinking" && (item.kind !== "tool" || item.status === "error")) return;
  if (typeof item.runId !== "string" || !item.runId.trim()) return;
  if (typeof item.turnId !== "string" || !item.turnId.trim()) return;
  return JSON.stringify([item.runId, item.turnId]);
}

/** Keep existing row starts when paging backwards, so an expanded group never gains older content. */
export function transcriptRows(
  records: readonly RuntimeTranscriptItemRecord[],
  previous: readonly TranscriptRow[] = [],
): TranscriptRow[] {
  const starts = new Set(previous.map((row) => row.records[0]!.itemId));
  const rows: Array<{ key: string; records: RuntimeTranscriptItemRecord[] }> = [];
  let identity: string | undefined;
  for (const record of records) {
    const nextIdentity = processIdentity(record);
    const last = rows.at(-1);
    if (last && nextIdentity && identity === nextIdentity && !starts.has(record.itemId))
      last.records.push(record);
    else rows.push({ key: record.itemId, records: [record] });
    identity = nextIdentity;
  }
  return rows;
}

export function rowIndexForItem(rows: readonly TranscriptRow[], itemId: string): number {
  return rows.findIndex((row) => row.records.some((record) => record.itemId === itemId));
}

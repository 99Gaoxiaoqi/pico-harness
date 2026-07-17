/**
 * Windows consoles scroll when a full-height frame writes the bottom-right cell.
 * Ink therefore clears every full-screen frame on win32, bypassing incremental
 * rendering. Reserve one physical row so streaming updates can stay incremental.
 */
export function effectiveTuiRows(
  terminalRows: number,
  platform: NodeJS.Platform = process.platform,
): number {
  const rows = Math.max(1, Math.floor(terminalRows));
  return platform === "win32" && rows > 1 ? rows - 1 : rows;
}

/** Reserve transient transcript chrome without pushing it to the bottom of a fixed-height box. */
export function transcriptContentRows(
  transcriptRows: number,
  options: { newMessageNotice: boolean; spinner: boolean },
): number {
  const rows = Math.max(1, Math.floor(transcriptRows));
  const reserved = Number(options.newMessageNotice) + Number(options.spinner);
  return Math.max(1, rows - reserved);
}

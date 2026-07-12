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

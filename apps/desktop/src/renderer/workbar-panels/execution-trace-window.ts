import type { RuntimeExecutionPage } from "@pico/protocol";

/** Every refresh rebuilds the visible window from fresh server cursors. */
export async function readExecutionWindow(
  query: (cursor?: string) => Promise<RuntimeExecutionPage>,
  pageCount: number,
  current: () => boolean,
): Promise<readonly RuntimeExecutionPage[] | undefined> {
  const pages: RuntimeExecutionPage[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < pageCount; index += 1) {
    if (!current()) return undefined;
    const page = await query(cursor);
    if (!current()) return undefined;
    pages.push(page);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return pages;
}

export function mergeExecutionPages(
  pages: readonly RuntimeExecutionPage[],
): RuntimeExecutionPage | undefined {
  const first = pages[0];
  if (!first) return undefined;
  const runs = new Map(pages.flatMap((page) => page.runs.map((run) => [run.runId, run] as const)));
  const union = (field: "oversizedRunIds" | "missingModelCallRunIds" | "incompleteRunIds") => [
    ...new Set(pages.flatMap((page) => page.coverage[field])),
  ];
  return {
    ...first,
    runs: [...runs.values()],
    // Summary is session-wide, never summed once per loaded page.
    coverage: {
      modelAttempts: pages.every(
        (page) => page.coverage.modelAttempts === first.coverage.modelAttempts,
      )
        ? first.coverage.modelAttempts
        : "mixed",
      oversizedRunIds: union("oversizedRunIds"),
      missingModelCallRunIds: union("missingModelCallRunIds"),
      incompleteRunIds: union("incompleteRunIds"),
    },
    nextCursor: pages.at(-1)?.nextCursor,
  };
}

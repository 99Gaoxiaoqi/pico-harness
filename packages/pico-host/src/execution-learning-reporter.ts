import type { TestEvent } from "node:test/reporters";

export const EXECUTION_TEST_REPORT_SCHEMA = "pico.node-test.v1";

/** Only runner events enter this channel. test:stdout/test:stderr are deliberately omitted. */
export default async function* executionLearningReporter(
  source: AsyncIterable<TestEvent>,
): AsyncGenerator<string> {
  const ancestry = new Map<string, string[]>();
  const active = new Set<string>();
  const seen = new Set<string>();
  let invalid = false;
  let summary = false;
  let outcomes = 0;
  const row = (value: object): string =>
    `${JSON.stringify({ schema: EXECUTION_TEST_REPORT_SCHEMA, ...value })}\n`;
  yield row({ kind: "begin" });
  for await (const event of source) {
    if (event.type === "test:start" || event.type === "test:pass" || event.type === "test:fail") {
      const data = event.data;
      if (
        !data.file ||
        !Number.isSafeInteger(data.nesting) ||
        data.nesting < 0 ||
        data.nesting > 64
      ) {
        invalid = true;
        continue;
      }
      const names = ancestry.get(data.file) ?? [];
      if (event.type === "test:start") {
        if (names.slice(0, data.nesting).length !== data.nesting) invalid = true;
        names.length = data.nesting;
        names.push(data.name);
        ancestry.set(data.file, names);
      }
      const id = JSON.stringify([data.file, ...names.slice(0, data.nesting), data.name]);
      if (event.type === "test:start") {
        if (seen.has(id)) invalid = true; // Duplicate nested names cannot be verified unambiguously on Node 22.
        seen.add(id);
        active.add(id);
      } else {
        const terminal = event.data;
        if (!active.delete(id) || ++outcomes > 4096) invalid = true;
        if (outcomes <= 4096) {
          yield row({
            kind: "outcome",
            id,
            file: data.file,
            suite: terminal.details.type === "suite",
            status:
              terminal.skip || terminal.todo
                ? "skipped"
                : event.type === "test:pass"
                  ? "passed"
                  : "failed",
          });
        }
      }
    } else if (event.type === "test:summary" && event.data.file === undefined) {
      if (summary) invalid = true;
      summary = true;
      yield row({ kind: "summary", success: event.data.success, counts: event.data.counts });
    }
  }
  yield row({ kind: "complete", valid: !invalid && active.size === 0 && summary });
}

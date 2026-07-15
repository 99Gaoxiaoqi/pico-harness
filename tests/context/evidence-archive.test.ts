import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EvidenceArchive,
  EvidenceArchiveIntegrityError,
  extractCompletedToolExchanges,
} from "../../src/context/evidence-archive.js";
import type { Message } from "../../src/schema/message.js";

describe("EvidenceArchive", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "pico-evidence-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("durably archives complete tool exchanges by content hash without overwriting existing evidence", async () => {
    let now = new Date("2026-07-15T00:00:00.000Z");
    const archive = new EvidenceArchive({ baseDir, now: () => now });
    const messages: Message[] = [
      { role: "user", content: "inspect the file" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "read_file", arguments: '{"path":"secret.txt"}' }],
      },
      { role: "user", toolCallId: "call-1", content: "top-secret tool output" },
      { role: "assistant", content: "done" },
    ];

    const reference = await archive.archiveToolExchanges("session-a", messages);
    expect(reference).toMatchObject({ sessionId: "session-a", exchangeCount: 1 });
    const first = await archive.read(reference!);
    expect(first.content.exchanges[0]!.results[0]!.content).toBe("top-secret tool output");

    now = new Date("2026-07-16T00:00:00.000Z");
    const repeated = await archive.archiveToolExchanges("session-a", messages);
    expect(repeated).toEqual(reference);
    expect((await archive.read(repeated!)).archivedAt).toBe(first.archivedAt);

    const file = join(baseDir, "session-a", `${reference!.contentHash}.json`);
    expect(await readFile(file, "utf8")).toContain("top-secret tool output");
  });

  it("rejects an incomplete tool batch instead of producing misleading evidence", () => {
    expect(() =>
      extractCompletedToolExchanges([
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-1", name: "read_file", arguments: "{}" }],
        },
      ]),
    ).toThrow(EvidenceArchiveIntegrityError);
  });

  it("rejects a non-hash reference before it can influence an archive path", async () => {
    const archive = new EvidenceArchive({ baseDir });
    await expect(
      archive.read({
        schemaVersion: 1,
        contentHash: "../../outside",
        sessionId: "session-a",
        exchangeCount: 1,
      }),
    ).rejects.toThrow("content hash is invalid");
  });
});

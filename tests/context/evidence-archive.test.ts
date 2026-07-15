import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

  it("archives a complete RuntimeEvent tool exchange with private filesystem permissions", async () => {
    const archive = new EvidenceArchive({ baseDir });
    const reference = await archive.archiveRuntimeToolExchange(
      "runtime-session",
      "tool-call-7",
      "run_shell",
      '{"command":"printf raw"}',
      "raw stdout\\nraw stderr",
      "sanitized model observation",
      true,
    );

    expect(reference).toEqual({
      schemaVersion: 1,
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      sessionId: "runtime-session",
      kind: "tool-exchange",
    });
    const manifest = await archive.read(reference);
    expect(manifest.content).toEqual({
      kind: "tool-exchange",
      sessionId: "runtime-session",
      toolCallId: "tool-call-7",
      toolName: "run_shell",
      arguments: '{"command":"printf raw"}',
      rawOutput: "raw stdout\\nraw stderr",
      modelVisibleOutput: "sanitized model observation",
      isError: true,
    });

    const directory = join(baseDir, "runtime-session");
    const file = join(directory, `${reference.contentHash}.json`);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("returns the first RuntimeEvent evidence record for identical content without overwriting it", async () => {
    let now = new Date("2026-07-15T00:00:00.000Z");
    const archive = new EvidenceArchive({ baseDir, now: () => now });
    const first = await archive.archiveRuntimeToolExchange(
      "runtime-session",
      "tool-call-8",
      "read_file",
      '{"path":"secret.txt"}',
      "unfiltered source output",
      "short model observation",
      false,
    );
    const firstManifest = await archive.readRuntimeToolExchange(first);

    now = new Date("2026-07-16T00:00:00.000Z");
    const repeated = await archive.archiveRuntimeToolExchange(
      "runtime-session",
      "tool-call-8",
      "read_file",
      '{"path":"secret.txt"}',
      "unfiltered source output",
      "short model observation",
      false,
    );

    expect(repeated).toEqual(first);
    expect((await archive.readRuntimeToolExchange(repeated)).archivedAt).toBe(
      firstManifest.archivedAt,
    );
  });

  it("rejects RuntimeEvent evidence whose stored content no longer matches its hash", async () => {
    const archive = new EvidenceArchive({ baseDir });
    const reference = await archive.archiveRuntimeToolExchange(
      "runtime-session",
      "tool-call-9",
      "read_file",
      '{"path":"secret.txt"}',
      "original raw output",
      "model observation",
      false,
    );
    const file = join(baseDir, "runtime-session", `${reference.contentHash}.json`);
    const corrupted = JSON.parse(await readFile(file, "utf8")) as {
      content: { rawOutput: string };
    };
    corrupted.content.rawOutput = "tampered output";
    await writeFile(file, `${JSON.stringify(corrupted)}\n`, "utf8");
    const corruptedBytes = await readFile(file, "utf8");

    await expect(archive.readRuntimeToolExchange(reference)).rejects.toThrow(
      "content hash mismatch",
    );
    await expect(
      archive.archiveRuntimeToolExchange(
        "runtime-session",
        "tool-call-9",
        "read_file",
        '{"path":"secret.txt"}',
        "original raw output",
        "model observation",
        false,
      ),
    ).rejects.toThrow("content hash mismatch");
    expect(await readFile(file, "utf8")).toBe(corruptedBytes);
  });

  it("rejects an invalid RuntimeEvent evidence reference before it can influence an archive path", async () => {
    const archive = new EvidenceArchive({ baseDir });

    await expect(
      archive.readRuntimeToolExchange({
        schemaVersion: 1,
        contentHash: "../../outside",
        sessionId: "runtime-session",
        kind: "tool-exchange",
      }),
    ).rejects.toThrow("content hash is invalid");
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

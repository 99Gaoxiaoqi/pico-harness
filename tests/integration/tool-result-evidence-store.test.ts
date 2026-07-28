import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  EvidenceArchive,
  formatEvidenceUri,
  MAX_EVIDENCE_PAGE_LIMIT_BYTES,
  parseEvidenceUri,
  type RuntimeToolResultEvidenceManifestV2,
  type SubagentReportEvidenceManifestV2,
} from "../../src/context/evidence-archive.js";
import type { RuntimeEvidenceReference } from "../../src/runtime/runtime-event.js";
import { buildDefaultToolRegistry } from "../../src/tools/default-registry.js";
import { DelegationManager } from "../../src/tools/delegation-manager.js";
import { createSubagentRegistryFactory } from "../../src/tools/delegation-registry.js";
import { ReadEvidenceTool } from "../../src/tools/evidence-read.js";
import type { AgentRunner } from "../../src/tools/subagent.js";

interface EvidenceFixture {
  readonly root: string;
  readonly evidenceRoot: string;
  readonly archive: EvidenceArchive;
}

test("Runtime Evidence v2 stores one immutable blob and no inline raw copy", async (context) => {
  const fixture = await evidenceFixture(context, "pico-evidence-v2-");
  const canary = `canary-${"raw-body-".repeat(2_000)}`;
  const first = await fixture.archive.archiveRuntimeToolResult({
    sessionId: "session/one",
    toolCallId: "call-1",
    toolName: "bash",
    rawArguments: '{"cmd":"fixture"}',
    rawOutput: canary,
    isError: false,
  });
  const second = await fixture.archive.archiveRuntimeToolResult({
    sessionId: "session/one",
    toolCallId: "call-2",
    toolName: "grep",
    rawArguments: '{"pattern":"fixture"}',
    rawOutput: canary,
    isError: false,
  });

  const firstManifest = await fixture.archive.readRuntimeToolExchange(first);
  const secondManifest = await fixture.archive.readRuntimeToolExchange(second);
  assert.equal(firstManifest.schemaVersion, 2);
  assert.equal(secondManifest.schemaVersion, 2);
  assert.deepEqual(firstManifest.content.rawOutput, secondManifest.content.rawOutput);
  assert.equal(await fixture.archive.readRuntimeToolOutput(first), canary);
  assert.equal(await fixture.archive.readRuntimeToolOutput(second), canary);

  const manifestPath = pathForManifest(fixture.evidenceRoot, first);
  const serializedManifest = await readFile(manifestPath, "utf8");
  assert.doesNotMatch(serializedManifest, /canary-/u);
  assert.doesNotMatch(serializedManifest, /modelVisibleOutput/u);
  const v2Manifest = firstManifest as RuntimeToolResultEvidenceManifestV2;
  const blobPath = pathForBlob(fixture.evidenceRoot, v2Manifest.content.rawOutput.digest);
  assert.equal(await readFile(blobPath, "utf8"), canary);
  assert.deepEqual(await readdir(join(fixture.evidenceRoot, "blobs", "sha256")), [
    v2Manifest.content.rawOutput.digest.slice(0, 2),
  ]);
  assert.deepEqual(
    await readdir(
      join(
        fixture.evidenceRoot,
        "blobs",
        "sha256",
        v2Manifest.content.rawOutput.digest.slice(0, 2),
      ),
    ),
    [v2Manifest.content.rawOutput.digest],
  );
  if (process.platform !== "win32") {
    assert.equal((await stat(blobPath)).mode & 0o777, 0o600);
    assert.equal(
      (
        await stat(
          join(
            fixture.evidenceRoot,
            "blobs",
            "sha256",
            v2Manifest.content.rawOutput.digest.slice(0, 2),
          ),
        )
      ).mode & 0o777,
      0o700,
    );
    assert.equal((await stat(manifestPath)).mode & 0o777, 0o600);
  }
});

test("Subagent reports use the same Evidence URI reader and immutable blob CAS", async (context) => {
  const fixture = await evidenceFixture(context, "pico-subagent-evidence-");
  const report = `完整报告\n${"证据行\n".repeat(2_000)}`;
  const reference = await fixture.archive.archiveSubagentReport({
    sessionId: "subagent/session",
    taskPrompt: "核验 Evidence 硬切换",
    report,
    status: "partial",
  });
  const uri = formatEvidenceUri(reference);
  const parsed = parseEvidenceUri(uri);

  assert.deepEqual(parsed, {
    schemaVersion: 1,
    contentHash: reference.contentHash,
    sessionId: reference.sessionId,
  });
  assert.equal(await fixture.archive.readSubagentReport(reference), report);
  const page = await fixture.archive.readEvidencePage(parsed, { limitBytes: 17 });
  assert.equal(page.kind, "subagent-report");
  assert.equal(report.startsWith(page.content), true);
  assert.equal(page.truncated, true);

  const manifest = await fixture.archive.readSubagentReportEvidence(reference);
  const typedManifest = manifest as SubagentReportEvidenceManifestV2;
  assert.equal(typedManifest.schemaVersion, 2);
  assert.equal(typedManifest.content.status, "partial");
  assert.equal(
    await readFile(pathForBlob(fixture.evidenceRoot, typedManifest.content.report.digest), "utf8"),
    report,
  );
  assert.doesNotMatch(
    await readFile(pathForManifest(fixture.evidenceRoot, reference), "utf8"),
    /证据行/u,
  );
});

test("Runtime Evidence rejects legacy v1 manifests while compaction Evidence v1 remains readable", async (context) => {
  const fixture = await evidenceFixture(context, "pico-evidence-v1-");
  const sessionId = "legacy/session";
  const contentHash = "a".repeat(64);
  const manifestPath = join(
    fixture.evidenceRoot,
    sanitizeFilePart(sessionId),
    `${contentHash}.json`,
  );
  await mkdir(join(fixture.evidenceRoot, sanitizeFilePart(sessionId)), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      schemaVersion: 1,
      contentHash,
      archivedAt: "2026-07-28T00:00:00.000Z",
      kind: "tool-exchange",
      content: {
        kind: "tool-exchange",
        sessionId,
        toolCallId: "legacy-call",
        toolName: "read_file",
        arguments: '{"path":"legacy.txt"}',
        rawOutput: "legacy raw output",
        modelVisibleOutput: "legacy projected output",
        isError: false,
      },
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const reference: RuntimeEvidenceReference = {
    schemaVersion: 1,
    contentHash,
    sessionId,
    kind: "tool-exchange",
  };

  await assert.rejects(
    fixture.archive.readRuntimeToolExchange(reference),
    /invalid schema version/u,
  );

  const compacted = await fixture.archive.archiveToolExchanges("compaction-session", [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "tool-call", name: "bash", arguments: '{"cmd":"pwd"}' }],
    },
    { role: "user", content: "/workspace", toolCallId: "tool-call" },
  ]);
  assert.ok(compacted);
  const compactedManifest = await fixture.archive.read(compacted);
  assert.equal(compactedManifest.schemaVersion, 1);
  assert.equal(compactedManifest.content.exchanges[0]?.results[0]?.content, "/workspace");
});

test("Runtime Evidence rejects manifest and blob tampering", async (context) => {
  const fixture = await evidenceFixture(context, "pico-evidence-tamper-");
  const reference = await fixture.archive.archiveRuntimeToolResult({
    sessionId: "tamper-session",
    toolCallId: "call-1",
    toolName: "bash",
    rawArguments: "{}",
    rawOutput: "integrity canary",
    isError: false,
  });
  const manifest = await fixture.archive.readRuntimeToolExchange(reference);
  assert.equal(manifest.schemaVersion, 2);
  const blobPath = pathForBlob(fixture.evidenceRoot, manifest.content.rawOutput.digest);
  await writeFile(blobPath, "x".repeat(manifest.content.rawOutput.sizeBytes), "utf8");
  await assert.rejects(
    fixture.archive.readRuntimeToolOutput(reference),
    /failed integrity validation/u,
  );

  const second = await fixture.archive.archiveRuntimeToolResult({
    sessionId: "tamper-session",
    toolCallId: "call-2",
    toolName: "grep",
    rawArguments: "{}",
    rawOutput: "separate body",
    isError: false,
  });
  const secondPath = pathForManifest(fixture.evidenceRoot, second);
  const secondValue = JSON.parse(await readFile(secondPath, "utf8")) as {
    content: { toolName: string };
  };
  secondValue.content.toolName = "forged";
  await writeFile(secondPath, `${JSON.stringify(secondValue)}\n`, "utf8");
  await assert.rejects(fixture.archive.readRuntimeToolExchange(second), /content hash mismatch/u);
});

test(
  "Runtime Evidence rejects symlink manifests and blobs",
  { skip: process.platform === "win32" },
  async (context) => {
    const fixture = await evidenceFixture(context, "pico-evidence-symlink-");
    const blobReference = await fixture.archive.archiveRuntimeToolResult({
      sessionId: "blob-link-session",
      toolCallId: "blob-call",
      toolName: "bash",
      rawArguments: "{}",
      rawOutput: "blob symlink canary",
      isError: false,
    });
    const blobManifest = await fixture.archive.readRuntimeToolExchange(blobReference);
    assert.equal(blobManifest.schemaVersion, 2);
    const blobPath = pathForBlob(fixture.evidenceRoot, blobManifest.content.rawOutput.digest);
    const realBlobPath = `${blobPath}.real`;
    await rename(blobPath, realBlobPath);
    await symlink(realBlobPath, blobPath);
    await assert.rejects(
      fixture.archive.readRuntimeToolOutput(blobReference),
      /regular non-symlink file/u,
    );

    const manifestReference = await fixture.archive.archiveRuntimeToolResult({
      sessionId: "manifest-link-session",
      toolCallId: "manifest-call",
      toolName: "grep",
      rawArguments: "{}",
      rawOutput: "manifest symlink canary",
      isError: false,
    });
    const manifestPath = pathForManifest(fixture.evidenceRoot, manifestReference);
    const realManifestPath = `${manifestPath}.real`;
    await rename(manifestPath, realManifestPath);
    await symlink(realManifestPath, manifestPath);
    await assert.rejects(
      fixture.archive.readRuntimeToolExchange(manifestReference),
      /regular non-symlink file/u,
    );
  },
);

test(
  "Runtime Evidence rejects symlink directory ancestors without touching their targets",
  { skip: process.platform === "win32" },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-evidence-ancestor-link-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const rawOutput = "ancestor link canary";
    const digest = createHash("sha256").update(rawOutput).digest("hex");
    const cases = [
      {
        name: "evidence root",
        linkPath(evidenceRoot: string) {
          return evidenceRoot;
        },
        async prepare() {},
      },
      {
        name: "blobs directory",
        linkPath(evidenceRoot: string) {
          return join(evidenceRoot, "blobs");
        },
        async prepare(evidenceRoot: string) {
          await mkdir(evidenceRoot, { mode: 0o700 });
        },
      },
      {
        name: "sha256 directory",
        linkPath(evidenceRoot: string) {
          return join(evidenceRoot, "blobs", "sha256");
        },
        async prepare(evidenceRoot: string) {
          await mkdir(join(evidenceRoot, "blobs"), { recursive: true, mode: 0o700 });
        },
      },
      {
        name: "digest prefix directory",
        linkPath(evidenceRoot: string) {
          return join(evidenceRoot, "blobs", "sha256", digest.slice(0, 2));
        },
        async prepare(evidenceRoot: string) {
          await mkdir(join(evidenceRoot, "blobs", "sha256"), {
            recursive: true,
            mode: 0o700,
          });
        },
      },
      {
        name: "session directory",
        linkPath(evidenceRoot: string) {
          return join(evidenceRoot, "ancestor-session");
        },
        async prepare(evidenceRoot: string) {
          await mkdir(evidenceRoot, { mode: 0o700 });
        },
      },
    ] as const;

    for (const fixtureCase of cases) {
      await context.test(fixtureCase.name, async () => {
        const caseRoot = join(root, fixtureCase.name.replaceAll(" ", "-"));
        const evidenceRoot = join(caseRoot, "evidence");
        const outside = join(caseRoot, "outside");
        await mkdir(caseRoot, { recursive: true, mode: 0o700 });
        await mkdir(outside, { mode: 0o751 });
        const markerPath = join(outside, "marker.txt");
        await writeFile(markerPath, "outside remains untouched", {
          encoding: "utf8",
          mode: 0o640,
        });
        await fixtureCase.prepare(evidenceRoot);
        await symlink(outside, fixtureCase.linkPath(evidenceRoot));

        const outsideMode = (await stat(outside)).mode & 0o777;
        const markerMode = (await stat(markerPath)).mode & 0o777;
        const outsideEntries = await readdir(outside);
        const archive = new EvidenceArchive({ baseDir: evidenceRoot });
        await assert.rejects(
          archive.archiveRuntimeToolResult({
            sessionId: "ancestor-session",
            toolCallId: "call-1",
            toolName: "bash",
            rawArguments: "{}",
            rawOutput,
            isError: false,
          }),
          /regular non-symlink directory|changed/u,
        );

        assert.equal((await stat(outside)).mode & 0o777, outsideMode);
        assert.equal((await stat(markerPath)).mode & 0o777, markerMode);
        assert.equal(await readFile(markerPath, "utf8"), "outside remains untouched");
        assert.deepEqual(await readdir(outside), outsideEntries);
      });
    }
  },
);

test("Runtime Evidence enforces strict UTF-8 byte page boundaries", async (context) => {
  const fixture = await evidenceFixture(context, "pico-evidence-utf8-boundary-");
  const rawOutput = "🙂a开";
  const reference = await fixture.archive.archiveRuntimeToolResult({
    sessionId: "utf8-session",
    toolCallId: "call-1",
    toolName: "bash",
    rawArguments: "{}",
    rawOutput,
    isError: false,
  });

  await assert.rejects(
    fixture.archive.readRuntimeToolOutputPage(reference, {
      offsetBytes: 1,
      limitBytes: 4,
    }),
    /not a UTF-8 code point boundary/u,
  );
  for (const limitBytes of [1, 2, 3]) {
    await assert.rejects(
      fixture.archive.readRuntimeToolOutputPage(reference, { limitBytes }),
      /cannot contain the next complete UTF-8 code point/u,
    );
  }

  const emoji = await fixture.archive.readRuntimeToolOutputPage(reference, {
    offsetBytes: 0,
    limitBytes: 4,
  });
  assert.equal(emoji.content, "🙂");
  assert.equal(Buffer.byteLength(emoji.content, "utf8"), 4);
  assert.equal(emoji.nextOffsetBytes, 4);

  const ascii = await fixture.archive.readRuntimeToolOutputPage(reference, {
    offsetBytes: 4,
    limitBytes: 2,
  });
  assert.equal(ascii.content, "a");
  assert.ok(Buffer.byteLength(ascii.content, "utf8") <= ascii.limitBytes);
  assert.equal(ascii.nextOffsetBytes, 5);
});

test("Runtime Evidence v2 validates once, reads bounded pages, and invalidates cache", async (context) => {
  const fixture = await evidenceFixture(context, "pico-evidence-page-cache-");
  const rawOutput = "a".repeat(2 * 1024 * 1024);
  const reference = await fixture.archive.archiveRuntimeToolResult({
    sessionId: "page-cache-session",
    toolCallId: "call-1",
    toolName: "read_file",
    rawArguments: "{}",
    rawOutput,
    isError: false,
  });
  const manifest = await fixture.archive.readRuntimeToolExchange(reference);
  assert.equal(manifest.schemaVersion, 2);
  const blobPath = pathForBlob(fixture.evidenceRoot, manifest.content.rawOutput.digest);
  const tracker = await trackFileHandleReads(context, blobPath);
  const reader = new EvidenceArchive({ baseDir: fixture.evidenceRoot });

  const beforeFirst = tracker.bytesRead;
  const first = await reader.readRuntimeToolOutputPage(reference, {
    offsetBytes: 0,
    limitBytes: 7,
  });
  const firstReadBytes = tracker.bytesRead - beforeFirst;
  assert.equal(first.content, "a".repeat(7));
  assert.equal(firstReadBytes, rawOutput.length + 8);

  const beforeSecond = tracker.bytesRead;
  const second = await reader.readRuntimeToolOutputPage(reference, {
    offsetBytes: 7,
    limitBytes: 7,
  });
  const secondReadBytes = tracker.bytesRead - beforeSecond;
  assert.equal(second.content, "a".repeat(7));
  assert.equal(secondReadBytes, 8);

  await writeFile(blobPath, "b".repeat(rawOutput.length), "utf8");
  const beforeTamper = tracker.bytesRead;
  await assert.rejects(
    reader.readRuntimeToolOutputPage(reference, {
      offsetBytes: 14,
      limitBytes: 7,
    }),
    /failed integrity validation/u,
  );
  assert.equal(tracker.bytesRead - beforeTamper, rawOutput.length);
});

test("read_evidence validates opaque refs and paginates UTF-8 without loss", async (context) => {
  const fixture = await evidenceFixture(context, "pico-read-evidence-");
  const rawOutput = "开头🙂middle-数据-终点";
  const reference = await fixture.archive.archiveRuntimeToolResult({
    sessionId: "source/session with space",
    toolCallId: "call-1",
    toolName: "bash",
    rawArguments: "{}",
    rawOutput,
    isError: false,
  });
  const ref = formatEvidenceUri(reference);
  assert.deepEqual(parseEvidenceUri(ref), {
    schemaVersion: 1,
    contentHash: reference.contentHash,
    sessionId: reference.sessionId,
  });

  let offsetBytes = 0;
  let recovered = "";
  const totalBytes = Buffer.byteLength(rawOutput, "utf8");
  while (offsetBytes < totalBytes) {
    const page = await fixture.archive.readRuntimeToolOutputPage(reference, {
      offsetBytes,
      limitBytes: 5,
    });
    assert.doesNotMatch(page.content, /\uFFFD/u);
    recovered += page.content;
    if (page.nextOffsetBytes === undefined) break;
    assert.ok(page.nextOffsetBytes > offsetBytes);
    offsetBytes = page.nextOffsetBytes;
  }
  assert.equal(recovered, rawOutput);

  const tool = new ReadEvidenceTool(fixture.root, fixture.evidenceRoot);
  const output = await tool.execute(JSON.stringify({ ref, offsetBytes: 0, limitBytes: 7 }));
  assert.match(output, /^开头/u);
  assert.match(output, /\[Evidence tool-exchange bytes 0-/u);
  assert.match(output, /"offsetBytes":/u);

  const hash = reference.contentHash;
  for (const invalid of [
    "file:///etc/passwd",
    `pico://evidence/session/${hash}?path=../../etc/passwd`,
    `pico://evidence/%61/${hash}`,
    `pico://evidence/a%2fb/${hash}`,
    `pico://evidence/session/${hash}/extra`,
  ]) {
    assert.throws(() => parseEvidenceUri(invalid), /Evidence ref/u);
  }
  await assert.rejects(
    tool.execute(
      JSON.stringify({
        ref,
        limitBytes: MAX_EVIDENCE_PAGE_LIMIT_BYTES + 1,
      }),
    ),
    /limitBytes/u,
  );
  await assert.rejects(
    tool.execute(
      JSON.stringify({
        ref: formatEvidenceUri({ ...reference, sessionId: "wrong-session" }),
      }),
    ),
    { code: "ENOENT" },
  );
  await assert.rejects(
    tool.execute(
      JSON.stringify({
        ref: formatEvidenceUri({ ...reference, contentHash: "0".repeat(64) }),
      }),
    ),
    { code: "ENOENT" },
  );

  const registry = buildDefaultToolRegistry(fixture.root, {
    evidenceBaseDir: fixture.evidenceRoot,
  });
  const names = registry.getAvailableTools().map((definition) => definition.name);
  assert.ok(names.includes("read_evidence"));
  assert.equal(names.includes("read_artifact"), false);

  const workerDir = join(fixture.root, "worker");
  await mkdir(workerDir, { recursive: true });
  const runner: AgentRunner = {
    async runSub() {
      return { status: "completed", summary: "unused", evidenceRefs: [] };
    },
  };
  const subagentRegistry = createSubagentRegistryFactory({
    workDir: fixture.root,
    runner,
    manager: new DelegationManager(),
    evidenceBaseDir: fixture.evidenceRoot,
  })({
    mode: "explore",
    role: "leaf",
    depth: 0,
    maxSpawnDepth: 0,
    workDir: workerDir,
  });
  assert.ok(
    subagentRegistry.getAvailableTools().some((definition) => definition.name === "read_evidence"),
  );
  const subagentRead = await subagentRegistry.execute({
    id: "call:read-shared-evidence",
    name: "read_evidence",
    arguments: JSON.stringify({ ref, offsetBytes: 0, limitBytes: 7 }),
  });
  assert.equal(subagentRead.isError, false);
  assert.match(subagentRead.output, /^开头/u);
});

async function evidenceFixture(context: TestContext, prefix: string): Promise<EvidenceFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  context.after(() => rm(root, { recursive: true, force: true }));
  const evidenceRoot = join(root, "evidence");
  return {
    root,
    evidenceRoot,
    archive: new EvidenceArchive({
      baseDir: evidenceRoot,
      now: () => new Date("2026-07-28T00:00:00.000Z"),
    }),
  };
}

interface FileReadTracker {
  readonly bytesRead: number;
}

type TrackedRead = (
  this: FileHandle,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number | null,
) => Promise<{ bytesRead: number; buffer: Buffer }>;

async function trackFileHandleReads(context: TestContext, path: string): Promise<FileReadTracker> {
  const probe = await open(path, "r");
  const target = await probe.stat({ bigint: true });
  const prototype = Object.getPrototypeOf(probe) as { read: TrackedRead };
  await probe.close();
  const originalRead = prototype.read;
  let bytesRead = 0;
  prototype.read = async function trackedRead(buffer, offset, length, position) {
    const result = await originalRead.call(this, buffer, offset, length, position);
    const opened = await this.stat({ bigint: true });
    if (opened.dev === target.dev && opened.ino === target.ino) {
      bytesRead += result.bytesRead;
    }
    return result;
  };
  context.after(() => {
    prototype.read = originalRead;
  });
  return {
    get bytesRead() {
      return bytesRead;
    },
  };
}

function pathForManifest(
  evidenceRoot: string,
  reference: { readonly sessionId: string; readonly contentHash: string },
): string {
  return join(evidenceRoot, sanitizeFilePart(reference.sessionId), `${reference.contentHash}.json`);
}

function pathForBlob(evidenceRoot: string, digest: string): string {
  return join(evidenceRoot, "blobs", "sha256", digest.slice(0, 2), digest);
}

function sanitizeFilePart(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/gu, "_");
}

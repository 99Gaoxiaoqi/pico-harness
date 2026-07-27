import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  EvidenceArchive,
  formatRuntimeEvidenceUri,
  MAX_EVIDENCE_PAGE_LIMIT_BYTES,
  parseRuntimeEvidenceUri,
  type RuntimeToolResultEvidenceManifestV2,
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

test("Runtime Evidence reads legacy v1 manifests and compaction Evidence v1", async (context) => {
  const fixture = await evidenceFixture(context, "pico-evidence-v1-");
  const sessionId = "legacy/session";
  const content = {
    kind: "tool-exchange" as const,
    sessionId,
    toolCallId: "legacy-call",
    toolName: "read_file",
    arguments: '{"path":"legacy.txt"}',
    rawOutput: "legacy raw output",
    modelVisibleOutput: "legacy projected output",
    isError: false,
  };
  const contentHash = hashContent(content);
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
      content,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const reference: RuntimeEvidenceReference = {
    schemaVersion: 1,
    contentHash,
    sessionId,
    kind: "tool-exchange",
  };

  assert.equal((await fixture.archive.readRuntimeToolExchange(reference)).schemaVersion, 1);
  assert.equal(await fixture.archive.readRuntimeToolOutput(reference), content.rawOutput);

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
  const ref = formatRuntimeEvidenceUri(reference);
  assert.deepEqual(parseRuntimeEvidenceUri(ref), reference);

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
  assert.match(output, /\[Evidence bytes 0-/u);
  assert.match(output, /"offsetBytes":/u);

  const hash = reference.contentHash;
  for (const invalid of [
    "file:///etc/passwd",
    `pico://evidence/session/${hash}?path=../../etc/passwd`,
    `pico://evidence/%61/${hash}`,
    `pico://evidence/a%2fb/${hash}`,
    `pico://evidence/session/${hash}/extra`,
  ]) {
    assert.throws(() => parseRuntimeEvidenceUri(invalid), /evidence ref/u);
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
        ref: formatRuntimeEvidenceUri({ ...reference, sessionId: "wrong-session" }),
      }),
    ),
    { code: "ENOENT" },
  );
  await assert.rejects(
    tool.execute(
      JSON.stringify({
        ref: formatRuntimeEvidenceUri({ ...reference, contentHash: "0".repeat(64) }),
      }),
    ),
    { code: "ENOENT" },
  );

  const registry = buildDefaultToolRegistry(fixture.root, {
    evidenceBaseDir: fixture.evidenceRoot,
  });
  const names = registry.getAvailableTools().map((definition) => definition.name);
  assert.ok(names.includes("read_evidence"));
  assert.ok(names.includes("read_artifact"));

  const workerDir = join(fixture.root, "worker");
  await mkdir(workerDir, { recursive: true });
  const runner: AgentRunner = {
    async runSub() {
      return { status: "completed", summary: "unused", artifacts: [] };
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

function pathForManifest(evidenceRoot: string, reference: RuntimeEvidenceReference): string {
  return join(evidenceRoot, sanitizeFilePart(reference.sessionId), `${reference.contentHash}.json`);
}

function pathForBlob(evidenceRoot: string, digest: string): string {
  return join(evidenceRoot, "blobs", "sha256", digest.slice(0, 2), digest);
}

function sanitizeFilePart(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/gu, "_");
}

function hashContent(content: unknown): string {
  return createHash("sha256").update(stableJson(content)).digest("hex");
}

function stableJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("fixture must be JSON serializable");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

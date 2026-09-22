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
import { EvidenceBlobStore } from "@pico/storage/evidence-blob-store";

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
        const blobs = new EvidenceBlobStore(evidenceRoot);
        await assert.rejects(blobs.putUtf8(rawOutput), /regular non-symlink directory|changed/u);

        assert.equal((await stat(outside)).mode & 0o777, outsideMode);
        assert.equal((await stat(markerPath)).mode & 0o777, markerMode);
        assert.equal(await readFile(markerPath, "utf8"), "outside remains untouched");
        assert.deepEqual(await readdir(outside), outsideEntries);
      });
    }
  },
);

test("blob CAS preserves UTF-8 page boundaries and validates cached content", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-blob-pages-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const blobs = new EvidenceBlobStore(root);
  const { ref: utf8 } = await blobs.putUtf8("🙂a开");
  const aligned = await blobs.readPage(utf8, 1, 4);
  assert.equal(aligned.offsetBytes, 0);
  assert.equal(aligned.bytes.toString("utf8"), "🙂");
  for (const limit of [1, 2, 3]) {
    await assert.rejects(
      blobs.readPage(utf8, 0, limit),
      /cannot contain the next complete UTF-8 code point/u,
    );
  }
  assert.equal((await blobs.readPage(utf8, 4, 2)).bytes.toString("utf8"), "a");
  const body = "a".repeat(2 * 1024 * 1024);
  const { ref } = await blobs.putUtf8(body);
  assert.deepEqual(await blobs.putUtf8(body), { ref, created: false });
  const path = join(root, "blobs", "sha256", ref.digest.slice(0, 2), ref.digest);
  const tracker = await trackFileHandleReads(context, path);
  const reader = new EvidenceBlobStore(root);
  assert.equal((await reader.readPage(ref, 0, 7)).bytes.toString("utf8"), "a".repeat(7));
  assert.equal(tracker.bytesRead, body.length + 8);
  const before = tracker.bytesRead;
  assert.equal((await reader.readPage(ref, 7, 7)).bytes.toString("utf8"), "a".repeat(7));
  assert.equal(tracker.bytesRead - before, 8);
  await writeFile(path, "b".repeat(body.length), "utf8");
  await assert.rejects(reader.readPage(ref, 14, 7), /failed integrity validation/u);
});

test("blob CAS rejects symlink files", { skip: process.platform === "win32" }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-blob-symlink-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const blobs = new EvidenceBlobStore(root);
  const { ref } = await blobs.putUtf8("symlink canary");
  const path = join(root, "blobs", "sha256", ref.digest.slice(0, 2), ref.digest);
  await rename(path, `${path}.real`);
  await symlink(`${path}.real`, path);
  await assert.rejects(blobs.read(ref), /regular non-symlink file/u);
});

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

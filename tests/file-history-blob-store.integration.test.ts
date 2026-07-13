import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileHistoryBlobIntegrityError,
  FileHistoryBlobStore,
} from "../src/storage/file-history-blob-store.js";
import { OperationReferenceIndex } from "../src/storage/operation-reference-index.js";

describe("FileHistory CAS blob store", () => {
  let testDir: string | undefined;

  afterEach(async () => {
    if (testDir) await rm(testDir, { recursive: true, force: true });
  });

  it("按 SHA-256 布局去重存储文件并拒绝读取损坏 blob", async () => {
    testDir = await mkdtemp(join(tmpdir(), "pico-file-history-cas-"));
    const baseDir = join(testDir, "file-history");
    const sourcePath = join(testDir, "workspace", "source.txt");
    const contents = Buffer.from("same file-history preimage\n", "utf8");
    const digest = createHash("sha256").update(contents).digest("hex");
    await mkdir(join(testDir, "workspace"), { recursive: true });
    await writeFile(sourcePath, contents);

    const store = new FileHistoryBlobStore({ baseDir });
    const first = await store.put(contents);
    const duplicate = await store.putFile(sourcePath);

    expect(first).toEqual({
      ref: { algorithm: "sha256", digest, sizeBytes: contents.byteLength },
      path: join(baseDir, "blobs", "sha256", digest.slice(0, 2), digest),
      created: true,
    });
    expect(duplicate).toEqual({ ...first, created: false });
    await expect(readFile(first.path)).resolves.toEqual(contents);
    await expect(store.read(first.ref)).resolves.toEqual(contents);

    await writeFile(first.path, "corrupt");
    await expect(store.read(first.ref)).rejects.toBeInstanceOf(FileHistoryBlobIntegrityError);
    await expect(store.put(contents)).rejects.toBeInstanceOf(FileHistoryBlobIntegrityError);
  });

  it("并发首次写入收敛到同一 GC generation 且不会给去重输家重新授权", async () => {
    testDir = await mkdtemp(join(tmpdir(), "pico-file-history-cas-generation-"));
    const baseDir = join(testDir, "file-history");
    const alpha = Buffer.from("alpha", "utf8");
    const beta = Buffer.from("beta", "utf8");
    const alphaDigest = createHash("sha256").update(alpha).digest("hex");
    const betaDigest = createHash("sha256").update(beta).digest("hex");
    const stores = [
      new FileHistoryBlobStore({ baseDir }),
      new FileHistoryBlobStore({ baseDir }),
      new FileHistoryBlobStore({ baseDir }),
    ];

    const writes = await Promise.all([
      stores[0]!.put(alpha),
      stores[1]!.put(beta),
      stores[2]!.put(alpha),
    ]);

    expect(writes.filter((write) => write.created)).toHaveLength(2);
    await expect(new OperationReferenceIndex(baseDir).scan()).resolves.toMatchObject({
      failures: [],
      gcEligibleDigests: [alphaDigest, betaDigest].toSorted(),
    });
  });
});

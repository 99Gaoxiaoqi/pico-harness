import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileHistoryBlobIntegrityError,
  FileHistoryBlobStore,
} from "../src/storage/file-history-blob-store.js";

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
});

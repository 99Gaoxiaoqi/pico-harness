import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { DraftScope } from "../../../apps/mobile/src/conversation/draft.js";
import type { RuntimePort } from "../../../apps/mobile/src/core.js";

function deferred<T>() {
  return Promise.withResolvers<T>();
}

/** The real repositories, cleanup coordinator and downloader use deterministic native ports. */
async function fixture() {
  const values = new Map<string, string>();
  const directories = new Set<string>();
  const files = new Map<string, Uint8Array>();
  let storageGate:
    | {
        key: string;
        entered: ReturnType<typeof deferred<void>>;
        release: ReturnType<typeof deferred<void>>;
      }
    | undefined;
  let removeFails = false;
  const downloadGate = deferred<void>();
  const downloadEntered = deferred<void>();
  let gatedDownload = false;
  const uri = (parts: (string | { uri: string })[]) =>
    parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
  class Directory {
    readonly uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = uri(parts);
    }
    get exists() {
      return directories.has(this.uri);
    }
    create() {
      let parent = this.uri;
      while (parent.startsWith("file:///cache")) {
        directories.add(parent);
        parent = parent.slice(0, parent.lastIndexOf("/"));
      }
    }
    list() {
      return [...directories, ...files.keys()].filter(
        (path) => path.startsWith(this.uri + "/") && !path.slice(this.uri.length + 1).includes("/"),
      );
    }
    delete() {
      for (const key of directories)
        if (key === this.uri || key.startsWith(this.uri + "/")) directories.delete(key);
      for (const key of files.keys()) if (key.startsWith(this.uri + "/")) files.delete(key);
    }
  }
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = uri(parts);
    }
    get exists() {
      return files.has(this.uri);
    }
    get size() {
      return files.get(this.uri)?.length ?? 0;
    }
    delete() {
      files.delete(this.uri);
    }
    open() {
      const bytes = files.get(this.uri)!;
      let offset = 0;
      return {
        readBytes(length: number) {
          const next = bytes.slice(offset, offset + length);
          offset += next.length;
          return next;
        },
        close() {},
      };
    }
    moveSync(target: File) {
      files.set(target.uri, files.get(this.uri)!);
      files.delete(this.uri);
      this.uri = target.uri;
    }
    static async downloadFileAsync(url: string, target: File) {
      if (url === "A" && gatedDownload) {
        downloadEntered.resolve();
        // A native operation that finishes after cancellation must not resurrect cached data.
        await downloadGate.promise;
      }
      files.set(target.uri, new TextEncoder().encode("verified artifact"));
    }
  }
  const native = {
    storage: {
      async getItem(key: string) {
        return values.get(key) ?? null;
      },
      async getAllKeys() {
        return [...values.keys()];
      },
      async setItem(key: string, value: string) {
        if (storageGate?.key === key) {
          storageGate.entered.resolve();
          await storageGate.release.promise;
        }
        values.set(key, value);
      },
      async removeItem(key: string) {
        if (removeFails && key.includes('"A"')) throw new Error("native storage removal failed");
        values.delete(key);
      },
    },
    fs: { Directory, File, Paths: { cache: "file:///cache" } },
    crypto: {
      randomUUID,
      CryptoDigestAlgorithm: { SHA256: "sha256" },
      async digestStringAsync(_algorithm: unknown, text: string) {
        return createHash("sha256").update(text).digest("hex");
      },
    },
  };
  const port = `__picoLocalData${randomUUID().replaceAll("-", "")}`;
  (globalThis as unknown as Record<string, unknown>)[port] = native;
  const prefix = `const native = globalThis[${JSON.stringify(port)}];`;
  const stubs = new Map([
    ["@react-native-async-storage/async-storage", `${prefix} export default native.storage;`],
    ["expo-file-system", `${prefix} export const {Directory,File,Paths}=native.fs;`],
    [
      "expo-crypto",
      `${prefix} export const {randomUUID,CryptoDigestAlgorithm,digestStringAsync}=native.crypto;`,
    ],
  ]);
  const source = (path: string) =>
    JSON.stringify(fileURLToPath(new URL(`../../../apps/mobile/src/${path}`, import.meta.url)));
  const bundle = await build({
    stdin: {
      contents: `export * from ${source("local-data.ts")}; export * from ${source("draft-store.ts")}; export * from ${source("conversation/draft.ts")}; export * from ${source("review-request-storage.ts")}; export * from ${source("review-controller.ts")}; export * from ${source("artifact-cache.ts")};`,
      resolveDir: fileURLToPath(new URL("../../../", import.meta.url)),
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "native-ports",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) =>
            stubs.has(args.path) ? { path: args.path, namespace: "port" } : undefined,
          );
          builder.onLoad({ filter: /.*/, namespace: "port" }, (args) => ({
            contents: stubs.get(args.path)!,
            loader: "js",
          }));
        },
      },
    ],
  });
  let modules: typeof import("../../../apps/mobile/src/local-data.js") &
    typeof import("../../../apps/mobile/src/draft-store.js") &
    typeof import("../../../apps/mobile/src/conversation/draft.js") &
    typeof import("../../../apps/mobile/src/review-request-storage.js") &
    typeof import("../../../apps/mobile/src/review-controller.js") &
    typeof import("../../../apps/mobile/src/artifact-cache.js");
  try {
    modules = await import(
      `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.text).toString("base64")}`
    );
  } finally {
    delete (globalThis as unknown as Record<string, unknown>)[port];
  }
  return {
    ...modules,
    values,
    directories,
    files,
    native,
    downloadGate,
    downloadEntered,
    setStorageGate(value: typeof storageGate) {
      storageGate = value;
    },
    gateDownload() {
      gatedDownload = true;
    },
    failRemoval() {
      removeFails = true;
    },
    allowRemoval() {
      removeFails = false;
    },
  };
}

const scopeA: DraftScope = { hostId: "A", workspaceId: "workspace", sessionId: "session" };
const scopeB = { ...scopeA, hostId: "B" };

test("按电脑清理保留另一台电脑，未确认操作须明确放弃，排空慢写和下载后拒绝迟到复活", async () => {
  const f = await fixture();
  const draftA = {
    ...f.emptyDraft("send-A"),
    text: "A draft",
    images: [{ type: "image_base64" as const, mimeType: "image/jpeg", data: "YQ==" }],
  };
  const draftB = { ...f.emptyDraft("send-B"), text: "B draft" };
  await f.drafts.save(scopeA, draftA);
  await f.drafts.save(scopeB, draftB);
  f.values.set("unrelated.setting", "keep");
  const review = (host: string) =>
    new f.ReviewRequestStorage(
      f.native.storage,
      JSON.stringify([host, "workspace", "session"]),
      () => `review-${host}`,
    );
  const reviewA = review("A");
  const reviewB = review("B");
  const reviewRequest = {
    idempotencyKey: "review-A",
    runId: "run",
    expectedFingerprint: "fingerprint",
    decision: "request_changes" as const,
    message: "A review",
  };
  await reviewA.save(reviewRequest);
  await reviewB.save({ ...reviewRequest, idempotencyKey: "review-B", message: "B review" });
  const reviewResponse = deferred<{ accepted: true }>();
  const reviewEntered = deferred<void>();
  let reviewCalls = 0;
  const controller = new f.MobileReview(
    {
      request: async () => {
        reviewCalls++;
        reviewEntered.resolve();
        return reviewResponse.promise;
      },
    } as unknown as RuntimePort,
    "workspace",
    "session",
    undefined,
    { recoveryStorage: reviewA, canRetry: () => true },
  );
  const unsubscribe = controller.subscribe(() => {});
  await controller.restore();
  const lateReview = controller.retryUnknown();
  await reviewEntered.promise;
  const oldGeneration = f.drafts.hostGeneration("A");
  const sendEntered = deferred<void>();
  const sendResponse = deferred<void>();
  const lateSend = f.submitDraft(
    f.drafts,
    scopeA,
    draftA,
    {
      sessionId: "session",
      input: f.draftInput(draftA),
      behavior: "auto",
      idempotencyKey: "send-A",
    },
    async () => {
      sendEntered.resolve();
      await sendResponse.promise;
      return "accepted";
    },
  );
  await sendEntered.promise;
  const artifact = {
    artifactId: "artifact",
    title: "result.txt",
    mimeType: "text/plain",
    sizeBytes: 17,
    digest: createHash("sha256").update("verified artifact").digest("hex"),
  };
  const download = (hostId: string) =>
    f.downloadArtifact({
      scopeId: hostId,
      workspaceId: "workspace",
      sessionId: "session",
      artifact: artifact as Parameters<typeof f.downloadArtifact>[0]["artifact"],
      client: { artifactUrl: () => hostId, authorizationHeaders: () => ({}) } as Parameters<
        typeof f.downloadArtifact
      >[0]["client"],
      assertCurrent() {},
    });
  const fileB = await download("B");
  const legacy = new f.native.fs.Directory("file:///cache", "pico-artifacts");
  legacy.create();
  f.files.set(legacy.uri + "/unknown-flat-file", new Uint8Array([1]));
  f.gateDownload();
  const downloadingA = download("A").then(
    () => "unexpected",
    (error: Error) => error.message,
  );
  await f.downloadEntered.promise;
  const gate = { key: reviewA.key, entered: deferred<void>(), release: deferred<void>() };
  f.setStorageGate(gate);
  const slowSave = reviewA.save(reviewRequest);
  await gate.entered.promise;
  let refusalSettled = false;
  const refusal = f.clearHostLocalData("A").finally(() => {
    refusalSettled = true;
  });
  const refusalCheck = assert.rejects(refusal, /结果未确认/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(refusalSettled, false, "清理检查先等待已开始的原生写入");
  await assert.rejects(reviewA.save(reviewRequest), /正在清理/);
  gate.release.resolve();
  await slowSave;
  await refusalCheck;
  assert.ok(f.values.has(f.draftKey(scopeA)), "未确认保护不能删除恢复信息");
  assert.equal((await f.inspectHostLocalData("A")).hasUnconfirmed, true);
  const retainedB = new Map([...f.values].filter(([key]) => key.includes('"B"')));
  let cleared = false;
  const clearing = f.clearHostLocalData("A", { discardUnconfirmed: true }).then((result) => {
    cleared = true;
    return result;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cleared, false, "完成提示须等待取消后的原生下载收尾");
  sendResponse.resolve();
  reviewResponse.resolve({ accepted: true });
  await lateSend;
  assert.equal(await lateReview, false);
  f.downloadGate.resolve();
  assert.match(await downloadingA, /取消/);
  assert.deepEqual(await clearing, { legacyCacheRemaining: true });
  assert.equal(await f.drafts.load(scopeA), undefined);
  assert.equal(await review("A").load(), undefined);
  assert.equal(controller.state.recovery, undefined);
  assert.equal(controller.active, false);
  assert.equal(await controller.retryUnknown(), false);
  assert.equal(reviewCalls, 1, "清除不触发远端重发");
  assert.deepEqual(new Map([...f.values].filter(([key]) => key.includes('"B"'))), retainedB);
  assert.equal(f.values.get("unrelated.setting"), "keep");
  assert.equal(f.files.has(fileB.uri), true);
  const hashA = createHash("sha256").update("A").digest("hex");
  assert.equal(
    [...f.directories].some((path) => path.includes(hashA)),
    false,
  );
  await assert.rejects(reviewA.save(reviewRequest), /已清除/);
  await assert.rejects(f.drafts.save(scopeA, draftA, oldGeneration), /已清除/);
  assert.deepEqual(await f.inspectHostLocalData("A"), { hasUnconfirmed: false, legacyCache: true });
  await f.drafts.save(scopeA, { ...f.emptyDraft("new-A"), text: "new A draft" });
  assert.equal(
    (await f.drafts.load(scopeA))?.text,
    "new A draft",
    "新的明确操作可使用清理后的代次",
  );
  f.clearLegacyArtifactCache();
  assert.equal(f.hasLegacyArtifactCache(), false);
  assert.equal(f.files.has(fileB.uri), true, "全量旧缓存清理不删除新版 B 缓存");
  unsubscribe();
});

test("按电脑清理失败不报告成功，损坏恢复记录须明确放弃，失败后可重试", async () => {
  const f = await fixture();
  await f.drafts.save(scopeB, { ...f.emptyDraft("B"), text: "keep B" });
  f.values.set(f.draftKey(scopeA), "corrupt pending record");
  await assert.rejects(f.clearHostLocalData("A"), /结果未确认/);
  assert.equal(f.values.get(f.draftKey(scopeA)), "corrupt pending record");
  f.failRemoval();
  await assert.rejects(
    f.clearHostLocalData("A", { discardUnconfirmed: true }),
    /native storage removal failed/,
  );
  f.allowRemoval();
  await f.clearHostLocalData("A", { discardUnconfirmed: true });
  assert.equal(f.values.has(f.draftKey(scopeA)), false);
  assert.equal((await f.drafts.load(scopeB))?.text, "keep B");
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { createArtifactExporter } from "../../../apps/desktop/src/main/artifact-export.js";
import { createArtifactBridge } from "../../../apps/desktop/src/preload/artifact-bridge.js";

const reference = {
  workspacePath: "/trusted/workspace",
  sessionId: "session-1",
  artifactId: "artifact-1",
};

test("HTML 产物经会话读取与摘要校验后才交给默认应用", async (t) => {
  const bytes = Buffer.from("<!doctype html><title>鹈鹕骑车</title>");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const opened: string[] = [];
  const exporter = createArtifactExporter({
    query: async (params) => {
      assert.equal(params.sessionId, reference.sessionId);
      assert.equal(params.artifactId, reference.artifactId);
      if (params.action === "get")
        return {
          artifacts: [
            {
              artifactId: reference.artifactId,
              title: "pelican-ride.html",
              mimeType: "text/html; charset=utf-8",
              digest,
              sizeBytes: bytes.byteLength,
            },
          ],
        };
      assert.equal(params.action, "read_chunk");
      return {
        contentBase64: bytes.toString("base64"),
        offsetBytes: 0,
        endOffsetBytes: bytes.byteLength,
        totalBytes: bytes.byteLength,
      };
    },
    chooseSavePath: async () => assert.fail("打开不应询问另存位置"),
    revealFile: () => assert.fail("打开默认应用不应在访达中显示"),
    openDefaultApp: async (path) => {
      assert.equal(await readFile(path, "utf8"), bytes.toString("utf8"));
      opened.push(path);
    },
  });
  t.after(() => exporter.dispose());
  await exporter.export(reference, "openInDefaultApp");
  assert.equal(opened.length, 1);
  await exporter.dispose();
  await assert.rejects(stat(opened[0]!));

  const calls: unknown[] = [];
  const bridge = createArtifactBridge({
    invoke: async (...args) => {
      calls.push(args);
      return { ok: true, value: undefined };
    },
  });
  assert.equal((await bridge.openInDefaultApp(reference)).ok, true);
  assert.deepEqual(calls, [["pico:artifact:open-in-default-app", reference]]);
  assert.equal(
    (await bridge.openInDefaultApp({ ...reference, path: "/private/secret" } as never)).ok,
    false,
  );
  assert.equal(calls.length, 1);
});

test("非 HTML、伪装 MIME 与摘要损坏的产物不能交给默认应用", async (t) => {
  const bytes = Buffer.from("<script>document.body.textContent='test'</script>");
  const cases = [
    { title: "report.txt", mimeType: "text/html", digest: digestOf(bytes) },
    { title: "report.html", mimeType: "text/plain", digest: digestOf(bytes) },
    { title: "report.html", mimeType: "text/html", digest: "0".repeat(64) },
  ];
  let opened = 0;
  for (const candidate of cases) {
    const exporter = createArtifactExporter({
      query: async (params) =>
        params.action === "get"
          ? {
              artifacts: [
                {
                  artifactId: reference.artifactId,
                  ...candidate,
                  sizeBytes: bytes.byteLength,
                },
              ],
            }
          : {
              contentBase64: bytes.toString("base64"),
              offsetBytes: 0,
              endOffsetBytes: bytes.byteLength,
              totalBytes: bytes.byteLength,
            },
      chooseSavePath: async () => assert.fail("不应询问另存位置"),
      revealFile: () => assert.fail("不应在访达中显示"),
      openDefaultApp: async () => {
        opened++;
      },
    });
    t.after(() => exporter.dispose());
    await assert.rejects(exporter.export(reference, "openInDefaultApp"));
  }
  assert.equal(opened, 0);
});

function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

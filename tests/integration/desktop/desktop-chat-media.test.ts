import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { parseConversation } from "../../../apps/desktop/src/renderer/conversation/runtime-projection.js";
import { stopTestChildProcess } from "../helpers/test-runtime-daemon.js";

const assets = [
  ["pixel.png", "image/png", "image"],
  ["clip.webm", "video/webm", "video"],
  ["clip.mp4", "video/mp4", "video"],
] as const;

test("媒体单独消息从 Runtime 投影到正文，非法媒体不成为展示能力", async () => {
  const bytes = await readFile(
    new URL("../../fixtures/desktop-media-assets/pixel.png", import.meta.url),
  );
  const media = [
    {
      artifactId: "pixel",
      kind: "image",
      alt: "像素",
      mimeType: "image/png",
      sizeBytes: bytes.length,
      digest: createHash("sha256").update(bytes).digest("hex"),
    },
  ];
  const result = parseConversation(
    {
      items: [
        { id: "user", kind: "userMessage", content: "", media },
        { id: "assistant", kind: "assistantMessage", content: "", media },
        {
          id: "bad",
          kind: "assistantMessage",
          content: "",
          media: [{ ...media[0], digest: "bad" }],
        },
      ],
    },
    "/fixture",
    "session",
  );
  assert.deepEqual(
    result.items.map((item) => item.id),
    ["user", "assistant"],
  );
  for (const item of result.items) {
    assert.ok(item.kind === "userMessage" || item.kind === "assistantMessage");
    assert.deepEqual(item.media, media);
  }
});

test(
  "真实 Electron 聊天图片和短视频：解码、播放/seek、授权边界、侧聊和 Blob 清理",
  { skip: !process.env.PICO_TEST_ELECTRON, timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-chat-media-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    await build({
      entryPoints: [join(repo, "tests/fixtures/desktop-media-electron.renderer.tsx")],
      bundle: true,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"production"' },
      outfile: join(root, "renderer.js"),
    });
    await writeFile(
      join(root, "index.html"),
      "<!doctype html><html><head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src blob:; connect-src 'self'\"><link rel=\"stylesheet\" href=\"renderer.css\"></head><body><div id=\"root\"></div><script src=\"renderer.js\"></script></body></html>",
    );
    const payload = await Promise.all(
      assets.map(async ([name, mimeType, kind]) => {
        const bytes = await readFile(
          new URL(`../../fixtures/desktop-media-assets/${name}`, import.meta.url),
        );
        return {
          reference: {
            artifactId: name,
            kind,
            alt: name,
            mimeType,
            sizeBytes: bytes.length,
            digest: createHash("sha256").update(bytes).digest("hex"),
          },
          base64: bytes.toString("base64"),
        };
      }),
    );
    await writeFile(join(root, "assets.json"), JSON.stringify(payload));
    const child = spawn(
      process.env.PICO_TEST_ELECTRON!,
      [fileURLToPath(new URL("../../fixtures/desktop-media-electron.mjs", import.meta.url)), root],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    t.after(() => stopTestChildProcess(child));
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(output))));
    });
    assert.match(output, /DESKTOP_CHAT_MEDIA_OK/);
    console.log(output);
  },
);

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { stopTestChildProcess } from "../helpers/test-runtime-daemon.js";

test(
  "Astryx 聊天集成：草稿提交、中文输入、粘贴、96px 跟随与侧聊",
  { skip: !process.env.PICO_TEST_ELECTRON, timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-astryx-chat-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    await Promise.all([
      build({
        entryPoints: [join(repo, "tests/fixtures/astryx-chat-electron.renderer.tsx")],
        bundle: true,
        platform: "browser",
        format: "iife",
        jsx: "automatic",
        define: { "process.env.NODE_ENV": '"production"' },
        outfile: join(root, "renderer.js"),
      }),
      build({
        entryPoints: [join(repo, "tests/fixtures/astryx-chat-electron.ts")],
        bundle: true,
        platform: "node",
        format: "esm",
        packages: "external",
        external: ["electron"],
        outfile: join(root, "main.mjs"),
      }),
    ]);
    await writeFile(
      join(root, "index.html"),
      '<!doctype html><html><head><link rel="stylesheet" href="renderer.css"><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}button{font:inherit}</style></head><body><div id="root"></div><script src="renderer.js"></script></body></html>',
    );
    const child = spawn(process.env.PICO_TEST_ELECTRON!, [join(root, "main.mjs"), root], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => stopTestChildProcess(child));
    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(output))));
    });
    assert.match(output, /ASTRYX_CHAT_ELECTRON_OK/);
    console.log(output);
  },
);

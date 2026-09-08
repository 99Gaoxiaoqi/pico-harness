import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

test(
  "子 Agent 设置在浏览器完成创建编辑启停删除、模型联动及保存失败恢复",
  { timeout: 45_000 },
  async (t) => {
    const candidates = [
      process.env.PICO_TEST_CHROME,
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ].filter((value): value is string => Boolean(value));
    let chrome: string | undefined;
    for (const candidate of candidates) {
      if (
        await access(candidate).then(
          () => true,
          () => false,
        )
      ) {
        chrome = candidate;
        break;
      }
    }
    if (!chrome) {
      t.skip("需要 Chrome/Chromium，可通过 PICO_TEST_CHROME 指定浏览器");
      return;
    }
    const bundle = await build({
      entryPoints: [
        fileURLToPath(
          new URL("../../fixtures/desktop-subagent-settings-browser.tsx", import.meta.url),
        ),
      ],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"development"' },
    });
    const script = bundle.outputFiles[0]?.text;
    assert.ok(script);
    const outcome = Promise.withResolvers<string>();
    const server = createServer((request, response) => {
      if (request.url === "/result") {
        let body = "";
        request.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        request.on("end", () => {
          response.end("ok");
          outcome.resolve(body);
        });
        return;
      }
      response.setHeader(
        "content-type",
        request.url === "/bundle.js" ? "text/javascript" : "text/html",
      );
      response.end(
        request.url === "/bundle.js"
          ? script
          : '<!doctype html><html><body><div id="app"></div><pre id="result">RUNNING</pre><script src="/bundle.js"></script></body></html>',
      );
    });
    const profile = await mkdtemp(join(tmpdir(), "pico-subagent-ui-"));
    let browser: ChildProcess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      browser = spawn(
        chrome,
        [
          "--headless=new",
          "--disable-gpu",
          "--disable-background-networking",
          "--no-first-run",
          "--no-default-browser-check",
          `--user-data-dir=${profile}`,
          `http://127.0.0.1:${address.port}`,
        ],
        { stdio: "ignore" },
      );
      browser.once("error", outcome.reject);
      timer = setTimeout(
        () => outcome.reject(new Error("Browser UI scenario did not finish in 30 seconds")),
        30_000,
      );
      const result = await outcome.promise;
      assert.match(result, /^PASS: preset UI lifecycle and failure recovery$/, result);
    } finally {
      clearTimeout(timer);
      if (browser && browser.exitCode === null && browser.signalCode === null) {
        const closed = new Promise<void>((resolve) => browser!.once("exit", () => resolve()));
        browser.kill("SIGTERM");
        await closed;
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
);

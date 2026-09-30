import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

for (const engine of ["Chrome", "Electron"] as const) {
  test(
    `${engine} 桌面命令输入、补全、会话选择和回退对话框完整交互`,
    { timeout: 45_000 },
    async (t) => {
      const candidates =
        engine === "Electron"
          ? [
              process.env.PICO_TEST_ELECTRON,
              fileURLToPath(
                new URL(
                  "../../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
                  import.meta.url,
                ),
              ),
              fileURLToPath(
                new URL("../../../node_modules/electron/dist/electron", import.meta.url),
              ),
            ].filter((value): value is string => Boolean(value))
          : [
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
        t.skip(`需要 ${engine}，可通过 PICO_TEST_CHROME/PICO_TEST_ELECTRON 指定可执行文件`);
        return;
      }
      const bundle = await build({
        stdin: {
          contents: await readFile(
            new URL("../../fixtures/desktop-slash-commands-browser.tsx", import.meta.url),
            "utf8",
          ),
          resolveDir: fileURLToPath(new URL("../../fixtures/", import.meta.url)),
          loader: "tsx",
        },
        outdir: "/virtual-pico-pages",
        plugins: [
          {
            name: "vite-brand-assets",
            setup(bundler) {
              bundler.onLoad({ filter: /ComposerModelPicker\.tsx$/ }, async ({ path }) => ({
                contents: (await readFile(path, "utf8")).replace(
                  /const marks = import\.meta\.glob<string>\([\s\S]*?\n\}\);/u,
                  "const marks: Record<string, string> = {};",
                ),
                loader: "tsx",
              }));
            },
          },
        ],
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        jsx: "automatic",
        define: { "process.env.NODE_ENV": '"development"' },
      });
      const script = bundle.outputFiles.find((file) => file.path.endsWith(".js"))?.text;
      const css = bundle.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "";
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
          request.url === "/bundle.js"
            ? "text/javascript"
            : request.url === "/bundle.css"
              ? "text/css"
              : "text/html",
        );
        response.end(
          request.url === "/bundle.js"
            ? script
            : request.url === "/bundle.css"
              ? css
              : '<!doctype html><html><head><link rel="stylesheet" href="/bundle.css"></head><body><div id="app"></div><pre id="result">RUNNING</pre><script src="/bundle.js"></script></body></html>',
        );
      });
      const profile = await mkdtemp(join(tmpdir(), "pico-command-ui-"));
      if (engine === "Electron") {
        await symlink(
          fileURLToPath(new URL("../../../node_modules", import.meta.url)),
          join(profile, "node_modules"),
          "dir",
        );
        await build({
          entryPoints: [
            fileURLToPath(
              new URL("../../fixtures/desktop-slash-commands-electron.ts", import.meta.url),
            ),
          ],
          outfile: join(profile, "main.mjs"),
          bundle: true,
          platform: "node",
          format: "esm",
          packages: "external",
        });
        await build({
          entryPoints: [
            fileURLToPath(
              new URL("../../fixtures/desktop-slash-commands-preload.ts", import.meta.url),
            ),
          ],
          outfile: join(profile, "preload.cjs"),
          bundle: true,
          platform: "node",
          format: "cjs",
          external: ["electron"],
        });
      }
      let browser: ChildProcess | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stderr = "";
      try {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        browser = spawn(
          chrome,
          engine === "Electron"
            ? [join(profile, "main.mjs"), profile, `http://127.0.0.1:${address.port}`]
            : [
                "--headless=new",
                "--disable-gpu",
                "--window-size=1280,900",
                "--disable-background-networking",
                "--no-first-run",
                "--no-default-browser-check",
                `--user-data-dir=${profile}`,
                `http://127.0.0.1:${address.port}`,
              ],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        browser.stderr?.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        browser.once("error", outcome.reject);
        browser.once("exit", (code) => {
          if (code !== null && code !== 0)
            outcome.reject(new Error(`${engine} exited ${code}: ${stderr}`));
        });
        timer = setTimeout(
          () =>
            outcome.reject(
              new Error(`Browser UI scenario did not finish in 30 seconds: ${stderr}`),
            ),
          30_000,
        );
        const result = await outcome.promise;
        assert.match(result, /^PASS: desktop commands$/, result);
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
}

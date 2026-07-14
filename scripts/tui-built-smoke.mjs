import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { startFakeOpenAiServer } from "./fake-openai-server.mjs";

const EXPECTED = "PICO_BUILT_TUI_SMOKE_OK";
const TIMEOUT_MS = 30_000;

async function main() {
  await ensureNodePtyHelperExecutable();
  const pty = await loadNodePty();
  const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const entry = join(repoRoot, "dist", "cli", "main.js");
  const { resolvePicoPaths } = await import("../dist/paths/pico-paths.js");
  await runBuiltTuiScenario({ pty, repoRoot, entry, resolvePicoPaths, term: "xterm-256color" });
  await runBuiltTuiScenario({ pty, repoRoot, entry, resolvePicoPaths, term: "dumb" });
  await runBuiltTuiScenario({
    pty,
    repoRoot,
    entry,
    resolvePicoPaths,
    term: "dumb",
    interrupt: true,
  });
}

async function runBuiltTuiScenario({
  pty,
  repoRoot,
  entry,
  resolvePicoPaths,
  term,
  interrupt = false,
}) {
  const workDir = await mkdtemp(join(tmpdir(), "pico-built-tui-smoke-"));
  const homeDir = await mkdtemp(join(tmpdir(), "pico-built-tui-home-"));
  const picoHome = join(homeDir, "pico-home");
  const fakeServer = await startFakeOpenAiServer({
    content: EXPECTED,
    ...(interrupt ? { delayMs: 1_200 } : {}),
  });
  const alternateFakeServer =
    term === "dumb" ? await startFakeOpenAiServer({ content: "WRONG_ROUTE" }) : undefined;
  let terminal;

  try {
    if (term === "dumb") {
      await mkdir(join(workDir, ".pico"), { recursive: true });
      await writeFile(
        join(workDir, ".pico", "config.json"),
        JSON.stringify({
          model: "configured-primary/shared-model",
          providers: {
            "configured-primary": {
              protocol: "openai",
              baseURL: fakeServer.baseURL,
              apiKeyEnv: "PICO_TUI_SMOKE_CONFIGURED_KEY",
              models: ["shared-model"],
              discoverModels: false,
            },
            "configured-secondary": {
              protocol: "openai",
              baseURL: alternateFakeServer.baseURL,
              apiKeyEnv: "PICO_TUI_SMOKE_CONFIGURED_KEY",
              models: ["shared-model"],
              discoverModels: false,
            },
          },
        }),
      );
    }
    terminal = pty.spawn(
      process.execPath,
      [
        entry,
        "--dir",
        workDir,
        "--provider",
        "openai",
        ...(term === "dumb" ? [] : ["--model", "fake-model"]),
        "--thinking",
        "false",
      ],
      {
        // node-pty 用 name 覆盖子进程 TERM；两种入口都必须走真实 PTY。
        name: term,
        cols: 100,
        rows: 30,
        cwd: repoRoot,
        env: {
          ...process.env,
          TERM: term,
          CODEX_SHELL: "1",
          CI: "false",
          LOG_LEVEL: "error",
          // 双 provider 场景需要验证首轮 route ID 已写回会话；xterm 冒烟仍可
          // 关闭持久化以保持原有的最小启动路径。
          PICO_PERSISTENCE: term === "dumb" ? "1" : "0",
          HOME: homeDir,
          USERPROFILE: homeDir,
          PICO_HOME: picoHome,
          LLM_BASE_URL: fakeServer.baseURL,
          LLM_API_KEY: "local-test-key",
          LLM_MODEL: "fake-model",
          PICO_TUI_SMOKE_CONFIGURED_KEY: "configured-test-key",
        },
      },
    );

    const output = await driveTerminal(terminal, { lineMode: term === "dumb", interrupt });
    const plainOutput = stripAnsi(output);
    if (!interrupt && !plainOutput.includes(EXPECTED)) {
      throw new Error(`built TUI (${term}) never rendered ${EXPECTED}\n${tail(plainOutput)}`);
    }
    if (term === "dumb" && !plainOutput.includes("兼容行模式")) {
      throw new Error(`built TUI did not enter TERM=dumb line mode\n${tail(plainOutput)}`);
    }
    if (term !== "dumb" && plainOutput.includes("兼容行模式")) {
      throw new Error(
        `built TUI unexpectedly left the full Ink entry (${term})\n${tail(plainOutput)}`,
      );
    }
    if (fakeServer.requestCount === 0) {
      throw new Error("built TUI made zero requests to the local fake OpenAI endpoint");
    }
    if (interrupt) {
      if (!plainOutput.includes("当前请求已中断。")) {
        throw new Error(`TERM=dumb Ctrl+C did not abort the active run\n${tail(plainOutput)}`);
      }
      if (fakeServer.requestCount !== 1) {
        throw new Error(
          `TERM=dumb Ctrl+C expected one interrupted request, got ${fakeServer.requestCount}`,
        );
      }
      console.log("PASS built TUI dumb Ctrl+C abort smoke");
      return;
    }
    if (term === "dumb") {
      if (output.includes(`${String.fromCharCode(27)}[`)) {
        throw new Error(`TERM=dumb line mode emitted CSI output\n${tail(output)}`);
      }
      if (fakeServer.requestCount !== 2) {
        throw new Error(`TERM=dumb expected two turns, got ${fakeServer.requestCount}`);
      }
      const serializedRequests = fakeServer.requests.map((request) => JSON.stringify(request));
      if (!serializedRequests[0]?.includes("first corrected prompt")) {
        throw new Error("TERM=dumb did not submit the backspace-corrected first prompt");
      }
      if (serializedRequests[0]?.includes("first corrected promptX")) {
        throw new Error("TERM=dumb sent the character that Backspace should have removed");
      }
      if (
        !serializedRequests[1]?.includes("second continuation prompt") ||
        !serializedRequests[1]?.includes("first corrected prompt") ||
        !serializedRequests[1]?.includes(EXPECTED)
      ) {
        throw new Error("TERM=dumb second request did not continue the first session conversation");
      }
      if (fakeServer.requests.some((request) => request.model !== "shared-model")) {
        throw new Error("TERM=dumb did not reuse the configured model route");
      }
      if (alternateFakeServer.requestCount !== 0) {
        throw new Error("TERM=dumb routed a same-name model turn to the wrong configured endpoint");
      }
      const persistedSession = await readPersistedSession(workDir, picoHome, resolvePicoPaths);
      if (!persistedSession.includes('"modelRouteId":"configured-primary/shared-model"')) {
        throw new Error("TERM=dumb did not persist the selected provider/model route identity");
      }
    }
    console.log(`PASS built TUI ${term} PTY smoke (${fakeServer.requestCount} local request(s))`);
  } finally {
    try {
      terminal?.kill();
    } catch {
      // The PTY may already have exited after Ctrl+C.
    }
    await fakeServer.close();
    await alternateFakeServer?.close();
    await rm(workDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
}

async function readPersistedSession(workDir, picoHome, resolvePicoPaths) {
  const sessionsDir = resolvePicoPaths(workDir, { picoHome }).workspace.sessions;
  const files = (await readdir(sessionsDir)).filter((file) => file.endsWith(".jsonl"));
  return (await Promise.all(files.map((file) => readFile(join(sessionsDir, file), "utf8")))).join(
    "\n",
  );
}

async function ensureNodePtyHelperExecutable() {
  if (process.platform === "win32") return;

  const require = createRequire(import.meta.url);
  const packageRoot = dirname(require.resolve("node-pty/package.json"));
  const candidates = [
    join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    join(packageRoot, "build", "Release", "spawn-helper"),
  ];

  for (const candidate of candidates) {
    try {
      await chmod(candidate, 0o755);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw new Error(`cannot make node-pty helper executable: ${candidate}`, { cause: error });
    }
  }
}

async function loadNodePty() {
  try {
    return await import("node-pty");
  } catch (error) {
    throw new Error(
      `node-pty is required for the built TUI smoke. Add it as a devDependency. (${formatError(error)})`,
      { cause: error },
    );
  }
}

function driveTerminal(terminal, { lineMode, interrupt }) {
  return new Promise((resolvePromise, reject) => {
    let output = "";
    let trustAccepted = false;
    let promptScheduled = false;
    let helpScheduled = false;
    let firstPromptScheduled = false;
    let secondPromptScheduled = false;
    let interruptPromptScheduled = false;
    let interruptScheduled = false;
    let exitScheduled = false;
    let promptTimer;
    let actionTimer;
    const timer = setTimeout(() => {
      reject(new Error(`built TUI smoke timed out\n${tail(stripAnsi(output))}`));
    }, TIMEOUT_MS);

    terminal.onData((chunk) => {
      output += chunk;
      const plain = stripAnsi(output);
      if (!trustAccepted && plain.includes("Pico 需要信任此工作区")) {
        trustAccepted = true;
        terminal.write("1\r");
      }
      if (!lineMode && !promptScheduled && /Try .*for commands/iu.test(plain)) {
        promptScheduled = true;
        // Wait until Ink has installed raw-mode input handlers. Writing on the
        // first rendered byte can race with mount and lose the submitted line.
        promptTimer = setTimeout(() => {
          terminal.write("Reply with the required smoke marker. Do not use tools.\r");
        }, 250);
      }
      if (!lineMode && !exitScheduled && plain.includes(EXPECTED)) {
        exitScheduled = true;
        actionTimer = setTimeout(() => terminal.write("\x04"), 100);
      }
      if (lineMode && interrupt && !interruptPromptScheduled && plain.includes("pico> ")) {
        interruptPromptScheduled = true;
        actionTimer = setTimeout(() => {
          terminal.write("interrupt this active request\r");
          actionTimer = setTimeout(() => terminal.write("\x03"), 250);
          interruptScheduled = true;
        }, 100);
      }
      if (
        lineMode &&
        interrupt &&
        interruptScheduled &&
        !exitScheduled &&
        plain.includes("当前请求已中断。") &&
        occurrences(plain, "pico> ") >= 2
      ) {
        exitScheduled = true;
        actionTimer = setTimeout(() => terminal.write("/exit\r"), 100);
      }
      if (lineMode && !interrupt && !helpScheduled && plain.includes("pico> ")) {
        helpScheduled = true;
        actionTimer = setTimeout(() => terminal.write("/help\r"), 100);
      }
      if (
        lineMode &&
        !interrupt &&
        helpScheduled &&
        !firstPromptScheduled &&
        plain.includes("兼容行模式仅支持")
      ) {
        firstPromptScheduled = true;
        actionTimer = setTimeout(() => {
          // terminal:false 下由 TTY canonical discipline 消化 DEL；这条断言覆盖
          // 用户真实输入的退格编辑，而不是只检查画面中有没有 ANSI。
          terminal.write("first corrected promptX\x7f\r");
        }, 100);
      }
      const promptCount = occurrences(plain, "pico> ");
      const responseCount = occurrences(plain, EXPECTED);
      if (
        lineMode &&
        !interrupt &&
        firstPromptScheduled &&
        !secondPromptScheduled &&
        responseCount >= 1 &&
        promptCount >= 3
      ) {
        secondPromptScheduled = true;
        actionTimer = setTimeout(() => terminal.write("second continuation prompt\r"), 100);
      }
      if (
        lineMode &&
        !interrupt &&
        secondPromptScheduled &&
        !exitScheduled &&
        responseCount >= 2 &&
        promptCount >= 4
      ) {
        exitScheduled = true;
        actionTimer = setTimeout(() => terminal.write("/exit\r"), 100);
      }
    });

    terminal.onExit(({ exitCode, signal }) => {
      clearTimeout(timer);
      clearTimeout(promptTimer);
      clearTimeout(actionTimer);
      if (!exitScheduled) {
        reject(
          new Error(
            `built TUI exited before rendering the expected response (exit=${exitCode}, signal=${signal})\n${tail(stripAnsi(output))}`,
          ),
        );
        return;
      }
      resolvePromise(output);
    });
  });
}

function occurrences(text, needle) {
  return text.split(needle).length - 1;
}

function stripAnsi(text) {
  const escape = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  return text
    .replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, "gu"), "")
    .replace(new RegExp(`${escape}\\][^${bell}]*(?:${bell}|${escape}\\\\)`, "gu"), "");
}

function tail(text) {
  return text.slice(-2_000);
}

function formatError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

await main();

import { chmod, mkdtemp, rm } from "node:fs/promises";
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
  const workDir = await mkdtemp(join(tmpdir(), "pico-built-tui-smoke-"));
  const homeDir = await mkdtemp(join(tmpdir(), "pico-built-tui-home-"));
  const fakeServer = await startFakeOpenAiServer({ content: EXPECTED });
  let terminal;

  try {
    terminal = pty.spawn(
      process.execPath,
      [
        entry,
        "--dir",
        workDir,
        "--provider",
        "openai",
        "--model",
        "fake-model",
        "--thinking",
        "false",
      ],
      {
        // node-pty 用 name 覆盖子进程 TERM；必须设为 dumb 才能覆盖兼容入口。
        name: "dumb",
        cols: 100,
        rows: 30,
        cwd: repoRoot,
        env: {
          ...process.env,
          // 覆盖 Codex 内嵌终端的保守渲染分支：终端仍由 node-pty 提供
          // 交互输入，但应用不可假定 alternate screen/增量差分可用。
          TERM: "dumb",
          CODEX_SHELL: "1",
          CI: "false",
          LOG_LEVEL: "error",
          PICO_PERSISTENCE: "0",
          HOME: homeDir,
          USERPROFILE: homeDir,
          LLM_BASE_URL: fakeServer.baseURL,
          LLM_API_KEY: "local-test-key",
          LLM_MODEL: "fake-model",
        },
      },
    );

    const output = await driveTerminal(terminal);
    const plainOutput = stripAnsi(output);
    if (!plainOutput.includes(EXPECTED)) {
      throw new Error(`built TUI never rendered ${EXPECTED}\n${tail(plainOutput)}`);
    }
    if (!plainOutput.includes("兼容行模式")) {
      throw new Error(`built TUI did not enter TERM=dumb line mode\n${tail(plainOutput)}`);
    }
    if (fakeServer.requestCount === 0) {
      throw new Error("built TUI made zero requests to the local fake OpenAI endpoint");
    }
    console.log(`PASS built TUI PTY smoke (${fakeServer.requestCount} local request(s))`);
  } finally {
    try {
      terminal?.kill();
    } catch {
      // The PTY may already have exited after Ctrl+C.
    }
    await fakeServer.close();
    await rm(workDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  }
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

function driveTerminal(terminal) {
  return new Promise((resolvePromise, reject) => {
    let output = "";
    let trustAccepted = false;
    let promptScheduled = false;
    let stopScheduled = false;
    let promptTimer;
    let stopTimer;
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
      if (!promptScheduled && (/Try .*for commands/iu.test(plain) || plain.includes("pico> "))) {
        promptScheduled = true;
        // Wait until Ink has installed raw-mode input handlers. Writing on the
        // first rendered byte can race with mount and lose the submitted line.
        promptTimer = setTimeout(() => {
          terminal.write("Reply with the required smoke marker. Do not use tools.\r");
        }, 250);
      }
      if (!stopScheduled && plain.includes(EXPECTED)) {
        stopScheduled = true;
        stopTimer = setTimeout(() => terminal.write("\x04"), 100);
      }
    });

    terminal.onExit(({ exitCode, signal }) => {
      clearTimeout(timer);
      clearTimeout(promptTimer);
      clearTimeout(stopTimer);
      if (!stopScheduled) {
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

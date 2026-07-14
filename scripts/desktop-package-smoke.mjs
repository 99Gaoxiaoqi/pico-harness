import { constants } from "node:fs";
import { access, mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";

const execFileAsync = promisify(execFile);

const desktopRoot = resolve(process.cwd());
const packageRoot = join(desktopRoot, "out", `Pico-${process.platform}-${process.arch}`);
const resourcesRoot =
  process.platform === "darwin"
    ? join(packageRoot, "Pico.app", "Contents", "Resources")
    : join(packageRoot, "resources");
const unpackedModules = join(resourcesRoot, "app.asar.unpacked", "node_modules");

await access(join(resourcesRoot, "app.asar"));
const nativeBindings = await collectNativeBindings(unpackedModules);
for (const expected of ["better_sqlite3.node", "pty.node"]) {
  if (!nativeBindings.some((path) => path.endsWith(expected))) {
    throw new Error(`桌面安装包缺少原生 Runtime 依赖: ${expected}`);
  }
}
if (process.platform !== "win32") {
  await access(
    join(
      unpackedModules,
      "node-pty",
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    ),
    constants.X_OK,
  );
}

const executable =
  process.platform === "darwin"
    ? join(packageRoot, "Pico.app", "Contents", "MacOS", "Pico")
    : join(packageRoot, "Pico.exe");
const nativeSmokeSource = String.raw`
const root = process.argv[1];
const Database = require(root + "/app.asar/node_modules/better-sqlite3");
const database = new Database(":memory:");
database.exec("select 1");
database.close();
const pty = require(root + "/app.asar/node_modules/node-pty");
if (process.platform === "win32") {
  process.stdout.write(typeof pty.spawn === "function" ? "PICO_NATIVE_OK" : "");
} else {
  const terminal = pty.spawn("/bin/sh", ["-lc", "printf PICO_NATIVE_OK"], { cols: 80, rows: 24 });
  let output = "";
  terminal.onData((data) => (output += data));
  terminal.onExit(() => process.stdout.write(output));
}
`;
const { stdout } = await execFileAsync(executable, ["-e", nativeSmokeSource, resourcesRoot], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
});
if (stdout.trim() !== "PICO_NATIVE_OK") {
  throw new Error(`桌面安装包原生模块运行失败: ${JSON.stringify(stdout)}`);
}
await runApplicationSmoke(executable);

process.stdout.write(`桌面安装包原生依赖验证通过（${nativeBindings.length} 个 binding）\n`);
process.stdout.write("桌面安装包主窗口、Preload、IPC 与 Runtime daemon 验证通过\n");

async function collectNativeBindings(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await collectNativeBindings(path)));
    else if (entry.isFile() && entry.name.endsWith(".node")) paths.push(path);
  }
  return paths;
}

async function runApplicationSmoke(applicationExecutable) {
  const root = await mkdtemp(join(tmpdir(), "pico-desktop-smoke-"));
  const userData = join(root, "user-data");
  const runtimeDirectory = join(root, "runtime");
  const picoHome = join(root, "pico-home");
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
    mkdir(picoHome, { recursive: true }),
  ]);
  const port = await reservePort();
  const output = [];
  const child = spawn(
    applicationExecutable,
    [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${userData}`,
    ],
    {
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        PICO_HOME: picoHome,
        XDG_RUNTIME_DIR: runtimeDirectory,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => appendOutput(output, chunk));
  child.stderr.on("data", (chunk) => appendOutput(output, chunk));

  try {
    const target = await waitForPageTarget(port, child, output);
    await waitForRuntimePing(target.webSocketDebuggerUrl);
    await evaluateInTarget(target.webSocketDebuggerUrl, "globalThis.pico.lifecycle.quit()").catch(
      () => undefined,
    );
    await waitForExit(child, 10_000);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n桌面应用输出:\n${output.join("").slice(-20_000)}`,
      { cause: error },
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await waitForExit(child, 5_000).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

async function waitForRuntimePing(webSocketUrl) {
  const deadline = Date.now() + 15_000;
  let lastResult;
  while (Date.now() < deadline) {
    lastResult = await evaluateInTarget(
      webSocketUrl,
      String.raw`(async () => {
        const bridge = globalThis.pico;
        if (typeof bridge?.runtime?.["runtime.ping"] !== "function") {
          return { ok: false, stage: "preload" };
        }
        const result = await bridge.runtime["runtime.ping"]({});
        return { ok: result?.ok === true && result.value?.pong === true, result };
      })()`,
    ).catch((error) => ({ ok: false, stage: "evaluate", error: String(error) }));
    if (lastResult?.ok === true) return;
    await delay(100);
  }
  throw new Error(`桌面应用 Runtime ping 失败: ${JSON.stringify(lastResult)}`);
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
  if (!port) throw new Error("无法为桌面应用验证分配端口");
  return port;
}

async function waitForPageTarget(port, child, output) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`桌面应用在主窗口就绪前退出 (${child.exitCode})`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const targets = await response.json();
        const page = Array.isArray(targets)
          ? targets.find(
              (target) =>
                target?.type === "page" && typeof target.webSocketDebuggerUrl === "string",
            )
          : undefined;
        if (page) return page;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `桌面应用未在 30 秒内创建 renderer 目标${lastError ? `: ${String(lastError)}` : ""}\n${output.join("").slice(-4_000)}`,
  );
}

async function evaluateInTarget(webSocketUrl, expression) {
  return await new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("桌面应用 renderer 验证超时"));
    }, 10_000);
    const finish = (error, value) => {
      clearTimeout(timeout);
      socket.close();
      if (error) reject(error);
      else resolvePromise(value);
    };
    socket.addEventListener("error", () => finish(new Error("无法连接桌面应用 renderer")), {
      once: true,
    });
    socket.addEventListener(
      "open",
      () =>
        socket.send(
          JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: { expression, awaitPromise: true, returnByValue: true },
          }),
        ),
      { once: true },
    );
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      if (message.error || message.result?.exceptionDetails) {
        finish(
          new Error(
            `renderer 执行失败: ${JSON.stringify(message.error ?? message.result.exceptionDetails)}`,
          ),
        );
        return;
      }
      finish(undefined, message.result?.result?.value);
    });
  });
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error("桌面应用未按时退出")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolvePromise();
    });
  });
}

function appendOutput(output, chunk) {
  output.push(chunk.toString("utf8"));
  if (output.length > 200) output.shift();
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

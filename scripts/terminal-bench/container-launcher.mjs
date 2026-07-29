import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const secretEnv = "PICO_TB_PROVIDER_API_KEY";
const requestPath = "/logs/agent/headless-request.json";
const resultPath = "/logs/agent/pico-result.json";
const exitCodePath = "/logs/agent/pico-exit-code.txt";
const stderrPath = "/logs/agent/pico-stderr.log";
const runnerPath = "/installed-agent/pico/dist/internal/headless-one-shot-runner.js";

const frame = readFileSync(0);
if (frame.length < 10 || frame[8] !== 0x0a) throw new Error("invalid secret frame");
const size = Number.parseInt(frame.subarray(0, 8).toString("ascii"), 16);
if (!Number.isSafeInteger(size) || size < 1 || size > 64 * 1024 || frame.length !== size + 9) {
  throw new Error("invalid secret payload");
}
const secret = frame.subarray(9).toString("utf8");
const dependencyEnv = Object.freeze({ ...process.env, [secretEnv]: secret });
delete process.env[secretEnv];
process.env.LOG_LEVEL = "fatal";

const abortController = new AbortController();
let signalKind;
const cancel = (kind) => {
  signalKind ??= kind;
  abortController.abort(new DOMException(kind, "AbortError"));
};
process.once("SIGINT", () => cancel("SIGINT"));
process.once("SIGTERM", () => cancel("SIGTERM"));

try {
  const { runHeadlessOneShotJson } = await import(runnerPath);
  const outcome = await runHeadlessOneShotJson(readFileSync(requestPath, "utf8"), {
    env: dependencyEnv,
    signal: abortController.signal,
    ...(signalKind ? { signalKind } : {}),
  });
  atomicReplace(resultPath, Buffer.from(`${JSON.stringify(outcome.result)}\n`));
  atomicReplace(exitCodePath, Buffer.from(`${outcome.exitCode}\n`));
  atomicReplace(stderrPath, Buffer.alloc(0));
  process.exit(outcome.exitCode);
} catch {
  atomicReplace(stderrPath, Buffer.from("Pico benchmark launcher failed\n"));
  process.exit(3);
}

function atomicReplace(path, data) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, data);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch (cleanupError) {
      void cleanupError;
    }
    throw error;
  }
}

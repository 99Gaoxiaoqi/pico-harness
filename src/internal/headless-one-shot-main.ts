#!/usr/bin/env node

import { stdin, stdout } from "node:process";
import {
  runHeadlessOneShotJson,
  type HeadlessOneShotOutcome,
  type HeadlessOneShotResultV1,
} from "./headless-one-shot-runner.js";

const MAX_STDIN_BYTES = 2 * 1024 * 1024;

void main();

async function main(): Promise<void> {
  const abortController = new AbortController();
  let signalKind: "SIGINT" | "SIGTERM" | undefined;
  const onSigint = () => {
    signalKind ??= "SIGINT";
    abortController.abort(new DOMException("SIGINT", "AbortError"));
  };
  const onSigterm = () => {
    signalKind ??= "SIGTERM";
    abortController.abort(new DOMException("SIGTERM", "AbortError"));
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  let outcome: HeadlessOneShotOutcome;
  try {
    const raw = await readStdin(abortController.signal);
    outcome = await runHeadlessOneShotJson(raw, {
      signal: abortController.signal,
      ...(signalKind ? { signalKind } : {}),
    });
  } catch {
    outcome = signalKind ? signalBeforeRequest(signalKind) : fallbackFailure();
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }

  const line = `${JSON.stringify(outcome.result)}\n`;
  stdout.write(line, () => process.exit(outcome.exitCode));
}

async function readStdin(signal: AbortSignal): Promise<string> {
  const reading = collectStdin();
  let rejectCanceled!: (reason: unknown) => void;
  const canceled = new Promise<never>((_resolve, reject) => {
    rejectCanceled = reject;
  });
  const onAbort = () =>
    rejectCanceled(signal.reason ?? new DOMException("stdin read canceled", "AbortError"));
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([reading, canceled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function collectStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > MAX_STDIN_BYTES) {
      throw new Error("stdin too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function signalBeforeRequest(signal: "SIGINT" | "SIGTERM"): HeadlessOneShotOutcome {
  const exitCode = signal === "SIGTERM" ? 143 : 130;
  const result: HeadlessOneShotResultV1 = {
    schemaVersion: 1,
    requestId: null,
    status: "canceled",
    sessionId: null,
    workDir: null,
    finalMessage: null,
    usage: { promptTokens: 0, completionTokens: 0, costCNY: 0 },
    durationMs: 0,
    tracePath: null,
    effective: {
      modelRouteId: null,
      thinkingEffort: null,
      permissionMode: null,
      allowedTools: [],
    },
    error: {
      code: signal,
      summary: "The headless process was canceled before a complete request was received.",
    },
    terminationConfirmed: true,
  };
  return { result, exitCode, shutdownConfirmed: true };
}

function fallbackFailure(): HeadlessOneShotOutcome {
  const result: HeadlessOneShotResultV1 = {
    schemaVersion: 1,
    requestId: null,
    status: "invalid_request",
    sessionId: null,
    workDir: null,
    finalMessage: null,
    usage: { promptTokens: 0, completionTokens: 0, costCNY: 0 },
    durationMs: 0,
    tracePath: null,
    effective: {
      modelRouteId: null,
      thinkingEffort: null,
      permissionMode: null,
      allowedTools: [],
    },
    error: {
      code: "STDIN_READ_FAILED",
      summary: "The headless request could not be read from stdin.",
    },
    terminationConfirmed: true,
  };
  return { result, exitCode: 2, shutdownConfirmed: true };
}

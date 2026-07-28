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
    const raw = await readStdin();
    outcome = await runHeadlessOneShotJson(raw, {
      signal: abortController.signal,
      ...(signalKind ? { signalKind } : {}),
    });
  } catch {
    outcome = fallbackFailure();
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }

  const line = `${JSON.stringify(outcome.result)}\n`;
  stdout.write(line, () => process.exit(outcome.exitCode));
}

async function readStdin(): Promise<string> {
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
  };
  return { result, exitCode: 2, shutdownConfirmed: true };
}

#!/usr/bin/env node

import { stdin, stdout } from "node:process";
import {
  bootstrapHeadlessCaseJson,
  type HeadlessBootstrapOutcome,
  type HeadlessBootstrapResultV1,
} from "./headless-bootstrap.js";

const MAX_STDIN_BYTES = 64 * 1024;

process.env.LOG_LEVEL = "fatal";
void main();

async function main(): Promise<void> {
  let outcome: HeadlessBootstrapOutcome;
  try {
    outcome = await bootstrapHeadlessCaseJson(await readStdin());
  } catch {
    outcome = fallbackFailure();
  }
  stdout.write(`${JSON.stringify(outcome.result)}\n`, () => process.exit(outcome.exitCode));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > MAX_STDIN_BYTES) throw new Error("stdin too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function fallbackFailure(): HeadlessBootstrapOutcome {
  const result: HeadlessBootstrapResultV1 = {
    schemaVersion: 1,
    status: "invalid_request",
    workspacePath: null,
    picoHome: null,
    modelRouteId: null,
    configRevision: null,
    error: {
      code: "STDIN_READ_FAILED",
      summary: "The bootstrap request could not be read from stdin.",
    },
  };
  return { result, exitCode: 2 };
}

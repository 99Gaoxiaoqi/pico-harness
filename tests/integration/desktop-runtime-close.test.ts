import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { test } from "node:test";
import {
  createRuntimeRequest,
  DesktopConversationStateStore,
  DesktopRuntimeService,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  WorkspaceRuntimeService,
} from "../../src/daemon/index.js";
import { globalSessionManager } from "../../src/engine/session.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";

test(
  "Desktop close fences new handles and drains an already-admitted request",
  { timeout: 15_000 },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-desktop-close-fence-"));
    const picoHome = join(root, "pico-home");
    await mkdir(picoHome, { recursive: true });
    const runtime = new WorkspaceRuntimeService({
      env: { PICO_HOME: picoHome },
      execute: async () => undefined,
    });
    const desktop = new DesktopRuntimeService({
      runtimeService: runtime,
      env: { PICO_HOME: picoHome },
    });
    const requestEntered = deferred();
    const releaseRequest = deferred();
    const order: string[] = [];
    const originalHandle = runtime.handle.bind(runtime);
    runtime.handle = async (request) => {
      if (request.method === "runtime.ping") {
        requestEntered.resolve();
        await releaseRequest.promise;
        order.push("request-finished");
      }
      return originalHandle(request);
    };
    const originalCloseRuntimes = runtime.closeRuntimes.bind(runtime);
    runtime.closeRuntimes = async () => {
      order.push("close-runtimes");
      await originalCloseRuntimes();
    };
    context.after(async () => {
      releaseRequest.resolve();
      await desktop.close();
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    });

    const inFlight = desktop.handle(createRuntimeRequest("runtime.ping", {}));
    await requestEntered.promise;
    const closing = desktop.close();
    await assert.rejects(
      desktop.handle(createRuntimeRequest("runtime.ping", {})),
      (error: unknown) =>
        error instanceof RuntimeProtocolError &&
        error.code === RUNTIME_ERROR_CODES.CONFLICT &&
        /正在关闭/u.test(error.message),
    );
    await waitForImmediate();
    assert.deepEqual(order, []);

    releaseRequest.resolve();
    await inFlight;
    await closing;
    assert.equal(order[0], "request-finished");
    assert.ok(order.slice(1).length > 0);
    assert.ok(order.slice(1).every((entry) => entry === "close-runtimes"));
  },
);

test(
  "shutdown run.finished does not consume another queued input",
  { timeout: 15_000 },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-desktop-close-queue-"));
    const workspace = join(root, "workspace");
    const picoHome = join(root, "pico-home");
    await mkdir(join(workspace, ".pico"), { recursive: true });
    await mkdir(picoHome, { recursive: true });
    await writeFile(
      join(workspace, ".pico", "config.json"),
      JSON.stringify({
        version: 1,
        model: "test/coder",
        providers: {
          test: {
            protocol: "openai",
            baseURL: "https://provider.invalid/v1",
            apiKeyEnv: "PICO_TEST_TOKEN",
            discoverModels: false,
            models: ["coder"],
          },
        },
      }),
      "utf8",
    );
    const canonicalWorkspace = await realpath(workspace);
    const env = { PICO_HOME: picoHome, PICO_TEST_TOKEN: "test-token" };
    const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
    await trustStore.trust(canonicalWorkspace);
    let queueSequence = 0;
    const conversationState = new DesktopConversationStateStore({
      picoHome,
      generateId: () => `queue-${++queueSequence}`,
    });
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const secondStarted = deferred();
    const releaseAdmission = deferred();
    const queueAdmitted = deferred();
    const order: string[] = [];
    const observedRunStartKeys: string[] = [];
    let executions = 0;
    const runtime = new WorkspaceRuntimeService({
      env,
      execute: async ({ context: runContext }) => {
        executions++;
        if (executions === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
          return { turn: 1 };
        }
        if (executions === 2) {
          secondStarted.resolve();
          await rejectWhenAborted(runContext.signal);
        }
        throw new Error("third queued input must not start during shutdown");
      },
    });
    const originalStartForegroundRun = runtime.startForegroundRun.bind(runtime);
    let interceptNextStart = false;
    runtime.startForegroundRun = async (input) => {
      if (input.idempotencyKey) observedRunStartKeys.push(input.idempotencyKey);
      if (interceptNextStart) {
        interceptNextStart = false;
        order.push("queue-admitted");
        queueAdmitted.resolve();
        await releaseAdmission.promise;
      }
      const result = await originalStartForegroundRun(input);
      order.push("queue-started");
      return result;
    };
    const managedSessionId = "session-close-queue";
    const desktop = new DesktopRuntimeService({
      runtimeService: runtime,
      trustStore,
      conversationStateStore: conversationState,
      env,
      createSessionId: () => managedSessionId,
    });
    const originalListQueued = conversationState.listQueued.bind(conversationState);
    let trackClosingQueueReads = false;
    let closingQueueReads = 0;
    conversationState.listQueued = async (...args) => {
      if (trackClosingQueueReads) closingQueueReads++;
      return originalListQueued(...args);
    };
    context.after(async () => {
      releaseFirst.resolve();
      releaseAdmission.resolve();
      await desktop.close();
      const session = globalSessionManager.delete(managedSessionId, canonicalWorkspace, {
        picoHome,
      });
      await session?.close();
      await rm(root, { recursive: true, force: true });
    });

    const first = asRecord(
      await desktop.handle(
        createRuntimeRequest("session.send", {
          workspacePath: workspace,
          input: { text: "first" },
          idempotencyKey: "close-queue-first",
        }),
      ),
    );
    const session = asRecord(first["session"]);
    const firstRun = asRecord(first["run"]);
    const sessionId = requiredString(session["sessionId"], "sessionId");
    assert.equal(sessionId, managedSessionId);
    const firstRunId = requiredString(firstRun["runId"], "runId");
    await firstStarted.promise;

    for (const [text, key] of [
      ["second", "close-queue-second"],
      ["third", "close-queue-third"],
    ] as const) {
      await desktop.handle(
        createRuntimeRequest("session.send", {
          workspacePath: workspace,
          sessionId,
          input: { text },
          behavior: "queue",
          expectedRunId: firstRunId,
          idempotencyKey: key,
        }),
      );
    }

    interceptNextStart = true;
    const originalCloseRuntimes = runtime.closeRuntimes.bind(runtime);
    runtime.closeRuntimes = async () => {
      order.push("close-runtimes");
      await originalCloseRuntimes();
    };

    releaseFirst.resolve();
    await queueAdmitted.promise;
    trackClosingQueueReads = true;
    const closing = desktop.close();
    await waitForImmediate();
    assert.equal(order.includes("close-runtimes"), false);

    releaseAdmission.resolve();
    await closing;
    await secondStarted.promise;
    trackClosingQueueReads = false;
    assert.equal(executions, 2);
    assert.equal(closingQueueReads, 0);
    assert.deepEqual(observedRunStartKeys, [
      `desktop-send-run:${sha256("close-queue-first")}`,
      `desktop-queue-run:${sha256("queue-1")}`,
    ]);
    const queued = await originalListQueued(canonicalWorkspace, sessionId);
    assert.deepEqual(
      queued.map((entry) => entry.input),
      [{ text: "third" }],
    );
    assert.ok(order.indexOf("queue-started") < order.indexOf("close-runtimes"));
  },
);

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const fail = () => reject(signal.reason ?? new Error("runtime closed"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

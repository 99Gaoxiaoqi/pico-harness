import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { test } from "node:test";
import type { LLMProvider, LLMProviderRequestOptions } from "../../src/provider/interface.js";
import type { Message } from "../../src/schema/message.js";
import { createToolResultEnvelope } from "../../src/engine/tool-result-contract.js";
import { EMPTY_USER_CONFIG_REVISION, UserConfigStore } from "../../src/input/user-config-store.js";
import {
  runHeadlessOneShotJson,
  terminalBenchAgentControlledProxyCapability,
  type HeadlessOneShotRequestV1,
} from "../../src/internal/headless-one-shot-runner.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import type { RunAgentCliOptions, RunAgentCliResult } from "../../src/runtime/runtime-contract.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { RuntimeEventStore } from "../../src/storage/runtime-event-store.js";

const PROVIDER_ID = "fixture";
const MODEL_ID = "fixture-model";
const ROUTE_ID = `${PROVIDER_ID}/${MODEL_ID}`;
type RunAgentCliDependenciesWithBashTimeout = { readonly bashTimeoutMs?: number };
type RunAgentCliDependenciesWithEnv = {
  readonly env?: Readonly<Record<string, string | undefined>>;
};

test("internal headless runner succeeds through the shared Runtime and redacts route credentials", async (context) => {
  const fixture = await createFixture(context, "success");
  const secret = "secret-canary-headless-success";
  await configureFixture(fixture, secret);
  let providerCalls = 0;
  const outcome = await runHeadlessOneShotJson(JSON.stringify(requestFor(fixture, "success-1")), {
    env: {},
    providerFactory: (_kind, config) => {
      assert.equal(config.routeId, ROUTE_ID);
      assert.equal(config.apiKey, secret);
      return {
        async generate() {
          providerCalls++;
          return assistant(`done ${secret}`, { promptTokens: 7, completionTokens: 3 });
        },
      };
    },
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result.status, "completed");
  assert.equal(outcome.result.finalMessage, "done [REDACTED]");
  assert.deepEqual(outcome.result.usage, {
    promptTokens: 7,
    completionTokens: 3,
    costCNY: 0,
  });
  assert.equal(outcome.result.effective.modelRouteId, ROUTE_ID);
  assert.equal(outcome.result.effective.permissionMode, "plan");
  assert.equal(Object.hasOwn(outcome.result, "policyDenials"), false);
  assert.equal(providerCalls, 1);
  assert.ok(outcome.result.tracePath);
  assert.equal((await readFile(outcome.result.tracePath, "utf8")).includes(secret), false);
  assert.equal(JSON.stringify(outcome.result).includes(secret), false);
});

test("headless single_non_stream mode uses one non-streaming provider attempt", async (context) => {
  const fixture = await createFixture(context, "single-non-stream");
  await configureFixture(fixture, "secret-canary-single-non-stream");
  let generateCalls = 0;
  let streamCalls = 0;
  const outcome = await runHeadlessOneShotJson(
    JSON.stringify({
      ...requestFor(fixture, "single-non-stream"),
      providerRequestMode: "single_non_stream",
    }),
    {
      env: {},
      providerFactory: () => ({
        async generate() {
          generateCalls++;
          throw new TypeError("synthetic retryable network failure");
        },
        async generateStream() {
          streamCalls++;
          return assistant("must not stream");
        },
      }),
    },
  );

  assert.equal(outcome.result.status, "failed");
  assert.equal(generateCalls, 1);
  assert.equal(streamCalls, 0);
});

test("headless traces retain metadata but remove tool arguments and workspace output", async (context) => {
  const fixture = await createFixture(context, "trace-sanitization");
  await configureFixture(fixture, "secret-canary-trace-route");
  const workspaceCanary = "WORKSPACE_TOOL_OUTPUT_CANARY_MUST_NOT_APPEAR";
  const secretPath = join(fixture.workspace, "fixture-secret.txt");
  await writeFile(secretPath, workspaceCanary);
  let calls = 0;
  const outcome = await runHeadlessOneShotJson(
    JSON.stringify({
      ...requestFor(fixture, "trace-sanitization"),
      allowedTools: ["read_file"],
    }),
    {
      env: {},
      providerFactory: () => ({
        async generate() {
          calls++;
          return calls === 1
            ? assistant("", undefined, [
                {
                  id: "read-secret",
                  name: "read_file",
                  arguments: JSON.stringify({ path: secretPath }),
                },
              ])
            : assistant("trace sanitized");
        },
      }),
    },
  );

  assert.equal(outcome.result.status, "completed");
  assert.ok(outcome.result.tracePath);
  const trace = await readFile(outcome.result.tracePath, "utf8");
  assert.equal(trace.includes(workspaceCanary), false);
  assert.equal(trace.includes(secretPath), false);
  assert.equal(trace.includes("[REDACTED]"), true);
  assert.equal(JSON.stringify(outcome.result).includes(workspaceCanary), false);
});

test("failed Runtime execution sanitizes its Session-bound trace without a result tracePath", async (context) => {
  const fixture = await createFixture(context, "failed-trace-sanitization");
  await configureFixture(fixture, "secret-canary-failed-trace-route");
  const workspaceCanary = "FAILED_WORKSPACE_TRACE_CANARY_MUST_NOT_APPEAR";
  const secretPath = join(fixture.workspace, "failed-fixture-secret.txt");
  await writeFile(secretPath, workspaceCanary);
  let calls = 0;
  const outcome = await runHeadlessOneShotJson(
    JSON.stringify({
      ...requestFor(fixture, "failed-trace-sanitization"),
      allowedTools: ["read_file"],
    }),
    {
      env: {},
      providerFactory: () => ({
        async generate() {
          calls++;
          if (calls === 1) {
            return assistant("", undefined, [
              {
                id: "read-failed-secret",
                name: "read_file",
                arguments: JSON.stringify({ path: secretPath }),
              },
            ]);
          }
          throw new DOMException("fixture provider failure", "AbortError");
        },
      }),
    },
  );

  assert.equal(outcome.result.status, "failed");
  assert.equal(outcome.result.tracePath, null);
  const traceDirectory = resolvePicoPaths(fixture.workspace, {
    picoHome: fixture.picoHome,
  }).workspace.traces;
  const traceFiles = (await readdir(traceDirectory)).filter((name) => name.endsWith(".json"));
  assert.equal(traceFiles.length, 1);
  const trace = await readFile(join(traceDirectory, traceFiles[0]!), "utf8");
  assert.equal(trace.includes(workspaceCanary), false);
  assert.equal(trace.includes(secretPath), false);
  assert.equal(trace.includes("[REDACTED]"), true);
});

test("trace baseline detects an in-place overwrite of a colliding Session filename", async (context) => {
  const fixture = await createFixture(context, "trace-overwrite-collision");
  await configureFixture(fixture, "secret-canary-trace-overwrite");
  const request = requestFor(fixture, "trace-overwrite-collision");
  const fixedNow = 1_785_260_000_000;
  const traceDirectory = resolvePicoPaths(fixture.workspace, {
    picoHome: fixture.picoHome,
  }).workspace.traces;
  await mkdir(traceDirectory, { recursive: true });
  const collidingPath = join(traceDirectory, `trace_${request.sessionId}_${fixedNow}.json`);
  await writeFile(collidingPath, '{"preexisting":true}\n');

  const originalNow = Date.now;
  Date.now = () => fixedNow;
  let outcome;
  try {
    outcome = await runHeadlessOneShotJson(JSON.stringify(request), {
      env: {},
      providerFactory: () => ({ generate: async () => assistant("collision sanitized") }),
    });
  } finally {
    Date.now = originalNow;
  }

  assert.equal(outcome.result.status, "completed");
  assert.equal(outcome.result.tracePath, await realpath(collidingPath));
  const trace = await readFile(outcome.result.tracePath, "utf8");
  assert.equal(trace.includes(outcome.result.workDir!), false);
  assert.equal(trace.includes("[REDACTED]"), true);
});

test("metadata-only trace attributes survive SIGKILL before post-processing", async (context) => {
  const fixture = await createFixture(context, "trace-sigkill");
  await configureFixture(fixture, "secret-canary-trace-sigkill-route");
  const workspaceCanary = "SIGKILL_TRACE_SECRET_CANARY_MUST_NOT_APPEAR";
  const secretPath = join(fixture.workspace, "sigkill-secret.txt");
  await writeFile(secretPath, workspaceCanary);
  const request = {
    ...requestFor(fixture, "trace-sigkill"),
    allowedTools: ["read_file"],
  };
  const child = spawnTraceKillChild(secretPath);
  const exported = waitForStreamText(child.stderr, "TRACE_EXPORTED");
  child.stdin.end(JSON.stringify(request));
  await exported;
  child.kill("SIGKILL");
  const [, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  assert.equal(signal, "SIGKILL");

  const traceDirectory = resolvePicoPaths(await realpath(fixture.workspace), {
    picoHome: await realpath(fixture.picoHome),
  }).workspace.traces;
  const traceFiles = (await readdir(traceDirectory)).filter((name) => name.endsWith(".json"));
  assert.equal(traceFiles.length, 1);
  const trace = await readFile(join(traceDirectory, traceFiles[0]!), "utf8");
  assert.equal(trace.includes(workspaceCanary), false);
  assert.equal(trace.includes(secretPath), false);
  assert.equal(trace.includes("[REDACTED]"), true);
});

test("invalid JSON, unknown fields, untrusted workspaces, and wrong routes fail before generation", async (context) => {
  const fixture = await createFixture(context, "preflight");
  await configureFixture(fixture, "secret-canary-preflight", false);
  let providerCalls = 0;
  const dependencies = {
    env: {},
    providerFactory: () => ({
      async generate() {
        providerCalls++;
        return assistant("must not run");
      },
    }),
  };

  const invalidJson = await runHeadlessOneShotJson("{", dependencies);
  assert.equal(invalidJson.result.error?.code, "INVALID_JSON");

  const unknownField = await runHeadlessOneShotJson(
    JSON.stringify({ ...requestFor(fixture, "unknown"), apiKey: "forbidden" }),
    dependencies,
  );
  assert.equal(unknownField.result.error?.code, "UNKNOWN_FIELD");

  const wrongVersion = await runHeadlessOneShotJson(
    JSON.stringify({ ...requestFor(fixture, "version"), schemaVersion: 2 }),
    dependencies,
  );
  assert.equal(wrongVersion.result.error?.code, "UNSUPPORTED_SCHEMA_VERSION");

  const projectConfigDirectory = join(fixture.workspace, ".pico");
  await mkdir(projectConfigDirectory);
  await writeFile(join(projectConfigDirectory, "config.json"), "{not-json", "utf8");
  const untrusted = await runHeadlessOneShotJson(
    JSON.stringify(requestFor(fixture, "untrusted")),
    dependencies,
  );
  assert.equal(untrusted.result.error?.code, "WORKSPACE_UNTRUSTED");
  await rm(projectConfigDirectory, { recursive: true });

  await trustFixture(fixture);
  const wrongRoute = await runHeadlessOneShotJson(
    JSON.stringify({ ...requestFor(fixture, "wrong-route"), modelRouteId: "missing/model" }),
    dependencies,
  );
  assert.equal(wrongRoute.result.error?.code, "MODEL_ROUTE_INVALID");

  const missingRoute = { ...requestFor(fixture, "missing-route") } as Record<string, unknown>;
  delete missingRoute["modelRouteId"];
  const missing = await runHeadlessOneShotJson(JSON.stringify(missingRoute), dependencies);
  assert.equal(missing.result.error?.code, "MISSING_FIELD");

  const supportedMaximumTimeout = await runHeadlessOneShotJson(
    JSON.stringify({
      ...requestFor(fixture, "supported-maximum-timeout"),
      modelRouteId: "missing/model",
      timeoutMs: 12_000_000,
    }),
    dependencies,
  );
  assert.equal(supportedMaximumTimeout.result.error?.code, "MODEL_ROUTE_INVALID");

  const timeoutAboveMaximum = await runHeadlessOneShotJson(
    JSON.stringify({
      ...requestFor(fixture, "timeout-above-maximum"),
      modelRouteId: "missing/model",
      timeoutMs: 12_000_001,
    }),
    dependencies,
  );
  assert.equal(timeoutAboveMaximum.result.error?.code, "INVALID_FIELD");

  const invalidPolicyDenialMode = await runHeadlessOneShotJson(
    JSON.stringify({
      ...requestFor(fixture, "policy-denial-mode"),
      policyDenialMode: "recoverable",
    }),
    dependencies,
  );
  assert.equal(invalidPolicyDenialMode.result.error?.code, "INVALID_POLICY_DENIAL_MODE");

  for (const [id, bashTimeoutMs, timeoutMs, errorCode] of [
    ["bash-timeout-low", 999, 30_000, "INVALID_FIELD"],
    ["bash-timeout-high", 300_001, 400_000, "INVALID_FIELD"],
    ["bash-timeout-overall", 1_001, 1_000, "INVALID_BASH_TIMEOUT"],
  ] as const) {
    const invalidBashTimeout = await runHeadlessOneShotJson(
      JSON.stringify({
        ...requestFor(fixture, id),
        bashTimeoutMs,
        timeoutMs,
      }),
      dependencies,
    );
    assert.equal(invalidBashTimeout.result.error?.code, errorCode);
  }
  assert.equal(providerCalls, 0);
});

test("headless accepts existing task tools and forwards a bounded bash timeout", async (context) => {
  const fixture = await createFixture(context, "task-tools");
  await configureFixture(fixture, "secret-canary-task-tools");
  const outcome = await runHeadlessOneShotJson(
    JSON.stringify({
      ...requestFor(fixture, "task-tools"),
      allowedTools: ["task_list", "task_output", "task_stop"],
      bashTimeoutMs: 30_000,
    }),
    {
      env: {},
      executeRuntime: async (options, dependencies) => {
        assert.deepEqual(options.allowedTools, ["task_list", "task_output", "task_stop"]);
        assert.equal(
          (dependencies as RunAgentCliDependenciesWithBashTimeout | undefined)?.bashTimeoutMs,
          30_000,
        );
        return runtimeResult(options, "task tools accepted");
      },
    },
  );

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result.status, "completed");
});

test("headless forwards only a complete adapter-gated controlled proxy environment", async (context) => {
  const fixture = await createFixture(context, "controlled-proxy");
  await configureFixture(fixture, "secret-canary-controlled-proxy");
  const token = "a".repeat(64);
  const proxyUrl = `http://pico:${token}@pico-egress:8081`;
  const noProxy = "pico-gateway,main,localhost,127.0.0.1,::1";
  const proxyEnv = {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  } as const;
  const proxyNames = Object.keys(proxyEnv);

  const runCase = async (
    id: string,
    env: Readonly<Record<string, string | undefined>>,
    gate: string | undefined,
    finalMessage = "controlled proxy case completed",
  ) => {
    let observedEnv: Readonly<Record<string, string | undefined>> | undefined;
    let runtimeCalls = 0;
    const capability = terminalBenchAgentControlledProxyCapability(gate);
    const outcome = await runHeadlessOneShotJson(JSON.stringify(requestFor(fixture, id)), {
      env,
      ...(capability ? { controlledProxyCapability: capability } : {}),
      executeRuntime: async (options, dependencies) => {
        runtimeCalls++;
        observedEnv = (dependencies as RunAgentCliDependenciesWithEnv | undefined)?.env;
        return runtimeResult(options, finalMessage);
      },
    });
    return { outcome, observedEnv, runtimeCalls };
  };

  for (const [id, gate] of [
    ["proxy-gate-missing", undefined],
    ["proxy-gate-disabled", "disabled"],
    ["proxy-gate-polluted", "terminal-bench-agent-v2"],
  ] as const) {
    const { outcome, observedEnv, runtimeCalls } = await runCase(
      id,
      {
        ...proxyEnv,
        PATH: "/controlled/bin",
        HOME: "/must-not-be-inherited",
        PICO_TB_AGENT_CONTROLLED_PROXY: gate,
      },
      gate,
    );
    assert.equal(outcome.result.status, "completed");
    assert.equal(runtimeCalls, 1);
    assert.ok(observedEnv);
    assert.equal(observedEnv["PATH"], "/controlled/bin");
    assert.notEqual(observedEnv["HOME"], "/must-not-be-inherited");
    for (const name of proxyNames) assert.equal(observedEnv[name], undefined);
    assert.equal(observedEnv["PICO_TB_AGENT_CONTROLLED_PROXY"], undefined);
  }

  const incompleteEnv = { ...proxyEnv } as Record<string, string | undefined>;
  delete incompleteEnv["no_proxy"];
  const incomplete = await runCase("proxy-incomplete", incompleteEnv, "terminal-bench-agent-v1");
  assert.equal(incomplete.outcome.result.status, "invalid_request");
  assert.equal(incomplete.outcome.result.error?.code, "CONTROLLED_PROXY_ENV_INVALID");
  assert.equal(incomplete.runtimeCalls, 0);

  const pollutedProxy = await runCase(
    "proxy-host-polluted",
    {
      ...proxyEnv,
      HTTP_PROXY: `http://pico:${token}@untrusted-proxy:8081`,
      HTTPS_PROXY: `http://pico:${token}@untrusted-proxy:8081`,
      http_proxy: `http://pico:${token}@untrusted-proxy:8081`,
      https_proxy: `http://pico:${token}@untrusted-proxy:8081`,
    },
    "terminal-bench-agent-v1",
  );
  assert.equal(pollutedProxy.outcome.result.status, "invalid_request");
  assert.equal(pollutedProxy.outcome.result.error?.code, "CONTROLLED_PROXY_ENV_INVALID");
  assert.equal(pollutedProxy.runtimeCalls, 0);

  const pollutedNoProxy = await runCase(
    "proxy-no-proxy-polluted",
    { ...proxyEnv, NO_PROXY: "*", no_proxy: "*" },
    "terminal-bench-agent-v1",
  );
  assert.equal(pollutedNoProxy.outcome.result.status, "invalid_request");
  assert.equal(pollutedNoProxy.outcome.result.error?.code, "CONTROLLED_PROXY_ENV_INVALID");
  assert.equal(pollutedNoProxy.runtimeCalls, 0);

  const enabled = await runCase(
    "proxy-enabled",
    {
      ...proxyEnv,
      PATH: "/controlled/bin",
      HOME: "/must-not-be-inherited",
      UNRELATED_ENV: "must-not-be-inherited",
    },
    "terminal-bench-agent-v1",
    `proxy=${proxyUrl} token=${token}`,
  );
  assert.equal(enabled.outcome.result.status, "completed");
  assert.equal(enabled.runtimeCalls, 1);
  assert.ok(enabled.observedEnv);
  for (const [name, value] of Object.entries(proxyEnv)) {
    assert.equal(enabled.observedEnv[name], value);
  }
  assert.equal(enabled.observedEnv["PATH"], "/controlled/bin");
  assert.notEqual(enabled.observedEnv["HOME"], "/must-not-be-inherited");
  assert.equal(enabled.observedEnv["UNRELATED_ENV"], undefined);
  assert.equal(enabled.observedEnv["PICO_TB_AGENT_CONTROLLED_PROXY"], undefined);
  assert.equal(enabled.outcome.result.finalMessage, "proxy=[REDACTED] token=[REDACTED]");
  assert.equal(JSON.stringify(enabled.outcome.result).includes(token), false);
});

test("controlled proxy ToolResults are redacted before Provider transcript and Runtime persistence", async (context) => {
  const fixture = await createFixture(context, "controlled-proxy-bash");
  await configureFixture(fixture, "secret-canary-controlled-proxy-bash");
  const token = "b".repeat(64);
  const ordinaryHex = "0123456789abcdef".repeat(4);
  const proxyUrl = `http://pico:${token}@pico-egress:8081`;
  const noProxy = "pico-gateway,main,localhost,127.0.0.1,::1";
  const safeMarker = "CONTROLLED_PROXY_SAFE_OUTPUT";
  const env = {
    PATH: process.env.PATH,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
  const controlledProxyCapability =
    terminalBenchAgentControlledProxyCapability("terminal-bench-agent-v1");
  assert.ok(controlledProxyCapability);
  let calls = 0;
  let secondProviderTranscript = "";
  let thirdProviderTranscript = "";
  const outcome = await runHeadlessOneShotJson(
    JSON.stringify({
      ...requestFor(fixture, "controlled-proxy-bash"),
      permissionMode: "yolo",
      allowedTools: ["bash", "task_output"],
    }),
    {
      env,
      controlledProxyCapability,
      providerFactory: () => ({
        async generate(messages) {
          calls++;
          if (calls === 1) {
            return assistant("", { promptTokens: 5, completionTokens: 2 }, [
              {
                id: "proxy-env-background",
                name: "bash",
                arguments: JSON.stringify({
                  command: [
                    'proxy_token="${HTTP_PROXY#http://pico:}"',
                    'proxy_token="${proxy_token%@pico-egress:8081}"',
                    `printf '{"stream":"background","proxy":"%s","token":"%s","marker":"${safeMarker}","ordinary":"${ordinaryHex}"}\\n' "$HTTP_PROXY" "$proxy_token"`,
                  ].join("; "),
                  background: true,
                }),
              },
              {
                id: "proxy-env-success",
                name: "bash",
                arguments: JSON.stringify({
                  command: [
                    "sleep 0.1",
                    'proxy_token="${HTTP_PROXY#http://pico:}"',
                    'proxy_token="${proxy_token%@pico-egress:8081}"',
                    `printf '{"stream":"stdout","proxy":"%s","token":"%s","noProxy":"%s","marker":"${safeMarker}","ordinary":"${ordinaryHex}"}\\n' "$HTTP_PROXY" "$proxy_token" "$NO_PROXY"`,
                  ].join("; "),
                }),
              },
            ]);
          }
          if (calls === 2) {
            secondProviderTranscript = JSON.stringify(messages);
            assert.equal(secondProviderTranscript.includes(proxyUrl), false);
            assert.equal(secondProviderTranscript.includes(token), false);
            assert.equal(secondProviderTranscript.includes("[REDACTED]"), true);
            assert.equal(secondProviderTranscript.includes(noProxy), true);
            assert.equal(secondProviderTranscript.includes(safeMarker), true);
            assert.equal(secondProviderTranscript.includes(ordinaryHex), true);
            assert.equal(secondProviderTranscript.includes("terminal-bench-agent-v1"), false);
            const foregroundResult = messages.find(
              (message) => message.toolCallId === "proxy-env-success",
            );
            assert.match(foregroundResult?.content ?? "", /\[REDACTED\]/u);
            assert.match(foregroundResult?.content ?? "", new RegExp(safeMarker, "u"));
            assert.match(foregroundResult?.content ?? "", new RegExp(ordinaryHex, "u"));
            const backgroundResult = messages.find(
              (message) => message.toolCallId === "proxy-env-background",
            );
            const taskId = backgroundResult?.content.match(/"taskId":"([^"]+)"/u)?.[1];
            assert.ok(taskId);
            return assistant("", { promptTokens: 5, completionTokens: 2 }, [
              {
                id: "proxy-background-output",
                name: "task_output",
                arguments: JSON.stringify({ taskId }),
              },
            ]);
          }
          thirdProviderTranscript = JSON.stringify(messages);
          assert.equal(thirdProviderTranscript.includes(proxyUrl), false);
          assert.equal(thirdProviderTranscript.includes(token), false);
          assert.equal(thirdProviderTranscript.includes("[REDACTED]"), true);
          assert.equal(thirdProviderTranscript.includes(safeMarker), true);
          assert.equal(thirdProviderTranscript.includes(ordinaryHex), true);
          const taskOutputResult = messages.find(
            (message) => message.toolCallId === "proxy-background-output",
          );
          assert.match(taskOutputResult?.content ?? "", /\[REDACTED\]/u);
          assert.match(taskOutputResult?.content ?? "", new RegExp(safeMarker, "u"));
          assert.match(taskOutputResult?.content ?? "", new RegExp(ordinaryHex, "u"));
          return assistant("controlled proxy transcript sanitized", {
            promptTokens: 5,
            completionTokens: 2,
          });
        },
      }),
    },
  );

  assert.equal(outcome.result.status, "completed", JSON.stringify(outcome.result));
  assert.equal(calls, 3);
  assert.equal(outcome.result.finalMessage, "controlled proxy transcript sanitized");
  assert.equal(JSON.stringify(outcome.result).includes(token), false);
  assert.equal(secondProviderTranscript.includes(ordinaryHex), true);
  assert.equal(thirdProviderTranscript.includes(ordinaryHex), true);

  const runtimeStore = new RuntimeEventStore({
    storageRoot: resolvePicoPaths(fixture.workspace, {
      picoHome: fixture.picoHome,
    }).workspace.root,
  });
  try {
    const events = await runtimeStore.readSession("session-controlled-proxy-bash");
    const serializedEvents = JSON.stringify(events);
    assert.equal(serializedEvents.includes(proxyUrl), false);
    assert.equal(serializedEvents.includes(token), false);
    assert.equal(serializedEvents.includes("[REDACTED]"), true);
    assert.equal(serializedEvents.includes(noProxy), true);
    assert.equal(serializedEvents.includes(safeMarker), true);
    assert.equal(serializedEvents.includes(ordinaryHex), true);
    const toolResults = events.filter((event) => event.kind === "tool.result.recorded");
    assert.equal(toolResults.length, 3);
    assert.deepEqual(
      new Set(toolResults.map((event) => event.data.status)),
      new Set(["succeeded"]),
    );
    assert.deepEqual(
      new Set(toolResults.map((event) => event.data.toolName)),
      new Set(["bash", "task_output"]),
    );
    for (const toolCallId of ["proxy-env-success", "proxy-background-output"]) {
      const toolResult = toolResults.find((event) => event.refs.toolCallId === toolCallId);
      const serializedToolResult = JSON.stringify(toolResult);
      assert.equal(serializedToolResult.includes(proxyUrl), false);
      assert.equal(serializedToolResult.includes(token), false);
      assert.equal(serializedToolResult.includes("[REDACTED]"), true);
      assert.equal(serializedToolResult.includes(safeMarker), true);
      assert.equal(serializedToolResult.includes(ordinaryHex), true);
    }
  } finally {
    runtimeStore.close();
  }

  assert.ok(outcome.result.tracePath);
  const trace = await readFile(outcome.result.tracePath, "utf8");
  assert.equal(trace.includes(token), false);
  assert.equal(trace.includes(proxyUrl), false);
  assert.equal(trace.includes(ordinaryHex), false);
});

test("unknown tools fail before provider generation and Session IDs cannot be reused", async (context) => {
  const fixture = await createFixture(context, "invalid-tools");
  await configureFixture(fixture, "secret-canary-invalid-tools");
  let providerCalls = 0;
  const providerFactory = () => ({
    async generate() {
      providerCalls++;
      return assistant("ok");
    },
  });
  const invalidTools = await runHeadlessOneShotJson(
    JSON.stringify({
      ...requestFor(fixture, "invalid-tools"),
      allowedTools: ["definitely_not_a_pico_tool"],
    }),
    { env: {}, providerFactory },
  );
  assert.equal(invalidTools.result.status, "invalid_request");
  assert.equal(invalidTools.result.error?.code, "ALLOWED_TOOLS_INVALID");
  assert.equal(providerCalls, 0);

  const corrected = await runHeadlessOneShotJson(
    JSON.stringify(requestFor(fixture, "invalid-tools")),
    { env: {}, providerFactory },
  );
  assert.equal(corrected.result.status, "completed");
  assert.equal(providerCalls, 1);

  const request = requestFor(fixture, "unique-session");
  const first = await runHeadlessOneShotJson(JSON.stringify(request), {
    env: {},
    providerFactory,
  });
  assert.equal(first.result.status, "completed");
  const repeated = await runHeadlessOneShotJson(JSON.stringify(request), {
    env: {},
    providerFactory,
  });
  assert.equal(repeated.result.status, "invalid_request");
  assert.equal(repeated.result.error?.code, "SESSION_ALREADY_EXISTS");
  assert.equal(providerCalls, 2);
});

test("headless policy denial defaults to the compatible terminal outcome", async (context) => {
  const fixture = await createFixture(context, "policy-terminal");
  await configureFixture(fixture, "secret-canary-policy-terminal");
  const outcome = await runHeadlessOneShotJson(
    JSON.stringify(requestFor(fixture, "policy-terminal")),
    {
      env: {},
      executeRuntime: async (options, dependencies) => {
        dependencies?.onPolicyDenied?.({
          source: "safety",
          code: "plan_mode",
          toolName: "write_file",
        });
        return runtimeResult(options, "must remain hidden", {
          promptTokens: 7,
          completionTokens: 3,
          costCNY: 0,
        });
      },
    },
  );

  assert.equal(outcome.exitCode, 4);
  assert.equal(outcome.result.status, "policy_blocked");
  assert.equal(outcome.result.finalMessage, null);
  assert.equal(outcome.result.error?.code, "POLICY_BLOCKED");
  assert.deepEqual(outcome.result.policyDenials, {
    total: 1,
    byCode: {
      plan_mode: 1,
      hardline: 0,
      hook: 0,
      approval: 0,
    },
    first: { source: "safety", code: "plan_mode", toolName: "write_file" },
    last: { source: "safety", code: "plan_mode", toolName: "write_file" },
  });
});

test("incident-mode policy denial remains recoverable after normal completion", async (context) => {
  const fixture = await createFixture(context, "policy");
  const secret = "secret-canary-policy";
  await configureFixture(fixture, secret);
  let calls = 0;
  const outcome = await runHeadlessOneShotJson(
    JSON.stringify({
      ...requestFor(fixture, "policy-block"),
      allowedTools: ["write_file"],
      permissionMode: "plan",
      policyDenialMode: "incident",
    }),
    {
      env: {},
      providerFactory: () => ({
        async generate() {
          calls++;
          if (calls === 1) {
            return assistant("", { promptTokens: 7, completionTokens: 3 }, [
              {
                id: "write-1",
                name: "write_file",
                arguments: JSON.stringify({ path: "blocked.txt", content: "blocked" }),
              },
            ]);
          }
          return assistant(`policy explained ${secret}`, {
            promptTokens: 5,
            completionTokens: 2,
          });
        },
      }),
    },
  );

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result.status, "completed");
  assert.equal(outcome.result.finalMessage, "policy explained [REDACTED]");
  assert.equal(outcome.result.error, null);
  assert.deepEqual(outcome.result.policyDenials, {
    total: 1,
    byCode: {
      plan_mode: 1,
      hardline: 0,
      hook: 0,
      approval: 0,
    },
    first: { source: "safety", code: "plan_mode", toolName: "write_file" },
    last: { source: "safety", code: "plan_mode", toolName: "write_file" },
  });
  assert.deepEqual(outcome.result.usage, {
    promptTokens: 12,
    completionTokens: 5,
    costCNY: 0,
  });
  assert.equal(calls, 2);
});

test("policy denial incidents preserve Runtime failure and timeout terminal states", async (context) => {
  const failedFixture = await createFixture(context, "policy-runtime-failure");
  await configureFixture(failedFixture, "secret-canary-policy-runtime-failure");
  const sensitiveError = "rm -rf /private/tmp/sensitive-command-output";
  const failed = await runHeadlessOneShotJson(
    JSON.stringify(requestFor(failedFixture, "policy-runtime-failure")),
    {
      env: {},
      executeRuntime: async (_options, dependencies) => {
        dependencies?.onPolicyDenied?.({
          source: "safety",
          code: "plan_mode",
          toolName: "write_file",
        });
        dependencies?.onPolicyDenied?.({
          source: "safety",
          code: "hardline",
          toolName: "bash",
        });
        dependencies?.onPolicyDenied?.({
          source: "permission",
          code: "hook",
          toolName: "edit_file",
        });
        throw new Error(sensitiveError);
      },
    },
  );

  assert.equal(failed.exitCode, 3);
  assert.equal(failed.result.status, "failed");
  assert.equal(failed.result.error?.code, "RUNTIME_FAILED");
  assert.deepEqual(failed.result.policyDenials, {
    total: 3,
    byCode: {
      plan_mode: 1,
      hardline: 1,
      hook: 1,
      approval: 0,
    },
    first: { source: "safety", code: "plan_mode", toolName: "write_file" },
    last: { source: "permission", code: "hook", toolName: "edit_file" },
  });
  assert.equal(JSON.stringify(failed.result).includes(sensitiveError), false);

  const timeoutFixture = await createFixture(context, "policy-timeout");
  await configureFixture(timeoutFixture, "secret-canary-policy-timeout");
  const timedOut = await runHeadlessOneShotJson(
    JSON.stringify({
      ...requestFor(timeoutFixture, "policy-timeout"),
      timeoutMs: 500,
    }),
    {
      env: {},
      executeRuntime: async (_options, dependencies) => {
        dependencies?.onPolicyDenied?.({
          source: "permission",
          code: "approval",
          toolName: "bash",
        });
        await rejectOnAbort({ signal: dependencies?.signal });
        throw new Error("unreachable");
      },
    },
  );

  assert.equal(timedOut.exitCode, 124);
  assert.equal(timedOut.result.status, "timed_out");
  assert.equal(timedOut.result.error?.code, "TIMEOUT");
  assert.deepEqual(timedOut.result.policyDenials, {
    total: 1,
    byCode: {
      plan_mode: 0,
      hardline: 0,
      hook: 0,
      approval: 1,
    },
    first: { source: "permission", code: "approval", toolName: "bash" },
    last: { source: "permission", code: "approval", toolName: "bash" },
  });
});

test("a non-policy rejected envelope does not become policy_blocked", async (context) => {
  const fixture = await createFixture(context, "control-rejection");
  await configureFixture(fixture, "secret-canary-control-rejection");
  const outcome = await runHeadlessOneShotJson(
    JSON.stringify(requestFor(fixture, "control-rejection")),
    {
      env: {},
      executeRuntime: async (options, dependencies) => {
        const content = "required delegation retry";
        dependencies?.reporter?.onToolResult(
          createToolResultEnvelope({
            toolCallId: "control-rejected",
            toolName: "delegate_task",
            status: "rejected",
            body: {
              storage: "inline",
              content,
              sha256: createHash("sha256").update(content).digest("hex"),
              sizeBytes: Buffer.byteLength(content),
            },
            projection: {
              version: 1,
              mode: "synthetic",
              text: content,
              strategy: "required-delegation",
              truncated: false,
            },
          }),
        );
        return runtimeResult(options, "continued safely");
      },
    },
  );

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.result.status, "completed");
  assert.equal(outcome.result.finalMessage, "continued safely");
});

test("an empty zero-usage runtime response fails closed", async (context) => {
  const fixture = await createFixture(context, "empty-runtime-response");
  await configureFixture(fixture, "secret-canary-empty-runtime-response");
  const outcome = await runHeadlessOneShotJson(
    JSON.stringify(requestFor(fixture, "empty-runtime-response")),
    {
      env: {},
      executeRuntime: async (options) => runtimeResult(options, ""),
    },
  );

  assert.equal(outcome.exitCode, 3);
  assert.equal(outcome.result.status, "failed");
  assert.equal(outcome.result.error?.code, "RUNTIME_EMPTY_RESPONSE");
});

test("trusted user routing ignores project providers and host extension canaries", async (context) => {
  const fixture = await createFixture(context, "host-isolation");
  const routeSecret = "secret-canary-trusted-route";
  const hostSecret = "secret-canary-host-environment";
  await configureFixture(fixture, routeSecret);
  const receiver = await createCountingServer(context);
  const hostHome = join(fixture.root, "host-home");
  const resourceCanary = "HOST_RESOURCE_CANARY_MUST_NOT_APPEAR";
  await Promise.all([
    mkdir(join(hostHome, ".claude", "skills", "host-canary"), { recursive: true }),
    mkdir(join(fixture.workspace, ".claude", "skills", "project-canary"), { recursive: true }),
    mkdir(join(fixture.picoHome, "skills", "user-canary"), { recursive: true }),
    mkdir(join(fixture.workspace, ".pico"), { recursive: true }),
  ]);
  const skill = `---\nname: canary\ndescription: ${resourceCanary}\n---\n${resourceCanary}\n`;
  await Promise.all([
    writeFile(join(hostHome, ".claude", "skills", "host-canary", "SKILL.md"), skill),
    writeFile(join(fixture.workspace, ".claude", "skills", "project-canary", "SKILL.md"), skill),
    writeFile(join(fixture.picoHome, "skills", "user-canary", "SKILL.md"), skill),
    writeFile(
      join(fixture.workspace, ".pico", "config.json"),
      JSON.stringify({
        version: 1,
        providers: {
          [PROVIDER_ID]: {
            protocol: "openai",
            baseURL: receiver.baseURL,
            apiKeyEnv: "HOST_SECRET",
            models: [MODEL_ID],
          },
        },
      }),
    ),
  ]);
  let serializedMessages = "";
  const outcome = await runHeadlessOneShotJson(
    JSON.stringify(requestFor(fixture, "host-isolation")),
    {
      env: { HOME: hostHome, HOST_SECRET: hostSecret },
      providerFactory: (_kind, config) => {
        assert.equal(config.apiKey, routeSecret);
        assert.notEqual(config.baseURL, receiver.baseURL);
        return {
          async generate(messages) {
            serializedMessages = JSON.stringify(messages);
            return assistant("isolated");
          },
        };
      },
    },
  );

  assert.equal(outcome.result.status, "completed");
  assert.equal(receiver.requests(), 0);
  assert.equal(serializedMessages.includes(resourceCanary), false);
  const projection = JSON.stringify(outcome.result);
  assert.equal(projection.includes(routeSecret), false);
  assert.equal(projection.includes(hostSecret), false);
});

test("timeout covers a hanging credential preflight and leaves the Session reusable", async (context) => {
  const fixture = await createFixture(context, "credential-timeout");
  await configureFixtureWithoutSecret(fixture);
  const request = {
    ...requestFor(fixture, "credential-timeout"),
    timeoutMs: 20,
    shutdownGraceMs: 10,
  };
  const startedAt = Date.now();
  const timedOut = await runHeadlessOneShotJson(JSON.stringify(request), {
    env: {},
    credentialVault: {
      capability: () => ({ available: true, backend: "macos-keychain", diagnostic: "test" }),
      resolve: () => new Promise(() => undefined),
      put: async () => undefined,
      has: async () => false,
      delete: async () => undefined,
    },
  });
  assert.equal(timedOut.result.status, "timed_out");
  assert.equal(timedOut.exitCode, 124);
  assert.equal(timedOut.result.terminationConfirmed, true);
  assert.ok(Date.now() - startedAt < 500);

  const corrected = await runHeadlessOneShotJson(
    JSON.stringify({ ...request, timeoutMs: 30_000 }),
    {
      env: { FIXTURE_API_KEY: "fixed-after-timeout" },
      providerFactory: () => ({ generate: async () => assistant("recovered") }),
    },
  );
  assert.equal(corrected.result.status, "completed");

  const signalFixture = await createFixture(context, "credential-signal");
  await configureFixtureWithoutSecret(signalFixture);
  const signalRequest = requestFor(signalFixture, "credential-signal");
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException("SIGTERM", "AbortError")), 20).unref();
  const canceled = await runHeadlessOneShotJson(JSON.stringify(signalRequest), {
    env: {},
    signal: controller.signal,
    signalKind: "SIGTERM",
    credentialVault: {
      capability: () => ({ available: true, backend: "macos-keychain", diagnostic: "test" }),
      resolve: () => new Promise(() => undefined),
      put: async () => undefined,
      has: async () => false,
      delete: async () => undefined,
    },
  });
  assert.equal(canceled.result.status, "canceled");
  assert.equal(canceled.exitCode, 143);
  assert.equal(canceled.result.terminationConfirmed, true);
  const afterSignal = await runHeadlessOneShotJson(JSON.stringify(signalRequest), {
    env: { FIXTURE_API_KEY: "fixed-after-signal" },
    providerFactory: () => ({ generate: async () => assistant("recovered") }),
  });
  assert.equal(afterSignal.result.status, "completed");
});

test("failed Runtime execution releases case resources for a corrected retry", async (context) => {
  const fixture = await createFixture(context, "failed-runtime-lock");
  await configureFixture(fixture, "secret-canary-failed-runtime");
  const failed = await runHeadlessOneShotJson(
    JSON.stringify(requestFor(fixture, "failed-runtime")),
    {
      env: {},
      executeRuntime: async () => {
        throw new Error("fixture runtime failure");
      },
    },
  );
  assert.equal(failed.result.status, "failed");
  const recovered = await runHeadlessOneShotJson(
    JSON.stringify(requestFor(fixture, "failed-runtime-retry")),
    {
      env: {},
      executeRuntime: async (options) => runtimeResult(options, "recovered"),
    },
  );
  assert.equal(recovered.result.status, "completed");
});

test("persistent background cleanup retains and retries owner leases after repeated deletion failures", async (context) => {
  const fixture = await createFixture(context, "release-retry");
  await configureFixture(fixture, "secret-canary-release-retry");
  let deletionCalls = 0;
  const first = await runHeadlessOneShotJson(
    JSON.stringify(requestFor(fixture, "release-retry-first")),
    {
      env: {},
      executeRuntime: async (options) => runtimeResult(options, "first completed"),
      lockRemoveLeaseDirectory: async (leaseDirectory) => {
        deletionCalls++;
        if (deletionCalls <= 5) {
          throw new Error("injected transient rm failure");
        }
        await rm(leaseDirectory, { recursive: true, force: true });
      },
    },
  );
  assert.equal(first.result.status, "completed");
  assert.equal(first.exitCode, 0);
  assert.equal(deletionCalls, 3);

  const secondRequest = JSON.stringify(requestFor(fixture, "release-retry-second"));
  let second;
  const deadline = Date.now() + 2_000;
  do {
    second = await runHeadlessOneShotJson(secondRequest, {
      env: {},
      executeRuntime: async (options) => runtimeResult(options, "second completed"),
    });
    if (second.result.status !== "completed") {
      assert.equal(second.result.error?.code, "CASE_RESOURCE_CONFLICT");
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));
    }
  } while (second.result.status !== "completed" && Date.now() < deadline);
  assert.ok(deletionCalls >= 6);
  assert.equal(second.result.status, "completed");
});

test("unconfirmed in-process cancellation retains locks until Runtime settles", async (context) => {
  const fixture = await createFixture(context, "unconfirmed-in-process");
  await configureFixture(fixture, "secret-canary-unconfirmed");
  const request = {
    ...requestFor(fixture, "unconfirmed-in-process"),
    timeoutMs: 500,
    shutdownGraceMs: 0,
  };
  let settleRuntime!: () => void;
  const timedOut = await runHeadlessOneShotJson(JSON.stringify(request), {
    env: {},
    executeRuntime: (options) =>
      new Promise<RunAgentCliResult>((resolveRuntime) => {
        settleRuntime = () => resolveRuntime(runtimeResult(options, "late completion"));
      }),
  });
  assert.equal(timedOut.result.status, "timed_out");
  assert.equal(timedOut.result.error?.code, "SHUTDOWN_UNCONFIRMED");
  assert.equal(timedOut.result.terminationConfirmed, false);
  assert.equal(timedOut.exitCode, 124);

  const conflict = await runHeadlessOneShotJson(
    JSON.stringify({ ...request, requestId: "request-conflict", sessionId: "session-conflict" }),
    { env: {}, executeRuntime: async (options) => runtimeResult(options, "must not run") },
  );
  assert.equal(conflict.result.error?.code, "CASE_RESOURCE_CONFLICT");

  settleRuntime();
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
  const recovered = await runHeadlessOneShotJson(
    JSON.stringify({ ...request, requestId: "request-recovered", sessionId: "session-recovered" }),
    { env: {}, executeRuntime: async (options) => runtimeResult(options, "recovered") },
  );
  assert.equal(recovered.result.status, "completed");
});

test("timeout and host signals map to stable statuses and exit codes", async (context) => {
  const timeoutFixture = await createFixture(context, "timeout");
  await configureFixture(timeoutFixture, "secret-canary-timeout");
  const timeout = await runHeadlessOneShotJson(
    JSON.stringify({
      ...requestFor(timeoutFixture, "timeout-case"),
      timeoutMs: 20,
      shutdownGraceMs: 2_000,
    }),
    { env: {}, providerFactory: () => abortableProvider() },
  );
  assert.equal(timeout.result.status, "timed_out");
  assert.equal(timeout.exitCode, 124);
  assert.equal(timeout.shutdownConfirmed, true);

  const signalFixture = await createFixture(context, "signal");
  await configureFixture(signalFixture, "secret-canary-signal");
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException("SIGTERM", "AbortError")), 20).unref();
  const signaled = await runHeadlessOneShotJson(
    JSON.stringify(requestFor(signalFixture, "signal-case")),
    {
      env: {},
      signal: controller.signal,
      providerFactory: () => abortableProvider(),
    },
  );
  assert.equal(signaled.result.status, "canceled");
  assert.equal(signaled.exitCode, 143);
  assert.equal(signaled.result.error?.code, "SIGTERM");
});

test("eight concurrent cases keep PICO_HOME, Session, and workspace state isolated", async (context) => {
  const fixtures = await Promise.all(
    Array.from({ length: 8 }, (_, index) => createFixture(context, `parallel-${index}`)),
  );
  await Promise.all(
    fixtures.map((fixture, index) => configureFixture(fixture, `secret-canary-parallel-${index}`)),
  );

  const outcomes = await Promise.all(
    fixtures.map((fixture, index) =>
      runHeadlessOneShotJson(JSON.stringify(requestFor(fixture, `parallel-${index}`)), {
        env: {},
        providerFactory: (_kind, config) => ({
          async generate() {
            return assistant(`${config.apiKey}:${index}`);
          },
        }),
      }),
    ),
  );

  for (const [index, outcome] of outcomes.entries()) {
    assert.equal(outcome.result.status, "completed");
    assert.equal(outcome.result.sessionId, `session-parallel-${index}`);
    assert.equal(outcome.result.workDir, await realpath(fixtures[index]!.workspace));
    assert.equal(outcome.result.finalMessage, `[REDACTED]:${index}`);
    assert.equal(JSON.stringify(outcome.result).includes("secret-canary"), false);
  }
  const tracePaths = outcomes.map((outcome) => outcome.result.tracePath);
  assert.equal(new Set(tracePaths).size, 8);
});

test("the internal process entry emits exactly one JSON line for success and invalid input", async (context) => {
  const serverFixture = await createFakeOpenAiServer(context);
  const fixture = await createFixture(context, "process");
  await configureFixture(fixture, "secret-canary-process", true, serverFixture.baseURL);

  const success = await runProcess(JSON.stringify(requestFor(fixture, "process-success")));
  assert.equal(success.code, 0);
  assert.equal(success.stdout.trim().split("\n").length, 1);
  const successResult = JSON.parse(success.stdout) as { status: string; finalMessage: string };
  assert.equal(successResult.status, "completed");
  assert.equal(successResult.finalMessage, "process-ok");
  assert.equal(success.stderr, "");

  const invalid = await runProcess("{");
  assert.equal(invalid.code, 2);
  assert.equal(invalid.stdout.trim().split("\n").length, 1);
  assert.equal((JSON.parse(invalid.stdout) as { status: string }).status, "invalid_request");
});

test("the internal process entry maps SIGTERM to canceled/143 with one JSON line", async (context) => {
  const serverFixture = await createFakeOpenAiServer(context, true);
  const fixture = await createFixture(context, "process-signal");
  await configureFixture(fixture, "secret-canary-process-signal", true, serverFixture.baseURL);

  const child = spawnHeadlessProcess();
  const collected = collectChild(child, JSON.stringify(requestFor(fixture, "process-signal")));
  await serverFixture.called;
  child.kill("SIGTERM");
  const result = await collected;

  assert.equal(result.code, 143);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  const payload = JSON.parse(result.stdout) as { status: string; error: { code: string } };
  assert.equal(payload.status, "canceled");
  assert.equal(payload.error.code, "SIGTERM");
  assert.equal(result.stderr.includes("secret-canary-process-signal"), false);
});

test("SIGINT and SIGTERM cancel while stdin remains open", async () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const result = await runProcessWithOpenStdin(signal);
    assert.equal(result.code, signal === "SIGTERM" ? 143 : 130);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    const payload = JSON.parse(result.stdout) as { status: string; error: { code: string } };
    assert.equal(payload.status, "canceled");
    assert.equal(payload.error.code, signal);
  }
});

test("dead CLI owners are recovered after unconfirmed exit and SIGKILL", async (context) => {
  const timeoutFixture = await createFixture(context, "dead-owner-timeout");
  await configureFixture(timeoutFixture, "secret-canary-dead-timeout");
  const timeoutRequest = {
    ...requestFor(timeoutFixture, "dead-owner-timeout"),
    timeoutMs: 500,
    shutdownGraceMs: 0,
  };
  const timeoutChild = spawnUnconfirmedChild("timeout");
  const timeoutResult = await collectChild(timeoutChild, JSON.stringify(timeoutRequest));
  assert.equal(timeoutResult.code, 124);
  const timeoutPayload = JSON.parse(timeoutResult.stdout) as {
    status: string;
    terminationConfirmed: boolean;
  };
  assert.equal(timeoutPayload.status, "timed_out");
  assert.equal(timeoutPayload.terminationConfirmed, false);
  const afterTimeout = await runHeadlessOneShotJson(
    JSON.stringify({
      ...timeoutRequest,
      requestId: "request-after-dead-timeout",
      sessionId: "session-after-dead-timeout",
    }),
    { env: {}, executeRuntime: async (options) => runtimeResult(options, "recovered") },
  );
  assert.equal(afterTimeout.result.status, "completed");

  const killedFixture = await createFixture(context, "dead-owner-sigkill");
  await configureFixture(killedFixture, "secret-canary-dead-kill");
  const killedRequest = {
    ...requestFor(killedFixture, "dead-owner-sigkill"),
    timeoutMs: 60_000,
    shutdownGraceMs: 0,
  };
  const killedChild = spawnUnconfirmedChild("hang");
  const started = waitForStreamText(killedChild.stderr, "RUNTIME_STARTED");
  killedChild.stdin.end(JSON.stringify(killedRequest));
  await started;
  killedChild.kill("SIGKILL");
  const [, killedSignal] = (await once(killedChild, "exit")) as [
    number | null,
    NodeJS.Signals | null,
  ];
  assert.equal(killedSignal, "SIGKILL");
  const afterKill = await runHeadlessOneShotJson(
    JSON.stringify({
      ...killedRequest,
      requestId: "request-after-sigkill",
      sessionId: "session-after-sigkill",
    }),
    { env: {}, executeRuntime: async (options) => runtimeResult(options, "recovered") },
  );
  assert.equal(afterKill.result.status, "completed");
});

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly picoHome: string;
}

async function createFixture(
  context: { after(callback: () => void | Promise<void>): void },
  name: string,
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `pico-headless-${name}-`));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await Promise.all([mkdir(workspace), mkdir(picoHome)]);
  context.after(() => rm(root, { recursive: true, force: true }));
  return { root, workspace, picoHome };
}

async function configureFixture(
  fixture: Fixture,
  apiKey: string,
  trust = true,
  baseURL = "https://provider.invalid/v1",
): Promise<void> {
  const store = new UserConfigStore({ picoHome: fixture.picoHome });
  await store.write(
    {
      version: 1,
      providers: {
        [PROVIDER_ID]: {
          protocol: "openai",
          baseURL,
          apiKeyEnv: "FIXTURE_API_KEY",
          apiKey,
          models: [MODEL_ID],
          discoverModels: false,
        },
      },
    },
    { expectedRevision: EMPTY_USER_CONFIG_REVISION },
  );
  if (trust) await trustFixture(fixture);
}

async function configureFixtureWithoutSecret(fixture: Fixture): Promise<void> {
  const store = new UserConfigStore({ picoHome: fixture.picoHome });
  await store.write(
    {
      version: 1,
      providers: {
        [PROVIDER_ID]: {
          protocol: "openai",
          baseURL: "https://provider.invalid/v1",
          apiKeyEnv: "FIXTURE_API_KEY",
          models: [MODEL_ID],
          discoverModels: false,
        },
      },
    },
    { expectedRevision: EMPTY_USER_CONFIG_REVISION },
  );
  await trustFixture(fixture);
}

async function trustFixture(fixture: Fixture): Promise<void> {
  const store = new WorkspaceTrustStore({ userStateDirectory: fixture.picoHome });
  await store.trust(await store.canonicalize(fixture.workspace));
}

function requestFor(fixture: Fixture, id: string): HeadlessOneShotRequestV1 {
  return {
    schemaVersion: 1,
    requestId: `request-${id}`,
    workspacePath: fixture.workspace,
    picoHome: fixture.picoHome,
    sessionId: `session-${id}`,
    prompt: `respond to ${id}`,
    modelRouteId: ROUTE_ID,
    permissionMode: "plan",
    allowedTools: [],
    timeoutMs: 30_000,
    shutdownGraceMs: 2_000,
    trace: true,
  };
}

function assistant(
  content: string,
  usage?: { promptTokens: number; completionTokens: number },
  toolCalls?: Message["toolCalls"],
): Message {
  return {
    role: "assistant",
    content,
    ...(usage ? { usage } : {}),
    ...(toolCalls ? { toolCalls } : {}),
  };
}

function runtimeResult(
  options: RunAgentCliOptions,
  finalMessage: string,
  usage = { promptTokens: 0, completionTokens: 0, costCNY: 0 },
): RunAgentCliResult {
  assert.ok(options.sessionSelection);
  assert.ok(options.dir);
  return {
    sessionId: options.sessionSelection.sessionId,
    sessionSelection: options.sessionSelection,
    workDir: options.dir,
    finalMessage,
    usage,
    messages: [{ role: "assistant", content: finalMessage }],
  };
}

function abortableProvider(): LLMProvider {
  return {
    generate(_messages, _tools, options) {
      return rejectOnAbort(options);
    },
  };
}

function rejectOnAbort(options?: LLMProviderRequestOptions): Promise<Message> {
  return new Promise((_, reject) => {
    const signal = options?.signal;
    const fail = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
    if (signal?.aborted) fail();
    else signal?.addEventListener("abort", fail, { once: true });
  });
}

async function createFakeOpenAiServer(
  context: {
    after(callback: () => void | Promise<void>): void;
  },
  hang = false,
): Promise<{ server: Server; baseURL: string; called: Promise<void> }> {
  let markCalled!: () => void;
  const called = new Promise<void>((resolveCalled) => {
    markCalled = resolveCalled;
  });
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the request before replying so fetch observes a normal response.
    }
    markCalled();
    if (hang) return;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "process-ok" } }] })}`,
        "",
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        })}`,
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(
    () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.closeAllConnections();
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, baseURL: `http://127.0.0.1:${address.port}/v1`, called };
}

async function createCountingServer(context: {
  after(callback: () => void | Promise<void>): void;
}): Promise<{ baseURL: string; requests(): number }> {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount++;
    response.writeHead(500);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(
    () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests: () => requestCount,
  };
}

async function runProcess(input: string): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return await collectChild(spawnHeadlessProcess(), input);
}

function spawnHeadlessProcess(): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["--import", "tsx", "src/internal/headless-one-shot-main.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "test", LOG_LEVEL: "trace" },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function spawnUnconfirmedChild(mode: "timeout" | "hang"): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    ["--import", "tsx", "tests/fixtures/headless-one-shot-unconfirmed-child.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        LOG_LEVEL: "fatal",
        HEADLESS_CHILD_MODE: mode,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

function spawnTraceKillChild(secretPath: string): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    ["--import", "tsx", "tests/fixtures/headless-one-shot-trace-kill-child.ts"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "test",
        LOG_LEVEL: "fatal",
        TRACE_KILL_SECRET_PATH: secretPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

async function collectChild(
  child: ChildProcessWithoutNullStreams,
  input: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(input);
  const [code] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

async function runProcessWithOpenStdin(
  signal: "SIGINT" | "SIGTERM",
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawnHeadlessProcess();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.write("{");
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 1_500));
  child.kill(signal);
  const [code] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

async function waitForStreamText(stream: NodeJS.ReadableStream, expected: string): Promise<void> {
  let output = "";
  for await (const chunk of stream) {
    output += Buffer.from(chunk as Uint8Array).toString("utf8");
    if (output.includes(expected)) return;
  }
  throw new Error(`Stream closed before ${expected}`);
}

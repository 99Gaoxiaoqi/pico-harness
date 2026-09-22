import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { AiSdkProvider } from "@pico/pico-host/provider/ai-sdk-provider";
import { Session } from "@pico/pico-host/session";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { RuntimeRun } from "@pico/pico-host/product-runtime-run";
import { CostTracker } from "@pico/runtime/cost-tracker";
import { generateWithRetry } from "@pico/runtime/provider-retry";
import { providerForReporter, resolveModelRouteCapabilities } from "@pico/runtime";

// Real HTTP -> SDK -> streaming/retry decorators -> SQLite; no paid model is needed.
test("physical attempts persist cache downgrade and streaming retry separately with semantic TTFT", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-physical-attempts-"));
  let requests = 0;
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    requests++;
    if (body.prompt_cache_key) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "unknown parameter prompt_cache_key" } }));
    } else if (requests === 2) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "private upstream response" } }));
    } else {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      send({
        id: "stream",
        model: "test",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      });
      await delay(45);
      send({
        id: "stream",
        model: "test",
        choices: [{ index: 0, delta: { content: "answer" }, finish_reason: null }],
      });
      send({
        id: "stream",
        model: "test",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      });
      res.end("data: [DONE]\n\n");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const openSession = () =>
    new Session("physical-attempts", root, {
      persistence: true,
      picoHome: join(root, "home"),
      runtimePort: createEngineRuntimePort(),
    });
  let session = openSession();
  try {
    await session.recover();
    const provider = new AiSdkProvider("openai", {
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: "never-persist-this-key",
      model: "physical-model",
      capabilities: resolveModelRouteCapabilities("openai", "physical-model", {
        cache: true,
        streamUsage: true,
        promptCache: { mode: "implicit" },
      }),
    });
    const tracked = new CostTracker(
      provider,
      { provider: "openai", model: "physical-model", billingMode: "subscription_included" },
      session,
    );
    const run = await RuntimeRun.start({
      capability: session.runtimeEventCapability!,
      agentSwarmAuthorization: "none",
    });
    await run.run(async () => {
      const response = await generateWithRetry(
        providerForReporter(tracked, { onTextDelta() {} }),
        [{ role: "user", content: "hello" }],
        [],
        { maxAttempts: 2 },
      );
      assert.equal(response.content, "answer");
    });
    await session.close();
    session = openSession();
    await session.recover();
    const events = await session.runtimeEventStore!.readSession(session.id);
    const calls = events.filter((e) => e.kind === "model.call.settled");
    assert.equal(requests, 3);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.data.logicalCallId, calls[1]!.data.logicalCallId);
    assert.deepEqual(
      calls.map((c) => c.data.retryAttempt),
      [0, 1],
    );
    assert.deepEqual(
      calls.map((c) => c.data.attemptCoverage),
      ["complete", "complete"],
    );
    const attempts = calls.flatMap((c) => c.data.attempts ?? []);
    assert.deepEqual(
      attempts.map((a) => a.httpStatus),
      [400, 503, 200],
    );
    assert.deepEqual(
      attempts.map((a) => a.status),
      ["failed", "failed", "succeeded"],
    );
    assert.equal(new Set(attempts.map((a) => a.attemptId)).size, 3);
    assert.deepEqual(
      attempts.map((a) => a.usageBasis),
      ["missing", "missing", "reported"],
    );
    assert.equal(attempts[0]!.timeToFirstTokenMs, undefined);
    assert.ok(attempts[2]!.timeToFirstTokenMs! >= 30, "metadata must not count as first token");
    assert.equal(attempts[2]!.usage!.promptTokens, 10);
    assert.equal(attempts[2]!.costStatus, "included");
    assert.equal(attempts[2]!.costCNY, 0);
    assert.doesNotMatch(JSON.stringify(events), /never-persist-this-key|private upstream response/);
  } finally {
    await session.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("interrupted stream preserves partial usage without inventing output, TTFT or priced cost", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-partial-attempt-"));
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* consume request */
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ id: "partial", choices: [], usage: { prompt_tokens: 7 } })}\n\n`,
    );
    // Deliberately omit a finish choice. The SDK must reject the incomplete stream.
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const session = new Session("partial-attempt", root, {
    persistence: true,
    picoHome: join(root, "home"),
    runtimePort: createEngineRuntimePort(),
  });
  try {
    await session.recover();
    const provider = new AiSdkProvider("openai", {
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: "test",
      model: "partial-model",
      capabilities: resolveModelRouteCapabilities("openai", "partial-model", { streamUsage: true }),
    });
    const tracked = new CostTracker(
      provider,
      { provider: "openai", model: "partial-model", billingMode: "subscription_included" },
      session,
    );
    const run = await RuntimeRun.start({
      capability: session.runtimeEventCapability!,
      agentSwarmAuthorization: "none",
    });
    await assert.rejects(
      run.run(() => tracked.generateStream([{ role: "user", content: "hello" }], [], () => {})),
    );
    const calls = (await session.runtimeEventStore!.readSession(session.id)).filter(
      (e) => e.kind === "model.call.settled",
    );
    const attempt = calls[0]!.data.attempts![0]!;
    assert.equal(attempt.usageBasis, "partial");
    assert.deepEqual(attempt.usage!.reportedFields, ["prompt"]);
    assert.equal(attempt.usage!.promptTokens, 7);
    assert.equal(attempt.timeToFirstTokenMs, undefined);
    assert.equal(attempt.costStatus, "unknown");
    assert.equal(attempt.costCNY, undefined);
    assert.equal(attempt.status, "failed");
  } finally {
    await session.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("cancelling a stream records its dispatch and observed usage exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-cancel-attempt-"));
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* consume request */
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ id: "cancelled", choices: [], usage: { prompt_tokens: 9 } })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ id: "cancelled", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] })}\n\n`,
    );
    // The request stays open until the client aborts it.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const session = new Session("cancel-attempt", root, {
    persistence: true,
    picoHome: join(root, "home"),
    runtimePort: createEngineRuntimePort(),
  });
  try {
    await session.recover();
    const controller = new AbortController();
    const provider = new AiSdkProvider("openai", {
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: "test",
      model: "cancel-model",
      capabilities: resolveModelRouteCapabilities("openai", "cancel-model", { streamUsage: true }),
    });
    const tracked = new CostTracker(
      provider,
      { provider: "openai", model: "cancel-model", billingMode: "subscription_included" },
      session,
    );
    const run = await RuntimeRun.start({
      capability: session.runtimeEventCapability!,
      agentSwarmAuthorization: "none",
    });
    await assert.rejects(
      run.run(() =>
        tracked.generateStream([{ role: "user", content: "hello" }], [], () => controller.abort(), {
          signal: controller.signal,
        }),
      ),
    );
    const calls = (await session.runtimeEventStore!.readSession(session.id)).filter(
      (e) => e.kind === "model.call.settled",
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.data.attempts!.length, 1);
    const attempt = calls[0]!.data.attempts![0]!;
    assert.equal(attempt.status, "cancelled");
    assert.equal(attempt.usageBasis, "partial");
    assert.equal(attempt.usage!.promptTokens, 9);
    assert.ok(attempt.timeToFirstTokenMs !== undefined);
    assert.equal(attempt.costCNY, undefined);
  } finally {
    await session.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

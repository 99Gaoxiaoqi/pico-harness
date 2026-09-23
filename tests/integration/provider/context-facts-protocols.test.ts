import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProvider } from "@pico/pico-host/provider/factory";
import { CostTracker } from "@pico/runtime/cost-tracker";
import { SqliteRuntimeControlStore } from "@pico/storage/sqlite/sqlite-runtime-control-store";
import { resolveModelRouteCapabilities } from "@pico/runtime";
import type { ProviderAttemptLifecycleSnapshot, RequestContextFacts } from "@pico/core";

for (const wire of ["openai", "responses", "claude"] as const) {
  test(`${wire}: physical request freezes context facts, persists reported usage, and never borrows missing usage`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `pico-context-${wire}-`));
    const ledger = new SqliteRuntimeControlStore({ storageRoot: root });
    let mode: "reported" | "missing" | "failed" = "reported";
    const bodies: Record<string, unknown>[] = [];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      bodies.push(JSON.parse(raw));
      if (mode === "failed") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: { type: "invalid_request_error", message: "fixture failure" } }),
        );
        return;
      }
      const withUsage = mode === "reported";
      const payload =
        wire === "openai"
          ? {
              id: "chat",
              choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Done" } }],
              ...(withUsage
                ? {
                    usage: {
                      prompt_tokens: 120,
                      completion_tokens: 9,
                      prompt_tokens_details: { cached_tokens: 80 },
                    },
                  }
                : {}),
            }
          : wire === "claude"
            ? {
                id: "msg",
                type: "message",
                role: "assistant",
                model: "context-fixture",
                stop_reason: "end_turn",
                stop_sequence: null,
                content: [{ type: "text", text: "Done" }],
                ...(withUsage
                  ? {
                      usage: {
                        input_tokens: 40,
                        output_tokens: 9,
                        cache_read_input_tokens: 80,
                        cache_creation_input_tokens: 0,
                      },
                    }
                  : { usage: { input_tokens: 0, output_tokens: 0 } }),
              }
            : {
                id: "resp",
                object: "response",
                created_at: 1,
                model: "context-fixture",
                status: "completed",
                output: [
                  {
                    type: "message",
                    id: "message",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: "Done", annotations: [] }],
                  },
                ],
                ...(withUsage
                  ? {
                      usage: {
                        input_tokens: 120,
                        output_tokens: 9,
                        total_tokens: 129,
                        input_tokens_details: { cached_tokens: 80 },
                      },
                    }
                  : {}),
              };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      ledger.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseURL = `http://127.0.0.1:${address.port}/v1`;
    const facts = {
      version: 1 as const,
      routeId: `${wire}/context-fixture`,
      connectionId: "fixture",
      contextWindow: 10_000,
      contextWindowSource: "config",
    };
    const compaction: NonNullable<RequestContextFacts["compaction"]> = {
      checkpointId: "checkpoint-1",
      throughEventId: "message-1",
      coveredEventCount: 3,
    };
    const tracker = new CostTracker(
      createProvider(wire, {
        baseURL,
        apiKey: "synthetic-test-key",
        model: "context-fixture",
        capabilities: resolveModelRouteCapabilities(wire, "context-fixture", { context: 10_000 }),
      }),
      { provider: wire, model: "context-fixture", baseUrl: baseURL },
      undefined,
      { ledger, context: { purpose: "main", sessionId: wire }, contextFacts: facts },
    );
    const lifecycle: ProviderAttemptLifecycleSnapshot[] = [];
    const messages = [
      { role: "system" as const, content: "stable system" },
      { role: "user" as const, content: "inspect" },
    ];
    const result = await tracker.generate(
      messages,
      [
        {
          name: "inspect",
          description: "Inspect",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      {
        contextFacts: { version: 1, compaction },
        onRequestPrepared: () => {
          facts.contextWindow = 20_000;
        },
        onProviderAttemptStart: async (snapshot) => {
          lifecycle.push(snapshot);
        },
        onProviderAttemptUpdate: async (snapshot) => {
          lifecycle.push(snapshot);
        },
      },
    );
    assert.equal(result.content, "Done");
    assert.equal(result.usage?.promptTokens, 120);
    assert.equal(result.usage?.cacheReadTokens, 80);
    assert.equal(result.usage?.completionTokens, 9);
    assert.deepEqual(
      lifecycle.map((entry) => entry.status),
      ["prepared", "observed", "succeeded"],
    );
    const reported = ledger.getLatestContextAttempt(wire)!;
    assert.equal(reported.contextFacts?.contextWindow, 10_000);
    assert.deepEqual(reported.contextFacts?.compaction, compaction);
    assert.equal(reported.contextFacts?.connectionId, "fixture");
    assert.equal(reported.usage?.promptTokens, 120);
    assert.ok(reported.requestDiagnostic, "same request retains composition capture");
    assert.doesNotMatch(JSON.stringify(bodies), /contextFacts|checkpoint-1|throughEventId/);
    mode = "missing";
    await tracker.generate(messages, []);
    const missing = ledger.getLatestContextAttempt(wire)!;
    assert.notEqual(missing.physicalAttemptId, reported.physicalAttemptId);
    assert.equal(missing.contextFacts?.contextWindow, 20_000);
    assert.equal(missing.contextFacts?.compaction, undefined);
    if (wire === "claude")
      assert.equal(missing.usage?.promptTokens, 0, "explicitly reported zero stays zero");
    else assert.notEqual(missing.usageBasis, "reported");
    assert.notEqual(
      missing.usage?.promptTokens,
      120,
      "missing usage cannot borrow the older 120-token request",
    );
    mode = "failed";
    await assert.rejects(tracker.generate(messages, []));
    assert.equal(
      ledger.getLatestContextAttempt(wire)?.physicalAttemptId,
      missing.physicalAttemptId,
    );
    assert.equal(bodies.length, 3);
  });
}

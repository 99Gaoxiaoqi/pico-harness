import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { ProviderAttemptLifecycleSnapshot } from "@pico/core";
import { AiSdkProvider } from "@pico/pico-host/provider/ai-sdk-provider";
import { resolveModelRouteCapabilities } from "@pico/runtime";

async function fixture(reply: (res: ServerResponse) => void, cache = false) {
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* consume body */
    }
    requests++;
    reply(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    provider: new AiSdkProvider("openai", {
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: "test",
      model: "lifecycle-test",
      capabilities: resolveModelRouteCapabilities("openai", "lifecycle-test", {
        streamUsage: true,
        ...(cache ? { cache: true, promptCache: { mode: "implicit" as const } } : {}),
      }),
    }),
    requests: () => requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
const messages = [{ role: "user" as const, content: "hello" }];
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
function success(res: ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    frame({
      id: "test",
      choices: [{ index: 0, delta: { content: "answer" }, finish_reason: null }],
    }) +
      frame({
        id: "test",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      }) +
      "data: [DONE]\n\n",
  );
}

test("durable admission blocks HTTP and each real dispatch publishes ordered lifecycle snapshots", async () => {
  const f = await fixture(success);
  try {
    await assert.rejects(
      f.provider.generateStream(messages, [], () => {}, {
        onProviderAttemptStart: async () => {
          throw new Error("accounting admission unavailable");
        },
      }),
      /本地请求计量准备记录写入失败/,
    );
    assert.equal(f.requests(), 0);
    const facts: ProviderAttemptLifecycleSnapshot[] = [];
    const result = await f.provider.generateStream(messages, [], () => {}, {
      onProviderAttemptStart: async (fact) => {
        assert.equal(f.requests(), 0);
        facts.push(fact);
        await delay(20);
      },
      onProviderAttemptUpdate: async (fact) => {
        facts.push(fact);
      },
    });
    assert.equal(result.content, "answer");
    assert.deepEqual(
      facts.map((f) => f.status),
      ["prepared", "observed", "succeeded"],
    );
    assert.deepEqual(
      facts.map((f) => f.revision),
      [0, 1, 2],
    );
    assert.equal(new Set(facts.map((f) => f.physicalAttemptId)).size, 1);
    assert.equal(facts[0]!.httpStatus, undefined);
    assert.equal(facts[2]!.usage!.completionTokens, 3);
  } finally {
    await f.close();
  }
});

test("post-response accounting failure is retried locally and never issues another model request", async () => {
  const f = await fixture(success);
  const revisions: number[] = [];
  try {
    const result = await f.provider.generateStream(messages, [], () => {}, {
      onProviderAttemptStart: async () => {},
      onProviderAttemptUpdate: async (fact) => {
        revisions.push(fact.revision);
        throw new Error("disk unavailable");
      },
    });
    assert.equal(result.content, "answer");
    assert.equal(f.requests(), 1);
    assert.deepEqual(revisions, [1, 1, 2, 2]);
  } finally {
    await f.close();
  }
});

test("cancel returns immediately while already-delivered SDK usage revises the cancelled attempt only", async () => {
  const f = await fixture(success);
  const facts: ProviderAttemptLifecycleSnapshot[] = [];
  const controller = new AbortController();
  let deltas = 0;
  let cancelledAt = 0;
  try {
    await assert.rejects(
      f.provider.generateStream(
        messages,
        [],
        () => {
          deltas++;
          cancelledAt = performance.now();
          controller.abort();
        },
        {
          signal: controller.signal,
          onProviderAttemptStart: async (fact) => {
            facts.push(fact);
          },
          onProviderAttemptUpdate: async (fact) => {
            facts.push(fact);
          },
        },
      ),
    );
    assert.ok(performance.now() - cancelledAt < 500);
    for (let i = 0; i < 40 && facts.at(-1)?.usageBasis !== "reported"; i++) await delay(25);
    assert.equal(facts.at(-1)!.status, "cancelled");
    assert.equal(facts.at(-1)!.usageBasis, "reported");
    assert.equal(facts.at(-1)!.usage!.completionTokens, 3);
    assert.equal(new Set(facts.map((f) => f.physicalAttemptId)).size, 1);
    assert.equal(deltas, 1);
    assert.equal(f.requests(), 1);
  } finally {
    await f.close();
  }
});

test("cancel with no delivered terminal usage remains partial and closes transport", async () => {
  let closed = false;
  const f = await fixture((res) => {
    res.on("close", () => {
      closed = true;
    });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      frame({ id: "partial", choices: [], usage: { prompt_tokens: 7 } }) +
        frame({
          id: "partial",
          choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
        }),
    );
  });
  const facts: ProviderAttemptLifecycleSnapshot[] = [];
  const controller = new AbortController();
  try {
    await assert.rejects(
      f.provider.generateStream(messages, [], () => controller.abort(), {
        signal: controller.signal,
        onProviderAttemptStart: async (fact) => {
          facts.push(fact);
        },
        onProviderAttemptUpdate: async (fact) => {
          facts.push(fact);
        },
      }),
    );
    await delay(100);
    assert.equal(closed, true);
    assert.equal(facts.at(-1)!.status, "cancelled");
    assert.equal(facts.at(-1)!.usageBasis, "partial");
    assert.deepEqual(facts.at(-1)!.usage!.reportedFields, ["prompt"]);
    assert.equal(f.requests(), 1);
  } finally {
    await f.close();
  }
});

test("compatibility downgrade admits and settles each HTTP request independently", async () => {
  let count = 0;
  const f = await fixture((res) => {
    if (++count === 1) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "unsupported prompt_cache_key" } }));
    } else success(res);
  }, true);
  const facts: ProviderAttemptLifecycleSnapshot[] = [];
  try {
    await f.provider.generateStream(messages, [], () => {}, {
      onProviderAttemptStart: async (fact) => {
        facts.push(fact);
      },
      onProviderAttemptUpdate: async (fact) => {
        facts.push(fact);
      },
    });
    assert.equal(f.requests(), 2);
    const starts = facts.filter((fact) => fact.status === "prepared");
    assert.equal(new Set(starts.map((fact) => fact.physicalAttemptId)).size, 2);
    for (const [index, start] of starts.entries()) {
      const lifecycle = facts.filter((fact) => fact.physicalAttemptId === start.physicalAttemptId);
      assert.deepEqual(
        lifecycle.map((fact) => fact.revision),
        [0, 1, 2],
      );
      assert.deepEqual(
        lifecycle.map((fact) => fact.status),
        ["prepared", "observed", index === 0 ? "failed" : "succeeded"],
      );
    }
  } finally {
    await f.close();
  }
});

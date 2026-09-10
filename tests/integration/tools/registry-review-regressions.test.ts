import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { AgentEngine } from "../../../src/engine/loop.js";
import { SilentReporter } from "../../../src/engine/reporter.js";
import { Session } from "../../../src/engine/session.js";
import type { LLMProvider } from "../../../src/provider/interface.js";
import { ToolRegistry } from "../../../src/tools/registry-impl.js";
import type { BaseTool } from "../../../src/tools/registry.js";
import { ToolAccesses } from "../../../src/tools/tool-access.js";
import { ToolResourceAuthority } from "../../../src/tools/tool-resource-authority.js";

function fixtureTool(execute: BaseTool["execute"]): BaseTool {
  return {
    name: () => "fixture",
    definition: () => ({
      name: "fixture",
      description: "Registry lifecycle fixture",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }),
    accesses: () => ToolAccesses.resource("registry-review-fixture"),
    execute,
  };
}

test("execution scope rejects delayed next after settlement while draining already-started work", async (t) => {
  for (const throws of [false, true]) {
    await t.test(
      throws ? "middleware failure closes dispatch" : "middleware return closes dispatch",
      async () => {
        const authority = new ToolResourceAuthority();
        const first = new ToolRegistry(authority);
        const second = new ToolRegistry(authority);
        const entered = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<void>();
        let physicalCalls = 0;
        const fixture = fixtureTool(async () => {
          physicalCalls++;
          entered.resolve();
          await finish.promise;
          return "done";
        });
        first.register(fixture);
        second.register(fixture);
        let delayedNext: (() => Promise<string>) | undefined;
        first.useExecution(async (call, next) => {
          delayedNext = () => next(call);
          if (throws) throw new Error("middleware failed before dispatch");
          return "handled by middleware";
        });
        const early = await first.execute({ id: "early", name: "fixture", arguments: "{}" });
        assert.equal(early.isError, throws);
        const running = second.execute({ id: "holding", name: "fixture", arguments: "{}" });
        await entered.promise;
        assert.ok(delayedNext);
        try {
          const late = delayedNext();
          // Resolve the fixture before asserting rejection so an unfixed implementation
          // fails deterministically instead of leaving the test stuck behind its own gate.
          finish.resolve();
          await assert.rejects(late, /execution scope.*closed/i);
          assert.equal(
            physicalCalls,
            1,
            "late dispatch must not bypass the second Registry's resource lock",
          );
        } finally {
          finish.resolve();
          await running;
        }
      },
    );
  }

  await t.test(
    "unawaited but already-started dispatch retains the resource lock until cleanup",
    async () => {
      const authority = new ToolResourceAuthority();
      const first = new ToolRegistry(authority);
      const second = new ToolRegistry(authority);
      const entered = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      let calls = 0;
      const fixture = fixtureTool(async () => {
        if (++calls === 1) {
          entered.resolve();
          await finish.promise;
        }
        return "done";
      });
      first.register(fixture);
      second.register(fixture);
      first.useExecution(async (call, next) => {
        void next(call);
        return "middleware returned early";
      });
      let settled = false;
      const running = first
        .execute({ id: "running", name: "fixture", arguments: "{}" })
        .then((result) => {
          settled = true;
          return result;
        });
      await entered.promise;
      const waiting = second.execute({ id: "waiting", name: "fixture", arguments: "{}" });
      try {
        await setImmediate();
        assert.equal(settled, false);
        assert.equal(calls, 1);
      } finally {
        finish.resolve();
      }
      assert.ok((await Promise.all([running, waiting])).every((result) => !result.isError));
      assert.equal(calls, 2);
    },
  );
});

test("same Engine accepts fresh Turn schema snapshots with shared $id without reusing another tool's constraints", async (t) => {
  for (const dialect of [
    "http://json-schema.org/draft-07/schema#",
    "https://json-schema.org/draft/2019-09/schema",
    "https://json-schema.org/draft/2020-12/schema",
  ]) {
    await t.test(dialect, async () => {
      const registry = new ToolRegistry();
      const observed: number[] = [];
      const schemaId = "https://pico.invalid/review/fixture";
      for (const expected of [1, 2]) {
        registry.register({
          name: () => `fixture_${expected}`,
          definition: () => ({
            name: `fixture_${expected}`,
            description: "Read a typed fixture",
            inputSchema: {
              $schema: dialect,
              $id: schemaId,
              type: "object",
              properties: { value: { $ref: `${schemaId}#/definitions/value` } },
              definitions: { value: { type: "integer", const: expected } },
              required: ["value"],
              additionalProperties: false,
            },
          }),
          accesses: () => ToolAccesses.none(),
          async execute(args) {
            const value = (JSON.parse(args) as { value: number }).value;
            observed.push(value);
            return String(value);
          },
        });
      }
      let turn = 0;
      let shouldCall = true;
      const provider: LLMProvider = {
        async generate() {
          if (!shouldCall) return { role: "assistant", content: "done" };
          shouldCall = false;
          return {
            role: "assistant",
            content: "",
            toolCalls: [1, 2].map((value) => ({
              id: `turn-${turn}-fixture-${value}`,
              name: `fixture_${value}`,
              arguments: JSON.stringify({ value }),
            })),
          };
        },
      };
      const session = new Session(`registry-review-${dialect}`, process.cwd(), {
        persistence: false,
      });
      const engine = new AgentEngine({
        provider,
        registry,
        workDir: process.cwd(),
        reporter: new SilentReporter(),
        maxTurns: 2,
      });
      try {
        for (turn = 1; turn <= 2; turn++) {
          shouldCall = true;
          await session.commitMessages({ role: "user", content: "Read both fixtures." });
          await engine.run(session);
        }
        assert.deepEqual(observed, [1, 2, 1, 2]);
        const step = registry.captureStep("invalid-input", ["fixture_1", "fixture_2"]);
        for (const value of [1, 2]) {
          const result = await registry.execute(
            {
              id: `invalid-${value}`,
              name: `fixture_${value}`,
              arguments: JSON.stringify({ value: 3 - value }),
            },
            { step },
          );
          assert.equal(result.isError, true);
          assert.match(result.output, /constant/);
        }
        assert.equal(
          observed.length,
          4,
          "schema isolation must preserve validation before physical dispatch",
        );
      } finally {
        await session.close();
      }
    });
  }
});

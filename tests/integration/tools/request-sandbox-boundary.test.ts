import assert from "node:assert/strict";
import test from "node:test";
import { buildDefaultToolRegistry } from "../../../src/tools/default-registry.js";
import {
  RequestSandboxBoundaryTool,
  type RequestSandboxBoundaryHandler,
} from "../../../src/tools/request-sandbox-boundary.js";
import { ToolRegistry } from "../../../src/tools/registry-impl.js";
import { NO_FILE_SIDE_EFFECTS, type ToolExecutionContext } from "../../../src/tools/registry.js";
import { ToolAccesses } from "../../../src/tools/tool-access.js";

const VALID_INPUT = {
  expansion: {
    filesystem: {
      entries: [{ path: "/outside/project", access: "read", scope: "subtree" }],
    },
    network: { enabled: true },
  },
  justification: "Inspect an external dependency and its upstream documentation.",
} as const;

test("request_sandbox_boundary declares a strict, direct-only exclusive control surface", async () => {
  const calls: unknown[] = [];
  const tool = new RequestSandboxBoundaryTool(async (...args) => {
    calls.push(args);
    return { status: "noop" };
  });
  const registry = new ToolRegistry();
  registry.register(tool);

  const definition = tool.definition();
  assert.deepEqual(definition.inputSchema["required"], ["expansion", "justification"]);
  assert.equal(definition.inputSchema["additionalProperties"], false);
  assert.equal(tool.executionSemantics, "exclusive_step");
  assert.equal(tool.nesting, "direct_only");
  assert.equal(tool.permissionCategory, "bounded_control");
  assert.equal(tool.readOnly, false);
  assert.strictEqual(tool.fileSideEffects, NO_FILE_SIDE_EFFECTS);
  assert.deepEqual(tool.accesses(), ToolAccesses.all());
  assert.equal(registry.getExecutionSemantics(tool.name()), "exclusive_step");
  assert.equal(registry.getNesting(tool.name()), "direct_only");
  assert.equal(registry.getPermissionCategory(tool.name()), "bounded_control");
  assert.deepEqual(
    registry.getFileSideEffects({
      id: "boundary-side-effects",
      name: tool.name(),
      arguments: JSON.stringify(VALID_INPUT),
    }),
    { kind: "none" },
  );

  const invalidInputs = [
    { ...VALID_INPUT, extra: true },
    { ...VALID_INPUT, justification: "   " },
    { ...VALID_INPUT, expansion: {} },
    {
      ...VALID_INPUT,
      expansion: {
        filesystem: {
          entries: [{ path: "/outside/project", access: "execute", scope: "subtree" }],
        },
      },
    },
    {
      ...VALID_INPUT,
      expansion: { network: { enabled: true, extra: true } },
    },
  ];
  for (const [index, input] of invalidInputs.entries()) {
    const result = await registry.execute({
      id: `invalid-schema-${index}`,
      name: tool.name(),
      arguments: JSON.stringify(input),
    });
    assert.equal(result.isError, true);
    assert.match(result.output, /Invalid tool arguments/u);
  }
  assert.equal(calls.length, 0);
});

test("request_sandbox_boundary validates and normalizes authority before invoking its handler", async () => {
  let captured:
    | {
        expansion: Parameters<RequestSandboxBoundaryHandler>[0];
        justification: string;
        context: ToolExecutionContext | undefined;
      }
    | undefined;
  const tool = new RequestSandboxBoundaryTool(async (expansion, justification, context) => {
    captured = { expansion, justification, context };
    return {
      status: "applied",
      requestId: " boundary-request-1 ",
      boundaryRevision: 7,
    };
  });
  const context: ToolExecutionContext = { toolCallId: "boundary-call-1" };
  const output = await tool.execute(
    JSON.stringify({
      expansion: {
        filesystem: {
          entries: [
            { path: "/outside/project/file.txt", access: "read", scope: "exact" },
            { path: "/outside/project", access: "read", scope: "subtree" },
          ],
        },
      },
      justification: "  Read the dependency source.  ",
    }),
    context,
  );

  assert.equal(
    output,
    '{"status":"applied","requestId":"boundary-request-1","boundaryRevision":7}',
  );
  assert.deepEqual(captured?.expansion, {
    filesystem: {
      entries: [{ path: "/outside/project", access: "read", scope: "subtree" }],
    },
  });
  assert.equal(captured?.justification, "Read the dependency source.");
  assert.strictEqual(captured?.context, context);
});

test("request_sandbox_boundary rejects invalid expansion before host dispatch", async () => {
  let calls = 0;
  const tool = new RequestSandboxBoundaryTool(async () => {
    calls++;
    return { status: "applied" };
  });
  await assert.rejects(
    tool.execute(
      JSON.stringify({
        expansion: {
          filesystem: {
            entries: [{ path: "../outside", access: "write", scope: "subtree" }],
          },
        },
        justification: "Need to write generated output.",
      }),
    ),
    /invalid_path/u,
  );
  assert.equal(calls, 0);
});

test("request_sandbox_boundary returns explicit denial but fails closed when unavailable or broken", async () => {
  const denied = new RequestSandboxBoundaryTool(async () => ({
    status: "denied",
    requestId: "request-denied-1",
    reason: "User denied the expansion.",
  }));
  assert.equal(
    await denied.execute(JSON.stringify(VALID_INPUT)),
    '{"status":"denied","requestId":"request-denied-1","reason":"User denied the expansion."}',
  );

  await assert.rejects(
    new RequestSandboxBoundaryTool().execute(JSON.stringify(VALID_INPUT)),
    /is unavailable/u,
  );

  const registry = new ToolRegistry();
  registry.register(
    new RequestSandboxBoundaryTool(async () => {
      throw new Error("boundary store is unavailable");
    }),
  );
  const failed = await registry.execute({
    id: "broken-boundary-handler",
    name: "request_sandbox_boundary",
    arguments: JSON.stringify(VALID_INPUT),
  });
  assert.equal(failed.isError, true);
  assert.match(failed.output, /boundary store is unavailable/u);
  assert.doesNotMatch(failed.output, /"status":"denied"/u);
});

test("request_sandbox_boundary owns its Step and cannot run from nested code", async () => {
  let calls = 0;
  const registry = new ToolRegistry();
  registry.register(
    new RequestSandboxBoundaryTool(async () => {
      calls++;
      return { status: "noop", boundaryRevision: 3 };
    }),
  );
  registry.register({
    name: () => "sibling_read",
    readOnly: true,
    nesting: "nestable",
    fileSideEffects: NO_FILE_SIDE_EFFECTS,
    accesses: () => ToolAccesses.none(),
    definition: () => ({
      name: "sibling_read",
      description: "Test-only read.",
      inputSchema: { type: "object", additionalProperties: false },
    }),
    execute: async () => "read",
  });

  const step = registry.captureStep("exclusive-boundary-step", [
    "request_sandbox_boundary",
    "sibling_read",
  ]);
  const boundary = await registry.execute(
    {
      id: "exclusive-boundary",
      name: "request_sandbox_boundary",
      arguments: JSON.stringify(VALID_INPUT),
    },
    { step },
  );
  assert.equal(boundary.isError, false);
  assert.deepEqual(JSON.parse(boundary.output), { status: "noop", boundaryRevision: 3 });
  const sibling = await registry.execute(
    { id: "exclusive-sibling", name: "sibling_read", arguments: "{}" },
    { step },
  );
  assert.equal(sibling.isError, true);
  assert.match(sibling.output, /cannot share an assistant Step/u);

  const nestedStep = registry.captureStep("nested-boundary-step", ["request_sandbox_boundary"]);
  const nested = await registry.execute(
    {
      id: "nested-boundary",
      name: "request_sandbox_boundary",
      arguments: JSON.stringify(VALID_INPUT),
    },
    { step: nestedStep, origin: "code_mode" },
  );
  assert.equal(nested.isError, true);
  assert.match(nested.output, /direct_only/u);
  assert.equal(calls, 1);
});

test("default registry exposes request_sandbox_boundary only with host authority", () => {
  assert.equal(
    buildDefaultToolRegistry(process.cwd()).getTool("request_sandbox_boundary"),
    undefined,
  );
  const handler: RequestSandboxBoundaryHandler = async () => ({ status: "noop" });
  assert.ok(
    buildDefaultToolRegistry(process.cwd(), { requestSandboxBoundaryHandler: handler }).getTool(
      "request_sandbox_boundary",
    ),
  );
});

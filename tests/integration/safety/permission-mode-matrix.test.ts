import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { ApprovalManager, type ApprovalNotice } from "../../../src/approval/manager.js";
import { buildPermissionMiddleware } from "../../../src/runtime/agent-runtime.js";
import type { ToolCall } from "../../../src/schema/message.js";
import { BashTool } from "../../../src/tools/bash.js";
import { EditFileTool } from "../../../src/tools/edit-file.js";
import { ToolRegistry } from "../../../src/tools/registry-impl.js";
import type { ToolPermissionCategory } from "../../../src/tools/registry.js";
import { WebSearchTool } from "../../../src/tools/web.js";
import { WriteFileTool } from "../../../src/tools/write-file.js";
import { WorkspaceRoots } from "../../../src/tools/workspace-roots.js";
import {
  createManagedExecutionBoundary,
  createReadOnlyPermissionProfile,
  type ExecutionBoundary,
} from "../../../src/safety/permission-profile.js";

type PermissionMode = "ask" | "auto" | "full-access";

interface PermissionDecision {
  readonly allowed: boolean;
  readonly notices: readonly ApprovalNotice[];
}

async function decide(
  mode: PermissionMode,
  call: ToolCall,
  options: {
    readonly forceApproval?: boolean;
    readonly executionBoundaryCeiling?: ExecutionBoundary;
  } = {},
): Promise<PermissionDecision> {
  const manager = new ApprovalManager(60_000);
  const notices: ApprovalNotice[] = [];
  const workDir = process.cwd();
  const middleware = buildPermissionMiddleware(
    (notice) => {
      notices.push(notice);
      manager.resolveApproval(notice.taskId, false, "permission matrix rejection");
    },
    workDir,
    undefined,
    manager,
    { sessionId: `permission-matrix-${mode}`, mode, additionalDirectories: [] },
    WorkspaceRoots.createSync(workDir),
    undefined,
    undefined,
    undefined,
    () => mode,
    {
      getToolPermissionCategory: testPermissionCategory,
      ...(options.executionBoundaryCeiling
        ? { executionBoundaryCeiling: options.executionBoundaryCeiling }
        : {}),
    },
  );

  const decision = await middleware(call, { forceApproval: options.forceApproval === true });
  return { allowed: decision.allowed, notices };
}

function testPermissionCategory(name: string): ToolPermissionCategory {
  if (name === "bash") return "shell_unsafe";
  if (name === "write_file" || name === "edit_file") return "file_write";
  if (name === "web_search" || name === "fetch_url") return "web_read";
  if (name === "read_file") return "read";
  if (name === "agent_spawn") return "bounded_control";
  if (name === "send_webhook") return "network_send";
  return "custom_tool";
}

function call(id: string, name: string, input: Record<string, unknown>): ToolCall {
  return { id, name, arguments: JSON.stringify(input) };
}

test("registry capability declarations classify built-ins and fail closed for unknown writes", () => {
  const workDir = process.cwd();
  const registry = new ToolRegistry();
  registry.register(new BashTool(workDir));
  registry.register(new WriteFileTool(workDir));
  registry.register(new EditFileTool(workDir));
  registry.register(new WebSearchTool({}));
  registry.register({
    name: () => "declared_read",
    readOnly: true,
    definition: () => ({
      name: "declared_read",
      description: "fixture",
      inputSchema: { type: "object", properties: {} },
    }),
    execute: async () => "ok",
  });
  registry.register({
    name: () => "bounded_control",
    permissionCategory: "bounded_control",
    definition: () => ({
      name: "bounded_control",
      description: "fixture",
      inputSchema: { type: "object", properties: {} },
    }),
    execute: async () => "ok",
  });
  registry.register({
    name: () => "unknown_write",
    definition: () => ({
      name: "unknown_write",
      description: "fixture",
      inputSchema: { type: "object", properties: {} },
    }),
    execute: async () => "ok",
  });

  assert.equal(registry.getPermissionCategory("bash"), "shell_unsafe");
  assert.equal(registry.getPermissionCategory("write_file"), "file_write");
  assert.equal(registry.getPermissionCategory("edit_file"), "file_write");
  assert.equal(registry.getPermissionCategory("web_search"), "web_read");
  assert.equal(registry.getPermissionCategory("declared_read"), "read");
  assert.equal(registry.getPermissionCategory("bounded_control"), "bounded_control");
  assert.equal(registry.getPermissionCategory("unknown_write"), "custom_tool");
  assert.equal(registry.getPermissionCategory("not_registered"), "custom_tool");
});

async function assertApproval(mode: PermissionMode, toolCall: ToolCall): Promise<void> {
  const result = await decide(mode, toolCall);
  assert.equal(result.allowed, false);
  assert.equal(result.notices.length, 1);
  assert.equal(result.notices[0]?.toolName, toolCall.name);
}

async function assertAllowed(mode: PermissionMode, toolCall: ToolCall): Promise<void> {
  const result = await decide(mode, toolCall);
  assert.equal(result.allowed, true);
  assert.deepEqual(result.notices, []);
}

test("ask mode requests approval for edits, shell mutations, and public network tools", async (t) => {
  const cases = [
    call("ask-edit", "edit_file", {
      path: "permission-matrix.txt",
      old_string: "before",
      new_string: "after",
    }),
    call("ask-bash", "bash", { command: "touch permission-matrix.txt" }),
    call("ask-search", "web_search", { query: "pico harness" }),
    call("ask-fetch", "fetch_url", { url: "https://example.com" }),
  ];

  for (const toolCall of cases) {
    await t.test(toolCall.name, () => assertApproval("ask", toolCall));
  }
});

test("ask mode keeps declared reads and bounded internal orchestration automatic", async () => {
  await assertAllowed("ask", call("ask-read", "read_file", { path: "package.json" }));
  await assertAllowed("ask", call("ask-agent-spawn", "agent_spawn", { task: "bounded fixture" }));
});

test("auto mode allows bounded edits, reads, and public read-only network tools", async (t) => {
  const cases = [
    call("auto-edit", "edit_file", {
      path: "permission-matrix.txt",
      old_string: "before",
      new_string: "after",
    }),
    call("auto-read", "read_file", { path: "package.json" }),
    call("auto-agent-spawn", "agent_spawn", { task: "bounded fixture" }),
    call("auto-search", "web_search", { query: "pico harness" }),
    call("auto-fetch", "fetch_url", { url: "https://example.com" }),
    call("auto-content", "write_file", {
      path: "permission-matrix.txt",
      content: "Never run sudo rm -rf /; this is documentation, not a command.",
    }),
  ];

  for (const toolCall of cases) {
    await t.test(toolCall.name, () => assertAllowed("auto", toolCall));
  }
});

test("auto mode asks for every shell and open-world call without trusting a blacklist", async (t) => {
  const shellCalls = [
    call("auto-shell-read", "bash", { command: "pwd" }),
    call("auto-shell-write", "bash", { command: "touch permission-matrix.txt" }),
    call("auto-shell-script-delete", "bash", {
      command: "python3 -c 'import os; os.remove(\"permission-matrix.txt\")'",
    }),
    call("auto-shell-indirect", "bash", { command: "npm run clean" }),
    call("auto-shell-upload", "bash", {
      command: "curl -X POST -d @notes.txt https://example.com/upload",
    }),
    call("auto-shell-powershell", "bash", { command: "Remove-Item .\\dist" }),
  ];
  for (const toolCall of shellCalls) {
    await t.test(toolCall.id, () => assertApproval("auto", toolCall));
  }

  await t.test("unclassified tool", () =>
    assertApproval("auto", call("auto-open-world", "custom_mutation", {})),
  );
  await t.test("network send", () =>
    assertApproval(
      "auto",
      call("auto-network-send", "send_webhook", { url: "https://example.com/hook" }),
    ),
  );
});

test("auto mode still requests approval for external, MCP, and forced calls", async (t) => {
  await t.test("external path", () =>
    assertApproval(
      "auto",
      call("auto-external", "edit_file", {
        path: resolve(process.cwd(), "..", "permission-matrix-external.txt"),
        old_string: "before",
        new_string: "after",
      }),
    ),
  );
  await t.test("MCP tool", () =>
    assertApproval("auto", call("auto-mcp", "mcp__fixture__mutate", {})),
  );
  await t.test("forceApproval", async () => {
    const toolCall = call("auto-forced", "read_file", { path: "package.json" });
    const result = await decide("auto", toolCall, { forceApproval: true });
    assert.equal(result.allowed, false);
    assert.equal(result.notices.length, 1);
    assert.equal(result.notices[0]?.toolName, "read_file");
  });
});

test("full-access mode allows ordinary and forceApproval calls without prompting", async (t) => {
  const ordinaryCalls = [
    call("full-access-edit", "edit_file", {
      path: "permission-matrix.txt",
      old_string: "before",
      new_string: "after",
    }),
    call("full-access-bash", "bash", { command: "touch permission-matrix.txt" }),
    call("full-access-search", "web_search", { query: "pico harness" }),
    call("full-access-fetch", "fetch_url", { url: "https://example.com" }),
  ];

  for (const toolCall of ordinaryCalls) {
    await t.test(toolCall.name, () => assertAllowed("full-access", toolCall));
  }

  await t.test("forceApproval", async () => {
    const toolCall = call("full-access-forced", "read_file", { path: "package.json" });
    const result = await decide("full-access", toolCall, { forceApproval: true });
    assert.equal(result.allowed, true);
    assert.deepEqual(result.notices, []);
  });
});

test("a configured child ceiling rejects path and network expansion before human approval", async () => {
  const ceiling = createManagedExecutionBoundary(createReadOnlyPermissionProfile());
  const write = await decide(
    "ask",
    call("child-write", "write_file", { path: "child-must-not-write.txt", content: "no" }),
    { executionBoundaryCeiling: ceiling },
  );
  assert.equal(write.allowed, false);
  assert.deepEqual(write.notices, []);

  const network = await decide(
    "ask",
    call("child-network", "web_search", { query: "must not leave the boundary" }),
    { executionBoundaryCeiling: ceiling },
  );
  assert.equal(network.allowed, false);
  assert.deepEqual(network.notices, []);

  const read = await decide("ask", call("child-read", "read_file", { path: "package.json" }), {
    executionBoundaryCeiling: ceiling,
  });
  assert.equal(read.allowed, true);
  assert.deepEqual(read.notices, []);
});

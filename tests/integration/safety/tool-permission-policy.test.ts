import assert from "node:assert/strict";
import { test } from "node:test";
import {
  categorizeBashCommand,
  classifyToolPermission,
  evaluateToolPermission,
  type RuntimePermissionMode,
  type ToolPermissionCategory,
} from "../../../src/approval/tool-permission-policy.js";
import { ToolRegistry } from "../../../src/tools/registry-impl.js";

const ALL_CATEGORIES: readonly ToolPermissionCategory[] = [
  "read",
  "web_read",
  "file_write",
  "fs_destructive",
  "shell_safe",
  "shell_unsafe",
  "git_destructive",
  "network_send",
  "privileged",
  "browser",
  "computer_use",
  "client_capability",
  "custom_tool",
  "subagent",
  "bounded_control",
];

const EXPECTED: Readonly<
  Record<RuntimePermissionMode, Readonly<Record<ToolPermissionCategory, "allow" | "prompt" | "deny">>>
> = {
  ask: {
    read: "allow",
    web_read: "prompt",
    file_write: "prompt",
    fs_destructive: "prompt",
    shell_safe: "prompt",
    shell_unsafe: "prompt",
    git_destructive: "prompt",
    network_send: "prompt",
    privileged: "prompt",
    browser: "prompt",
    computer_use: "prompt",
    client_capability: "deny",
    custom_tool: "prompt",
    subagent: "allow",
    bounded_control: "allow",
  },
  auto: {
    read: "allow",
    web_read: "allow",
    file_write: "allow",
    fs_destructive: "prompt",
    shell_safe: "prompt",
    shell_unsafe: "prompt",
    git_destructive: "prompt",
    network_send: "prompt",
    privileged: "prompt",
    browser: "prompt",
    computer_use: "prompt",
    client_capability: "deny",
    custom_tool: "prompt",
    subagent: "allow",
    bounded_control: "allow",
  },
  "full-access": Object.fromEntries(ALL_CATEGORIES.map((category) => [category, "allow"])) as Record<
    ToolPermissionCategory,
    "allow"
  >,
};

test("permission evaluator exhaustively applies ask, auto and full-access policy", () => {
  for (const mode of ["ask", "auto", "full-access"] as const) {
    for (const category of ALL_CATEGORIES) {
      const decision = evaluateToolPermission(mode, category);
      assert.equal(decision.kind, EXPECTED[mode][category], `${mode}:${category}`);
      if (decision.kind !== "allow") assert.ok(decision.reason.length > 0, `${mode}:${category}`);
    }
  }
});

test("unknown tools fail closed through registry and classifier fallbacks", () => {
  const registry = new ToolRegistry();
  registry.register({
    name: () => "undeclared_mutation",
    definition: () => ({
      name: "undeclared_mutation",
      description: "fixture",
      inputSchema: { type: "object", properties: {} },
    }),
    execute: async () => "ok",
  });

  assert.equal(registry.getPermissionCategory("missing_tool"), "custom_tool");
  assert.equal(registry.getPermissionCategory("undeclared_mutation"), "custom_tool");
  const category = classifyToolPermission(
    { name: "undeclared_mutation", arguments: "{}" },
    (name) => registry.getPermissionCategory(name),
  );
  assert.equal(category, "custom_tool");
  assert.equal(evaluateToolPermission("ask", category).kind, "prompt");
  assert.equal(evaluateToolPermission("auto", category).kind, "prompt");
});

test("MCP and browser names retain host-owned classifications", () => {
  const misleadingMetadata = () => "read" as const;
  assert.equal(
    classifyToolPermission(
      { name: "mcp__fixture__mutate", arguments: "{}" },
      misleadingMetadata,
    ),
    "network_send",
  );
  assert.equal(
    classifyToolPermission(
      { name: "browser_navigate", arguments: '{"url":"https://example.com"}' },
      misleadingMetadata,
    ),
    "browser",
  );
  assert.equal(
    classifyToolPermission({ name: "browser_get_state", arguments: "{}" }, () => "custom_tool"),
    "read",
  );
});

test("Bash risk classification remains conservative and recognizes destructive nesting", () => {
  const cases: ReadonlyArray<readonly [string, ToolPermissionCategory]> = [
    ["pwd", "shell_unsafe"],
    ["git status --short", "shell_unsafe"],
    ["sudo apt-get update", "privileged"],
    ["rm -rf ./dist", "fs_destructive"],
    ["git reset --hard HEAD", "git_destructive"],
    ["bash -c 'rm -rf ./dist'", "fs_destructive"],
    ["bash -c 'git reset --hard HEAD'", "git_destructive"],
    ["sh -c 'sudo whoami'", "privileged"],
  ];

  for (const [command, expected] of cases) {
    assert.equal(categorizeBashCommand(command), expected, command);
    assert.equal(
      classifyToolPermission({ name: "bash", arguments: JSON.stringify({ command }) }),
      expected,
      command,
    );
    assert.equal(evaluateToolPermission("ask", expected).kind, "prompt", command);
    assert.equal(evaluateToolPermission("auto", expected).kind, "prompt", command);
  }
});

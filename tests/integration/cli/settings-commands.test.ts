import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeUserDefaults } from "@pico/protocol";
import { createSettingsCommands, type SettingsCommandRuntime } from "@pico/cli/settings-commands";
import * as helpers from "@pico/cli/command-helpers";
import { createSettingsCommands as legacyCreateSettingsCommands } from "../../../src/tui/commands/settings-commands.js";
import * as legacyHelpers from "../../../src/tui/commands/shared.js";

test("设置命令通过窄 runtime 端口设置新会话并发送 Swarm 任务，旧入口保持同一实现", async () => {
  assert.equal(createSettingsCommands, legacyCreateSettingsCommands);
  for (const name of [
    "rpcCommand",
    "staticCompleter",
    "cachedArgumentCompleter",
    "sessionAccess",
  ] as const) {
    assert.equal(helpers[name], legacyHelpers[name]);
  }
  let defaults: RuntimeUserDefaults = {};
  const sent: unknown[] = [];
  const runtime: SettingsCommandRuntime = {
    activeSessionId: undefined,
    get preSessionSettings() {
      return defaults;
    },
    request: async () => {
      throw new Error("新会话预设不应发出 settings RPC");
    },
    setPreSessionCollaborationMode: (collaborationMode) => {
      defaults = { ...defaults, collaborationMode };
      return true;
    },
    setPreSessionPermissionMode: (permissionMode) => {
      defaults = { ...defaults, permissionMode };
      return true;
    },
    setPreSessionOrchestrationMode: (orchestrationMode) => {
      defaults = { ...defaults, orchestrationMode };
      return true;
    },
    sendInput: async (...args) => {
      sent.push(args);
      return true;
    },
  };
  const commands = createSettingsCommands({ runtime, workspacePath: "/workspace" });
  const run = (name: keyof typeof commands, args: string) =>
    commands[name].execute({ raw: `/${name} ${args}`, name, args, argv: args.split(" ") }, {});
  await run("mode", "plan");
  await run("permissions", "auto");
  await run("swarm", "on");
  assert.deepEqual(defaults, {
    collaborationMode: "plan",
    permissionMode: "auto",
    orchestrationMode: "swarm",
  });
  await run("swarm", "Review this change");
  assert.deepEqual(sent, [
    [{ kind: "text", text: "Review this change" }, "auto", { orchestrationMode: "swarm" }],
  ]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createHookManagementCommands } from "@pico/cli/hook-management-commands";
import { createHookManagementCommands as legacyCreateHookManagementCommands } from "@pico/cli/hook-management-commands";
import type { HookManagementService } from "@pico/pico-host/hooks/management/service";

test("Hook 管理命令由 CLI 包提供且旧入口保持同一实现", async () => {
  assert.equal(createHookManagementCommands, legacyCreateHookManagementCommands);
  const management = {
    list: () => [],
    review: async () => {
      throw new Error("unexpected review");
    },
    trust: async () => undefined,
    enable: async () => undefined,
    disable: async () => undefined,
    reload: async () => true,
  } as unknown as HookManagementService;
  const commands = createHookManagementCommands({
    management,
    hookify: async () => {
      throw new Error("unexpected hookify");
    },
  });

  assert.deepEqual(
    commands.map((command) => command.name),
    ["hooks", "hookify"],
  );
  const result = await commands[0]!.execute(
    { raw: "/hooks", name: "hooks", args: "", argv: [] },
    {},
  );
  assert.equal(result.type, "local");
  assert.equal("ui" in result ? result.ui?.kind : undefined, "open-panel");
});

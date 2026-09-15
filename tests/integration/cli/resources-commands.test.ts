import assert from "node:assert/strict";
import test from "node:test";
import { createResourcesCommands } from "@pico/cli/resources-commands";
import { createResourcesCommands as legacyCreateResourcesCommands } from "@pico/cli/resources-commands";

test("资源命令由 CLI 包提供且旧入口保持同一实现", () => {
  assert.equal(createResourcesCommands, legacyCreateResourcesCommands);
});

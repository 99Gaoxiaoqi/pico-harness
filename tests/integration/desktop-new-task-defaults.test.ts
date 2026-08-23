import assert from "node:assert/strict";
import test from "node:test";
import { parseUserDefaults } from "../../apps/desktop/src/renderer/runtime.js";

test("new task defaults preserve canonical session settings", () => {
  assert.deepEqual(
    parseUserDefaults({
      modelRouteId: "openai/coder",
      collaborationMode: "plan",
      orchestrationMode: "graph",
      permissionMode: "yolo",
      thinkingEffort: "high",
    }),
    {
      modelRouteId: "openai/coder",
      collaborationMode: "plan",
      orchestrationMode: "graph",
      permissionMode: "yolo",
      thinkingEffort: "high",
    },
  );
});

test("new task defaults retain only protocol-supported legacy mode values", () => {
  assert.deepEqual(parseUserDefaults({ mode: "auto" }), { mode: "auto" });
  assert.deepEqual(parseUserDefaults({ mode: "unsupported" }), {});
});

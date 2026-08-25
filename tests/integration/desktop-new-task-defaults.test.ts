import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("desktop permission selectors expose all modes with explicit labels", async () => {
  const source = await readFile(
    new URL("../../apps/desktop/src/renderer/App.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /<option value="default">权限：默认<\/option>/u);
  assert.match(source, /<option value="auto">权限：自动<\/option>/u);
  assert.match(source, /<option value="yolo">权限：YOLO（完全访问）<\/option>/u);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseUserDefaults } from "../../../apps/desktop/src/renderer/runtime-projections/configuration.js";
import { parseSessionSettings } from "../../../apps/desktop/src/renderer/runtime-projections/workspace.js";

test("new task defaults preserve canonical session settings", () => {
  assert.deepEqual(
    parseUserDefaults({
      modelRouteId: "openai/coder",
      collaborationMode: "plan",
      orchestrationMode: "graph",
      permissionMode: "full-access",
      thinkingEffort: "high",
    }),
    {
      modelRouteId: "openai/coder",
      collaborationMode: "plan",
      orchestrationMode: "graph",
      permissionMode: "full-access",
      thinkingEffort: "high",
    },
  );
});

test("new task defaults reject the removed combined mode field", () => {
  assert.deepEqual(parseUserDefaults({ mode: "ask" }), {});
  assert.deepEqual(parseUserDefaults({ mode: "plan" }), {});
  assert.deepEqual(parseUserDefaults({ mode: "auto" }), {});
  assert.deepEqual(parseUserDefaults({ mode: "full-access" }), {});
  assert.deepEqual(parseUserDefaults({ mode: "default" }), {});
  assert.deepEqual(parseUserDefaults({ mode: "yolo" }), {});
});

test("session settings projection requires the current split permission axes", () => {
  assert.deepEqual(
    parseSessionSettings({
      settings: {
        sessionId: "session-1",
        provider: "openai",
        modelRouteId: "openai/coder",
        model: "coder",
        collaborationMode: "agent",
        orchestrationMode: "default",
        permissionMode: "ask",
        thinkingEffort: "off",
        thinkingEffortExplicit: false,
        reasoningLevels: [],
      },
    }),
    {
      modelRouteId: "openai/coder",
      model: "coder",
      collaborationMode: "agent",
      orchestrationMode: "default",
      permissionMode: "ask",
      thinkingEffort: "off",
      reasoningLevels: [],
    },
  );
  assert.equal(parseSessionSettings({ model: "coder", mode: "full-access" }), undefined);
  assert.equal(
    parseSessionSettings({
      settings: {
        model: "coder",
        collaborationMode: "agent",
        orchestrationMode: "default",
        permissionMode: "ask",
        thinkingEffort: "off",
        reasoningLevels: [],
      },
    }),
    undefined,
  );
});

test("new task falls back to the fail-closed Runtime default when user config is absent", async () => {
  const source = await readFile(
    new URL("../../../apps/desktop/src/renderer/pages/ConversationPage.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /permissionMode: defaults\.permissionMode \?\? "ask"/u);
  assert.doesNotMatch(source, /legacyMode/u);
});

test("desktop permission selectors expose all modes with explicit labels", async () => {
  const source = await readFile(
    new URL("../../../apps/desktop/src/renderer/pages/ConversationPage.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /<option value="ask">权限：请求批准<\/option>/u);
  assert.match(source, /<option value="auto">权限：帮我批准<\/option>/u);
  assert.match(source, /<option value="full-access">权限：完全访问权限<\/option>/u);
});

import assert from "node:assert/strict";
import test from "node:test";

import { renderAgentDispatchPrompt } from "../../../src/input/agent-activation.js";

test("Agent Profile activation uses the current Graph new_agent contract", () => {
  const prompt = renderAgentDispatchPrompt({ name: "reviewer" }, "Review the runtime boundary");
  const jsonStart = prompt.indexOf("{");
  assert.notEqual(jsonStart, -1);
  assert.deepEqual(JSON.parse(prompt.slice(jsonStart)), {
    operation: "add_work",
    add_work: [
      {
        target_kind: "new_agent",
        agent_id: "reviewer",
        instruction: "Review the runtime boundary",
        workspace: { kind: "shared" },
      },
    ],
  });
  assert.match(prompt, /update_agent_graph/u);
  assert.match(prompt, /yield_agent_graph/u);
});

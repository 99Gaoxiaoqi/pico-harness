import assert from "node:assert/strict";
import test from "node:test";

import {
  replaceWorkspaceItems,
  sessionHref,
  workspacePathFromSearch,
  workspaceSessionKey,
} from "../../apps/desktop/src/renderer/workspace-session.js";

test("Desktop keeps identical session ids isolated by workspace", () => {
  const left = { workspacePath: "/projects/alpha", sessionId: "shared-session" };
  const right = { workspacePath: "/projects/beta", sessionId: "shared-session" };

  assert.notEqual(workspaceSessionKey(left), workspaceSessionKey(right));

  const updated = replaceWorkspaceItems(
    [
      { ...left, title: "old alpha" },
      { ...right, title: "beta" },
    ],
    left.workspacePath,
    [{ ...left, title: "new alpha" }],
  );

  assert.deepEqual(updated, [
    { ...left, title: "new alpha" },
    { ...right, title: "beta" },
  ]);
});

test("Desktop session links preserve the selected workspace", () => {
  const ref = {
    workspacePath: "/Users/anxuan/中文 项目/pico",
    sessionId: "session/with spaces",
  };
  const href = sessionHref(ref);
  const [pathname, search = ""] = href.split("?");

  assert.equal(pathname, "/session/session%2Fwith%20spaces");
  assert.equal(workspacePathFromSearch(`?${search}`), ref.workspacePath);
});

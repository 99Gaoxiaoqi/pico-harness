import assert from "node:assert/strict";
import test from "node:test";
import { startMobileGateway } from "../../src/mobile-gateway/server.js";

const token = "t".repeat(32);

test("mobile gateway binds loopback and authenticates before Runtime access", async (context) => {
  let listCalls = 0;
  const gateway = await startMobileGateway({
    token,
    authority: {
      async listProjects() {
        listCalls += 1;
        return [{ projectId: "opaque-project", name: "pico-harness" }];
      },
    },
  });
  context.after(() => gateway.close());

  assert.match(gateway.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await fetch(`${gateway.origin}/v1/projects`)).status, 401);
  assert.equal(
    (
      await fetch(`${gateway.origin}/v1/projects`, {
        headers: { Authorization: "Bearer wrong-token" },
      })
    ).status,
    401,
  );
  assert.equal(listCalls, 0);

  const response = await fetch(`${gateway.origin}/v1/projects`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    projects: [{ projectId: "opaque-project", name: "pico-harness" }],
  });
  assert.equal(listCalls, 1);
});

test("mobile gateway rejects non-loopback binding", async () => {
  await assert.rejects(
    () =>
      startMobileGateway({
        host: "0.0.0.0",
        token,
        authority: { listProjects: async () => [] },
      }),
    /must listen on 127\.0\.0\.1/,
  );
});

test("mobile gateway hides internal failures", async (context) => {
  const gateway = await startMobileGateway({
    token,
    authority: {
      async listProjects() {
        throw new Error("/private/workspaces/secret failed");
      },
    },
  });
  context.after(() => gateway.close());

  const response = await fetch(`${gateway.origin}/v1/projects`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /private|secret/);
});

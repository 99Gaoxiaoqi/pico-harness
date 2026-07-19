import assert from "node:assert/strict";
import test from "node:test";
import { startMobileGateway } from "../../src/mobile-gateway/server.js";

const token = "t".repeat(32);

function createApi(
  overrides: {
    readonly listProjects?: () => Promise<readonly { projectId: string; name: string }[]>;
    readonly listSessions?: (projectId: string) => Promise<readonly never[]>;
  } = {},
) {
  return {
    listProjects: overrides.listProjects ?? (async () => []),
    listSessions: overrides.listSessions ?? (async () => []),
  };
}

test("mobile gateway binds loopback and authenticates before Runtime access", async (context) => {
  let listCalls = 0;
  const gateway = await startMobileGateway({
    token,
    api: createApi({
      async listProjects() {
        listCalls += 1;
        return [{ projectId: "opaque-project", name: "pico-harness" }];
      },
    }),
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
        api: createApi(),
      }),
    /must listen on 127\.0\.0\.1/,
  );
});

test("mobile gateway hides internal failures", async (context) => {
  const gateway = await startMobileGateway({
    token,
    api: createApi({
      async listProjects() {
        throw new Error("/private/workspaces/secret failed");
      },
    }),
  });
  context.after(() => gateway.close());

  const response = await fetch(`${gateway.origin}/v1/projects`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /private|secret/);
});

test("mobile gateway exposes authenticated project sessions", async (context) => {
  const requestedProjects: string[] = [];
  const gateway = await startMobileGateway({
    token,
    api: createApi({
      async listSessions(projectId) {
        requestedProjects.push(projectId);
        return [];
      },
    }),
  });
  context.after(() => gateway.close());

  const response = await fetch(`${gateway.origin}/v1/projects/opaque-project/sessions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { sessions: [] });
  assert.deepEqual(requestedProjects, ["opaque-project"]);
});

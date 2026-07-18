import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeRequest } from "../../src/daemon/protocol.js";
import { DesktopRequestRouter } from "../../src/daemon/desktop-request-router.js";

test("desktop request router dispatches registered methods without owning business logic", async () => {
  const router = new DesktopRequestRouter({
    handlers: {
      "runtime.ping": () => ({ pong: true }),
    },
    methodNotFound: (method) => new Error(`unsupported: ${method}`),
  });

  await assert.deepEqual(await router.dispatch(createRuntimeRequest("runtime.ping", {})), {
    pong: true,
  });
});

test("desktop request router rejects an unsupported method through one contract", async () => {
  const router = new DesktopRequestRouter({
    unsupportedMethods: new Set(["runtime.ping"]),
    methodNotFound: (method) => new Error(`unsupported: ${method}`),
  });

  await assert.rejects(
    router.dispatch(createRuntimeRequest("runtime.ping", {})),
    /unsupported: runtime\.ping/,
  );
});

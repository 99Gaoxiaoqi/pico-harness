import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeRequest } from "@pico/protocol";
import { DesktopRuntimeService } from "@pico/pico-host/desktop-runtime-service";
import { WorkspaceRuntimeService } from "@pico/pico-host/workspace-runtime-service";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { globalSessionManager } from "@pico/pico-host/session";
import { globalSessionPermissionGrants } from "@pico/pico-host/session-permissions";
import { globalClientCapabilityGrants } from "@pico/pico-host/client-capability-grants";
import { resolvePicoPaths } from "@pico/pico-host";
import { writeDesktopModelRouting } from "../../fixtures/desktop-model-routing.js";

test("desktop mode downgrade revokes earlier session approvals", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-permission-revoke-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(picoHome, { recursive: true })]);
  await writeDesktopModelRouting(picoHome);
  const canonical = await realpath(workspace);
  const workspaceRoot = resolvePicoPaths(canonical, { picoHome }).workspace.root;
  const env = { PICO_HOME: picoHome };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(canonical);
  const runtime = new WorkspaceRuntimeService({ env, execute: async () => ({ ok: true }) });
  const desktop = new DesktopRuntimeService({ runtimeService: runtime, trustStore, env });
  let sessionId: string | undefined;
  try {
    const created = (await desktop.handle(
      createRuntimeRequest("session.create", { workspacePath: canonical }),
    )) as { session: { sessionId: string } };
    sessionId = created.session.sessionId;
    const call = { id: "call-1", name: "bash", arguments: '{"command":"pwd"}' };
    const browserScope = { kind: "browser_origin", origin: "https://example.com" } as const;
    let epoch = 0;
    const grant = async () => {
      await globalClientCapabilityGrants.bindSession(sessionId!, workspaceRoot, `epoch-${++epoch}`);
      globalSessionPermissionGrants.addNetwork(sessionId!, canonical, picoHome);
      globalSessionPermissionGrants.add(
        sessionId!,
        canonical,
        { type: "tool", toolName: "bash" },
        picoHome,
      );
      globalSessionPermissionGrants.authorizeNetworkOnce(sessionId!, canonical, "once", picoHome);
      await globalClientCapabilityGrants.grant(sessionId!, browserScope);
    };
    const assertRevoked = () => {
      assert.equal(
        globalSessionPermissionGrants.allowsNetwork(sessionId!, canonical, picoHome),
        false,
      );
      assert.equal(
        globalSessionPermissionGrants.allows(sessionId!, call, canonical, undefined, picoHome),
        false,
      );
      assert.equal(
        globalSessionPermissionGrants.consumeNetworkAuthorization(
          sessionId!,
          canonical,
          "once",
          picoHome,
        ),
        false,
      );
      assert.equal(globalClientCapabilityGrants.allows(sessionId!, browserScope), false);
    };
    const update = async (permissionMode: "ask" | "auto" | "full-access") =>
      desktop.handle(
        createRuntimeRequest("session.settings.update", {
          workspacePath: canonical,
          sessionId: sessionId!,
          permissionMode,
        }),
      );

    await grant();
    await update("full-access");
    assertRevoked();

    await grant();
    await update("ask");
    assertRevoked();

    await update("auto");
    await grant();
    await update("ask");
    assertRevoked();

    await grant();
    await desktop.handle(
      createRuntimeRequest("session.settings.update", {
        workspacePath: canonical,
        sessionId,
        collaborationMode: "plan",
      }),
    );
    assertRevoked();
  } finally {
    if (sessionId) globalSessionPermissionGrants.clear(sessionId, canonical, picoHome);
    if (sessionId) await globalClientCapabilityGrants.revokeSession(sessionId, workspaceRoot);
    await desktop.close();
    await globalSessionManager.clearAndDrain();
    await rm(root, { recursive: true, force: true });
  }
});

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DesktopConversationStateStore } from "../src/daemon/desktop-conversation-state.js";
import { DesktopSessionStateStore } from "../src/daemon/desktop-session-state.js";
import { WorkspaceRegistrationStore } from "../src/daemon/workspace-registration.js";
import { defaultHookConfigSources } from "../src/hooks/config.js";
import { HookTrustStore } from "../src/hooks/trust/store.js";
import { resolvePicoHome, resolvePicoPaths } from "../src/paths/pico-paths.js";
import { WorkspaceTrustStore } from "../src/security/workspace-trust.js";

describe("PICO_HOME production state isolation", () => {
  it("routes user resources, trust, history and daemon discovery through one home", () => {
    const picoHome = resolvePicoHome();
    const paths = resolvePicoPaths(process.cwd());

    expect(paths.home.trustedWorkspaces).toBe(join(picoHome, "trusted-workspaces.json"));
    expect(paths.home.trustedHooks).toBe(join(picoHome, "trusted-hooks.json"));
    expect(paths.home.fileHistory).toBe(join(picoHome, "file-history"));
    expect(paths.home.daemonWorkspaces).toBe(join(picoHome, "daemon-workspaces.json"));
    expect(new WorkspaceTrustStore().filePath).toBe(paths.home.trustedWorkspaces);
    expect(new HookTrustStore().filePath).toBe(paths.home.trustedHooks);
    expect(new WorkspaceRegistrationStore().filePath).toBe(paths.home.daemonWorkspaces);
    expect(new DesktopSessionStateStore().filePath).toBe(
      join(picoHome, "desktop", "session-state.json"),
    );
    expect(new DesktopConversationStateStore().filePath).toBe(
      join(picoHome, "desktop", "conversation-state.json"),
    );
    expect(defaultHookConfigSources(process.cwd())[0]?.path).toBe(paths.home.hooks);
  });

  it("allows desktop state hosts to inject the same Pico home without changing process env", () => {
    const envHome = join(process.cwd(), "env-pico-home");
    const explicitHome = join(process.cwd(), "explicit-pico-home");

    expect(new DesktopSessionStateStore({ env: { PICO_HOME: envHome } }).filePath).toBe(
      join(envHome, "desktop", "session-state.json"),
    );
    expect(new DesktopConversationStateStore({ picoHome: explicitHome }).filePath).toBe(
      join(explicitHome, "desktop", "conversation-state.json"),
    );
  });

  it("keeps the explicit legacy userHome test seam independent from process PICO_HOME", () => {
    const userHome = join(process.cwd(), "fixture-home");

    expect(defaultHookConfigSources(process.cwd(), userHome)[0]?.path).toBe(
      join(userHome, ".pico", "hooks.json"),
    );
    expect(new HookTrustStore({ userHome }).filePath).toBe(
      join(userHome, ".pico", "trusted-hooks.json"),
    );
  });
});

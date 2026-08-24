import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTrustedDesktopAutomation,
  type DesktopAutomationAuthorityDependencies,
  type DesktopAutomationService,
} from "../../src/daemon/desktop-automation-service.js";

test("Desktop daemon rejects tools outside the explicit Automation allowlist", async () => {
  await assert.rejects(
    createTrustedDesktopAutomation(
      {} as DesktopAutomationService,
      "/workspace",
      {
        prompt: "run future tool",
        schedule: "* * * * *",
        modelRouteId: "provider/model",
        expectedCredentialRef: "provider:fixture",
        allowedTools: ["hypothetical_new_tool"],
        toolNetworkPolicy: "disabled",
      },
      {} as DesktopAutomationAuthorityDependencies,
    ),
    /未显式授权的工具: hypothetical_new_tool/u,
  );
});

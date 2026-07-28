import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HookTrustStore } from "../../src/hooks/trust/store.js";
import {
  BACKGROUND_HARDLINE_VERSION,
  BACKGROUND_HOOK_VERSION,
  BackgroundPolicyViolationError,
  prepareBackgroundYoloPolicy,
} from "../../src/safety/background-yolo-policy.js";

test("background policy rejects an untrusted PostToolUseFailure command hook", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-background-failure-hook-trust-"));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  try {
    await mkdir(join(workDir, ".pico"), { recursive: true });
    await writeFile(
      join(workDir, ".pico", "hooks.json"),
      `${JSON.stringify({
        PostToolUseFailure: [
          {
            hooks: [{ type: "command", command: 'node -e "process.exit(0)"' }],
          },
        ],
      })}\n`,
    );

    await assert.rejects(
      prepareBackgroundYoloPolicy({
        workDir,
        policy: {
          mode: "yolo",
          backgroundEnabled: true,
          trustedWorkspace: true,
          toolNetworkPolicy: "disabled",
          allowedTools: [],
          hardlineVersion: BACKGROUND_HARDLINE_VERSION,
          hookVersion: BACKGROUND_HOOK_VERSION,
          createdAt: Date.now(),
        },
        trustStore: {
          async canonicalize() {
            return workDir;
          },
          async isTrusted() {
            return true;
          },
        },
        hookTrustStore: new HookTrustStore({ picoHome }),
      }),
      (error: unknown) =>
        error instanceof BackgroundPolicyViolationError && error.code === "hook_unavailable",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

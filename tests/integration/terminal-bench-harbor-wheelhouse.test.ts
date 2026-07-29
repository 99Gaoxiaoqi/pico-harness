import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error The benchmark orchestrator is intentionally plain Node ESM.
import * as harborWheelhouse from "../../scripts/terminal-bench/harbor-wheelhouse.mjs";

const { verifyApprovedHarborWheelhouse } = harborWheelhouse;

test("Terminal-Bench verifies every approved Harbor artifact", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-harbor-wheelhouse-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const wheelhouse = join(root, "wheelhouse");
  await mkdir(wheelhouse);
  const wheel = Buffer.from("approved wheel");
  await writeFile(join(wheelhouse, "fixture-1.0.0-py3-none-any.whl"), wheel);
  await writeFile(join(root, "constraints.txt"), "fixture==1.0.0\n");
  const manifest = Buffer.from(
    `${JSON.stringify({
      schemaVersion: 1,
      python: "3.12",
      platform: "macos-arm64",
      artifacts: [
        {
          requirement: "fixture==1.0.0",
          filename: "fixture-1.0.0-py3-none-any.whl",
          sha256: digest(wheel),
        },
      ],
    })}\n`,
  );
  await writeFile(join(wheelhouse, "artifact-manifest.json"), manifest);
  const options = {
    manifestPath: join(wheelhouse, "artifact-manifest.json"),
    wheelhousePath: wheelhouse,
    constraintsPath: join(root, "constraints.txt"),
    expectedManifestSha256: digest(manifest),
  };
  await verifyApprovedHarborWheelhouse(options);

  await writeFile(join(wheelhouse, "fixture-1.0.0-py3-none-any.whl"), "tampered wheel");
  await assert.rejects(verifyApprovedHarborWheelhouse(options), /artifact digest mismatch/u);
});

function digest(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WindowsTaskNetworkAuthority } from "@pico/pico-host/process-sandbox";

test("Windows task network Host grants only after preparation and revokes the task receipt", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-windows-network-authority-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const broker = join(root, "broker.cjs");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const get = (name) => args[args.indexOf(name) + 1];
const op = get("--task-network");
const profileName = get("--profile-name");
const control = get("--control-root");
if (control.includes("cancel") && op === "prepare") process.exit(5);
const marker = path.join(control, "system-ready");
let result;
if (op === "prepare") { fs.writeFileSync(marker, profileName); result = "applied"; }
else if (op === "verify") result = fs.existsSync(marker) ? "match" : "drift";
else if (op === "revoke") { fs.rmSync(marker, {force: true}); result = "revoked"; }
else process.exit(6);
process.stdout.write(JSON.stringify({op, result, profileName}));
`;
  await writeFile(broker, script);
  await chmod(broker, 0o755);
  await writeFile(`${broker}.sha256`, createHash("sha256").update(script).digest("hex"));

  const authority = new WindowsTaskNetworkAuthority("task-a", join(root, "task-a"), broker);
  assert.equal(await authority.verify(), false);
  await authority.prepare();
  assert.equal(await authority.verify(), true);
  const receiptPath = await authority.issueReceipt({
    boundaryRevision: 3,
    generation: 23,
    scope: "once",
  });
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
    taskId: string;
    boundaryRevision: number;
    generation: number;
    scope: string;
  };
  assert.deepEqual(
    [receipt.taskId, receipt.boundaryRevision, receipt.generation, receipt.scope],
    ["task-a", 3, 23, "once"],
  );
  await authority.revoke();
  assert.equal(await authority.verify(), false);
  await assert.rejects(access(receiptPath));

  const cancelled = new WindowsTaskNetworkAuthority("task-b", join(root, "cancel-task-b"), broker);
  await assert.rejects(cancelled.prepare(), /Windows 任务联网prepare失败/u);
  assert.equal(await cancelled.verify(), false);
  await assert.rejects(access(join(root, "cancel-task-b", "state.json")));
});

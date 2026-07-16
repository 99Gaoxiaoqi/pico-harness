import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HookTrustStore, type HookTrustSubject } from "../../src/hooks/trust/store.js";

test("package script definition changes invalidate Hook trust", async (context) => {
  const fixture = await createFixture(context);
  await writePackageScript(fixture.workspace, "node safe.js");
  await writeFile(join(fixture.workspace, "safe.js"), "export const value = 'safe';\n");
  await fixture.store.trust(fixture.packageSubject);

  await writePackageScript(fixture.workspace, "node changed.js");
  await writeFile(join(fixture.workspace, "changed.js"), "export const value = 'changed';\n");

  assert.equal(await fixture.store.status(fixture.packageSubject), "pending");
});

test("direct file changes behind a package script invalidate Hook trust", async (context) => {
  const fixture = await createFixture(context);
  const scriptPath = join(fixture.workspace, "safe.js");
  await writePackageScript(fixture.workspace, "node safe.js");
  await writeFile(scriptPath, "export const value = 'safe';\n");
  await fixture.store.trust(fixture.packageSubject);

  await writeFile(scriptPath, "export const value = 'changed';\n");

  assert.equal(await fixture.store.status(fixture.packageSubject), "pending");
});

test("unchanged package script definition and bytes keep Hook trust active", async (context) => {
  const fixture = await createFixture(context);
  await writePackageScript(fixture.workspace, "node safe.js");
  await writeFile(join(fixture.workspace, "safe.js"), "export const value = 'safe';\n");
  const trusted = await fixture.store.trust(fixture.packageSubject);

  const unchanged = await fixture.store.fingerprint(fixture.packageSubject);

  assert.equal(unchanged.id, trusted.id);
  assert.equal(await fixture.store.status(fixture.packageSubject), "active");
  assert.ok(Object.keys(unchanged.scriptHashes).some((path) => path.endsWith("/safe.js")));
  assert.ok(Object.keys(unchanged.scriptHashes).some((path) => path.startsWith("package-script:")));
});

test("ordinary directly referenced scripts preserve byte-bound trust", async (context) => {
  const fixture = await createFixture(context);
  const scriptPath = join(fixture.workspace, "check.sh");
  const subject: HookTrustSubject = {
    ...fixture.packageSubject,
    handler: { type: "command", command: "./check.sh", args: [] },
  };
  await writeFile(scriptPath, "#!/bin/sh\nexit 0\n");
  await fixture.store.trust(subject);
  assert.equal(await fixture.store.status(subject), "active");

  await writeFile(scriptPath, "#!/bin/sh\nexit 2\n");

  assert.equal(await fixture.store.status(subject), "pending");
});

interface Fixture {
  readonly workspace: string;
  readonly store: HookTrustStore;
  readonly packageSubject: HookTrustSubject;
}

async function createFixture(context: {
  after: (callback: () => Promise<void>) => void;
}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pico-hook-indirect-trust-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(join(workspace, ".pico"), { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));
  return {
    workspace,
    store: new HookTrustStore({ picoHome }),
    packageSubject: {
      workspace,
      source: { kind: "project", path: join(workspace, ".pico", "hooks.json"), version: 1 },
      handler: { type: "command", command: "npm run pretool" },
    },
  };
}

async function writePackageScript(workspace: string, definition: string): Promise<void> {
  await writeFile(
    join(workspace, "package.json"),
    `${JSON.stringify({ private: true, scripts: { pretool: definition } }, null, 2)}\n`,
  );
}

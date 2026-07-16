import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveReferencedScripts } from "../../src/hooks/config/referenced-scripts.js";
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

for (const scenario of [
  { command: "npm test", scriptName: "test" },
  { command: "npm --silent start", scriptName: "start" },
  { command: "npm stop -- --signal=TERM", scriptName: "stop" },
] as const) {
  test(`${scenario.command} binds the complete npm lifecycle`, async (context) => {
    const fixture = await createFixture(context, {
      type: "command",
      command: scenario.command,
    });
    await writePackageScripts(fixture.workspace, {
      [`pre${scenario.scriptName}`]: "node before.js",
      [scenario.scriptName]: "node main.js",
      [`post${scenario.scriptName}`]: "node after.js",
    });
    await fixture.store.trust(fixture.packageSubject);

    await writePackageScripts(fixture.workspace, {
      [`pre${scenario.scriptName}`]: "node before.js",
      [scenario.scriptName]: "node main.js",
      [`post${scenario.scriptName}`]: "node changed.js",
    });

    assert.equal(await fixture.store.status(fixture.packageSubject), "pending");
  });
}

test("npm start binds its default server.js when the start script is absent", async (context) => {
  const fixture = await createFixture(context, { type: "command", command: "npm start" });
  const serverPath = join(fixture.workspace, "server.js");
  await writePackageScripts(fixture.workspace, {});
  const resolution = await resolveReferencedScripts(
    fixture.packageSubject.handler,
    fixture.workspace,
  );
  assert.ok(resolution.paths.includes(serverPath));
  await fixture.store.trust(fixture.packageSubject);

  await writeFile(serverPath, "export const value = 'created';\n");
  assert.equal(await fixture.store.status(fixture.packageSubject), "pending");

  await fixture.store.trust(fixture.packageSubject);
  await writeFile(serverPath, "export const value = 'changed';\n");
  assert.equal(await fixture.store.status(fixture.packageSubject), "pending");
});

for (const command of ["npm --loglevel error restart", "npm run restart"] as const) {
  test(`${command} binds stop/start fallback lifecycles when restart is absent`, async (context) => {
    const fixture = await createFixture(context, { type: "command", command });
    const scripts = {
      prerestart: "node pre-restart.js",
      prestop: "node pre-stop.js",
      stop: "node stop.js",
      poststop: "node post-stop.js",
      prestart: "node pre-start.js",
      start: "node start.js",
      poststart: "node post-start.js",
      postrestart: "node post-restart.js",
    };
    await writePackageScripts(fixture.workspace, scripts);
    await fixture.store.trust(fixture.packageSubject);

    await writePackageScripts(fixture.workspace, { ...scripts, poststop: "node changed.js" });

    assert.equal(await fixture.store.status(fixture.packageSubject), "pending");
  });
}

test("npm run restart binds the default server.js in its fallback", async (context) => {
  const fixture = await createFixture(context, { type: "command", command: "npm run restart" });
  const serverPath = join(fixture.workspace, "server.js");
  await writePackageScripts(fixture.workspace, {});
  const resolution = await resolveReferencedScripts(
    fixture.packageSubject.handler,
    fixture.workspace,
  );
  assert.ok(resolution.paths.includes(serverPath));
  await fixture.store.trust(fixture.packageSubject);

  await writeFile(serverPath, "export const value = 'created';\n");

  assert.equal(await fixture.store.status(fixture.packageSubject), "pending");
});

test("npm restart with an explicit restart script ignores the stop/start fallback", async (context) => {
  const fixture = await createFixture(context, {
    type: "command",
    command: "npm restart",
  });
  const scripts = {
    prerestart: "node pre-restart.js",
    restart: "node restart.js",
    postrestart: "node post-restart.js",
    start: "node start.js",
    stop: "node stop.js",
  };
  await writePackageScripts(fixture.workspace, scripts);
  await fixture.store.trust(fixture.packageSubject);

  await writePackageScripts(fixture.workspace, { ...scripts, start: "node changed-start.js" });
  assert.equal(await fixture.store.status(fixture.packageSubject), "active");

  await writePackageScripts(fixture.workspace, {
    ...scripts,
    restart: "node changed-restart.js",
    start: "node changed-start.js",
  });
  assert.equal(await fixture.store.status(fixture.packageSubject), "pending");
});

for (const scenario of [
  { label: "yarn direct shorthand", command: "yarn test" },
  { label: "yarn leading option", command: "yarn --silent test --watch" },
  { label: "pnpm direct shorthand", command: "pnpm test -- --runInBand" },
  { label: "pnpm test alias", command: "pnpm t" },
  { label: "pnpm valued leading option", command: "pnpm --reporter silent test" },
  { label: "bun direct shorthand", command: "bun test --watch" },
  { label: "bun leading option", command: "bun --silent test" },
  { label: "npm explicit run option", command: "npm run --if-present test" },
  { label: "yarn explicit run option", command: "yarn run --silent test" },
  { label: "pnpm explicit run option", command: "pnpm run --if-present test" },
  { label: "bun explicit run option", command: "bun run --if-present test" },
] as const) {
  test(`${scenario.label} invalidates trust when the script changes`, async (context) => {
    const fixture = await createFixture(context, {
      type: "command",
      command: scenario.command,
    });
    await writePackageScripts(fixture.workspace, {
      pretest: "node before.js",
      test: "node test.js",
      posttest: "node after.js",
    });
    await fixture.store.trust(fixture.packageSubject);

    await writePackageScripts(fixture.workspace, {
      pretest: "node before.js",
      test: "node changed.js",
      posttest: "node after.js",
    });

    assert.equal(await fixture.store.status(fixture.packageSubject), "pending");
  });
}

for (const command of [
  "npm view pico-harness",
  "yarn config get registry",
  "pnpm --silent list",
  "bun info react",
] as const) {
  test(`${command} is not mistaken for a direct package script`, async (context) => {
    const fixture = await createFixture(context, { type: "command", command });
    await writePackageScripts(fixture.workspace, {
      view: "node unexpected.js",
      config: "node unexpected.js",
      list: "node unexpected.js",
      info: "node unexpected.js",
    });

    const resolution = await resolveReferencedScripts(
      fixture.packageSubject.handler,
      fixture.workspace,
    );

    assert.deepEqual(resolution.packageScripts, []);
  });
}

for (const command of [
  "npm --workspace child run test",
  "pnpm --filter child test",
  "yarn --cwd child test",
  "bun --cwd child test",
  "npm test && npm run deploy",
] as const) {
  test(`${command} fails closed instead of receiving partial trust`, async (context) => {
    const fixture = await createFixture(context, { type: "command", command });
    await writePackageScripts(fixture.workspace, { test: "node test.js" });

    await assert.rejects(
      fixture.store.trust(fixture.packageSubject),
      /\u4e0d\u652f\u6301\u4e3a\u8be5 .* Hook \u5efa\u7acb\u95f4\u63a5\u811a\u672c\u4fe1\u4efb/u,
    );
    assert.deepEqual(await fixture.store.list(), []);
  });
}

test("shell composition on an ordinary non-package command keeps direct-path behavior", async (context) => {
  const fixture = await createFixture(context, {
    type: "command",
    command: "echo safe && echo done",
  });

  const resolution = await resolveReferencedScripts(
    fixture.packageSubject.handler,
    fixture.workspace,
  );

  assert.deepEqual(resolution.packageScripts, []);
});

interface Fixture {
  readonly workspace: string;
  readonly store: HookTrustStore;
  readonly packageSubject: HookTrustSubject;
}

async function createFixture(
  context: {
    after: (callback: () => Promise<void>) => void;
  },
  handler: HookTrustSubject["handler"] = { type: "command", command: "npm run pretool" },
): Promise<Fixture> {
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
      handler,
    },
  };
}

async function writePackageScript(workspace: string, definition: string): Promise<void> {
  await writePackageScripts(workspace, { pretool: definition });
}

async function writePackageScripts(
  workspace: string,
  scripts: Readonly<Record<string, string>>,
): Promise<void> {
  await writeFile(
    join(workspace, "package.json"),
    `${JSON.stringify({ private: true, scripts }, null, 2)}\n`,
  );
}

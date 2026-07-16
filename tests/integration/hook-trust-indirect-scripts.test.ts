import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveReferencedScripts } from "../../src/hooks/config/referenced-scripts.js";
import { DefaultHookExecutor } from "../../src/hooks/executors/executor.js";
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

for (const command of [
  "npm run inner",
  "npm run -- inner",
  "npm run-script -- inner",
  "npm rum inner",
  "npm urn inner",
  "pnpm run inner",
  "pnpm run-script -- inner",
  "yarn inner",
  "yarn run -- inner",
  "bun run inner",
  "bun run -- inner",
] as const) {
  test(`${command} recursively binds the called package script`, async (context) => {
    const fixture = await createFixture(context, { type: "command", command: "npm test" });
    await writePackageScripts(fixture.workspace, {
      test: command,
      inner: "node safe.cjs",
    });
    await fixture.store.trust(fixture.packageSubject);

    await writePackageScripts(fixture.workspace, {
      test: command,
      inner: "node changed.cjs",
    });

    assert.equal(await fixture.store.status(fixture.packageSubject), "pending");
  });
}

test("nested package lifecycle and direct file bytes remain trust-bound", async (context) => {
  const fixture = await createFixture(context, { type: "command", command: "npm test" });
  const scripts = {
    test: "npm run inner",
    preinner: "node pre.cjs",
    inner: "node inner.cjs",
    postinner: "node post.cjs",
  };
  await writePackageScripts(fixture.workspace, scripts);
  await writeFile(join(fixture.workspace, "pre.cjs"), "export const value = 'pre';\n");
  await writeFile(join(fixture.workspace, "inner.cjs"), "export const value = 'inner';\n");
  await writeFile(join(fixture.workspace, "post.cjs"), "export const value = 'post';\n");
  await fixture.store.trust(fixture.packageSubject);

  await writePackageScripts(fixture.workspace, {
    ...scripts,
    postinner: "node changed-post.cjs",
  });
  assert.equal(await fixture.store.status(fixture.packageSubject), "pending");

  await writePackageScripts(fixture.workspace, scripts);
  await fixture.store.trust(fixture.packageSubject);
  await writeFile(join(fixture.workspace, "inner.cjs"), "export const value = 'changed';\n");
  assert.equal(await fixture.store.status(fixture.packageSubject), "pending");
});

test("multiple static nested package calls are all trust-bound", async (context) => {
  const fixture = await createFixture(context, { type: "command", command: "npm test" });
  await writePackageScripts(fixture.workspace, {
    test: "npm run first && pnpm run second",
    first: "node first.cjs",
    second: "node second.cjs",
  });
  await fixture.store.trust(fixture.packageSubject);

  await writePackageScripts(fixture.workspace, {
    test: "npm run first && pnpm run second",
    first: "node first.cjs",
    second: "node changed-second.cjs",
  });

  assert.equal(await fixture.store.status(fixture.packageSubject), "pending");
});

test("nested npm restart binds its stop-start fallback lifecycle", async (context) => {
  const fixture = await createFixture(context, { type: "command", command: "npm test" });
  const scripts = {
    test: "npm restart",
    stop: "node stop.cjs",
    start: "node start.cjs",
    poststart: "node poststart.cjs",
  };
  await writePackageScripts(fixture.workspace, scripts);
  await fixture.store.trust(fixture.packageSubject);

  await writePackageScripts(fixture.workspace, {
    ...scripts,
    poststart: "node changed-poststart.cjs",
  });

  assert.equal(await fixture.store.status(fixture.packageSubject), "pending");
});

test("static nested package-script cycles are deduplicated and remain trust-bound", async (context) => {
  const fixture = await createFixture(context, { type: "command", command: "npm test" });
  await writePackageScripts(fixture.workspace, {
    test: "npm run inner",
    inner: "npm test",
  });
  await fixture.store.trust(fixture.packageSubject);
  assert.equal(await fixture.store.status(fixture.packageSubject), "active");

  await writePackageScripts(fixture.workspace, {
    test: "npm run inner",
    inner: "node changed.cjs && npm test",
  });

  assert.equal(await fixture.store.status(fixture.packageSubject), "pending");
});

test("nested package-script depth overflow fails closed", async (context) => {
  const fixture = await createFixture(context, { type: "command", command: "npm test" });
  const scripts: Record<string, string> = { test: "npm run level0" };
  for (let index = 0; index <= 32; index++) {
    scripts[`level${index}`] = index === 32 ? "node terminal.cjs" : `npm run level${index + 1}`;
  }
  await writePackageScripts(fixture.workspace, scripts);

  await assert.rejects(fixture.store.trust(fixture.packageSubject), /超过 32 层/u);
});

for (const definition of [
  'npm run "$TARGET"',
  "cd packages/app && npm run inner",
  "command -- cd packages/app && npm run inner",
  "builtin cd packages/app && npm run inner",
  "eval 'cd packages/app' && npm run inner",
  "npm --workspace child run inner",
  "npm --prefix child run inner",
  "pnpm --filter child run inner",
  "yarn --cwd child run inner",
  "bun --cwd child run inner",
  "npm_config_workspace=child npm run inner",
  "export npm_config_prefix=packages/app; npm run inner",
  "echo 'npm run inner' | sh",
  'printf "npm run inner\\n" | bash',
  "command -v npm | sh",
  "$PM run inner",
  "$PM inner",
  '"$PM" run inner',
  'command "$PM" run inner',
  'PM=npm; "$PM" run inner',
] as const) {
  test(`nested dynamic or cross-workspace call fails closed: ${definition}`, async (context) => {
    const fixture = await createFixture(context, { type: "command", command: "npm test" });
    await writePackageScripts(fixture.workspace, {
      test: definition,
      inner: "node inner.cjs",
    });

    await assert.rejects(
      fixture.store.trust(fixture.packageSubject),
      /(?:不支持为该 .* Hook 建立间接脚本信任|动态 package-manager Hook)/u,
    );
  });
}

for (const scenario of [
  {
    label: "inline workspace selector environment",
    handler: { type: "command", command: "npm_config_workspace=child npm run test" },
  },
  {
    label: "env wrapper prefix selector",
    handler: { type: "command", command: "env npm_config_prefix=child npm run test" },
  },
  {
    label: "handler.env workspace selector",
    handler: {
      type: "command",
      command: "npm run test",
      env: { NPM_CONFIG_WORKSPACES: "true" },
    },
  },
] as const) {
  test(`${scenario.label} fails closed`, async (context) => {
    const fixture = await createFixture(context, scenario.handler);
    await writePackageScripts(fixture.workspace, { test: "node test.cjs" });

    await assert.rejects(
      fixture.store.trust(fixture.packageSubject),
      /环境变量 .* package\.json 目标/u,
    );
    assert.deepEqual(await fixture.store.list(), []);
  });
}

test("inherited selector environment is removed before package invocation execution", async (context) => {
  const fixture = await createFixture(context);
  const fakeNpm = join(fixture.workspace, "npm");
  await writeFile(
    fakeNpm,
    '#!/bin/sh\nprintf \'{"additionalContext":"%s:%s"}\\n\' "${npm_config_workspace-unset}" "${KEEP-unset}"\n',
  );
  await chmod(fakeNpm, 0o755);
  const handler = { type: "command", command: fakeNpm, args: ["--version"] } as const;
  const executor = new DefaultHookExecutor({
    workDir: fixture.workspace,
    env: { PATH: process.env.PATH, npm_config_workspace: "child", KEEP: "preserved" },
  });
  context.after(async () => await executor.dispose());

  const output = await executor.execute(
    {
      id: "selector-environment",
      event: "Stop",
      source: fixture.packageSubject.source,
      order: 0,
      handler,
      trusted: true,
    },
    {
      session_id: "selector-environment",
      cwd: fixture.workspace,
      hook_event_name: "Stop",
      payload: { reason: "test" },
    },
    {},
  );

  assert.equal(output.additionalContext, "unset:preserved");
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

for (const scenario of [
  {
    label: "leading environment assignment",
    handler: { type: "command", command: "NODE_ENV=test npm test" },
  },
  { label: "env wrapper", handler: { type: "command", command: "env npm test" } },
  {
    label: "env assignment and package option",
    handler: { type: "command", command: "env NODE_ENV=test npm --silent test" },
  },
  { label: "command wrapper", handler: { type: "command", command: "command npm test" } },
  { label: "exec wrapper", handler: { type: "command", command: "exec npm test" } },
  {
    label: "no-shell env wrapper",
    handler: { type: "command", command: "env", args: ["NODE_ENV=test", "npm", "test"] },
  },
] as const) {
  test(`${scenario.label} still binds the package script`, async (context) => {
    const fixture = await createFixture(context, scenario.handler);
    await writePackageScripts(fixture.workspace, { test: "node test.js" });
    await fixture.store.trust(fixture.packageSubject);

    await writePackageScripts(fixture.workspace, { test: "node changed.js" });

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
  "echo safe && npm test",
  "sh -c 'npm test'",
  "sudo npm test",
  "env -S 'npm test'",
  "stdbuf -oL npm test",
  "corepack yarn test",
  "ionice npm test",
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

for (const command of ["echo npm test", "command -v npm"] as const) {
  test(`${command} does not claim package-script execution`, async (context) => {
    const fixture = await createFixture(context, { type: "command", command });

    const resolution = await resolveReferencedScripts(
      fixture.packageSubject.handler,
      fixture.workspace,
    );

    assert.deepEqual(resolution.packageScripts, []);
  });
}

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

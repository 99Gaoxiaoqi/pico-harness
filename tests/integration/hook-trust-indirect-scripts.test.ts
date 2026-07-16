import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { resolveCommandHookInvocation } from "../../src/hooks/config/referenced-scripts.js";
import { DefaultHookExecutor } from "../../src/hooks/executors/executor.js";
import { HookTrustStore, type HookTrustSubject } from "../../src/hooks/trust/store.js";
import type { CommandHookHandler } from "../../src/hooks/types.js";

test("ordinary executable scripts remain byte-bound", async (context) => {
  const fixture = await createFixture(context);
  const scriptPath = join(fixture.workspace, "check.sh");
  const subject = fixture.subject({ type: "command", command: "./check.sh", args: [] });
  await writeExecutable(scriptPath, '#!/bin/sh\nprintf \'{"additionalContext":"A"}\\n\'\n');
  await fixture.store.trust(subject);
  assert.equal(await fixture.store.status(subject), "active");

  await writeExecutable(scriptPath, '#!/bin/sh\nprintf \'{"additionalContext":"B"}\\n\'\n');

  assert.equal(await fixture.store.status(subject), "pending");
});

for (const handler of [
  { type: "command", command: "npm run test" },
  { type: "command", command: "npm", args: ["exec", "tool"] },
  { type: "command", command: "npm view package" },
  { type: "command", command: "pnpm test" },
  { type: "command", command: "yarn node ./tool.js" },
  { type: "command", command: "bun ./tool.ts" },
  { type: "command", command: "npx tool" },
  { type: "command", command: "pnpx tool" },
  { type: "command", command: "bunx tool" },
  { type: "command", command: "corepack yarn test" },
  { type: "command", command: process.execPath, args: ["--run", "test"] },
  { type: "command", command: `${process.execPath} --run=test` },
] as const satisfies readonly CommandHookHandler[]) {
  test(`${handler.command} package execution cannot be trusted`, async (context) => {
    const fixture = await createFixture(context);
    await assert.rejects(fixture.store.trust(fixture.subject(handler)), /无法建立完整静态信任/u);
    assert.deepEqual(await fixture.store.list(), []);
  });
}

for (const command of [
  "echo safe && ./other.sh",
  "echo $HOME",
  "./scripts/*.sh",
  "env node ./main.js",
  "sh -c 'node ./main.js'",
] as const) {
  test(`${command} dynamic shell form fails closed`, () => {
    assert.throws(
      () => resolveCommandHookInvocation({ type: "command", command }),
      /无法建立完整静态信任/u,
    );
  });
}

test("package runners reached through Node or an executable alias fail closed", async (context) => {
  const fixture = await createFixture(context);
  const runnerPath = join(fixture.workspace, "npm-cli.js");
  const aliasPath = join(fixture.workspace, "pico-runner-alias");
  await writeExecutable(runnerPath, "#!/usr/bin/env node\nprocess.stdout.write('runner');\n");
  await symlink(runnerPath, aliasPath);

  await assert.rejects(
    fixture.store.trust(
      fixture.subject({ type: "command", command: process.execPath, args: [runnerPath, "run"] }),
    ),
    /package-manager\/runner/u,
  );
  await assert.rejects(
    fixture.store.trust(fixture.subject({ type: "command", command: aliasPath, args: ["run"] })),
    /package-manager\/runner/u,
  );
});

test("inherited runtime loader variables are stripped before command execution", async (context) => {
  const fixture = await createFixture(context);
  const scriptPath = join(fixture.workspace, "environment.sh");
  const preloadPath = join(fixture.workspace, "preload.sh");
  const markerPath = join(fixture.root, "preloaded.txt");
  await writeExecutable(
    scriptPath,
    [
      "#!/bin/sh",
      'printf \'{"additionalContext":"%s:%s:%s:%s"}\\n\' "${BASH_ENV-unset}" "${ENV-unset}" "${NODE_OPTIONS-unset}" "${KEEP-unset}"',
      "",
    ].join("\n"),
  );
  await writeFile(preloadPath, `printf injected > ${JSON.stringify(markerPath)}\n`);
  const handler = {
    type: "command",
    command: scriptPath,
    args: [],
    env: { KEEP: "preserved" },
  } as const;
  const executor = new DefaultHookExecutor({
    workDir: fixture.workspace,
    env: {
      PATH: process.env.PATH,
      BASH_ENV: preloadPath,
      ENV: preloadPath,
      NODE_OPTIONS: `--require=${preloadPath}`,
      LD_PRELOAD: join(fixture.workspace, "missing.so"),
      DYLD_INSERT_LIBRARIES: join(fixture.workspace, "missing.dylib"),
    },
  });
  context.after(async () => await executor.dispose());

  const output = await executor.execute(
    {
      id: "environment-sanitization",
      event: "Stop",
      source: fixture.source,
      order: 0,
      handler,
      trusted: true,
    },
    {
      session_id: "environment-sanitization",
      cwd: fixture.workspace,
      hook_event_name: "Stop",
      payload: { reason: "test" },
    },
    {},
  );

  assert.equal(output.additionalContext, "unset:unset:unset:preserved");
  assert.equal(await exists(markerPath), false);
});

for (const name of [
  "PATH",
  "PATHEXT",
  "BASH_ENV",
  "ENV",
  "ZDOTDIR",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",
  "PYTHONPATH",
  "RUBYOPT",
  "PERL5OPT",
  "JAVA_TOOL_OPTIONS",
] as const) {
  test(`handler.env ${name} fails closed`, async (context) => {
    const fixture = await createFixture(context);
    const handler = {
      type: "command",
      command: process.execPath,
      args: ["--version"],
      env: { [name]: "./injected" },
    } as const;
    await assert.rejects(
      fixture.store.trust(fixture.subject(handler)),
      new RegExp(`不允许覆盖 ${name}`, "u"),
    );
  });
}

test("the executable selected from host PATH is version-bound", async (context) => {
  const fixture = await createFixture(context);
  const executablePath = join(fixture.workspace, "pico-hook-runner");
  const environment = { PATH: `${fixture.workspace}${delimiter}${process.env.PATH ?? ""}` };
  const store = new HookTrustStore({ picoHome: fixture.picoHome, env: environment });
  const subject = fixture.subject({ type: "command", command: "pico-hook-runner", args: [] });
  await writeExecutable(executablePath, '#!/bin/sh\nprintf \'{"additionalContext":"A"}\\n\'\n');
  await store.trust(subject);
  assert.equal(await store.status(subject), "active");

  await writeExecutable(executablePath, '#!/bin/sh\nprintf \'{"additionalContext":"B"}\\n\'\n');

  assert.equal(await store.status(subject), "pending");
});

test("Node extensionless entry files are byte-bound", async (context) => {
  const fixture = await createFixture(context);
  const entryPath = join(fixture.workspace, "hook");
  const subject = fixture.subject({ type: "command", command: process.execPath, args: ["hook"] });
  await writeFile(entryPath, "process.stdout.write('A');\n");
  await fixture.store.trust(subject);

  await writeFile(entryPath, "process.stdout.write('B');\n");

  assert.equal(await fixture.store.status(subject), "pending");
});

test("Node directory entries fail closed", async (context) => {
  const fixture = await createFixture(context);
  await mkdir(join(fixture.workspace, "entry"));
  await writeFile(
    join(fixture.workspace, "entry", "package.json"),
    `${JSON.stringify({ main: "main.cjs" })}\n`,
  );
  await writeFile(join(fixture.workspace, "entry", "main.cjs"), "process.stdout.write('A');\n");

  await assert.rejects(
    fixture.store.trust(
      fixture.subject({ type: "command", command: process.execPath, args: ["./entry"] }),
    ),
    /不允许使用目录入口/u,
  );
});

for (const scenario of [
  { label: "attached require", args: ["--require=./preload.cjs", "./main.cjs"] },
  { label: "separate require", args: ["--require", "./preload.cjs", "./main.cjs"] },
  { label: "attached import", args: ["--import=./preload.mjs", "./main.cjs"] },
  { label: "attached loader", args: ["--loader=./preload.mjs", "./main.cjs"] },
  {
    label: "attached experimental loader",
    args: ["--experimental-loader=./preload.mjs", "./main.cjs"],
  },
] as const) {
  test(`Node ${scenario.label} bytes are trust-bound`, async (context) => {
    const fixture = await createFixture(context);
    await writeFile(join(fixture.workspace, "main.cjs"), "process.stdout.write('main');\n");
    await writeFile(join(fixture.workspace, "preload.cjs"), "globalThis.marker = 'A';\n");
    await writeFile(join(fixture.workspace, "preload.mjs"), "globalThis.marker = 'A';\n");
    const subject = fixture.subject({
      type: "command",
      command: process.execPath,
      args: scenario.args,
    });
    await fixture.store.trust(subject);

    const preload = scenario.args.some((value) => value.includes("preload.mjs"))
      ? "preload.mjs"
      : "preload.cjs";
    await writeFile(join(fixture.workspace, preload), "globalThis.marker = 'B';\n");

    assert.equal(await fixture.store.status(subject), "pending");
  });
}

for (const args of [
  ["--require=unbound-package", "./main.cjs"],
  ["--import", "unbound-package", "./main.cjs"],
  ["--env-file=./runtime.env", "./main.cjs"],
  ["--test", "./main.cjs"],
] as const) {
  test(`Node unsupported option ${args[0]} fails closed`, async (context) => {
    const fixture = await createFixture(context);
    await writeFile(join(fixture.workspace, "main.cjs"), "process.stdout.write('main');\n");
    await writeFile(join(fixture.workspace, "runtime.env"), "NODE_OPTIONS=--require=./other.cjs\n");
    await assert.rejects(
      fixture.store.trust(fixture.subject({ type: "command", command: process.execPath, args })),
      /无法建立完整静态信任/u,
    );
  });
}

test("Node ordinary entry keeps trust until its bytes change", async (context) => {
  const fixture = await createFixture(context);
  const entryPath = join(fixture.workspace, "main.cjs");
  const subject = fixture.subject({
    type: "command",
    command: process.execPath,
    args: ["./main.cjs", "ordinary-argument"],
  });
  await writeFile(entryPath, "process.stdout.write('A');\n");
  await fixture.store.trust(subject);
  assert.equal(await fixture.store.status(subject), "active");

  await writeFile(entryPath, "process.stdout.write('B');\n");

  assert.equal(await fixture.store.status(subject), "pending");
});

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly picoHome: string;
  readonly source: HookTrustSubject["source"];
  readonly store: HookTrustStore;
  subject(handler: CommandHookHandler): HookTrustSubject;
}

async function createFixture(context: {
  after: (callback: () => Promise<void>) => void;
}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pico-hook-static-trust-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(join(workspace, ".pico"), { recursive: true });
  await mkdir(picoHome, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = {
    kind: "project",
    path: join(workspace, ".pico", "hooks.json"),
    version: 1,
  } as const;
  return {
    root,
    workspace,
    picoHome,
    source,
    store: new HookTrustStore({ picoHome }),
    subject(handler) {
      return { workspace, source, handler };
    },
  };
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

async function exists(path: string): Promise<boolean> {
  return await access(path).then(
    () => true,
    () => false,
  );
}

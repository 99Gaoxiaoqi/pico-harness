import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  resolveCommandHookExecution,
  resolveCommandHookInvocation,
  resolveReferencedScripts,
  sanitizeCommandHookEnvironment,
} from "../../src/hooks/config/referenced-scripts.js";
import { DefaultHookExecutor } from "../../src/hooks/executors/executor.js";
import { HookTrustStore, type HookTrustSubject } from "../../src/hooks/trust/store.js";
import type { CommandHookHandler } from "../../src/hooks/types.js";

const execFile = promisify(execFileCallback);

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

test("workspace shebang interpreters are version-bound", async (context) => {
  if (process.platform === "win32") return context.skip("Shebangs are POSIX-only");
  const fixture = await createFixture(context);
  const interpreterPath = join(fixture.root, "custom-interpreter");
  const scriptPath = join(fixture.workspace, "check-with-custom-interpreter");
  await copyFile("/bin/sh", interpreterPath);
  await chmod(interpreterPath, 0o755);
  await writeExecutable(
    scriptPath,
    `#!${interpreterPath}\nprintf '{"additionalContext":"A"}\\n'\n`,
  );
  const subject = fixture.subject({ type: "command", command: scriptPath, args: [] });
  await fixture.store.trust(subject);
  assert.equal(await fixture.store.status(subject), "active");

  await writeExecutable(interpreterPath, "changed interpreter bytes\n");

  assert.equal(await fixture.store.status(subject), "pending");
});

for (const scenario of [
  { label: "env forwarder", declaration: "#!/usr/bin/env sh" },
  { label: "login option", declaration: "#!/bin/sh -l" },
] as const) {
  test(`workspace shebang ${scenario.label} fails closed`, async (context) => {
    if (process.platform === "win32") return context.skip("Shebangs are POSIX-only");
    const fixture = await createFixture(context);
    const scriptPath = join(fixture.workspace, "unsafe-shebang");
    await writeExecutable(scriptPath, `${scenario.declaration}\nexit 0\n`);

    await assert.rejects(
      fixture.store.trust(fixture.subject({ type: "command", command: scriptPath, args: [] })),
      /shebang 不允许携带解释器参数/u,
    );
  });
}

test("workspace shebang CRLF line endings fail closed", async (context) => {
  if (process.platform === "win32") return context.skip("Shebangs are POSIX-only");
  const fixture = await createFixture(context);
  const scriptPath = join(fixture.workspace, "crlf-shebang");
  await writeExecutable(scriptPath, "#!/bin/sh\r\nexit 0\r\n");

  await assert.rejects(
    fixture.store.trust(fixture.subject({ type: "command", command: scriptPath, args: [] })),
    /shebang 不允许 CR\/CRLF 行尾/u,
  );
});

test("nested workspace shebang forwarders fail closed", async (context) => {
  if (process.platform === "win32") return context.skip("Shebangs are POSIX-only");
  const fixture = await createFixture(context);
  const wrapperPath = join(fixture.root, "interpreter-wrapper");
  const scriptPath = join(fixture.workspace, "nested-shebang");
  await writeExecutable(wrapperPath, '#!/usr/bin/env sh\nexec /bin/sh "$@"\n');
  await writeExecutable(scriptPath, `#!${wrapperPath}\nexit 0\n`);

  await assert.rejects(
    fixture.store.trust(fixture.subject({ type: "command", command: scriptPath, args: [] })),
    /shebang 不允许携带解释器参数/u,
  );
});

test("nested workspace shebang interpreters fail closed on every platform", async (context) => {
  if (process.platform === "win32") return context.skip("Shebangs are POSIX-only");
  const fixture = await createFixture(context);
  const wrapperPath = join(fixture.root, "nested-interpreter");
  const scriptPath = join(fixture.workspace, "nested-interpreter-script");
  await writeExecutable(wrapperPath, '#!/bin/sh\nexec /bin/sh "$@"\n');
  await writeExecutable(scriptPath, `#!${wrapperPath}\nexit 0\n`);

  await assert.rejects(
    fixture.store.trust(fixture.subject({ type: "command", command: scriptPath, args: [] })),
    /shebang 解释器自身不得再使用 shebang/u,
  );
});

test("known external interpreter names cannot hide shebang forwarders", async (context) => {
  if (process.platform === "win32") return context.skip("Shebangs are POSIX-only");
  const fixture = await createFixture(context);
  const externalBin = join(fixture.root, "external-bin");
  const interpreterPath = join(externalBin, "sh");
  const scriptPath = join(fixture.workspace, "ordinary-script.sh");
  await mkdir(externalBin);
  await writeExecutable(interpreterPath, '#!/usr/bin/env sh\nexec /bin/sh "$@"\n');
  await writeFile(scriptPath, "exit 0\n");

  await assert.rejects(
    fixture.store.trust(
      fixture.subject({ type: "command", command: interpreterPath, args: [scriptPath] }),
    ),
    /shebang 不允许携带解释器参数/u,
  );
});

test("versioned Python 3 executable names retain the audited interpreter grammar", async (context) => {
  if (process.platform === "win32") return context.skip("POSIX executable fixture");
  const fixture = await createFixture(context);
  const interpreterPath = join(fixture.root, "python3.14");
  const scriptPath = join(fixture.workspace, "ordinary.py");
  await copyFile("/bin/sh", interpreterPath);
  await chmod(interpreterPath, 0o755);
  await writeFile(scriptPath, "print('ordinary')\n");
  const subject = fixture.subject({
    type: "command",
    command: interpreterPath,
    args: [scriptPath],
  });

  await fixture.store.trust(subject);

  assert.equal(await fixture.store.status(subject), "active");
});

test("Python virtualenv hooks preserve the selected logical executable path", async (context) => {
  if (process.platform === "win32") return context.skip("POSIX virtualenv executable layout");
  const fixture = await createFixture(context);
  const virtualenvPath = join(fixture.workspace, ".venv");
  const scriptPath = join(fixture.workspace, "virtualenv-hook.py");
  await execFile("python3", ["-m", "venv", virtualenvPath]);
  await writeFile(
    scriptPath,
    "import json, sys\nprint(json.dumps({'additionalContext': sys.prefix}))\n",
  );
  const handler = {
    type: "command",
    command: "./.venv/bin/python",
    args: ["./virtualenv-hook.py"],
  } as const;
  const subject = fixture.subject(handler);
  await fixture.store.trust(subject);
  const invocation = await resolveCommandHookExecution(handler, fixture.workspace);
  assert.equal(
    invocation.command,
    join(await realpath(fixture.workspace), ".venv", "bin", "python"),
  );
  const references = await resolveReferencedScripts(handler, fixture.workspace);
  assert.ok(references.watchPaths.includes(invocation.command));
  assert.ok(references.watchPaths.includes(invocation.canonicalCommand));

  const executor = new DefaultHookExecutor({
    workDir: fixture.workspace,
    authorizeCommandExecution: async (entry) =>
      await fixture.store.authorizeCommandExecution({
        workspace: fixture.workspace,
        source: entry.source,
        handler: entry.handler,
      }),
  });
  context.after(async () => await executor.dispose());
  const output = await executeStopHook(executor, fixture, handler, "python-virtualenv");

  assert.equal(await realpath(output.additionalContext ?? ""), await realpath(virtualenvPath));
});

test("logical interpreter aliases remain trust-bound to their canonical target", async (context) => {
  if (process.platform === "win32") return context.skip("POSIX executable symlink fixture");
  const fixture = await createFixture(context);
  const binPath = join(fixture.workspace, ".venv", "bin");
  const interpreterTarget = join(fixture.root, "python3.14");
  const interpreterAlias = join(binPath, "python");
  const scriptPath = join(fixture.workspace, "ordinary.py");
  await mkdir(binPath, { recursive: true });
  await copyFile("/bin/sh", interpreterTarget);
  await chmod(interpreterTarget, 0o755);
  await symlink(interpreterTarget, interpreterAlias);
  await writeFile(scriptPath, "print('ordinary')\n");
  const handler = {
    type: "command",
    command: "./.venv/bin/python",
    args: ["./ordinary.py"],
  } as const;
  const subject = fixture.subject(handler);
  await fixture.store.trust(subject);
  assert.equal(await fixture.store.status(subject), "active");

  await writeFile(interpreterTarget, "changed interpreter bytes\n");

  assert.equal(await fixture.store.status(subject), "pending");
});

test("versioned Ruby executable names retain the audited interpreter grammar", async (context) => {
  if (process.platform === "win32") return context.skip("POSIX executable fixture");
  const fixture = await createFixture(context);
  const interpreterPath = join(fixture.root, "ruby3.3");
  const scriptPath = join(fixture.workspace, "ordinary.rb");
  await copyFile("/bin/sh", interpreterPath);
  await chmod(interpreterPath, 0o755);
  await writeFile(scriptPath, "puts 'ordinary'\n");
  const subject = fixture.subject({
    type: "command",
    command: interpreterPath,
    args: [scriptPath],
  });

  await fixture.store.trust(subject);

  assert.equal(await fixture.store.status(subject), "active");
});

test("cyclic workspace shebang interpreter chains fail closed", async (context) => {
  if (process.platform === "win32") return context.skip("Shebangs are POSIX-only");
  const fixture = await createFixture(context);
  const wrapperPath = join(fixture.root, "cycle-wrapper");
  const scriptPath = join(fixture.workspace, "cycle-script");
  await writeExecutable(scriptPath, `#!${wrapperPath}\nexit 0\n`);
  await writeExecutable(wrapperPath, `#!${scriptPath}\nexit 0\n`);

  await assert.rejects(
    fixture.store.trust(fixture.subject({ type: "command", command: scriptPath, args: [] })),
    /shebang 解释器链存在循环/u,
  );
});

test("workspace shebang interpreter names cannot trigger login argv zero", async (context) => {
  if (process.platform === "win32") return context.skip("Shebangs are POSIX-only");
  const fixture = await createFixture(context);
  const aliasPath = join(fixture.root, "-sh");
  const scriptPath = join(fixture.workspace, "login-alias-shebang");
  await symlink("/bin/sh", aliasPath);
  await writeExecutable(scriptPath, `#!${aliasPath}\nexit 0\n`);

  await assert.rejects(
    fixture.store.trust(fixture.subject({ type: "command", command: scriptPath, args: [] })),
    /shebang 解释器名称不允许以 - 开头/u,
  );
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
      'printf \'{"additionalContext":"%s:%s:%s:%s:%s"}\\n\' "${BASH_ENV-unset}" "${ENV-unset}" "${NODE_OPTIONS-unset}" "${PYTHONPYCACHEPREFIX-unset}" "${KEEP-unset}"',
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
      PYTHONPYCACHEPREFIX: join(fixture.root, "attacker-pyc-cache"),
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

  assert.equal(output.additionalContext, "unset:unset:unset:unset:preserved");
  assert.equal(await exists(markerPath), false);
});

test("inherited Bash exported functions are stripped before trust and execution", async (context) => {
  if (process.platform === "win32") return context.skip("Bash exported functions are POSIX-only");
  const fixture = await createFixture(context);
  const scriptPath = join(fixture.workspace, "function-check.sh");
  await writeFile(
    scriptPath,
    [
      "if command -v hookpayload >/dev/null 2>&1; then",
      "  value=$(hookpayload)",
      "else",
      "  value=unset",
      "fi",
      'printf \'{"additionalContext":"%s"}\\n\' "$value"',
      "",
    ].join("\n"),
  );
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    "BASH_FUNC_hookpayload%%": "() { printf A; }",
  };
  const store = new HookTrustStore({ picoHome: fixture.picoHome, env: environment });
  const handler = { type: "command", command: "bash", args: ["./function-check.sh"] } as const;
  const subject = fixture.subject(handler);
  await store.trust(subject);
  environment["BASH_FUNC_hookpayload%%"] = "() { printf B; }";
  assert.equal(await store.status(subject), "active");

  const executor = new DefaultHookExecutor({ workDir: fixture.workspace, env: environment });
  context.after(async () => await executor.dispose());
  const output = await executeStopHook(executor, fixture, handler, "bash-exported-function");

  assert.equal(output.additionalContext, "unset");
});

test("interpreter startup environments are stripped or pinned to inert sentinels", () => {
  const handler = { type: "command", command: process.execPath, args: ["--version"] } as const;
  const sanitized = sanitizeCommandHookEnvironment(handler, {
    PATH: process.env.PATH,
    SHELLOPTS: "xtrace",
    PS4: "$(injected)",
    RUBYGEMS_GEMDEPS: "./gem.deps.rb",
    PYTHONUSERBASE: "./python-user-base",
    PYTHONPYCACHEPREFIX: "./python-cache",
    PYTHONWARNINGS: "ignore::payload.CustomWarning",
    PYTHONBREAKPOINT: "payload.breakpoint",
    PYTHON_PRESITE: "payload",
    PERLLIB: "./perl-lib",
    XDG_CONFIG_HOME: "./fish-config",
    OPENSSL_CONF: "./openssl.cnf",
    LD_PROFILE: "./profile.so",
  });

  assert.equal(sanitized.SHELLOPTS, undefined);
  assert.equal(sanitized.PS4, undefined);
  assert.equal(sanitized.RUBYGEMS_GEMDEPS, undefined);
  assert.equal(sanitized.PYTHONUSERBASE, undefined);
  assert.equal(sanitized.PYTHONPYCACHEPREFIX, undefined);
  assert.equal(sanitized.PYTHONWARNINGS, undefined);
  assert.equal(sanitized.PYTHONBREAKPOINT, undefined);
  assert.equal(sanitized.PYTHON_PRESITE, undefined);
  assert.equal(sanitized.PERLLIB, undefined);
  assert.equal(sanitized.OPENSSL_CONF, undefined);
  assert.equal(sanitized.LD_PROFILE, undefined);
  assert.equal(sanitized.PYTHONNOUSERSITE, "1");
  assert.equal(sanitized.PYTHONDONTWRITEBYTECODE, "1");
  if (process.platform !== "win32") {
    assert.equal(sanitized.ZDOTDIR, "/dev/null");
    assert.equal(sanitized.XDG_CONFIG_HOME, "/dev/null");
  }
});

for (const name of [
  "PATH",
  "PATHEXT",
  "BASH_ENV",
  "ENV",
  "ZDOTDIR",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_PROFILE",
  "DYLD_INSERT_LIBRARIES",
  "OPENSSL_CONF",
  "PYTHONPATH",
  "RUBYOPT",
  "PERL5OPT",
  "JAVA_TOOL_OPTIONS",
  "BASH_FUNC_hookpayload%%",
  "SHELLOPTS",
  "PS4",
  "RUBYGEMS_GEMDEPS",
  "PYTHONUSERBASE",
  "PYTHONPYCACHEPREFIX",
  "PYTHONWARNINGS",
  "PYTHONDONTWRITEBYTECODE",
  "PERLLIB",
  "XDG_CONFIG_HOME",
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

test("relative executable paths and spawn use the same workspace file", async (context) => {
  const fixture = await createFixture(context);
  const pathRoot = join(fixture.root, "path-root");
  const workspaceScript = join(fixture.workspace, "scripts", "hook.sh");
  const pathScript = join(pathRoot, "scripts", "hook.sh");
  await mkdir(join(fixture.workspace, "scripts"), { recursive: true });
  await mkdir(join(pathRoot, "scripts"), { recursive: true });
  await writeExecutable(
    workspaceScript,
    '#!/bin/sh\nprintf \'{"additionalContext":"workspace"}\\n\'\n',
  );
  await writeExecutable(pathScript, '#!/bin/sh\nprintf \'{"additionalContext":"path"}\\n\'\n');
  const environment = { PATH: `${pathRoot}${delimiter}${process.env.PATH ?? ""}` };
  const store = new HookTrustStore({ picoHome: fixture.picoHome, env: environment });
  const handler = { type: "command", command: "scripts/hook.sh", args: [] } as const;
  await store.trust(fixture.subject(handler));

  const executor = new DefaultHookExecutor({ workDir: fixture.workspace, env: environment });
  context.after(async () => await executor.dispose());
  const output = await executeStopHook(executor, fixture, handler, "relative-executable");

  assert.equal(output.additionalContext, "workspace", JSON.stringify(output));
});

test("PATH resolution matches spawn when a differently-cased key is also present", async (context) => {
  if (process.platform === "win32")
    return context.skip("Windows environment keys are case-insensitive");
  const fixture = await createFixture(context);
  const wrongBin = join(fixture.workspace, "wrong-bin");
  const rightBin = join(fixture.workspace, "right-bin");
  await mkdir(wrongBin);
  await mkdir(rightBin);
  await writeExecutable(
    join(wrongBin, "pico-path-runner"),
    '#!/bin/sh\nprintf \'{"additionalContext":"wrong"}\\n\'\n',
  );
  await writeExecutable(
    join(rightBin, "pico-path-runner"),
    '#!/bin/sh\nprintf \'{"additionalContext":"right"}\\n\'\n',
  );
  const environment = {
    Path: wrongBin,
    PATH: `${rightBin}${delimiter}${process.env.PATH ?? ""}`,
  };
  const store = new HookTrustStore({ picoHome: fixture.picoHome, env: environment });
  const handler = { type: "command", command: "pico-path-runner", args: [] } as const;
  await store.trust(fixture.subject(handler));

  const executor = new DefaultHookExecutor({ workDir: fixture.workspace, env: environment });
  context.after(async () => await executor.dispose());
  const output = await executeStopHook(executor, fixture, handler, "path-case");

  assert.equal(output.additionalContext, "right", JSON.stringify(output));
});

test("command hooks accept valid output when the child closes stdin early", async (context) => {
  const fixture = await createFixture(context);
  const scriptPath = join(fixture.workspace, "close-stdin.cjs");
  await writeFile(
    scriptPath,
    [
      'const fs = require("node:fs");',
      "fs.closeSync(0);",
      'process.stdout.write(JSON.stringify({ additionalContext: "stdin-closed" }));',
      "setTimeout(() => undefined, 100);",
      "",
    ].join("\n"),
  );
  const handler = {
    type: "command",
    command: process.execPath,
    args: ["./close-stdin.cjs"],
  } as const;
  await fixture.store.trust(fixture.subject(handler));
  const executor = new DefaultHookExecutor({ workDir: fixture.workspace });
  context.after(async () => await executor.dispose());

  const output = await executor.execute(
    {
      id: "stdin-closed",
      event: "Stop",
      source: fixture.source,
      order: 0,
      handler,
      trusted: true,
    },
    {
      session_id: "stdin-closed",
      cwd: fixture.workspace,
      hook_event_name: "Stop",
      payload: { reason: "x".repeat(2 * 1024 * 1024) },
    },
    {},
  );

  assert.equal(output.additionalContext, "stdin-closed", JSON.stringify(output));
});

test("unknown external command wrappers cannot establish trust", async (context) => {
  const fixture = await createFixture(context);
  const externalRunner = join(fixture.root, "external-dsl-runner");
  const payload = join(fixture.workspace, "rule.dsl");
  await writeExecutable(externalRunner, "#!/bin/sh\nexit 0\n");
  await writeFile(payload, "version-one\n");

  await assert.rejects(
    fixture.store.trust(
      fixture.subject({ type: "command", command: externalRunner, args: ["-f", payload] }),
    ),
    /外部可执行文件.*未经审计/u,
  );
});

test("workspace executables bind visible ordinary-file arguments", async (context) => {
  const fixture = await createFixture(context);
  const runner = join(fixture.workspace, "dsl-runner");
  const payload = join(fixture.workspace, "rule.dsl");
  await writeExecutable(runner, "#!/bin/sh\nexit 0\n");
  await writeFile(payload, "version-one\n");
  const subject = fixture.subject({ type: "command", command: runner, args: ["-f", "rule.dsl"] });
  await fixture.store.trust(subject);

  await writeFile(payload, "version-two\n");

  assert.equal(await fixture.store.status(subject), "pending");
});

test("workspace executables bind dash-prefixed operands after option markers", async (context) => {
  const fixture = await createFixture(context);
  const runner = join(fixture.workspace, "operand-runner");
  const payload = join(fixture.workspace, "-payload.sh");
  await writeExecutable(runner, "#!/bin/sh\nexit 0\n");
  await writeFile(payload, "version-one\n");
  const subject = fixture.subject({
    type: "command",
    command: runner,
    args: ["--", "-payload.sh"],
  });
  await fixture.store.trust(subject);

  await writeFile(payload, "version-two\n");

  assert.equal(await fixture.store.status(subject), "pending");
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

test("Node options after the entry remain ordinary script arguments", async (context) => {
  const fixture = await createFixture(context);
  const entryPath = join(fixture.workspace, "argv.cjs");
  await writeFile(
    entryPath,
    'process.stdout.write(JSON.stringify({ additionalContext: process.argv.slice(2).join(":") }));\n',
  );
  const handler = {
    type: "command",
    command: process.execPath,
    args: ["./argv.cjs", "--env-file"],
  } as const;
  await fixture.store.trust(fixture.subject(handler));
  const executor = new DefaultHookExecutor({ workDir: fixture.workspace });
  context.after(async () => await executor.dispose());

  const output = await executeStopHook(executor, fixture, handler, "node-script-argv");

  assert.equal(output.additionalContext, "--env-file");
});

test("known interpreter options after the script remain ordinary argv", async (context) => {
  const fixture = await createFixture(context);
  const scriptPath = join(fixture.workspace, "argv.sh");
  await writeFile(scriptPath, '#!/bin/sh\nprintf \'{"additionalContext":"%s"}\\n\' "$1"\n');
  const handler = { type: "command", command: "sh", args: ["./argv.sh", "-c"] } as const;
  await fixture.store.trust(fixture.subject(handler));
  const executor = new DefaultHookExecutor({ workDir: fixture.workspace });
  context.after(async () => await executor.dispose());

  const output = await executeStopHook(executor, fixture, handler, "interpreter-script-argv");

  assert.equal(output.additionalContext, "-c");
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

async function executeStopHook(
  executor: DefaultHookExecutor,
  fixture: Fixture,
  handler: CommandHookHandler,
  id: string,
) {
  return await executor.execute(
    {
      id,
      event: "Stop",
      source: fixture.source,
      order: 0,
      handler,
      trusted: true,
    },
    {
      session_id: id,
      cwd: fixture.workspace,
      hook_event_name: "Stop",
      payload: { reason: "test" },
    },
    {},
  );
}

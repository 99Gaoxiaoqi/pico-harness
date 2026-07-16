import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadHookSnapshot } from "../../src/hooks/config.js";
import { DefaultHookExecutor } from "../../src/hooks/executors/index.js";
import { createSessionHookRuntime } from "../../src/hooks/runtime.js";
import { HookService } from "../../src/hooks/service.js";
import {
  HookTrustStore,
  type HookTrustStatus,
  type HookTrustSubject,
} from "../../src/hooks/trust/store.js";

test("command Hook revalidates script bytes immediately before execution", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-hook-execution-trust-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const configPath = join(workspace, ".pico", "hooks.json");
  const scriptPath = join(workspace, "script.cjs");
  const markerPath = join(root, "executed.txt");
  await mkdir(join(workspace, ".pico"), { recursive: true });
  await mkdir(picoHome, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));

  const handler = {
    type: "command",
    command: process.execPath,
    args: ["script.cjs", markerPath],
  } as const;
  await writeFile(
    configPath,
    `${JSON.stringify({ PreToolUse: [{ hooks: [handler] }] }, null, 2)}\n`,
  );
  await writeMarkerScript(scriptPath, "trusted");

  const trustStore = new HookTrustStore({ picoHome });
  const pending = await loadHookSnapshot({ workDir: workspace, picoHome, trustStore });
  const pendingEntry = pending.snapshot.handlers.PreToolUse[0];
  assert.ok(pendingEntry);
  assert.equal(pendingEntry.trusted, false);
  await trustStore.trustResolved(workspace, pendingEntry);

  const active = await loadHookSnapshot({
    workDir: workspace,
    picoHome,
    trustStore,
    version: 2,
  });
  const activeEntry = active.snapshot.handlers.PreToolUse[0];
  assert.ok(activeEntry?.trusted);
  const executor = new DefaultHookExecutor({ workDir: workspace });
  context.after(async () => await executor.dispose());
  const service = new HookService({
    workDir: workspace,
    sessionId: "hook-execution-trust",
    executor,
    snapshot: active.snapshot,
    revalidateExecutableTrust: async (entry) =>
      (await trustStore.status({
        workspace,
        source: entry.source,
        handler: entry.handler,
      })) === "active",
  });

  await service.dispatch("PreToolUse", { tool_name: "read_file", tool_input: {} });
  assert.equal(await readFile(markerPath, "utf8"), "trusted");
  await rm(markerPath);

  await writeMarkerScript(scriptPath, "changed");
  assert.equal(
    await trustStore.status({ workspace, source: activeEntry.source, handler }),
    "pending",
  );
  const denied = await service.dispatch("PreToolUse", {
    tool_name: "read_file",
    tool_input: {},
  });

  assert.equal(await exists(markerPath), false, "变化后的脚本字节不得在 watcher debounce 前执行");
  assert.ok(denied.diagnostics?.some((diagnostic) => /执行前信任已失效/u.test(diagnostic.message)));
});

test("each command Hook revalidates after preceding handlers complete", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-hook-sequential-trust-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const configPath = join(workspace, ".pico", "hooks.json");
  const mutatorPath = join(workspace, "mutator.cjs");
  const victimPath = join(workspace, "victim.cjs");
  const markerPath = join(root, "victim-executed.txt");
  await mkdir(join(workspace, ".pico"), { recursive: true });
  await mkdir(picoHome, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));

  const handlers = [
    { type: "command", command: process.execPath, args: ["mutator.cjs", victimPath] },
    { type: "command", command: process.execPath, args: ["victim.cjs", markerPath] },
  ] as const;
  await writeFile(
    configPath,
    `${JSON.stringify({ PreToolUse: [{ hooks: handlers }] }, null, 2)}\n`,
  );
  await writeFile(
    mutatorPath,
    `require("node:fs").writeFileSync(process.argv[2], ${JSON.stringify(
      'require("node:fs").writeFileSync(process.argv[2], "changed");\n',
    )});\n`,
  );
  await writeMarkerScript(victimPath, "trusted");

  const trustStore = new HookTrustStore({ picoHome });
  const pending = await loadHookSnapshot({ workDir: workspace, picoHome, trustStore });
  assert.equal(pending.snapshot.handlers.PreToolUse.length, 2);
  for (const entry of pending.snapshot.handlers.PreToolUse) {
    await trustStore.trustResolved(workspace, entry);
  }
  const active = await loadHookSnapshot({
    workDir: workspace,
    picoHome,
    trustStore,
    version: 2,
  });
  assert.ok(active.snapshot.handlers.PreToolUse.every((entry) => entry.trusted));

  const executor = new DefaultHookExecutor({ workDir: workspace });
  context.after(async () => await executor.dispose());
  const service = new HookService({
    workDir: workspace,
    sessionId: "hook-sequential-trust",
    executor,
    snapshot: active.snapshot,
    concurrency: 1,
    revalidateExecutableTrust: async (entry) =>
      (await trustStore.status({
        workspace,
        source: entry.source,
        handler: entry.handler,
      })) === "active",
  });

  const denied = await service.dispatch("PreToolUse", {
    tool_name: "read_file",
    tool_input: {},
  });

  assert.equal(await exists(markerPath), false, "前序 Hook 改写的后续脚本不得沿用预检查结果");
  assert.equal(
    await trustStore.status({
      workspace,
      source: active.snapshot.handlers.PreToolUse[1]!.source,
      handler: handlers[1],
    }),
    "pending",
  );
  assert.ok(denied.diagnostics?.some((diagnostic) => /执行前信任已失效/u.test(diagnostic.message)));
});

test("session Hook runtime rejects an executable alias redirected after service revalidation", async (context) => {
  if (process.platform === "win32") return context.skip("POSIX executable symlink fixture");
  const root = await mkdtemp(join(tmpdir(), "pico-hook-alias-execution-trust-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const configPath = join(workspace, ".pico", "hooks.json");
  const trustedTarget = join(workspace, "trusted-hook.cjs");
  const replacementTarget = join(workspace, "replacement-hook.cjs");
  const executableAlias = join(workspace, "hook-alias");
  const nextAlias = join(workspace, ".hook-alias.next");
  const trustedMarker = join(root, "trusted-executed.txt");
  const replacementMarker = join(root, "replacement-executed.txt");
  await mkdir(join(workspace, ".pico"), { recursive: true });
  await mkdir(picoHome, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));

  const handler = { type: "command", command: "./hook-alias" } as const;
  await writeFile(
    configPath,
    `${JSON.stringify({ PreToolUse: [{ hooks: [handler] }] }, null, 2)}\n`,
  );
  await writeExecutableMarkerScript(trustedTarget, trustedMarker, "trusted");
  await writeExecutableMarkerScript(replacementTarget, replacementMarker, "replacement");
  await symlink(trustedTarget, executableAlias);

  const trustStore = new RedirectAfterStatusHookTrustStore({ picoHome });
  const pending = await loadHookSnapshot({ workDir: workspace, picoHome, trustStore });
  const pendingEntry = pending.snapshot.handlers.PreToolUse[0];
  assert.ok(pendingEntry);
  await trustStore.trustResolved(workspace, pendingEntry);

  const runtime = await createSessionHookRuntime({
    workDir: workspace,
    picoHome,
    sessionId: "hook-alias-execution-trust",
    trustStore,
  });
  context.after(async () => await runtime.dispose());
  const activeVersion = runtime.service.currentSnapshot().version;
  assert.equal(runtime.service.currentSnapshot().handlers.PreToolUse[0]?.trusted, true);

  trustStore.redirectAfterNextActiveStatus(async () => {
    await symlink(replacementTarget, nextAlias);
    await rename(nextAlias, executableAlias);
  });
  const output = await runtime.service.dispatch("PreToolUse", {
    tool_name: "read_file",
    tool_input: {},
  });

  assert.equal(await exists(trustedMarker), false, "重定向后不应退回执行旧目标");
  assert.equal(
    await exists(replacementMarker),
    false,
    "旧 trusted snapshot 不得执行新 canonical 对象",
  );
  assert.ok(output.diagnostics?.some((diagnostic) => /执行前信任已失效/u.test(diagnostic.message)));

  await waitUntil(
    () =>
      runtime.service.currentSnapshot().version > activeVersion &&
      runtime.service.currentSnapshot().handlers.PreToolUse[0]?.trusted === false,
  );

  const pendingVersion = runtime.service.currentSnapshot().version;
  await symlink(trustedTarget, nextAlias);
  await rename(nextAlias, executableAlias);
  await waitUntil(
    () =>
      runtime.service.currentSnapshot().version > pendingVersion &&
      runtime.service.currentSnapshot().handlers.PreToolUse[0]?.trusted === true,
  );

  trustStore.redirectAfterNextAuthorization(async () => {
    await symlink(replacementTarget, nextAlias);
    await rename(nextAlias, executableAlias);
  });
  const postAuthorizationOutput = await runtime.service.dispatch("PreToolUse", {
    tool_name: "read_file",
    tool_input: {},
  });

  assert.equal(await exists(trustedMarker), false);
  assert.equal(await exists(replacementMarker), false);
  assert.ok(
    postAuthorizationOutput.diagnostics?.some((diagnostic) =>
      /logical executable 已重定向/u.test(diagnostic.message),
    ),
  );
});

test("session Hook runtime binds referenced aliases and bytes through final execution", async (context) => {
  if (process.platform === "win32") return context.skip("POSIX symlink fixture");
  const root = await mkdtemp(join(tmpdir(), "pico-hook-reference-execution-trust-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const configPath = join(workspace, ".pico", "hooks.json");
  const trustedTarget = join(workspace, "trusted-entry.cjs");
  const replacementTarget = join(workspace, "replacement-entry.cjs");
  const entryAlias = join(workspace, "entry-alias.cjs");
  const nextAlias = join(workspace, ".entry-alias.next");
  const trustedMarker = join(root, "trusted-entry-executed.txt");
  const replacementMarker = join(root, "replacement-entry-executed.txt");
  await mkdir(join(workspace, ".pico"), { recursive: true });
  await mkdir(picoHome, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));

  const handler = {
    type: "command",
    command: process.execPath,
    args: ["./entry-alias.cjs"],
  } as const;
  await writeFile(
    configPath,
    `${JSON.stringify({ PreToolUse: [{ hooks: [handler] }] }, null, 2)}\n`,
  );
  await writeProtocolMarkerScript(trustedTarget, trustedMarker, "trusted");
  await writeProtocolMarkerScript(replacementTarget, replacementMarker, "replacement");
  await symlink(trustedTarget, entryAlias);

  const trustStore = new RedirectAfterStatusHookTrustStore({ picoHome });
  const pending = await loadHookSnapshot({ workDir: workspace, picoHome, trustStore });
  const pendingEntry = pending.snapshot.handlers.PreToolUse[0];
  assert.ok(pendingEntry);
  await trustStore.trustResolved(workspace, pendingEntry);
  const runtime = await createSessionHookRuntime({
    workDir: workspace,
    picoHome,
    sessionId: "hook-reference-execution-trust",
    trustStore,
  });
  context.after(async () => await runtime.dispose());
  let activeVersion = runtime.service.currentSnapshot().version;

  trustStore.redirectAfterNextAuthorization(async () => {
    await symlink(replacementTarget, nextAlias);
    await rename(nextAlias, entryAlias);
  });
  const redirected = await runtime.service.dispatch("PreToolUse", {
    tool_name: "read_file",
    tool_input: {},
  });
  assert.equal(await exists(trustedMarker), false);
  assert.equal(await exists(replacementMarker), false);
  assert.ok(
    redirected.diagnostics?.some((diagnostic) =>
      /logical 引用路径已重定向/u.test(diagnostic.message),
    ),
  );
  await waitUntil(
    () =>
      runtime.service.currentSnapshot().version > activeVersion &&
      runtime.service.currentSnapshot().handlers.PreToolUse[0]?.trusted === false,
  );

  const pendingVersion = runtime.service.currentSnapshot().version;
  await symlink(trustedTarget, nextAlias);
  await rename(nextAlias, entryAlias);
  await waitUntil(
    () =>
      runtime.service.currentSnapshot().version > pendingVersion &&
      runtime.service.currentSnapshot().handlers.PreToolUse[0]?.trusted === true,
  );
  activeVersion = runtime.service.currentSnapshot().version;

  trustStore.redirectAfterNextAuthorization(async () => {
    await writeProtocolMarkerScript(
      trustedTarget,
      replacementMarker,
      "changed-after-authorization",
    );
  });
  const changedBytes = await runtime.service.dispatch("PreToolUse", {
    tool_name: "read_file",
    tool_input: {},
  });
  assert.equal(await exists(trustedMarker), false);
  assert.equal(await exists(replacementMarker), false);
  assert.ok(
    changedBytes.diagnostics?.some((diagnostic) =>
      /Hook 引用文件内容已变化/u.test(diagnostic.message),
    ),
  );
  await waitUntil(() => runtime.service.currentSnapshot().version > activeVersion);
});

test("session Hook runtime binds a shebang interpreter alias through final execution", async (context) => {
  if (process.platform === "win32") return context.skip("POSIX shebang fixture");
  const root = await mkdtemp(join(tmpdir(), "pico-hook-shebang-alias-trust-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const configPath = join(workspace, ".pico", "hooks.json");
  const interpreterAlias = join(workspace, "shell-interpreter");
  const nextAlias = join(workspace, ".shell-interpreter.next");
  const scriptPath = join(workspace, "hook-script");
  const markerPath = join(root, "shebang-executed.txt");
  await mkdir(join(workspace, ".pico"), { recursive: true });
  await mkdir(picoHome, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));

  const handler = { type: "command", command: "./hook-script" } as const;
  await writeFile(
    configPath,
    `${JSON.stringify({ PreToolUse: [{ hooks: [handler] }] }, null, 2)}\n`,
  );
  await symlink("/bin/sh", interpreterAlias);
  await writeFile(
    scriptPath,
    `#!${interpreterAlias}\nprintf marker > ${JSON.stringify(markerPath)}\nprintf '{"decision":"allow"}'\n`,
  );
  await chmod(scriptPath, 0o755);

  const trustStore = new RedirectAfterStatusHookTrustStore({ picoHome });
  const pending = await loadHookSnapshot({ workDir: workspace, picoHome, trustStore });
  const pendingEntry = pending.snapshot.handlers.PreToolUse[0];
  assert.ok(pendingEntry);
  await trustStore.trustResolved(workspace, pendingEntry);
  const runtime = await createSessionHookRuntime({
    workDir: workspace,
    picoHome,
    sessionId: "hook-shebang-alias-trust",
    trustStore,
  });
  context.after(async () => await runtime.dispose());

  trustStore.redirectAfterNextAuthorization(async () => {
    await symlink("/bin/bash", nextAlias);
    await rename(nextAlias, interpreterAlias);
  });
  const output = await runtime.service.dispatch("PreToolUse", {
    tool_name: "read_file",
    tool_input: {},
  });

  assert.equal(await exists(markerPath), false);
  assert.ok(
    output.diagnostics?.some((diagnostic) => /logical 引用路径已重定向/u.test(diagnostic.message)),
  );
});

test("Hook watcher resolves bare commands with the trust store environment", async (context) => {
  if (process.platform === "win32") return context.skip("POSIX executable fixture");
  const root = await mkdtemp(join(tmpdir(), "pico-hook-watcher-environment-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  const binDirectory = join(workspace, "bin");
  const configPath = join(workspace, ".pico", "hooks.json");
  const executablePath = join(binDirectory, "pico-custom-hook");
  const markerPath = join(root, "custom-hook-executed.txt");
  await mkdir(join(workspace, ".pico"), { recursive: true });
  await mkdir(binDirectory, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));

  const handler = { type: "command", command: "pico-custom-hook" } as const;
  await writeFile(
    configPath,
    `${JSON.stringify({ PreToolUse: [{ hooks: [handler] }] }, null, 2)}\n`,
  );
  await writeExecutableMarkerScript(executablePath, markerPath, "trusted");
  const env = { ...process.env, PATH: binDirectory };
  const trustStore = new HookTrustStore({ picoHome, env });
  const pending = await loadHookSnapshot({ workDir: workspace, picoHome, trustStore });
  const pendingEntry = pending.snapshot.handlers.PreToolUse[0];
  assert.ok(pendingEntry);
  await trustStore.trustResolved(workspace, pendingEntry);
  const runtime = await createSessionHookRuntime({
    workDir: workspace,
    picoHome,
    sessionId: "hook-watcher-environment",
    env,
    trustStore,
  });
  context.after(async () => await runtime.dispose());
  const activeVersion = runtime.service.currentSnapshot().version;
  assert.equal(runtime.service.currentSnapshot().handlers.PreToolUse[0]?.trusted, true);

  await writeExecutableMarkerScript(executablePath, markerPath, "changed");
  await waitUntil(
    () =>
      runtime.service.currentSnapshot().version > activeVersion &&
      runtime.service.currentSnapshot().handlers.PreToolUse[0]?.trusted === false,
  );
  assert.equal(await exists(markerPath), false);
});

async function writeMarkerScript(path: string, marker: string): Promise<void> {
  await writeFile(
    path,
    `require("node:fs").writeFileSync(process.argv[2], ${JSON.stringify(marker)});\n`,
  );
}

async function writeProtocolMarkerScript(
  path: string,
  markerPath: string,
  marker: string,
): Promise<void> {
  await writeFile(
    path,
    `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, ${JSON.stringify(
      marker,
    )});\nprocess.stdout.write('{"decision":"allow"}');\n`,
  );
}

async function writeExecutableMarkerScript(
  path: string,
  markerPath: string,
  marker: string,
): Promise<void> {
  await writeFile(
    path,
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(
      markerPath,
    )}, ${JSON.stringify(marker)});\nprocess.stdout.write('{"decision":"allow"}');\n`,
  );
  await chmod(path, 0o755);
}

class RedirectAfterStatusHookTrustStore extends HookTrustStore {
  private redirect?: () => Promise<void>;
  private redirectAfterAuthorization?: () => Promise<void>;

  redirectAfterNextActiveStatus(redirect: () => Promise<void>): void {
    this.redirect = redirect;
  }

  redirectAfterNextAuthorization(redirect: () => Promise<void>): void {
    this.redirectAfterAuthorization = redirect;
  }

  override async status(subject: HookTrustSubject): Promise<HookTrustStatus> {
    const status = await super.status(subject);
    const redirect = status === "active" ? this.redirect : undefined;
    if (redirect) {
      this.redirect = undefined;
      await redirect();
    }
    return status;
  }

  override async authorizeCommandExecution(subject: HookTrustSubject) {
    const invocation = await super.authorizeCommandExecution(subject);
    const redirect = invocation ? this.redirectAfterAuthorization : undefined;
    if (redirect) {
      this.redirectAfterAuthorization = undefined;
      await redirect();
    }
    return invocation;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待 Hook alias watcher 刷新超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function exists(path: string): Promise<boolean> {
  return await access(path).then(
    () => true,
    () => false,
  );
}

import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  WorkbarTerminalAuthority,
  WorkbarTerminalError,
  type WorkbarTerminalRecord,
} from "@pico/runtime-host";
import { FileWorkbarTerminalStateStore } from "../../src/daemon/workbar-terminal-state-store.js";

test("File terminal store 让 Host 重启后把 running 资源持久化为 interrupted", async (context) => {
  const fixture = await createFixture(context, "recover");
  const store = new FileWorkbarTerminalStateStore({ picoHome: fixture.picoHome });
  const running = terminalRecord(fixture.workspace, "terminal-1", {
    status: "running",
    pid: 12_345,
    sequence: 7,
    signal: undefined,
  });
  await store.save([running]);

  const authority = new WorkbarTerminalAuthority({ store });
  await authority.recover();
  const [recovered] = await authority.list({
    workspacePath: fixture.workspace,
    sessionId: running.sessionId,
  });
  assert.ok(recovered);
  assert.equal(recovered.status, "interrupted");
  assert.equal(recovered.sequence, 1);
  assert.notEqual(recovered.resourceEpoch, running.resourceEpoch);
  assert.equal(recovered.pid, undefined);
  assert.throws(
    () =>
      authority.attach({
        resourceId: running.resourceId,
        resourceEpoch: running.resourceEpoch,
        attachmentId: "stale-view",
      }),
    (error: unknown) =>
      error instanceof WorkbarTerminalError && error.code === "resource_epoch_mismatch",
  );

  const persisted = await store.load();
  assert.equal(persisted[0]?.status, "interrupted");
  assert.equal(persisted[0]?.resourceEpoch, recovered.resourceEpoch);
});

test("File terminal store 隔离语义损坏的状态，不把原文写入诊断", async (context) => {
  const fixture = await createFixture(context, "corrupt");
  const store = new FileWorkbarTerminalStateStore({ picoHome: fixture.picoHome });
  const invalid = {
    schemaVersion: 1,
    records: [
      {
        ...terminalRecord(fixture.workspace, "terminal-corrupt"),
        cwd: fixture.picoHome,
        shell: "sensitive-shell-value",
      },
    ],
  };
  await writeFile(store.filePath, `${JSON.stringify(invalid)}\n`, { mode: 0o600 });

  assert.deepEqual(await store.load(), []);
  await assert.rejects(access(store.filePath), isMissing);
  const files = await readdir(fixture.picoHome);
  const quarantined = files.find((name) => name.startsWith("workbar-terminals.json.corrupt."));
  const diagnostic = files.find((name) => name.endsWith(".diagnostic.json"));
  assert.ok(quarantined);
  assert.ok(diagnostic);
  const diagnosticText = await readFile(join(fixture.picoHome, diagnostic), "utf8");
  assert.match(diagnosticText, /cwd escapes its workspace/u);
  assert.doesNotMatch(diagnosticText, /sensitive-shell-value/u);
  assert.deepEqual(await store.load(), []);

  await writeFile(store.filePath, '{"secret":"sensitive-malformed-value"', { mode: 0o600 });
  assert.deepEqual(await store.load(), []);
  const diagnostics = (await readdir(fixture.picoHome)).filter((name) =>
    name.endsWith(".diagnostic.json"),
  );
  assert.equal(diagnostics.length, 2);
  const allDiagnostics = (
    await Promise.all(diagnostics.map((name) => readFile(join(fixture.picoHome, name), "utf8")))
  ).join("\n");
  assert.match(allDiagnostics, /JSON is malformed/u);
  assert.doesNotMatch(allDiagnostics, /sensitive-malformed-value/u);
});

test("File terminal store 原子替换完整快照，且校验失败不覆盖旧状态", async (context) => {
  const fixture = await createFixture(context, "atomic");
  const store = new FileWorkbarTerminalStateStore({ picoHome: fixture.picoHome });
  const first = terminalRecord(fixture.workspace, "terminal-a");
  const second = terminalRecord(fixture.workspace, "terminal-b");
  await store.save([first]);
  const beforeInvalidWrite = await readFile(store.filePath, "utf8");
  await assert.rejects(
    store.save([{ ...first, cwd: fixture.picoHome }]),
    /cwd escapes its workspace/u,
  );
  assert.equal(await readFile(store.filePath, "utf8"), beforeInvalidWrite);

  const writes = Array.from({ length: 12 }, (_, index) =>
    store.save(index % 2 === 0 ? [first, second] : [first]),
  );
  const reads = Array.from({ length: 80 }, async () => {
    const parsed = JSON.parse(await readFile(store.filePath, "utf8")) as {
      schemaVersion: number;
      records: unknown[];
    };
    assert.equal(parsed.schemaVersion, 1);
    assert.ok(parsed.records.length === 1 || parsed.records.length === 2);
  });
  await Promise.all([...writes, ...reads]);

  const temporaryPrefix = `.${basename(store.filePath)}.`;
  assert.deepEqual(
    (await readdir(fixture.picoHome)).filter(
      (name) => name.startsWith(temporaryPrefix) && name.endsWith(".tmp"),
    ),
    [],
  );
  if (process.platform !== "win32") {
    assert.equal((await stat(fixture.picoHome)).mode & 0o777, 0o700);
    assert.equal((await stat(store.filePath)).mode & 0o777, 0o600);
  }
});

function terminalRecord(
  workspacePath: string,
  resourceId: string,
  overrides: Partial<WorkbarTerminalRecord> = {},
): WorkbarTerminalRecord {
  return {
    resourceId,
    resourceEpoch: `epoch-${resourceId}`,
    workspacePath,
    sessionId: "session-1",
    status: "interrupted",
    capability: "pty",
    resizeSupported: true,
    cwd: workspacePath,
    shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
    cols: 100,
    rows: 30,
    sequence: 1,
    createdAt: 1,
    updatedAt: 2,
    signal: "host_restart",
    ...overrides,
  };
}

async function createFixture(
  context: { after(callback: () => Promise<void> | void): void },
  name: string,
): Promise<{ root: string; picoHome: string; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), `pico-workbar-terminal-store-${name}-`));
  context.after(() => rm(root, { recursive: true, force: true }));
  const picoHome = join(root, "pico-home");
  const workspace = join(root, "workspace");
  await mkdir(picoHome, { recursive: true });
  await mkdir(workspace, { recursive: true });
  return {
    root: await realpath(root),
    picoHome: await realpath(picoHome),
    workspace: await realpath(workspace),
  };
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  createSandboxPolicy,
  managedProcessLauncher,
  normalizeRoots,
  type ManagedSpawnRequest,
  type SandboxProfile,
} from "../../src/safety/process-sandbox/index.js";
import { BashTool } from "../../src/tools/bash.js";
import { GrepTool, resetRgCache, setRgAvailable } from "../../src/tools/grep.js";
import { WorkspaceRoots } from "../../src/tools/workspace-roots.js";
import { McpConnectionManager } from "../../src/mcp/manager.js";

const nativeAvailable =
  process.platform === "darwin" || process.platform === "linux" || process.platform === "win32";

test(
  "native sandbox enforces workspace write, read-only, Unicode cwd and child inheritance",
  {
    skip: !nativeAvailable,
  },
  async (context) => {
    const fixture = await fixtureRoot(context, "pico-native-sandbox-");
    const unicodeDirectory = join(fixture.workspace, "子目录-🧪");
    await mkdir(unicodeDirectory);
    const output = join(unicodeDirectory, "output.txt");
    const childOutput = join(unicodeDirectory, "child.txt");
    const existingInput = join(unicodeDirectory, "existing.txt");
    await writeFile(existingInput, "existing");
    const script = [
      'const {spawnSync}=require("node:child_process");',
      'const fs=require("node:fs");',
      `if(fs.readFileSync(${JSON.stringify(existingInput)},"utf8")!=="existing")process.exit(9);`,
      `fs.writeFileSync(${JSON.stringify(output)}, "parent");`,
      `const child=spawnSync(process.execPath,["-e",${JSON.stringify(
        `require("node:fs").writeFileSync(${JSON.stringify(childOutput)},"child")`,
      )}],{stdio:"inherit"});`,
      "process.exit(child.status ?? 1);",
    ].join("");
    const writable = await runNode(fixture, "workspace-write", script, unicodeDirectory);
    assert.equal(writable.code, 0, writable.stderr);
    assert.equal(await readFile(output, "utf8"), "parent");
    assert.equal(await readFile(childOutput, "utf8"), "child");

    await rm(output);
    const readOnly = await runNode(
      fixture,
      "read-only",
      `require("node:fs").writeFileSync(${JSON.stringify(output)},"denied")`,
      unicodeDirectory,
    );
    assert.notEqual(readOnly.code, 0);
    await assert.rejects(readFile(output));
  },
);

test(
  "Windows broker isolates concurrent recovery journals",
  { skip: process.platform !== "win32" },
  async (context) => {
    const fixture = await fixtureRoot(context, "pico-native-concurrent-broker-");
    const script =
      'setTimeout(()=>{process.stdout.write(require("node:fs").readFileSync("existing.txt","utf8"))},250)';
    await writeFile(join(fixture.workspace, "existing.txt"), "ok");
    const [first, second] = await Promise.all([
      runNode(fixture, "workspace-write", script),
      runNode(fixture, "workspace-write", script),
    ]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(first.stdout, "ok");
    assert.equal(second.stdout, "ok");
  },
);

test(
  "native sandbox blocks external files and symlink escape",
  { skip: !nativeAvailable },
  async (context) => {
    const fixture = await fixtureRoot(context, "pico-native-external-");
    const secret = join(fixture.root, "host-secret.txt");
    const link = join(fixture.workspace, "outside-link.txt");
    await writeFile(secret, "host-secret");
    await symlink(secret, link, process.platform === "win32" ? "file" : undefined);
    for (const target of [secret, link]) {
      const result = await runNode(
        fixture,
        "workspace-write",
        `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(target)},"utf8"))`,
      );
      assert.notEqual(result.code, 0, `unexpectedly read ${target}`);
      assert.doesNotMatch(result.stdout, /host-secret/u);
    }
  },
);

test(
  "native sandbox hides host HOME and credential directories",
  { skip: !nativeAvailable },
  async (context) => {
    const fixture = await fixtureRoot(context, "pico-native-home-");
    const hostHome = join(fixture.root, "host-home");
    const credential = join(hostHome, ".ssh", "id_test");
    await mkdir(join(hostHome, ".ssh"), { recursive: true });
    await writeFile(credential, "credential-secret");
    const env = { ...process.env, HOME: hostHome, USERPROFILE: hostHome };
    const homeVariable = process.platform === "win32" ? "USERPROFILE" : "HOME";
    const visibleHome = await runNode(
      fixture,
      "workspace-write",
      `process.stdout.write(process.env[${JSON.stringify(homeVariable)}])`,
      fixture.workspace,
      env,
    );
    assert.equal(visibleHome.code, 0, visibleHome.stderr);
    assert.notEqual(visibleHome.stdout, hostHome);
    assert.match(visibleHome.stdout, /scratch[/\\]home/iu);
    const denied = await runNode(
      fixture,
      "workspace-write",
      `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(credential)},"utf8"))`,
      fixture.workspace,
      env,
    );
    assert.notEqual(denied.code, 0);
    assert.doesNotMatch(denied.stdout, /credential-secret/u);
  },
);

test(
  "native sandbox network follows the platform policy",
  {
    skip: !nativeAvailable,
    timeout: 30_000,
  },
  async (context) => {
    const fixture = await fixtureRoot(context, "pico-native-network-");
    const server = createServer((socket) => socket.end("ok"));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    context.after(() => server.close());
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const clientScript = `const n=require("node:net").connect(${address.port},"127.0.0.1");n.on("data",d=>process.stdout.write(d));n.on("end",()=>process.exit(0));n.on("error",()=>process.exit(23));`;
    const allowed = await runNode(fixture, "workspace-write", clientScript);
    if (process.platform === "win32") {
      assert.notEqual(allowed.code, 0, "Windows AppContainer must deny host loopback");
    } else {
      assert.equal(allowed.code, 0, allowed.stderr);
      assert.equal(allowed.stdout, "ok");
    }
    const denied = await runNode(fixture, "read-only", clientScript);
    assert.notEqual(denied.code, 0);

    const listener = await runNode(
      fixture,
      "workspace-write",
      'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write("listening");s.close()});',
    );
    if (process.platform === "win32") {
      assert.notEqual(listener.code, 0, "Windows AppContainer must deny listening sockets");
    } else {
      assert.equal(listener.code, 0, listener.stderr);
      assert.equal(listener.stdout, "listening");
    }
    const deniedListener = await runNode(
      fixture,
      "read-only",
      'const s=require("node:net").createServer();s.on("error",()=>process.exit(24));s.listen(0,"127.0.0.1",()=>process.exit(0));',
    );
    assert.notEqual(deniedListener.code, 0);
  },
);

test(
  "Windows broker replays an interrupted ACL recovery journal idempotently",
  {
    skip: process.platform !== "win32",
  },
  async (context) => {
    const fixture = await fixtureRoot(context, "pico-native-recovery-");
    const capability = "S-1-15-3-1024-1-2-3-4-5-6-7-8";
    const grant = spawnSync(
      "icacls.exe",
      [fixture.workspace, "/grant", `*${capability}:(OI)(CI)RX`, "/T", "/C"],
      { encoding: "utf8" },
    );
    assert.equal(grant.status, 0, grant.stderr);
    const journal = join(fixture.control, "stale-recovery.log");
    await writeFile(journal, `acl\t${fixture.workspace}\t${capability}\n`);
    const result = await runNode(fixture, "workspace-write", 'process.stdout.write("recovered")');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "recovered");
    await assert.rejects(readFile(journal));
    const acl = spawnSync("icacls.exe", [fixture.workspace], { encoding: "utf8" });
    assert.equal(acl.status, 0, acl.stderr);
    assert.doesNotMatch(acl.stdout, new RegExp(capability.replaceAll("-", "\\-"), "u"));
  },
);

test(
  "one-shot external process grant expires while session directory grant persists",
  {
    skip: !nativeAvailable,
  },
  async (context) => {
    const fixture = await fixtureRoot(context, "pico-native-grant-");
    const external = join(fixture.root, "external");
    await mkdir(external);
    const roots = await WorkspaceRoots.create(fixture.workspace);
    const target = join(external, "granted.txt");
    const command = nodeWriteCommand(target);
    roots.authorizeOnce(external);
    const bash = new BashTool(fixture.workspace, undefined, {
      sandbox: {
        workspaceRoots: roots,
        profile: "workspace-write",
        scratchRoot: fixture.scratch,
      },
    });
    const firstResult = await bash.execute(JSON.stringify({ command }));
    const firstContent = await readFile(target, "utf8").catch((error: unknown) => {
      throw new Error(firstResult, { cause: error });
    });
    assert.equal(firstContent, "granted");
    await rm(target);
    await assert.rejects(
      bash.execute(JSON.stringify({ command })),
      /EPERM|EACCES|denied|permitted|sandbox/iu,
    );
    await assert.rejects(readFile(target));

    const beforeGeneration = roots.generation();
    await roots.addDirectory(external);
    assert.equal(roots.generation(), beforeGeneration + 1);
    await bash.execute(JSON.stringify({ command }));
    await rm(target);
    await bash.execute(JSON.stringify({ command }));
    assert.equal(await readFile(target, "utf8"), "granted");
  },
);

test(
  "macOS grep 使用已探测的 rg 绝对路径且不依赖目标 PATH",
  {
    skip: process.platform !== "darwin" || spawnSync("rg", ["--version"]).status !== 0,
  },
  async (context) => {
    const fixture = await fixtureRoot(context, "pico-native-grep-path-");
    await writeFile(join(fixture.workspace, "needle.txt"), "absolute-rg-path\n");
    resetRgCache();
    context.after(resetRgCache);
    const grep = new GrepTool(fixture.workspace, {
      processSandbox: {
        profile: "read-only",
        scratchRoot: fixture.scratch,
        env: { LANG: "C" },
      },
    });

    const result = await grep.execute(JSON.stringify({ pattern: "absolute-rg-path" }));
    assert.match(result, /needle\.txt:1:absolute-rg-path/u);
  },
);

test(
  "grep keeps an external one-shot root for exactly one sandboxed rg process",
  { skip: !nativeAvailable },
  async (context) => {
    const fixture = await fixtureRoot(context, "pico-native-grep-grant-");
    const external = join(fixture.root, "external");
    await mkdir(external);
    await writeFile(join(external, "needle.txt"), "one-shot-grep-secret\n");
    const roots = await WorkspaceRoots.create(fixture.workspace);
    roots.authorizeOnce(external);
    setRgAvailable(true);
    const grep = new GrepTool(roots, {
      processSandbox: {
        profile: "read-only",
        scratchRoot: fixture.scratch,
      },
    });

    const first = await grep.execute(
      JSON.stringify({ pattern: "one-shot-grep-secret", path: external }),
    );
    assert.match(first, /needle\.txt:1:one-shot-grep-secret/u);
    await assert.rejects(
      grep.execute(JSON.stringify({ pattern: "one-shot-grep-secret", path: external })),
      /路径不在当前工作区/u,
    );
  },
);

test(
  "stdio MCP one-shot policy is active only for the approved call window",
  { skip: !nativeAvailable },
  async (context) => {
    const fixture = await fixtureRoot(context, "pico-native-mcp-grant-");
    const ambientFixtureName = "PICO_MCP_AMBIENT_TOKEN_FIXTURE";
    const previousAmbientFixture = process.env[ambientFixtureName];
    process.env[ambientFixtureName] = "ambient-must-not-forward";
    context.after(() => {
      if (previousAmbientFixture === undefined) delete process.env[ambientFixtureName];
      else process.env[ambientFixtureName] = previousAmbientFixture;
    });
    const externalDirectory = join(fixture.root, "external");
    const external = join(externalDirectory, "secret.txt");
    const serverScript = join(fixture.workspace, "fixture-mcp.cjs");
    await mkdir(externalDirectory);
    await writeFile(external, "one-shot-secret");
    await writeFile(
      serverScript,
      [
        'const fs=require("node:fs");',
        'const rl=require("node:readline").createInterface({input:process.stdin});',
        'const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",id,result})+"\\n");',
        'rl.on("line",line=>{const message=JSON.parse(line);if(message.id===undefined)return;',
        'if(message.method==="initialize")return send(message.id,{protocolVersion:"2024-11-05",capabilities:{},serverInfo:{name:"fixture",version:"1"}});',
        'if(message.method==="tools/list")return send(message.id,{tools:[{name:"read_external",description:"fixture",inputSchema:{type:"object"}}]});',
        'if(message.method==="tools/call"){let text;if(message.params.arguments.path==="__environment_fixture__"){text=(process.env.PICO_MCP_EXPLICIT_FIXTURE??"missing")+":"+(process.env.PICO_MCP_AMBIENT_TOKEN_FIXTURE===undefined?"ambient-absent":"ambient-present")}else{try{text=fs.readFileSync(message.params.arguments.path,"utf8")}catch{text="denied"}}return send(message.id,{content:[{type:"text",text}],isError:false})}',
        "send(message.id,{})});",
      ].join(""),
    );
    const baseline = createSandboxPolicy({
      profile: "workspace-write",
      workspaceRoots: [fixture.workspace],
      scratchRoot: fixture.scratch,
    });
    const manager = new McpConnectionManager(undefined, {
      stdioCwd: fixture.workspace,
      processSandbox: baseline,
    });
    context.after(() => manager.closeAll());
    await manager.replaceSources([
      {
        id: "test",
        config: {
          mcpServers: {
            local: {
              name: "local",
              transport: "stdio",
              command: process.execPath,
              args: [serverScript],
              env: { PICO_MCP_EXPLICIT_FIXTURE: "explicit-forwarded" },
            },
          },
        },
      },
    ]);
    await manager.connectAll();
    assert.equal(
      await readExternalViaMcp(manager, "__environment_fixture__"),
      "explicit-forwarded:ambient-absent",
    );
    assert.equal(await readExternalViaMcp(manager, external), "denied");

    await manager.restartStdioServerForTool("mcp__local__read_external", {
      ...baseline,
      readRoots: normalizeRoots([...baseline.readRoots, externalDirectory]),
    });
    assert.equal(await readExternalViaMcp(manager, external), "one-shot-secret");

    await manager.restartStdioServerForTool("mcp__local__read_external");
    assert.equal(await readExternalViaMcp(manager, external), "denied");
  },
);

interface Fixture {
  root: string;
  workspace: string;
  scratch: string;
  control: string;
}

async function fixtureRoot(
  context: { after(callback: () => unknown): void },
  prefix: string,
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const workspace = join(root, "workspace");
  const scratch = join(root, "scratch");
  const control = join(root, "control");
  await mkdir(workspace);
  await mkdir(control);
  context.after(() => rm(root, { recursive: true, force: true }));
  return { root, workspace, scratch, control };
}

async function runNode(
  fixture: Fixture,
  profile: SandboxProfile,
  script: string,
  cwd = fixture.workspace,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const policy = createSandboxPolicy({
    profile,
    workspaceRoots: [fixture.workspace],
    scratchRoot: fixture.scratch,
    config: { network: "allow" },
  });
  const request: ManagedSpawnRequest = {
    command: process.execPath,
    args: ["-e", script],
    cwd,
    env,
    origin: "bash",
    policy,
    controlRoot: fixture.control,
  };
  const managed = managedProcessLauncher.launch(request, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  managed.child.stdout?.setEncoding("utf8");
  managed.child.stderr?.setEncoding("utf8");
  managed.child.stdout?.on("data", (chunk: string) => (stdout += chunk));
  managed.child.stderr?.on("data", (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    managed.child.once("error", reject);
    managed.child.once("close", resolve);
  });
  await managed.lease.release();
  return { code, stdout, stderr };
}

function nodeWriteCommand(target: string): string {
  const script = `require("node:fs").writeFileSync(${JSON.stringify(target)},"granted")`;
  return process.platform === "win32"
    ? `& node -e ${powerShellQuote(script)}`
    : `node -e ${posixQuote(script)}`;
}

async function readExternalViaMcp(manager: McpConnectionManager, path: string): Promise<string> {
  const result = await manager.invokeConnectedTool("local", "read_external", { path });
  const block = result.content[0];
  assert.ok(block && block.type === "text");
  const text = block.text;
  if (typeof text !== "string") throw new Error("MCP fixture returned non-text content");
  return text;
}

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function powerShellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

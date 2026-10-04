import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  ensureGatewayHome,
  readPrivateJson,
  writePrivateJson,
} from "../../../packages/remote-gateway/src/state.js";

const execFileAsync = promisify(execFile);

test(
  "Windows remote state persists with private ACLs when inherited PowerShell modules are incompatible",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-remote-state-acl-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const modules = join(root, "modules");
    const securityModule = join(modules, "Microsoft.PowerShell.Security");
    await mkdir(securityModule, { recursive: true });
    await writeFile(
      join(securityModule, "Microsoft.PowerShell.Security.psd1"),
      "@{ RootModule='security.psm1'; ModuleVersion='99.0.0'; PowerShellVersion='7.0'; FunctionsToExport=@('Set-Acl','Get-Acl') }",
    );
    await writeFile(
      join(securityModule, "security.psm1"),
      "function Set-Acl { throw 'INCOMPATIBLE_SECURITY_MODULE' }; function Get-Acl { throw 'INCOMPATIBLE_SECURITY_MODULE' }",
    );
    const previousModulePath = process.env.PSModulePath;
    process.env.PSModulePath = modules;
    t.after(() => {
      if (previousModulePath === undefined) delete process.env.PSModulePath;
      else process.env.PSModulePath = previousModulePath;
    });

    const home = await ensureGatewayHome(join(root, "home 'quoted' 中文"));
    const path = join(home, "state.json");
    const value = { version: 1, value: "中文🙂" };
    await writePrivateJson(path, value);
    assert.deepEqual(await readPrivateJson(path), value);
    await ensureGatewayHome(home);
    await assertPrivateWindowsAcl(home, true);
    await assertPrivateWindowsAcl(path, false);
    assert.deepEqual(await readdir(home), ["state.json"]);
  },
);

test("remote state rejects linked directories and hard-linked files before touching their targets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-remote-state-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = join(root, "outside");
  await mkdir(outside);
  const original = join(outside, "original.json");
  const contents = '{"value":"unchanged"}\n';
  await writeFile(original, contents);
  const directoryLink = join(root, "directory-link");
  await symlink(outside, directoryLink, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(ensureGatewayHome(directoryLink), /拒绝符号链接或无效文件类型/u);
  const fileLink = join(root, "hard-link.json");
  await link(original, fileLink);
  await assert.rejects(readPrivateJson(fileLink), /拒绝符号链接或无效文件类型/u);
  await assert.rejects(
    writePrivateJson(fileLink, { value: "changed" }),
    /拒绝符号链接或无效文件类型/u,
  );
  assert.equal(await readFile(original, "utf8"), contents);
  assert.deepEqual((await readdir(root)).sort(), ["directory-link", "hard-link.json", "outside"]);
});

async function assertPrivateWindowsAcl(path: string, directory: boolean): Promise<void> {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  assert.ok(systemRoot, "Windows system directory is required");
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = String.raw`
$ErrorActionPreference='Stop'
$Target=$env:PICO_TEST_ACL_TARGET
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($env:PICO_TEST_ACL_KIND -eq 'directory') {
  $security=[IO.Directory]::GetAccessControl($Target)
} else {
  $security=[IO.File]::GetAccessControl($Target)
}
$rules=$security.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
[Console]::WriteLine($sid)
[Console]::WriteLine($security.GetOwner([Security.Principal.SecurityIdentifier]).Value)
[Console]::WriteLine($security.AreAccessRulesProtected)
[Console]::WriteLine($rules.Count)
foreach ($rule in $rules) {
  [Console]::WriteLine($rule.IdentityReference.Value)
  [Console]::WriteLine($rule.AccessControlType)
  [Console]::WriteLine([int]$rule.FileSystemRights)
  [Console]::WriteLine($rule.IsInherited)
  [Console]::WriteLine([int]$rule.InheritanceFlags)
}`;
  const execution = execFileAsync(
    powershell,
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      env: {
        ...process.env,
        PICO_TEST_ACL_TARGET: path,
        PICO_TEST_ACL_KIND: directory ? "directory" : "file",
      },
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    },
  );
  execution.child.stdin?.end();
  const { stdout } = await execution;
  const [currentSid, ...actual] = stdout.trim().split(/\r?\n/u);
  assert.ok(currentSid?.startsWith("S-1-"));
  assert.deepEqual(actual, [
    currentSid,
    "True",
    "1",
    currentSid,
    "Allow",
    "2032127",
    "False",
    directory ? "3" : "0",
  ]);
}

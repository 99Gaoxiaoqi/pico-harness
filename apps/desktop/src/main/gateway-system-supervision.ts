import { execFile } from "node:child_process";
import { access, chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  ensureGatewaySupervisionDirectory,
  type ActiveGatewayRuntime,
} from "@pico/remote-gateway/desktop";

const LABEL = "com.pico.harness.remote-gateway";
export type SupervisionBackend = "launchd" | "task-scheduler" | "none";
export interface GatewaySystemSupervisor {
  readonly backend: SupervisionBackend;
  register(runtime: ActiveGatewayRuntime): Promise<void>;
  enable(): Promise<void>;
  disable(): Promise<void>;
  unregister(): Promise<void>;
  registered(): Promise<boolean>;
  launch(): Promise<void>;
}
export interface SystemSupervisionOptions {
  readonly home: string;
  readonly packaged: boolean;
  readonly platform?: NodeJS.Platform;
  readonly userHome?: string;
  readonly uid?: number;
  readonly run?: (file: string, args: readonly string[]) => Promise<string>;
}
const xml = (value: string) =>
  value.replace(
    /[<>&"']/gu,
    (character) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character]!,
  );
const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
export function macGatewayLauncher(home: string): string {
  return `#!/bin/sh
set -eu
home=${shellQuote(home)}
manifest="$home/active-runtime.json"
executable=$(/usr/bin/plutil -extract executablePath raw -o - "$manifest") || exit 1
gateway=$(/usr/bin/plutil -extract gatewayPath raw -o - "$manifest") || exit 1
[ -f "$executable" ] || exit 1
supervisor="$(/usr/bin/dirname "$gateway")/gateway-supervisor.cjs"
[ -f "$supervisor" ] || exit 1
exec /usr/bin/env -i HOME="$HOME" USER="\${USER-}" LOGNAME="\${LOGNAME-}" TMPDIR="\${TMPDIR-/tmp}" PATH="/usr/bin:/bin:/usr/sbin:/sbin" ELECTRON_RUN_AS_NODE=1 "$executable" "$supervisor" --home "$home"
`;
}
export function windowsGatewayLauncher(): string {
  return String.raw`param([Parameter(Mandatory=$true)][string]$Home)
$ErrorActionPreference='Stop'
$manifest=Get-Content -LiteralPath (Join-Path $Home 'active-runtime.json') -Raw | ConvertFrom-Json
$supervisor=Join-Path ([IO.Path]::GetDirectoryName($manifest.gatewayPath)) 'gateway-supervisor.cjs'
if (-not [IO.File]::Exists($manifest.executablePath) -or -not [IO.File]::Exists($supervisor)) { exit 1 }
$start=[Diagnostics.ProcessStartInfo]::new()
$start.FileName=$manifest.executablePath
$start.UseShellExecute=$false
$start.CreateNoWindow=$true
$start.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
# Windows argument quoting doubles trailing backslashes before the closing quote.
function Quote-Argument([string]$Value) { return '"' + [regex]::Replace([regex]::Replace($Value,'(\\*)"','$1$1\\"'),'(\\+)$','$1$1') + '"' }
$start.Arguments=(Quote-Argument $supervisor)+' --home '+(Quote-Argument $Home)
$start.EnvironmentVariables.Clear()
foreach ($name in @('SystemRoot','WINDIR','USERPROFILE','APPDATA','LOCALAPPDATA','PROGRAMDATA','TEMP','TMP','COMSPEC','HOME','USER','LANG')) {
  $value=[Environment]::GetEnvironmentVariable($name)
  if ($value) { $start.EnvironmentVariables[$name]=$value }
}
$start.EnvironmentVariables['PATH']=$env:SystemRoot+'\\System32;'+$env:SystemRoot
$start.EnvironmentVariables['ELECTRON_RUN_AS_NODE']='1'
$child=[Diagnostics.Process]::Start($start)
$child.WaitForExit()
exit $child.ExitCode
`;
}
export function macGatewayLaunchAgent(launcher: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array><string>/bin/sh</string><string>${xml(launcher)}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>15</integer><key>ProcessType</key><string>Background</string></dict></plist>\n`;
}
export function windowsGatewayTask(
  sid: string,
  powershell: string,
  launcher: string,
  home: string,
): string {
  if (!/^S-1-[0-9-]+$/u.test(sid)) throw new Error("GATEWAY_USER_SID_INVALID");
  const args = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${launcher}" -Home "${home}"`;
  return `<?xml version="1.0" encoding="UTF-16"?><Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>Pico user-session remote gateway</Description></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${sid}</UserId></LogonTrigger><TimeTrigger><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>2020-01-01T00:00:00</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers><Principals><Principal id="User"><UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Enabled>true</Enabled></Settings><Actions Context="User"><Exec><Command>${xml(powershell)}</Command><Arguments>${xml(args)}</Arguments></Exec></Actions></Task>`;
}
async function atomicResource(
  path: string,
  content: string | Buffer,
  executable = false,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: executable ? 0o700 : 0o600, flag: "wx" });
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  if (process.platform !== "win32") await chmod(path, executable ? 0o700 : 0o600);
}
export function createGatewaySystemSupervisor(
  options: SystemSupervisionOptions,
): GatewaySystemSupervisor {
  const platform = options.platform ?? process.platform;
  if (!options.packaged || (platform !== "darwin" && platform !== "win32")) {
    return {
      backend: "none",
      register: async () => undefined,
      enable: async () => undefined,
      disable: async () => undefined,
      unregister: async () => undefined,
      registered: async () => false,
      launch: async () => undefined,
    };
  }
  const run =
    options.run ??
    (async (file, args) =>
      (await promisify(execFile)(file, [...args], { windowsHide: true, timeout: 15_000 })).stdout);
  const resources = join(options.home, "supervision");
  const launcher = join(
    resources,
    platform === "darwin" ? "gateway-launcher.sh" : "gateway-launcher.ps1",
  );
  const service = `gui/${options.uid ?? process.getuid?.()}/${LABEL}`;
  const plist = join(options.userHome ?? homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  const taskFile = join(resources, "gateway-task.xml");
  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  let taskName: string | undefined;
  const getTask = async () => {
    if (!taskName) {
      const sid = (
        await run(powershell, [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
        ])
      ).trim();
      if (!/^S-1-[0-9-]+$/u.test(sid)) throw new Error("GATEWAY_USER_SID_INVALID");
      taskName = `${LABEL}-${sid}`;
    }
    return taskName;
  };
  const registered = async () => {
    try {
      if (platform === "darwin") await run("/bin/launchctl", ["print", service]);
      else await run("schtasks.exe", ["/Query", "/TN", await getTask()]);
      return true;
    } catch {
      return false;
    }
  };
  return {
    backend: platform === "darwin" ? "launchd" : "task-scheduler",
    registered,
    async register(runtime) {
      await Promise.all([
        access(runtime.executablePath),
        access(runtime.gatewayPath),
        access(join(dirname(runtime.gatewayPath), "gateway-supervisor.cjs")),
      ]);
      await ensureGatewaySupervisionDirectory(options.home);
      if (platform === "darwin") {
        await atomicResource(launcher, macGatewayLauncher(options.home), true);
        await mkdir(dirname(plist), { recursive: true, mode: 0o700 });
        await atomicResource(plist, macGatewayLaunchAgent(launcher));
        await run("/bin/launchctl", ["enable", service]);
        if (!(await registered()))
          await run("/bin/launchctl", [
            "bootstrap",
            service.slice(0, service.lastIndexOf("/")),
            plist,
          ]);
      } else {
        const name = await getTask();
        const sid = name.slice(LABEL.length + 1);
        await atomicResource(launcher, windowsGatewayLauncher());
        await atomicResource(
          taskFile,
          Buffer.from(
            `\uFEFF${windowsGatewayTask(sid, powershell, launcher, options.home)}`,
            "utf16le",
          ),
        );
        await run("schtasks.exe", ["/Create", "/TN", name, "/XML", taskFile, "/F"]);
      }
    },
    async enable() {
      if (platform === "darwin") await run("/bin/launchctl", ["enable", service]);
      else await run("schtasks.exe", ["/Change", "/TN", await getTask(), "/ENABLE"]);
    },
    async disable() {
      if (!(await registered())) return;
      if (platform === "darwin") await run("/bin/launchctl", ["disable", service]);
      else await run("schtasks.exe", ["/Change", "/TN", await getTask(), "/DISABLE"]);
    },
    async unregister() {
      if (await registered()) {
        if (platform === "darwin") await run("/bin/launchctl", ["bootout", service]);
        else await run("schtasks.exe", ["/Delete", "/TN", await getTask(), "/F"]);
      }
      if (platform === "darwin") await rm(plist, { force: true });
      await rm(resources, { recursive: true, force: true });
    },
    async launch() {
      if (platform === "darwin") await run("/bin/launchctl", ["kickstart", service]);
      else await run("schtasks.exe", ["/Run", "/TN", await getTask()]);
    },
  };
}

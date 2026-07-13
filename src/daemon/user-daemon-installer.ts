import { execFile } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface UserDaemonInstallInput {
  serviceName: string;
  executable: string;
  args: readonly string[];
  environment?: Readonly<Record<string, string>>;
}

export interface GeneratedDaemonSpec {
  platform: NodeJS.Platform;
  filePath?: string;
  content?: string;
  commands: readonly { command: string; args: readonly string[] }[];
}

export interface UserDaemonInstaller {
  readonly platform: NodeJS.Platform;
  generate(input: UserDaemonInstallInput): GeneratedDaemonSpec;
  install?(input: UserDaemonInstallInput): Promise<GeneratedDaemonSpec>;
}

/** macOS implementation writes a per-user LaunchAgent and atomically replaces an older service. */
export class LaunchdUserDaemonInstaller implements UserDaemonInstaller {
  readonly platform = "darwin" as const;

  generate(input: UserDaemonInstallInput): GeneratedDaemonSpec {
    assertServiceName(input.serviceName);
    const filePath = join(homedir(), "Library", "LaunchAgents", `${input.serviceName}.plist`);
    return {
      platform: this.platform,
      filePath,
      content: renderLaunchdPlist(input),
      commands: [
        { command: "launchctl", args: ["bootout", `gui/${process.getuid?.() ?? 0}`, input.serviceName] },
        {
          command: "launchctl",
          args: ["bootstrap", `gui/${process.getuid?.() ?? 0}`, filePath],
        },
      ],
    };
  }

  async install(input: UserDaemonInstallInput): Promise<GeneratedDaemonSpec> {
    const spec = this.generate(input);
    if (!spec.filePath || !spec.content) throw new Error("launchd spec 不完整");
    await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true, mode: 0o700 });
    await execFileAsync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}`, input.serviceName]).catch(
      () => undefined,
    );
    await writeFile(spec.filePath, spec.content, { encoding: "utf8", mode: 0o600 });
    await chmod(spec.filePath, 0o600);
    await execFileAsync("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 0}`, spec.filePath]);
    return spec;
  }
}

/** Command-only adapter; actual installation remains a future Linux platform integration. */
export class SystemdUserDaemonInstaller implements UserDaemonInstaller {
  readonly platform = "linux" as const;

  generate(input: UserDaemonInstallInput): GeneratedDaemonSpec {
    assertServiceName(input.serviceName);
    const filePath = join(homedir(), ".config", "systemd", "user", `${input.serviceName}.service`);
    return {
      platform: this.platform,
      filePath,
      content: [
        "[Unit]",
        `Description=${input.serviceName}`,
        "[Service]",
        `ExecStart=${[input.executable, ...input.args].map(systemdEscape).join(" ")}`,
        "Restart=on-failure",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n"),
      commands: [
        { command: "systemctl", args: ["--user", "daemon-reload"] },
        { command: "systemctl", args: ["--user", "enable", "--now", `${input.serviceName}.service`] },
      ],
    };
  }
}

/** Command-only adapter; actual installation remains a future Windows platform integration. */
export class WindowsTaskSchedulerInstaller implements UserDaemonInstaller {
  readonly platform = "win32" as const;

  generate(input: UserDaemonInstallInput): GeneratedDaemonSpec {
    assertServiceName(input.serviceName);
    return {
      platform: this.platform,
      commands: [
        {
          command: "schtasks",
          args: [
            "/Create",
            "/TN",
            input.serviceName,
            "/SC",
            "ONLOGON",
            "/TR",
            quoteWindows([input.executable, ...input.args]),
            "/F",
          ],
        },
      ],
    };
  }
}

export function createUserDaemonInstaller(target = platform()): UserDaemonInstaller {
  if (target === "darwin") return new LaunchdUserDaemonInstaller();
  if (target === "linux") return new SystemdUserDaemonInstaller();
  if (target === "win32") return new WindowsTaskSchedulerInstaller();
  throw new Error(`暂不支持 ${target} 的用户级 daemon 安装`);
}

function renderLaunchdPlist(input: UserDaemonInstallInput): string {
  const environment = input.environment
    ? [
        "  <key>EnvironmentVariables</key>",
        "  <dict>",
        ...Object.entries(input.environment).flatMap(([key, value]) => [
          `    <key>${xmlEscape(key)}</key>`,
          `    <string>${xmlEscape(value)}</string>`,
        ]),
        "  </dict>",
      ]
    : [];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${xmlEscape(input.serviceName)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...[input.executable, ...input.args].map((arg) => `    <string>${xmlEscape(arg)}</string>`),
    "  </array>",
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><true/>",
    ...environment,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function assertServiceName(serviceName: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(serviceName)) throw new Error("serviceName 只能包含字母、数字、点、下划线和连字符");
}

function xmlEscape(value: string): string {
  return value.replace(/[<>&'"]/g, (character) => {
    const entities: Record<string, string> = {
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      "'": "&apos;",
      '"': "&quot;",
    };
    return entities[character] ?? character;
  });
}

function systemdEscape(value: string): string {
  return value.includes(" ") ? JSON.stringify(value) : value;
}

function quoteWindows(args: readonly string[]): string {
  return args.map((arg) => `"${arg.replaceAll('"', '\\"')}"`).join(" ");
}

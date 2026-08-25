import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSandboxEnvironment, runtimeReadRoots } from "./environment.js";
import { isWithinRoot, normalizeRoots } from "./policy.js";
import {
  SandboxViolationError,
  type ManagedSpawnRequest,
  type SandboxBackend,
  type SandboxPolicy,
  type SandboxSpawnPlan,
} from "./types.js";

export function buildManagedSpawnPlan(request: ManagedSpawnRequest): SandboxSpawnPlan {
  const platform = request.platform ?? process.platform;
  const env = buildSandboxEnvironment(request.env ?? process.env, request.policy, platform);
  if (request.policy.profile === "danger-full-access") {
    return {
      backend: "none",
      command: request.command,
      args: [...request.args],
      env,
      sandboxed: false,
      profile: request.policy.profile,
    };
  }

  const policy = withRuntimeRoots(request.policy, request.command, env, platform);
  const backend = detectSandboxBackend(platform, request.arch ?? process.arch, request.backendExecutable);
  if (backend === "unavailable") {
    throw new SandboxViolationError(
      "sandbox_unavailable",
      `当前 ${platform}/${request.arch ?? process.arch} 宿主没有可用的 OS 沙箱后端，已拒绝 ${request.origin}。`,
    );
  }

  switch (backend) {
    case "macos-seatbelt":
      return {
        backend,
        command: request.backendExecutable ?? "/usr/bin/sandbox-exec",
        args: ["-p", buildMacosProfile(policy), request.command, ...request.args],
        env,
        sandboxed: true,
        profile: policy.profile,
      };
    case "linux-bubblewrap":
      return {
        backend,
        command:
          request.backendExecutable ?? resolveBundledSandboxExecutable(platform, request.arch),
        args: buildBubblewrapArgs(policy, request.command, request.args, request.cwd),
        env,
        sandboxed: true,
        profile: policy.profile,
      };
    case "windows-appcontainer":
      return {
        backend,
        command:
          request.backendExecutable ?? resolveBundledSandboxExecutable(platform, request.arch),
        args: ["--profile", policy.profile, "--cwd", request.cwd, "--", request.command, ...request.args],
        env,
        sandboxed: true,
        profile: policy.profile,
      };
    default:
      throw new SandboxViolationError("policy_compilation_failed", `无法编译后端 ${backend}`);
  }
}

export function detectSandboxBackend(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
  overrideExecutable?: string,
): SandboxBackend {
  if (overrideExecutable) {
    if (!existsSync(overrideExecutable)) return "unavailable";
    return platform === "darwin"
      ? "macos-seatbelt"
      : platform === "linux"
        ? "linux-bubblewrap"
        : platform === "win32"
          ? "windows-appcontainer"
          : "unavailable";
  }
  if (platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) return "macos-seatbelt";
  if (
    (platform === "linux" || platform === "win32") &&
    isVerifiedBundledExecutable(resolveBundledSandboxExecutable(platform, arch))
  ) {
    return platform === "linux" ? "linux-bubblewrap" : "windows-appcontainer";
  }
  return "unavailable";
}

export function isVerifiedBundledExecutable(executable: string): boolean {
  if (!existsSync(executable) || !existsSync(`${executable}.sha256`)) return false;
  try {
    const expected = readFileSync(`${executable}.sha256`, "utf8").trim().split(/\s+/u)[0];
    if (!expected || !/^[a-f0-9]{64}$/u.test(expected)) return false;
    const actual = createHash("sha256").update(readFileSync(executable)).digest("hex");
    return actual === expected;
  } catch {
    return false;
  }
}

export function buildMacosProfile(policy: SandboxPolicy): string {
  const rules = [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    "(allow process-exec)",
    "(allow process-info* (target same-sandbox))",
    "(allow signal (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow ipc-posix-sem)",
    "(allow user-preference-read)",
    '(allow mach-lookup (global-name "com.apple.cfprefsd.agent") (global-name "com.apple.cfprefsd.daemon") (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.bsd.dirhelper") (global-name "com.apple.PowerManagement.control"))',
    '(allow system-mac-syscall (mac-policy-name "vnguard"))',
    '(allow system-mac-syscall (require-all (mac-policy-name "Sandbox") (mac-syscall-number 67)))',
    '(allow file-read* file-test-existence (literal "/"))',
    '(allow file-read-metadata file-test-existence (literal "/etc") (literal "/tmp") (literal "/var") (literal "/System/Volumes") (literal "/System/Volumes/Data"))',
    '(allow file-read-metadata (subpath "/var") (subpath "/private/var"))',
    '(allow file-read* file-test-existence (literal "/dev/null") (literal "/dev/tty") (literal "/dev/random") (literal "/dev/urandom"))',
    '(allow file-read* file-write* (regex #"^/dev/fd/(0|1|2)$"))',
    '(allow file-read* file-write* (literal "/dev/null") (literal "/dev/tty"))',
    '(allow file-read-metadata (literal "/dev") (regex #"^/dev/.*$"))',
    ...policy.readRoots.map(
      (root) => `(allow file-read* file-test-existence (subpath ${sbplString(root)}))`,
    ),
    ...policy.readRoots.map(
      (root) => `(allow file-map-executable (subpath ${sbplString(root)}))`,
    ),
    ...policy.writeRoots.map((root) => `(allow file-write* (subpath ${sbplString(root)}))`),
  ];
  if (policy.network === "allow") rules.push("(allow network*)");
  return rules.join("\n");
}

export function buildBubblewrapArgs(
  policy: SandboxPolicy,
  command: string,
  args: readonly string[],
  cwd: string,
): string[] {
  const writeRoots = normalizeRoots(policy.writeRoots);
  const readRoots = normalizeRoots(policy.readRoots).filter(
    (root) => !writeRoots.some((writable) => isWithinRoot(writable, root)),
  );
  const result = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    ...(policy.network === "allow" ? ["--share-net"] : []),
    "--disable-userns",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
  ];
  for (const root of readRoots) result.push("--ro-bind-try", root, root);
  for (const root of writeRoots) result.push("--bind", root, root);
  result.push("--chdir", cwd, "--", command, ...args);
  return result;
}

export function resolveBundledSandboxExecutable(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const executable = platform === "win32" ? "pico-appcontainer-broker.exe" : "bwrap";
  const resourceDirectory = `sandbox/${platform}-${arch}`;
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    ...(resourcesPath ? [resolve(resourcesPath, resourceDirectory, executable)] : []),
    resolve(moduleDirectory, "../../../resources", resourceDirectory, executable),
    resolve(moduleDirectory, "../../../../resources", resourceDirectory, executable),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function withRuntimeRoots(
  policy: SandboxPolicy,
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): SandboxPolicy {
  return {
    ...policy,
    readRoots: normalizeRoots([...policy.readRoots, ...runtimeReadRoots(command, env, platform)]),
  };
}

function sbplString(value: string): string {
  return JSON.stringify(value);
}

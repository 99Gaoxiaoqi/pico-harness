import { spawn } from "node:child_process";
import type { ModelRoute } from "./model-router.js";

const CREDENTIAL_REF_PREFIX = "pico-keychain://model-route/";
const KEYCHAIN_SERVICE = "dev.pico.runtime.provider";

declare const credentialRefBrand: unique symbol;

/** Opaque, non-secret identifier that may safely be persisted in runtime.sqlite. */
export type CredentialRef = string & { readonly [credentialRefBrand]: true };

export interface CredentialVaultCapability {
  available: boolean;
  backend: "macos-keychain" | "unavailable";
  diagnostic: string;
}

export interface CredentialResolver {
  resolve(ref: CredentialRef): Promise<string>;
}

export interface CredentialVault extends CredentialResolver {
  capability(): CredentialVaultCapability;
  put(ref: CredentialRef, secret: string): Promise<void>;
  has(ref: CredentialRef): Promise<boolean>;
}

export class CredentialVaultUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialVaultUnavailableError";
  }
}

export class CredentialNotFoundError extends Error {
  constructor(ref: CredentialRef) {
    super(`系统凭证库中不存在 ${ref}。请先在 TUI 执行 /cron credential import。`);
    this.name = "CredentialNotFoundError";
  }
}

export function credentialRefForModelRoute(routeId: string): CredentialRef {
  const normalized = routeId.trim();
  if (!/^[^/\s]+\/.+$/u.test(normalized)) {
    throw new Error("credentialRef 只接受 providerID/modelID 路由");
  }
  return `${CREDENTIAL_REF_PREFIX}${encodeURIComponent(normalized)}` as CredentialRef;
}

export function parseCredentialRef(ref: string): { ref: CredentialRef; modelRouteId: string } {
  if (!ref.startsWith(CREDENTIAL_REF_PREFIX)) throw new Error("不支持的 credentialRef");
  const encoded = ref.slice(CREDENTIAL_REF_PREFIX.length);
  let modelRouteId: string;
  try {
    modelRouteId = decodeURIComponent(encoded);
  } catch {
    throw new Error("credentialRef 编码无效");
  }
  if (!/^[^/\s]+\/.+$/u.test(modelRouteId)) throw new Error("credentialRef 路由无效");
  return { ref: ref as CredentialRef, modelRouteId };
}

export async function importModelRouteCredential(input: {
  route: ModelRoute;
  vault: CredentialVault;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<CredentialRef> {
  if (input.route.source === "legacy") {
    throw new Error(
      "持久 Cron 不支持仅由 shell 环境提供的 legacy 路由；请先在 .pico/config.json 配置 provider。",
    );
  }
  const raw = (input.env ?? process.env)[input.route.apiKeyEnv]?.trim();
  const secret = raw?.split(",").map((value) => value.trim()).find(Boolean);
  if (!secret) throw new Error(`缺少凭证环境变量 ${input.route.apiKeyEnv}，无法导入。`);
  const ref = credentialRefForModelRoute(input.route.id);
  await input.vault.put(ref, secret);
  return ref;
}

export function createPlatformCredentialVault(
  platform: NodeJS.Platform = process.platform,
): CredentialVault {
  if (platform === "darwin") return new MacOsKeychainCredentialVault();
  return new UnavailableCredentialVault(
    `${platform} 尚未提供经过验证的系统凭证库适配；后台 Provider 凭证已按 fail-closed 禁用。`,
  );
}

interface SecurityCommandRunner {
  run(args: readonly string[], stdin?: string): Promise<string>;
}

export class MacOsKeychainCredentialVault implements CredentialVault {
  constructor(private readonly runner: SecurityCommandRunner = new MacSecurityCommandRunner()) {}

  capability(): CredentialVaultCapability {
    return {
      available: true,
      backend: "macos-keychain",
      diagnostic: "Provider 凭证由当前 macOS 用户的 Login Keychain 保存。",
    };
  }

  async put(ref: CredentialRef, secret: string): Promise<void> {
    parseCredentialRef(ref);
    if (!secret.trim() || /[\r\n]/u.test(secret)) {
      throw new Error("拒绝保存空白或包含换行的 Provider 凭证");
    }
    // `-w` intentionally remains last: security then reads the password from stdin,
    // keeping the secret out of argv, process listings, transcripts and shell history.
    await this.runner.run(
      ["add-generic-password", "-U", "-a", ref, "-s", KEYCHAIN_SERVICE, "-w"],
      `${secret}\n${secret}\n`,
    );
  }

  async resolve(ref: CredentialRef): Promise<string> {
    parseCredentialRef(ref);
    try {
      const secret = await this.runner.run([
        "find-generic-password",
        "-a",
        ref,
        "-s",
        KEYCHAIN_SERVICE,
        "-w",
      ]);
      const normalized = secret.replace(/\r?\n$/u, "");
      if (!normalized) throw new CredentialNotFoundError(ref);
      return normalized;
    } catch (error) {
      if (error instanceof CredentialNotFoundError) throw error;
      throw new CredentialNotFoundError(ref);
    }
  }

  async has(ref: CredentialRef): Promise<boolean> {
    try {
      await this.resolve(ref);
      return true;
    } catch (error) {
      if (error instanceof CredentialNotFoundError) return false;
      throw error;
    }
  }
}

class UnavailableCredentialVault implements CredentialVault {
  constructor(private readonly diagnostic: string) {}

  capability(): CredentialVaultCapability {
    return { available: false, backend: "unavailable", diagnostic: this.diagnostic };
  }

  async put(): Promise<void> {
    throw new CredentialVaultUnavailableError(this.diagnostic);
  }

  async resolve(): Promise<string> {
    throw new CredentialVaultUnavailableError(this.diagnostic);
  }

  async has(): Promise<boolean> {
    return false;
  }
}

class MacSecurityCommandRunner implements SecurityCommandRunner {
  run(args: readonly string[], stdin?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn("/usr/bin/security", args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (!child.stdin || !child.stdout || !child.stderr) {
        reject(new Error("无法连接 macOS Keychain 命令的标准流"));
        child.kill();
        return;
      }
      const childStdin = child.stdin;
      const childStdout = child.stdout;
      const childStderr = child.stderr;
      let stdout = "";
      let stderr = "";
      childStdout.setEncoding("utf8");
      childStderr.setEncoding("utf8");
      childStdout.on("data", (chunk: string) => (stdout += chunk));
      childStderr.on("data", (chunk: string) => (stderr += chunk));
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`macOS Keychain 命令失败（exit ${code ?? "unknown"}）：${stderr.trim()}`));
      });
      childStdin.end(stdin);
    });
  }
}

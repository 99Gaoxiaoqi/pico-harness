import { spawn } from "node:child_process";
import {
  credentialRefForProvider,
  parseProviderCredentialRef,
  type CredentialRef,
  type ProviderCredentialIdentity,
} from "@pico/core/provider-identity";

/** @deprecated Credential identity is a Core contract. */
export {
  assertCredentialRefMatchesProvider,
  createProviderCredentialRef,
  credentialRefForProvider,
  normalizeProviderEndpoint,
  parseProviderCredentialRef,
  type CredentialRef,
  type ParsedProviderCredentialRef,
  type ProviderCredentialIdentity,
} from "@pico/core/provider-identity";

const KEYCHAIN_SERVICE = "dev.pico.runtime.provider";

export interface CredentialVaultCapability {
  available: boolean;
  backend: "macos-keychain" | "unavailable";
  diagnostic: string;
  /** Metadata lookup/deletion remains available; never permits storing or resolving plaintext. */
  cleanupAvailable?: boolean;
}

export interface CredentialResolver {
  resolve(ref: CredentialRef): Promise<string>;
}

export interface CredentialVault extends CredentialResolver {
  capability(): CredentialVaultCapability;
  put(ref: CredentialRef, secret: string): Promise<void>;
  has(ref: CredentialRef): Promise<boolean>;
  delete(ref: CredentialRef): Promise<void>;
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

export async function importProviderCredential(input: {
  readonly provider: ProviderCredentialIdentity;
  readonly secret: string;
  readonly vault: CredentialVault;
}): Promise<CredentialRef> {
  validateSecret(input.secret);
  const ref = credentialRefForProvider(input.provider);
  await input.vault.put(ref, input.secret);
  return ref;
}

function validateSecret(secret: string): void {
  if (!secret.trim() || /[\r\n]/u.test(secret)) {
    throw new Error("拒绝保存空白或包含换行的 Provider 凭证");
  }
}

export function createPlatformCredentialVault(
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
): CredentialVault {
  if (platform === "darwin" && env["PICO_UNSAFE_KEYCHAIN_CLI"] === "1") {
    return new MacOsKeychainCredentialVault();
  }
  if (platform === "darwin") {
    return new UnavailableCredentialVault(
      "持久 Provider 凭证已按 fail-closed 禁用：当前 /usr/bin/security 适配无法阻止同一用户的 Agent Shell 读取。正式版本需使用签名的 Pico Credential Broker；仅本地开发可显式设置 PICO_UNSAFE_KEYCHAIN_CLI=1。已有旧条目不会自动删除。",
      new MacOsKeychainCredentialVault(),
    );
  }
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
      diagnostic:
        "不安全开发模式：Provider 凭证由 /usr/bin/security 写入 Login Keychain，同一 macOS 用户的其他进程可能读取；禁止用于发布构建。",
    };
  }

  async put(ref: CredentialRef, secret: string): Promise<void> {
    parseProviderCredentialRef(ref);
    validateSecret(secret);
    // `-w` intentionally remains last: security then reads the password from stdin,
    // keeping the secret out of argv, process listings, transcripts and shell history.
    await this.runner.run(
      ["add-generic-password", "-U", "-a", ref, "-s", KEYCHAIN_SERVICE, "-w"],
      `${secret}\n${secret}\n`,
    );
  }

  async resolve(ref: CredentialRef): Promise<string> {
    parseProviderCredentialRef(ref);
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
      if (isMacKeychainItemNotFound(error)) throw new CredentialNotFoundError(ref);
      throw error;
    }
  }

  async has(ref: CredentialRef): Promise<boolean> {
    parseProviderCredentialRef(ref);
    try {
      // Deliberately omit `-w`: status/list operations must not read plaintext credentials
      // into daemon memory merely to determine whether a Keychain item exists.
      await this.runner.run(["find-generic-password", "-a", ref, "-s", KEYCHAIN_SERVICE]);
      return true;
    } catch (error) {
      if (isMacKeychainItemNotFound(error)) return false;
      throw error;
    }
  }

  async delete(ref: CredentialRef): Promise<void> {
    parseProviderCredentialRef(ref);
    try {
      await this.runner.run(["delete-generic-password", "-a", ref, "-s", KEYCHAIN_SERVICE]);
    } catch (error) {
      if (!isMacKeychainItemNotFound(error)) throw error;
    }
  }
}

class UnavailableCredentialVault implements CredentialVault {
  constructor(
    private readonly diagnostic: string,
    private readonly cleanup?: Pick<CredentialVault, "has" | "delete">,
  ) {}

  capability(): CredentialVaultCapability {
    return {
      available: false,
      backend: "unavailable",
      diagnostic: this.diagnostic,
      ...(this.cleanup ? { cleanupAvailable: true } : {}),
    };
  }

  async put(): Promise<void> {
    throw new CredentialVaultUnavailableError(this.diagnostic);
  }

  async resolve(): Promise<string> {
    throw new CredentialVaultUnavailableError(this.diagnostic);
  }

  async has(ref: CredentialRef): Promise<boolean> {
    return this.cleanup?.has(ref) ?? false;
  }

  async delete(ref: CredentialRef): Promise<void> {
    if (this.cleanup) return this.cleanup.delete(ref);
    throw new CredentialVaultUnavailableError(this.diagnostic);
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
        else reject(new MacSecurityCommandError(code, stderr));
      });
      childStdin.end(stdin);
    });
  }
}

class MacSecurityCommandError extends Error {
  constructor(
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`macOS Keychain 命令失败（exit ${exitCode ?? "unknown"}）：${stderr.trim()}`);
    this.name = "MacSecurityCommandError";
  }
}

function isMacKeychainItemNotFound(error: unknown): boolean {
  if (error instanceof MacSecurityCommandError && error.exitCode === 44) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /(?:-25300|could not be found|item[^\n]*not found)/iu.test(message);
}

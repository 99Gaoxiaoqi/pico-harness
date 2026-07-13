import { describe, expect, it } from "vitest";
import {
  CredentialVaultUnavailableError,
  MacOsKeychainCredentialVault,
  createPlatformCredentialVault,
  credentialRefForModelRoute,
} from "../../src/provider/credential-vault.js";

describe("Provider credential vault integration", () => {
  it("把 secret 通过 stdin 交给 macOS Keychain，argv 与引用中不包含明文", async () => {
    const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
    const vault = new MacOsKeychainCredentialVault({
      run: async (args, stdin) => {
        calls.push({ args, ...(stdin !== undefined ? { stdin } : {}) });
        return args[0] === "find-generic-password" ? "vault-secret\n" : "";
      },
    });
    const ref = credentialRefForModelRoute("volcengine/doubao-seed");

    await vault.put(ref, "vault-secret");
    await expect(vault.resolve(ref)).resolves.toBe("vault-secret");

    expect(calls[0]?.args.join(" ")).not.toContain("vault-secret");
    expect(calls[0]?.stdin).toBe("vault-secret\nvault-secret\n");
    expect(ref).not.toContain("vault-secret");
  });

  it("未验证的平台明确诊断并 fail-closed，不回退到文件或进程环境", async () => {
    const vault = createPlatformCredentialVault("linux");
    const ref = credentialRefForModelRoute("provider/model");

    expect(vault.capability()).toMatchObject({ available: false, backend: "unavailable" });
    await expect(vault.resolve(ref)).rejects.toBeInstanceOf(CredentialVaultUnavailableError);
    await expect(vault.put(ref, "must-not-persist")).rejects.toBeInstanceOf(
      CredentialVaultUnavailableError,
    );
  });
});

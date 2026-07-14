import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import {
  assertCredentialRefMatchesModelRoute,
  CredentialVaultUnavailableError,
  MacOsKeychainCredentialVault,
  createPlatformCredentialVault,
  credentialRefForModelRoute,
} from "../../src/provider/credential-vault.js";
import { resolveModelRouteCapabilities } from "../../src/provider/model-capabilities.js";

describe("Provider credential vault integration", () => {
  it("把 secret 通过 stdin 交给 macOS Keychain，argv 与引用中不包含明文", async () => {
    const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
    const vault = new MacOsKeychainCredentialVault({
      run: async (args, stdin) => {
        calls.push({ args, ...(stdin !== undefined ? { stdin } : {}) });
        return args[0] === "find-generic-password" ? "vault-secret\n" : "";
      },
    });
    const route = modelRoute("volcengine/doubao-seed", "https://provider.example/v1");
    const ref = credentialRefForModelRoute(route, process.cwd());

    await vault.put(ref, "vault-secret");
    await expect(vault.resolve(ref)).resolves.toBe("vault-secret");

    expect(calls[0]?.args.join(" ")).not.toContain("vault-secret");
    expect(calls[0]?.stdin).toBe("vault-secret\nvault-secret\n");
    expect(ref).not.toContain("vault-secret");
  });

  it("未验证的平台明确诊断并 fail-closed，不回退到文件或进程环境", async () => {
    const vault = createPlatformCredentialVault("linux");
    const ref = credentialRefForModelRoute(
      modelRoute("provider/model", "https://provider.example/v1"),
      process.cwd(),
    );

    expect(vault.capability()).toMatchObject({ available: false, backend: "unavailable" });
    await expect(vault.resolve(ref)).rejects.toBeInstanceOf(CredentialVaultUnavailableError);
    await expect(vault.put(ref, "must-not-persist")).rejects.toBeInstanceOf(
      CredentialVaultUnavailableError,
    );
  });

  it("把凭证引用绑定到工作区和 Provider 端点，配置漂移时 fail-closed", () => {
    const route = modelRoute("provider/model", "https://provider.example/v1");
    const workspace = process.cwd();
    const ref = credentialRefForModelRoute(route, workspace);

    expect(credentialRefForModelRoute(route, tmpdir())).not.toBe(ref);
    expect(
      credentialRefForModelRoute({ ...route, baseURL: "https://attacker.example/v1" }, workspace),
    ).not.toBe(ref);
    expect(() => assertCredentialRefMatchesModelRoute(ref, route, workspace)).not.toThrow();
    expect(() =>
      assertCredentialRefMatchesModelRoute(
        ref,
        { ...route, baseURL: "https://attacker.example/v1" },
        workspace,
      ),
    ).toThrow(/不匹配/u);
  });
});

function modelRoute(id: string, baseURL: string) {
  const model = id.slice(id.indexOf("/") + 1);
  return {
    id,
    providerId: id.slice(0, id.indexOf("/")),
    provider: "openai" as const,
    model,
    baseURL,
    apiKeyEnv: "TEST_API_KEY",
    source: "config" as const,
    capabilities: resolveModelRouteCapabilities("openai", model),
  };
}

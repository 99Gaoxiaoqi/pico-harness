import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import {
  assertCredentialRefMatchesProvider,
  assertCredentialRefMatchesModelRoute,
  CredentialVaultUnavailableError,
  MacOsKeychainCredentialVault,
  createPlatformCredentialVault,
  credentialRefForProvider,
  credentialRefForModelRoute,
  importProviderCredential,
  parseAnyCredentialRef,
  parseCredentialRef,
  parseProviderCredentialRef,
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

  it("使用固定 argv 删除 macOS Keychain 凭证，不把 secret 或 stdin 传给删除命令", async () => {
    const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
    const vault = new MacOsKeychainCredentialVault({
      run: async (args, stdin) => {
        calls.push({ args, ...(stdin !== undefined ? { stdin } : {}) });
        return "";
      },
    });
    const ref = credentialRefForProvider({
      providerId: "shared",
      protocol: "openai",
      baseURL: "https://provider.example/v1",
    });

    await vault.delete(ref);

    expect(calls).toEqual([
      {
        args: ["delete-generic-password", "-a", ref, "-s", "dev.pico.runtime.provider"],
      },
    ]);
    expect(calls[0]?.args.join(" ")).not.toContain("vault-secret");
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
    await expect(vault.delete(ref)).rejects.toBeInstanceOf(CredentialVaultUnavailableError);
  });

  it("把凭证引用绑定到工作区和 Provider 端点，配置漂移时 fail-closed", () => {
    const route = modelRoute("provider/model", "https://provider.example/v1");
    const workspace = process.cwd();
    const ref = credentialRefForModelRoute(route, workspace);

    expect(credentialRefForModelRoute(route, tmpdir())).not.toBe(ref);
    expect(
      credentialRefForModelRoute({ ...route, baseURL: "https://attacker.example/v1" }, workspace),
    ).not.toBe(ref);
    expect(
      credentialRefForModelRoute({ ...route, apiKeyEnv: "OTHER_API_KEY" }, workspace),
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

  it("保留 v1 解析契约，并由通用解析器显式区分 v1 和 v2", () => {
    const route = modelRoute("provider/model", "https://provider.example/v1");
    const legacyRef = credentialRefForModelRoute(route, process.cwd());
    const providerRef = credentialRefForProvider({
      providerId: "provider",
      protocol: "openai",
      baseURL: route.baseURL,
    });

    expect(parseCredentialRef(legacyRef).modelRouteId).toBe("provider/model");
    expect(parseAnyCredentialRef(legacyRef)).toMatchObject({
      version: "v1",
      modelRouteId: "provider/model",
    });
    expect(parseAnyCredentialRef(providerRef)).toMatchObject({
      version: "v2",
      providerId: "provider",
      protocol: "openai",
      credentialSlot: "api-key",
    });
    expect(() => parseCredentialRef(providerRef)).toThrow(/v1/u);
  });

  it("将 v2 凭证绑定到 Provider、协议、规范化 Endpoint 和 slot，不绑定工作区或模型", () => {
    const identity = {
      providerId: "shared-provider",
      protocol: "openai" as const,
      baseURL: " HTTPS://Provider.Example:443/v1/ ",
      credentialSlot: "api-key",
    };
    const ref = credentialRefForProvider(identity);
    const canonicalRef = credentialRefForProvider({
      ...identity,
      baseURL: "https://provider.example/v1",
    });

    expect(ref).toBe(canonicalRef);
    expect(ref).not.toContain(identity.baseURL.trim());
    expect(parseProviderCredentialRef(ref)).toMatchObject({
      providerId: "shared-provider",
      protocol: "openai",
      credentialSlot: "api-key",
    });
    expect(() => assertCredentialRefMatchesProvider(ref, identity)).not.toThrow();
    expect(() =>
      assertCredentialRefMatchesProvider(ref, {
        ...identity,
        baseURL: "https://attacker.example/v1",
      }),
    ).toThrow(/Endpoint/u);
    expect(() =>
      assertCredentialRefMatchesProvider(ref, { ...identity, credentialSlot: "oauth-token" }),
    ).toThrow(/slot/u);
    expect(() =>
      assertCredentialRefMatchesProvider(ref, { ...identity, protocol: "claude" }),
    ).toThrow(/协议/u);
  });

  it("导入 v2 凭证时只把 secret 交给 Vault，返回可共享的 Provider 引用", async () => {
    const calls: Array<{ ref: string; secret: string }> = [];
    const vault = new MacOsKeychainCredentialVault({
      run: async (args, stdin) => {
        if (args[0] === "add-generic-password") {
          calls.push({ ref: args[3] ?? "", secret: stdin ?? "" });
        }
        return "";
      },
    });

    const ref = await importProviderCredential({
      provider: {
        providerId: "shared-provider",
        protocol: "gemini",
        baseURL: "https://generativelanguage.googleapis.com/v1beta",
        credentialSlot: "api-key",
      },
      secret: "imported-secret",
      vault,
    });

    expect(parseProviderCredentialRef(ref)).toMatchObject({
      providerId: "shared-provider",
      protocol: "gemini",
    });
    expect(ref).not.toContain("imported-secret");
    expect(calls).toEqual([{ ref, secret: "imported-secret\nimported-secret\n" }]);
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

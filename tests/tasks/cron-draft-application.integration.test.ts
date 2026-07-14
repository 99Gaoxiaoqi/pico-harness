import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CredentialRef, CredentialVault } from "../../src/provider/credential-vault.js";
import { resolveModelRouteCapabilities } from "../../src/provider/model-capabilities.js";
import type { ModelRoute } from "../../src/provider/model-router.js";
import type { CronDraft, CronDraftId } from "../../src/tasks/cron-draft.js";
import { CronDraftApplication } from "../../src/tasks/cron-draft-application.js";
import { CronService } from "../../src/tasks/cron-service.js";

describe("CronDraftApplication integration", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("确认后导入凭证、先写 disabled、登记 daemon 再启用", async () => {
    const workspace = await workspaceDir();
    const vault = new MemoryCredentialVault();
    const cron = new CronService({ workDir: workspace, now: () => 100 });
    const enabledAtRegistration: boolean[] = [];
    const app = new CronDraftApplication({
      cronService: cron,
      workspacePath: workspace,
      resolveModelRoute: modelRoute,
      listAllowedTools: () => ["schedule_task", "ask_user", "fetch_url", "bash"],
      credentialVault: vault,
      credentialEnv: { TEST_API_KEY: "secret" },
      workspaceRegistrar: {
        statusWorkspace: async () => ({ available: true, message: "daemon ready" }),
        registerWorkspace: async () => {
          enabledAtRegistration.push(cron.list(workspace)[0]?.enabled ?? true);
          return { available: true, message: "daemon registered" };
        },
      },
      now: () => 100,
    });
    const context = await app.context();
    expect(context.allowedTools).toEqual(["bash", "fetch_url"]);
    expect(context.credentialStatus).toBe("missing");

    const receipt = await app.commit(draft(workspace, context.allowedTools));
    const job = cron.list(workspace)[0]!;
    expect(enabledAtRegistration).toEqual([false]);
    expect(receipt.enabled).toBe(true);
    expect(receipt.nextRun).toBe(Date.UTC(1970, 0, 1, 1, 0));
    expect(receipt.nextRun).not.toBe(1_000);
    expect(job.enabled).toBe(true);
    expect(job.policySnapshot.toolNetworkPolicy).toBe("allow");
    expect(job.policySnapshot.allowedTools).toEqual(["bash", "fetch_url"]);
    expect(vault.values.size).toBe(1);
    cron.close();
  });

  it("daemon 不可用时保留 disabled Job", async () => {
    const workspace = await workspaceDir();
    const vault = new MemoryCredentialVault();
    const cron = new CronService({ workDir: workspace });
    const app = new CronDraftApplication({
      cronService: cron,
      workspacePath: workspace,
      resolveModelRoute: modelRoute,
      listAllowedTools: () => ["fetch_url"],
      credentialVault: vault,
      credentialEnv: { TEST_API_KEY: "secret" },
      workspaceRegistrar: {
        statusWorkspace: async () => ({ available: false, message: "offline" }),
        registerWorkspace: async () => ({ available: false, message: "offline" }),
      },
    });

    const receipt = await app.commit(draft(workspace, ["fetch_url"]));
    expect(receipt).toMatchObject({ enabled: false, daemonMessage: "offline" });
    expect(cron.list(workspace)[0]?.enabled).toBe(false);
    cron.close();
  });

  it("凭证导入失败时不创建 Job", async () => {
    const workspace = await workspaceDir();
    const cron = new CronService({ workDir: workspace });
    const app = new CronDraftApplication({
      cronService: cron,
      workspacePath: workspace,
      resolveModelRoute: modelRoute,
      listAllowedTools: () => ["fetch_url"],
      credentialVault: new MemoryCredentialVault(),
      credentialEnv: {},
      workspaceRegistrar: {
        statusWorkspace: async () => ({ available: true, message: "ready" }),
        registerWorkspace: async () => ({ available: true, message: "ready" }),
      },
    });

    await expect(app.commit(draft(workspace, ["fetch_url"]))).rejects.toThrow(/TEST_API_KEY/u);
    expect(cron.list(workspace)).toEqual([]);
    cron.close();
  });

  async function workspaceDir(): Promise<string> {
    const workspace = await mkdtemp(join(tmpdir(), "pico-cron-draft-app-"));
    cleanup.push(workspace);
    return workspace;
  }
});

class MemoryCredentialVault implements CredentialVault {
  readonly values = new Map<CredentialRef, string>();

  capability() {
    return {
      available: true,
      backend: "macos-keychain" as const,
      diagnostic: "test vault",
    };
  }

  async put(ref: CredentialRef, secret: string): Promise<void> {
    this.values.set(ref, secret);
  }

  async has(ref: CredentialRef): Promise<boolean> {
    return this.values.has(ref);
  }

  async resolve(ref: CredentialRef): Promise<string> {
    const value = this.values.get(ref);
    if (!value) throw new Error("missing");
    return value;
  }
}

function modelRoute(): ModelRoute {
  return {
    id: "test/model",
    providerId: "test",
    provider: "openai",
    model: "model",
    baseURL: "https://provider.example/v1",
    apiKeyEnv: "TEST_API_KEY",
    source: "config",
    capabilities: resolveModelRouteCapabilities("openai", "model"),
  };
}

function draft(workspacePath: string, allowedTools: readonly string[]): CronDraft {
  return {
    draftId: "draft-1" as CronDraftId,
    title: "日报",
    prompt: "生成日报",
    scheduleText: "每天九点",
    cronExpression: "0 9 * * *",
    timeZone: "Asia/Shanghai",
    workspacePath,
    modelRouteId: "test/model",
    nextRuns: [1_000],
    allowedTools,
    toolNetworkPolicy: "allow",
    credentialStatus: "missing",
    daemonStatus: "ready",
  };
}

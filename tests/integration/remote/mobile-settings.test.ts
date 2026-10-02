import assert from "node:assert/strict";
import test from "node:test";
import { parseRuntimeResult } from "../../../packages/protocol/src/mobile.js";
import {
  getRemoteMethodSpec,
  toRuntimeParams,
  type RemoteMethod,
  type RemoteParams,
  type RemoteRequest,
} from "../../../packages/protocol/src/remote.js";
import type { RuntimePort } from "../../../apps/mobile/src/core.js";
import type {
  RuntimeProviderProfile,
  RuntimeSubagentSettingsSnapshot,
  RuntimeUserDefaults,
} from "@pico/protocol/mobile";
import {
  availableProviderModels,
  modelChoices,
  providerInput,
  queryWorkspaceUsage,
  saveAutomation,
  saveSubagentPresets,
  saveUserDefaults,
  scheduleCron,
  scheduleDraft,
  usageMetricLabel,
} from "../../../apps/mobile/src/settings/management.js";

function settingsHost() {
  const requests: { method: string; params: Record<string, unknown>; workspaceId?: string }[] = [];
  let revision = "a".repeat(64);
  let defaults: RuntimeUserDefaults = {
    modelRouteId: "user/old",
    collaborationMode: "research",
    orchestrationMode: "swarm",
    permissionMode: "ask",
    thinkingEffort: "high",
  };
  let presets: RuntimeSubagentSettingsSnapshot["presets"] = [
    {
      id: "reader",
      name: "阅读",
      description: "读取项目",
      profile: "local_read",
      connectionSlug: "user",
      model: "new",
      enabled: true,
      availability: { status: "available" },
    },
  ];
  const connections: RuntimeSubagentSettingsSnapshot["connections"] = [
    {
      id: "user",
      name: "用户连接",
      enabled: true,
      models: [{ id: "new", thinkingLevels: ["low", "high"], offerable: true }],
    },
  ];
  const paths: Record<string, string> = {
    "allowed-a": "/authorized/a",
    "allowed-b": "/authorized/b",
  };
  const port: RuntimePort = {
    async request<M extends RemoteMethod>(
      method: M,
      params: RemoteParams<M>,
      workspaceId?: string,
    ) {
      const spec = getRemoteMethodSpec(method);
      if (spec.workspaceRequired && (!workspaceId || !paths[workspaceId]))
        throw new Error("工作区未授权");
      // Same strict conversion and result parsing as the remote transport, without native dependencies.
      const runtime = toRuntimeParams(
        {
          version: 1,
          requestId: "mobile-settings",
          method,
          params,
          ...(workspaceId ? { workspaceId } : {}),
        } as RemoteRequest<M>,
        workspaceId ? paths[workspaceId] : undefined,
      ) as Record<string, unknown>;
      requests.push({ method, params: runtime, ...(workspaceId ? { workspaceId } : {}) });
      let result: unknown;
      if (method === "config.user.get")
        result = { config: { version: 1, defaults, providers: [] }, revision };
      else if (method === "config.user.update") {
        if (runtime.expectedRevision !== revision) throw new Error("CONFLICT：电脑配置已改变");
        defaults = runtime.defaults as RuntimeUserDefaults;
        revision = "b".repeat(64);
        result = { config: { version: 1, defaults, providers: [] }, revision };
      } else if (method === "subagents.get") result = { presets, connections, revision };
      else if (method === "subagents.update") {
        if (runtime.expectedRevision !== revision) throw new Error("CONFLICT：预设版本已改变");
        presets = (runtime.presets as RuntimeSubagentSettingsSnapshot["presets"]).map((item) => ({
          ...item,
          availability: { status: "available" },
        }));
        revision = "c".repeat(64);
        result = { presets, connections, revision };
      } else if (method === "jobs.create" || method === "jobs.update") {
        result = {
          job: {
            jobId: "job-1",
            workspacePath: runtime.workspacePath,
            name: runtime.name,
            prompt: runtime.prompt,
            schedule: runtime.schedule,
            enabled: runtime.enabled ?? false,
            status: "idle",
            updatedAt: 1,
            timeZone: "Asia/Shanghai",
          },
        };
      } else if (method === "usage.get")
        result = {
          usage: {
            scope: "workspace",
            workspacePath: runtime.workspacePath,
            total: { totalTokens: 123, costCNY: 0 },
            costStatus: "unknown",
          },
        };
      else throw new Error(`Unexpected ${method}`);
      return parseRuntimeResult(method, result);
    },
  };
  // In the app store the selected workspace is added for job operations.
  const workspacePort: RuntimePort = {
    request: (method, params, workspaceId) =>
      port.request(
        method,
        params,
        workspaceId ?? (getRemoteMethodSpec(method).workspaceRequired ? "allowed-a" : undefined),
      ),
  };
  return { port, workspacePort, requests };
}

test("手机设置通过既有严格协议保存默认、预设和关闭的 Cron，并按授权项目查询用量", async () => {
  const host = settingsHost();
  const original = await host.port.request("config.user.get", {});
  const config = await saveUserDefaults(host.port, original, {
    modelRouteId: "user/new",
    thinkingEffort: undefined,
    webSearch: { enabled: true, source: "external" },
  });
  assert.equal(config.config.defaults.collaborationMode, "research");
  assert.equal(config.config.defaults.orchestrationMode, "swarm");
  assert.equal(config.config.defaults.permissionMode, "ask");
  assert.equal("thinkingEffort" in config.config.defaults, false);
  assert.deepEqual(config.config.defaults.webSearch, { enabled: true, source: "external" });
  const snapshot = await host.port.request("subagents.get", {});
  const next = await saveSubagentPresets(
    host.port,
    snapshot.presets.map((item) => ({
      ...item,
      name: "已修改阅读",
      thinkingLevel: "low" as const,
    })),
    snapshot.revision,
  );
  assert.equal(next.presets[0]?.name, "已修改阅读");
  const writtenPresets = host.requests.find((call) => call.method === "subagents.update")!.params
    .presets as Record<string, unknown>[];
  assert.equal("availability" in writtenPresets[0]!, false);
  assert.deepEqual(next.connections[0]?.models[0]?.thinkingLevels, ["low", "high"]);
  const cron = scheduleCron("weekdays", "09:30", "1", "");
  const job = await saveAutomation(host.workspacePort, {
    name: "每日整理",
    prompt: "总结项目",
    schedule: cron,
  });
  assert.equal(job.job.enabled, false);
  assert.equal(job.job.schedule, "30 9 * * 1-5");
  assert.equal(job.job.timeZone, "Asia/Shanghai");
  const advanced = "*/15 8-18 * * 1,3";
  const draft = scheduleDraft(advanced);
  const edited = await saveAutomation(host.workspacePort, {
    jobId: job.job.jobId,
    name: "高级计划",
    prompt: "保留高级日程",
    schedule: scheduleCron(draft.kind, draft.time, draft.weekday, draft.advanced),
  });
  assert.equal(edited.job.schedule, advanced);
  const usageResult = await queryWorkspaceUsage(
    host.port,
    ["allowed-a", "allowed-b"],
    "allowed-b",
    "2026-10-01",
    "2026-10-03",
  );
  assert.equal(
    usageMetricLabel(
      usageResult.usage,
      (usageResult.usage.total as Record<string, unknown>).totalTokens,
    ),
    "未知",
    "缺少完整上报信息不能把汇总数字当成精确总量",
  );
  const usage = host.requests.find((call) => call.method === "usage.get")!;
  assert.equal(usage.workspaceId, "allowed-b");
  assert.equal(usage.params.workspacePath, "/authorized/b");
  assert.equal(usage.params.from, new Date(2026, 9, 1).getTime());
  assert.equal(usage.params.to, new Date(2026, 9, 3, 23, 59, 59, 999).getTime());
  const profile: RuntimeProviderProfile = {
    id: "user",
    protocol: "responses",
    baseURL: "https://api.example/v1",
    apiKeyEnv: "MODEL_KEY",
    models: ["new"],
    disabledModels: ["hidden"],
    discoverModels: true,
    auth: "none",
    modelProtocols: { new: "responses" },
    modelCapabilities: { new: { reasoning: true } },
    availableModels: ["new", "discovered", "hidden"],
    origin: "user",
    fingerprint: "fingerprint",
    credentialStatus: "ready",
    credentialSource: "none",
    storedCredentialPresent: false,
    resolvedModelCapabilities: {
      new: {
        reasoningLevels: ["low", "high"],
        nativeWebSearch: { available: false, reason: "disabled" },
      },
    },
  };
  assert.deepEqual(availableProviderModels(profile), ["new", "discovered", "hidden"]);
  assert.deepEqual(
    modelChoices([profile]).map((item) => item.id),
    ["user/new", "user/discovered"],
  );
  assert.deepEqual(modelChoices([profile])[0]?.reasoningLevels, ["low", "high"]);
  const input = providerInput(profile);
  assert.equal(input.auth, "none");
  assert.deepEqual(input.modelProtocols, { new: "responses" });
  assert.deepEqual(input.modelCapabilities, profile.modelCapabilities);
  assert.equal("credentialStatus" in input, false);
});

test("手机设置不重试旧版本写入，也不向未授权项目发送用量查询", async () => {
  const host = settingsHost();
  const first = await host.port.request("subagents.get", {});
  await saveSubagentPresets(host.port, first.presets, first.revision);
  await assert.rejects(
    () => saveSubagentPresets(host.port, first.presets, first.revision),
    /CONFLICT/,
  );
  assert.equal(host.requests.filter((call) => call.method === "subagents.update").length, 2);
  const before = host.requests.length;
  await assert.rejects(
    () => queryWorkspaceUsage(host.port, ["allowed-a"], "allowed-b", "", ""),
    /已授权/,
  );
  await assert.rejects(
    () => queryWorkspaceUsage(host.port, ["allowed-a"], "allowed-a", "2026-02-30", ""),
    /有效日期/,
  );
  await assert.rejects(
    () => queryWorkspaceUsage(host.port, ["allowed-a"], "allowed-a", "2026-10-04", "2026-10-03"),
    /开始日期/,
  );
  assert.equal(host.requests.length, before);
  assert.throws(() => scheduleCron("daily", "25:00", "1", ""), /HH:mm/);
});

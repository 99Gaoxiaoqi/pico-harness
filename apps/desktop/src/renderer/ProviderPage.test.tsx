// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopApp } from "./App.js";
import type { ProviderView } from "./model.js";
import type { RendererBridge } from "./runtime.js";

const successful = <T,>(value: T) => Promise.resolve({ ok: true as const, value });

interface ProviderHarness {
  readonly calls: Array<{
    readonly method: string;
    readonly params: Readonly<Record<string, unknown>>;
  }>;
}

function installProviderBridge(options?: {
  readonly sharedConfig?: boolean;
  readonly initialProviders?: readonly ProviderView[];
}): ProviderHarness {
  const calls: ProviderHarness["calls"] = [];
  let revision = "revision-1";
  let providers = [...(options?.initialProviders ?? [])];
  let defaults: Readonly<Record<string, unknown>> = {};
  const runtime = new Proxy(
    {},
    {
      get: (_target, property) => async (params: Readonly<Record<string, unknown>>) => {
        const method = String(property);
        calls.push({ method, params });
        switch (method) {
          case "runtime.ping":
            return successful({
              version: "test",
              capabilities: [
                "session-conversation-v1",
                "runtime-events-v1",
                ...(options?.sharedConfig === false ? [] : ["shared-config-v1"]),
              ],
            });
          case "workspace.list":
            return successful({
              workspaces: [{ workspacePath: "/workspace", registered: true }],
            });
          case "workspace.status":
            return successful({
              workspacePath: "/workspace",
              mode: "folder",
              capabilities: { foregroundRuns: true, fileHistory: true },
            });
          case "workspace.trustStatus":
            return successful({ trusted: true });
          case "provider.list":
            return successful({ providers, revision });
          case "config.user.get":
            return successful({
              config: { version: 1, defaults, providers: [] },
              revision,
            });
          case "config.effective.get":
            return successful({
              config: {
                ...(typeof defaults.modelRouteId === "string"
                  ? { defaultModelRouteId: defaults.modelRouteId }
                  : {}),
                providers,
                sources: {},
                revisions: { user: revision, project: "project-revision" },
              },
            });
          case "provider.upsert": {
            const input = params.provider as Readonly<Record<string, unknown>>;
            const previous = providers.find((provider) => provider.id === input.id);
            const next: ProviderView = {
              id: String(input.id),
              protocol:
                input.protocol === "claude" || input.protocol === "gemini"
                  ? input.protocol
                  : "openai",
              baseURL: String(input.baseURL),
              apiKeyEnv: String(input.apiKeyEnv),
              models: Array.isArray(input.models) ? input.models.map(String) : [],
              discoverModels: input.discoverModels === true,
              origin: "user",
              fingerprint: previous?.fingerprint ?? `fingerprint-${String(input.id)}`,
              credentialStatus: previous?.credentialStatus ?? "missing",
              credentialSource: previous?.credentialSource ?? "none",
            };
            providers = [...providers.filter((provider) => provider.id !== next.id), next];
            revision = "revision-2";
            return successful({ provider: next, revision });
          }
          case "config.user.update":
            defaults = params.defaults as Readonly<Record<string, unknown>>;
            revision = "revision-3";
            return successful({
              config: { version: 1, defaults, providers: [] },
              revision,
            });
          case "provider.delete":
            providers = providers.filter((provider) => provider.id !== params.providerId);
            revision = "revision-4";
            return successful({ deleted: true, revision });
          case "provider.credential.set":
            providers = providers.map((provider) =>
              provider.id === params.providerId
                ? {
                    ...provider,
                    credentialStatus: "ready",
                    credentialSource: "keychain",
                  }
                : provider,
            );
            return successful({
              providerId: params.providerId,
              status: "ready",
              source: "keychain",
              providerFingerprint: params.expectedProviderFingerprint,
            });
          case "provider.credential.delete":
            providers = providers.map((provider) =>
              provider.id === params.providerId
                ? {
                    ...provider,
                    credentialStatus: "missing",
                    credentialSource: "none",
                  }
                : provider,
            );
            return successful({
              providerId: params.providerId,
              status: "missing",
              source: "none",
              providerFingerprint: params.expectedProviderFingerprint,
            });
          default:
            return successful({});
        }
      },
    },
  ) as RendererBridge["runtime"];
  (window as unknown as { pico?: RendererBridge }).pico = {
    runtime,
    events: {
      subscribe: () => ({ ready: successful({ subscribed: true }), dispose: vi.fn() }),
    },
    platform: {
      chooseWorkspace: () => successful(undefined),
      openDirectory: () => successful(undefined),
      getLaunchAtLogin: () => successful(false),
      setLaunchAtLogin: () => successful(undefined),
    },
    lifecycle: {
      setBackgroundMode: () => successful(undefined),
      quit: () => successful(undefined),
    },
  };
  return { calls };
}

function openAiProvider(overrides?: Partial<ProviderView>): ProviderView {
  return {
    id: "openai",
    protocol: "openai",
    baseURL: "https://api.openai.example/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    models: ["gpt-5.4", "gpt-5.4-mini"],
    discoverModels: true,
    origin: "user",
    fingerprint: "openai-fingerprint",
    credentialStatus: "ready",
    credentialSource: "keychain",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { pico?: unknown }).pico;
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

describe("Desktop Provider settings", () => {
  it("shows provider source, endpoint, models, and credential status", async () => {
    installProviderBridge({ initialProviders: [openAiProvider()] });
    window.history.replaceState({}, "", "/#/providers");

    render(<DesktopApp />);

    expect(await screen.findByRole("heading", { name: "openai" })).toBeTruthy();
    expect(screen.getByText("当前设备")).toBeTruthy();
    expect(screen.getByText("https://api.openai.example/v1")).toBeTruthy();
    expect(screen.getByText("gpt-5.4")).toBeTruthy();
    expect(screen.getByText("凭证已保存")).toBeTruthy();
  });

  it("adds a provider and updates the shared user default model", async () => {
    const user = userEvent.setup();
    const harness = installProviderBridge();
    window.history.replaceState({}, "", "/#/providers");
    render(<DesktopApp />);

    await user.click(await screen.findByRole("button", { name: "配置第一个 Provider" }));
    const dialog = screen.getByRole("dialog", { name: "添加 Provider" });
    await user.type(within(dialog).getByRole("textbox", { name: "Provider ID" }), "team-openai");
    await user.type(
      within(dialog).getByRole("textbox", { name: "Endpoint" }),
      "https://models.example.test/v1",
    );
    await user.clear(within(dialog).getByRole("textbox", { name: "环境变量名" }));
    await user.type(within(dialog).getByRole("textbox", { name: "环境变量名" }), "TEAM_OPENAI_KEY");
    await user.type(
      within(dialog).getByRole("textbox", { name: "已知模型" }),
      "gpt-5.4\ngpt-5.4-mini",
    );
    await user.click(
      within(dialog).getByRole("checkbox", { name: "允许从 Provider 动态发现模型" }),
    );
    await user.click(within(dialog).getByRole("button", { name: "添加 Provider" }));

    await waitFor(() => expect(dialog.isConnected).toBe(false));
    expect(await screen.findByRole("heading", { name: "team-openai" })).toBeTruthy();
    const upsertCall = harness.calls.find((call) => call.method === "provider.upsert");
    expect(upsertCall?.params).toEqual({
      provider: {
        id: "team-openai",
        protocol: "openai",
        baseURL: "https://models.example.test/v1",
        apiKeyEnv: "TEAM_OPENAI_KEY",
        models: ["gpt-5.4", "gpt-5.4-mini"],
        discoverModels: true,
      },
      expectedRevision: "revision-1",
    });

    await user.selectOptions(
      screen.getByRole("combobox", { name: "默认模型" }),
      "team-openai/gpt-5.4",
    );
    await waitFor(() =>
      expect(
        harness.calls.some(
          (call) =>
            call.method === "config.user.update" &&
            (call.params.defaults as Readonly<Record<string, unknown>>).modelRouteId ===
              "team-openai/gpt-5.4",
        ),
      ).toBe(true),
    );
  });

  it("keeps a credential local to the dialog and clears it after the request", async () => {
    const user = userEvent.setup();
    const harness = installProviderBridge({ initialProviders: [openAiProvider()] });
    window.history.replaceState({}, "", "/#/providers");
    render(<DesktopApp />);

    await user.click(await screen.findByRole("button", { name: "凭证" }));
    const secretInput = screen.getByLabelText("API Key / Token");
    await user.type(secretInput, "test-only-secret");
    await user.click(screen.getByRole("button", { name: "保存凭证" }));

    await waitFor(() => expect(screen.queryByDisplayValue("test-only-secret")).toBeNull());
    const credentialCall = harness.calls.find((call) => call.method === "provider.credential.set");
    expect(credentialCall?.params).toEqual({
      providerId: "openai",
      secret: "test-only-secret",
      expectedProviderFingerprint: "openai-fingerprint",
    });
    expect(screen.queryByText("test-only-secret")).toBeNull();

    await user.click(await screen.findByRole("button", { name: "凭证" }));
    await user.click(screen.getByRole("button", { name: "删除系统凭证" }));
    await waitFor(() =>
      expect(
        harness.calls.some(
          (call) =>
            call.method === "provider.credential.delete" && call.params.providerId === "openai",
        ),
      ).toBe(true),
    );
  });

  it("keeps provider IDs immutable while editing and supports explicit deletion", async () => {
    const user = userEvent.setup();
    const harness = installProviderBridge({ initialProviders: [openAiProvider()] });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    window.history.replaceState({}, "", "/#/providers");
    render(<DesktopApp />);

    await user.click(await screen.findByRole("button", { name: "编辑" }));
    const dialog = screen.getByRole("dialog", { name: "编辑 openai" });
    const idInput = within(dialog).getByRole("textbox", { name: /Provider ID/ });
    expect((idInput as HTMLInputElement).disabled).toBe(true);
    const endpoint = within(dialog).getByRole("textbox", { name: "Endpoint" });
    await user.clear(endpoint);
    await user.type(endpoint, "https://new-api.example.test/v1");
    await user.click(within(dialog).getByRole("button", { name: "保存更改" }));

    await waitFor(() =>
      expect(
        harness.calls.some(
          (call) =>
            call.method === "provider.upsert" &&
            (call.params.provider as Readonly<Record<string, unknown>>).id === "openai" &&
            (call.params.provider as Readonly<Record<string, unknown>>).baseURL ===
              "https://new-api.example.test/v1",
        ),
      ).toBe(true),
    );
    await user.click(await screen.findByRole("button", { name: "删除" }));
    await waitFor(() =>
      expect(
        harness.calls.some(
          (call) => call.method === "provider.delete" && call.params.providerId === "openai",
        ),
      ).toBe(true),
    );
  });

  it("requires a restart when the Runtime lacks shared configuration support", async () => {
    const harness = installProviderBridge({ sharedConfig: false });
    window.history.replaceState({}, "", "/#/providers");
    render(<DesktopApp />);

    expect(await screen.findByText(/请完全退出并重新启动 Pico/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "添加 Provider" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(harness.calls.some((call) => call.method === "provider.list")).toBe(false);
  });
});

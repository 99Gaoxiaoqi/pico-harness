import * as Dialog from "@radix-ui/react-dialog";
import { BrainCircuit, Check, KeyRound, Pencil, Plus, Server, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Button, EmptyState, IconButton, InlineNotice } from "./components.js";
import type {
  ProviderCredentialStatus,
  ProviderDraft,
  ProviderOrigin,
  ProviderProtocol,
  ProviderView,
} from "./model.js";
import type { RuntimeStore } from "./runtime.js";

const protocolLabels: Readonly<Record<ProviderProtocol, string>> = {
  openai: "OpenAI compatible",
  claude: "Anthropic Claude",
  gemini: "Google Gemini",
};

const originLabels: Readonly<Record<ProviderOrigin, string>> = {
  user: "当前设备",
  "project-legacy": "工作区兼容配置",
  environment: "当前进程环境",
};

const credentialLabels: Readonly<Record<ProviderCredentialStatus, string>> = {
  ready: "API Key 已配置",
  missing: "尚未配置 API Key",
  environment: "环境变量（兼容）",
  unsupported: "当前来源不可配置",
};

const defaultApiKeyEnvs: Readonly<Record<ProviderProtocol, string>> = {
  openai: "OPENAI_API_KEY",
  claude: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
};

function credentialTone(status: ProviderCredentialStatus): string {
  if (status === "ready" || status === "environment") return "success";
  return status === "missing" ? "warning" : "neutral";
}

function routeOptions(providers: readonly ProviderView[]) {
  return providers
    .filter((provider) => provider.origin === "user")
    .flatMap((provider) =>
      provider.models.map((model) => ({
        id: `${provider.id}/${model}`,
        label: `${model} · ${provider.id}`,
      })),
    );
}

function providerApiKeyEnv(
  provider: ProviderView | undefined,
  protocol: ProviderProtocol,
): string {
  if (!provider) return defaultApiKeyEnvs[protocol];
  const current = provider.apiKeyEnv.trim();
  return !current || current === defaultApiKeyEnvs[provider.protocol]
    ? defaultApiKeyEnvs[protocol]
    : current;
}

export function ProviderPage({ runtime }: { readonly runtime: RuntimeStore }) {
  const { data, actions, busy } = runtime;
  const config = data.providerConfig;
  const [editor, setEditor] = useState<ProviderView | null>();
  const [credentialEditor, setCredentialEditor] = useState<{
    readonly provider: ProviderView;
    readonly revision: string;
  }>();
  const models = useMemo(() => routeOptions(config.providers), [config.providers]);
  const isBusy = Boolean(busy);

  const handleDefaultChange = (modelRouteId: string) => {
    void actions.setDefaultModelRoute(modelRouteId || undefined);
  };

  const handleDeleteProvider = (provider: ProviderView) => {
    if (
      window.confirm(
        `删除 Provider“${provider.id}”？已有会话不会被删除，但恢复时可能需要重新选择模型。`,
      )
    ) {
      void actions.deleteProvider(provider.id);
    }
  };

  return (
    <div className="page-stack provider-page">
      <section className="page-intro">
        <div>
          <span className="eyebrow">推理能力</span>
          <h2>模型 Providers</h2>
          <p>
            在 App 和 TUI 之间共用模型路由。API Key 保存在 ~/.pico/config.json，文件权限为
            0600。
          </p>
        </div>
        <Button
          variant="primary"
          disabled={isBusy || !config.writable}
          onClick={() => setEditor(null)}
        >
          <Plus aria-hidden="true" size={16} />
          添加 Provider
        </Button>
      </section>

      {!config.supported && (
        <InlineNotice tone="warning">
          当前 Runtime 缺少统一配置能力。请完全退出并重新启动 Pico，不会回退到旧的任务配置。
        </InlineNotice>
      )}
      {config.supported && data.notices.providers && (
        <InlineNotice tone="error">{data.notices.providers}</InlineNotice>
      )}
      {config.supported && !config.writable && !data.notices.providers && (
        <InlineNotice tone="warning">
          Provider 配置没有完整加载，已暂停编辑以避免覆盖更新的配置。请重新加载后再试。
        </InlineNotice>
      )}

      {config.supported && (
        <section className="panel provider-defaults" aria-labelledby="provider-default-heading">
          <div>
            <span className="provider-section-icon" aria-hidden="true">
              <BrainCircuit size={17} />
            </span>
            <div>
              <h3 id="provider-default-heading">用户默认模型</h3>
              <p>新会话优先使用这个选择；可信工作区和会话显式选择仍可覆盖它。</p>
            </div>
          </div>
          <label className="provider-default-select">
            <span>默认模型</span>
            <select
              value={config.userDefaults.modelRouteId ?? ""}
              disabled={isBusy || !config.writable || models.length === 0}
              onChange={(event) => handleDefaultChange(event.currentTarget.value)}
            >
              <option value="">不设置用户默认值</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          </label>
          {config.defaultModelRouteId &&
            config.defaultModelRouteId !== config.userDefaults.modelRouteId && (
              <p className="provider-effective-route">
                当前工作区实际默认值：<code>{config.defaultModelRouteId}</code>
              </p>
            )}
        </section>
      )}

      {config.supported && (
        <section className="panel provider-list-panel" aria-label="Provider 列表">
          {config.providers.length === 0 ? (
            <EmptyState
              icon={<Server aria-hidden="true" />}
              title="还没有可用的 Provider"
              detail="添加一个模型服务后，App 与 TUI 会在这台设备上共用它。"
              action={
                <Button
                  variant="primary"
                  disabled={!config.writable}
                  onClick={() => setEditor(null)}
                >
                  <Plus aria-hidden="true" size={16} />
                  配置第一个 Provider
                </Button>
              }
            />
          ) : (
            <div className="provider-list">
              {config.providers.map((provider) => (
                <article className="provider-card" key={provider.id}>
                  <header>
                    <span className="provider-card__icon" aria-hidden="true">
                      <Server size={17} />
                    </span>
                    <div>
                      <div className="provider-card__title">
                        <h3>{provider.id}</h3>
                        <span className="provider-origin">{originLabels[provider.origin]}</span>
                      </div>
                      <p>{protocolLabels[provider.protocol]}</p>
                    </div>
                    <div className="provider-card__actions">
                      {provider.origin === "user" ? (
                        <>
                          <Button
                            variant="quiet"
                            disabled={isBusy || !config.writable}
                            onClick={() =>
                              setCredentialEditor({ provider, revision: config.revision })
                            }
                          >
                            <KeyRound aria-hidden="true" size={15} />
                            API Key
                          </Button>
                          <Button
                            variant="quiet"
                            disabled={isBusy || !config.writable}
                            onClick={() => setEditor(provider)}
                          >
                            <Pencil aria-hidden="true" size={15} />
                            编辑
                          </Button>
                          <Button
                            variant="quiet"
                            disabled={isBusy || !config.writable}
                            onClick={() => handleDeleteProvider(provider)}
                          >
                            <Trash2 aria-hidden="true" size={15} />
                            删除
                          </Button>
                        </>
                      ) : (
                        <span className="provider-managed-hint">
                          由{originLabels[provider.origin]}管理
                        </span>
                      )}
                    </div>
                  </header>
                  <dl className="provider-facts">
                    <div>
                      <dt>Endpoint</dt>
                      <dd>
                        <code title={provider.baseURL}>{provider.baseURL}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>凭证</dt>
                      <dd>
                        <span
                          className={`status-pill status-pill--${credentialTone(provider.credentialStatus)}`}
                        >
                          {credentialLabels[provider.credentialStatus]}
                        </span>
                        {provider.credentialSource === "environment" && provider.apiKeyEnv && (
                          <code>{provider.apiKeyEnv}</code>
                        )}
                      </dd>
                    </div>
                  </dl>
                  <div className="provider-models" aria-label={`${provider.id} 模型`}>
                    {provider.models.length > 0 ? (
                      provider.models.map((model) => <code key={model}>{model}</code>)
                    ) : (
                      <span>
                        {provider.discoverModels ? "由 Provider 动态发现模型" : "尚未配置模型"}
                      </span>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      <InlineNotice tone="neutral">
        登录同步尚未开放。Provider 配置仅在当前设备上由 App 和 TUI 共用。
      </InlineNotice>

      <ProviderEditorDialog
        open={editor !== undefined}
        provider={editor ?? undefined}
        busy={isBusy}
        onOpenChange={(open) => {
          if (!open) setEditor(undefined);
        }}
        onSave={actions.upsertProvider}
      />
      <CredentialDialog
        open={credentialEditor !== undefined}
        provider={credentialEditor?.provider}
        expectedRevision={credentialEditor?.revision}
        busy={isBusy}
        onOpenChange={(open) => {
          if (!open) setCredentialEditor(undefined);
        }}
        onSave={actions.setProviderCredential}
        onDelete={actions.deleteProviderCredential}
      />
    </div>
  );
}

function ProviderEditorDialog({
  open,
  provider,
  busy,
  onOpenChange,
  onSave,
}: {
  readonly open: boolean;
  readonly provider?: ProviderView | undefined;
  readonly busy: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (provider: ProviderDraft) => Promise<boolean>;
}) {
  const [id, setId] = useState("");
  const [protocol, setProtocol] = useState<ProviderProtocol>("openai");
  const [baseURL, setBaseURL] = useState("");
  const [models, setModels] = useState("");
  const [discoverModels, setDiscoverModels] = useState(false);

  useEffect(() => {
    if (!open) return;
    setId(provider?.id ?? "");
    setProtocol(provider?.protocol ?? "openai");
    setBaseURL(provider?.baseURL ?? "");
    setModels(provider?.models.join("\n") ?? "");
    setDiscoverModels(provider?.discoverModels ?? false);
  }, [open, provider]);

  const handleProtocolChange = (next: ProviderProtocol) => {
    setProtocol(next);
    if (next !== "openai") setDiscoverModels(false);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedModels = [
      ...new Set(
        models
          .split(/[\n,]/u)
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ];
    const retainedModelCapabilities = provider?.modelCapabilities
      ? Object.fromEntries(
          Object.entries(provider.modelCapabilities).filter(([model]) =>
            normalizedModels.includes(model),
          ),
        )
      : undefined;
    const succeeded = await onSave({
      id: id.trim(),
      protocol,
      baseURL: baseURL.trim(),
      apiKeyEnv: providerApiKeyEnv(provider, protocol),
      models: normalizedModels,
      discoverModels: protocol === "openai" && discoverModels,
      ...(retainedModelCapabilities && Object.keys(retainedModelCapabilities).length > 0
        ? { modelCapabilities: retainedModelCapabilities }
        : {}),
    });
    if (succeeded) onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog provider-dialog"
          aria-describedby="provider-editor-detail"
        >
          <Dialog.Title>{provider ? `编辑 ${provider.id}` : "添加 Provider"}</Dialog.Title>
          <Dialog.Description id="provider-editor-detail">
            模型配置会保存到当前设备。保存 Provider 后，可直接添加 API Key。
          </Dialog.Description>
          <Dialog.Close asChild>
            <IconButton className="dialog__close" label="关闭 Provider 编辑器">
              <X aria-hidden="true" size={17} />
            </IconButton>
          </Dialog.Close>
          <form className="provider-form" onSubmit={(event) => void handleSubmit(event)}>
            <label>
              <span>Provider ID</span>
              <input
                required
                value={id}
                disabled={Boolean(provider)}
                placeholder="openai"
                onChange={(event) => setId(event.currentTarget.value)}
              />
              {provider && <small>ID 创建后不可修改。</small>}
            </label>
            <label>
              <span>协议</span>
              <select
                value={protocol}
                onChange={(event) =>
                  handleProtocolChange(event.currentTarget.value as ProviderProtocol)
                }
              >
                <option value="openai">OpenAI compatible</option>
                <option value="claude">Anthropic Claude</option>
                <option value="gemini">Google Gemini</option>
              </select>
            </label>
            <label className="provider-form__wide">
              <span>Endpoint</span>
              <input
                required
                type="url"
                value={baseURL}
                placeholder="https://api.example.com/v1"
                onChange={(event) => setBaseURL(event.currentTarget.value)}
              />
            </label>
            <label className="provider-discovery-toggle">
              <input
                type="checkbox"
                checked={discoverModels}
                disabled={protocol !== "openai"}
                onChange={(event) => setDiscoverModels(event.currentTarget.checked)}
              />
              <span>允许从 Provider 动态发现模型</span>
            </label>
            <label className="provider-form__wide">
              <span>已知模型</span>
              <textarea
                aria-label="已知模型"
                required
                rows={4}
                value={models}
                placeholder={"gpt-5.4\ngpt-5.4-mini"}
                onChange={(event) => setModels(event.currentTarget.value)}
              />
              <small>至少填写一个可稳定选择的模型；每行一个，也可以使用逗号分隔。</small>
            </label>
            <div className="dialog__actions provider-form__wide">
              <Dialog.Close asChild>
                <Button disabled={busy}>取消</Button>
              </Dialog.Close>
              <Button type="submit" variant="primary" disabled={busy}>
                <Check aria-hidden="true" size={16} />
                {provider ? "保存更改" : "添加 Provider"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CredentialDialog({
  open,
  provider,
  expectedRevision,
  busy,
  onOpenChange,
  onSave,
  onDelete,
}: {
  readonly open: boolean;
  readonly provider?: ProviderView | undefined;
  readonly expectedRevision?: string | undefined;
  readonly busy: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (
    providerId: string,
    secret: string,
    expectedRevision: string,
  ) => Promise<boolean>;
  readonly onDelete: (providerId: string, expectedRevision: string) => Promise<boolean>;
}) {
  const secretInputRef = useRef<HTMLInputElement>(null);

  const clearSecret = () => {
    if (secretInputRef.current) secretInputRef.current.value = "";
  };

  useEffect(() => {
    if (!open && secretInputRef.current) secretInputRef.current.value = "";
  }, [open]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) clearSecret();
    onOpenChange(nextOpen);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const secret = secretInputRef.current?.value ?? "";
    if (!provider || !expectedRevision || !secret) return;
    try {
      const succeeded = await onSave(provider.id, secret, expectedRevision);
      if (succeeded) handleOpenChange(false);
    } finally {
      clearSecret();
    }
  };

  const handleDelete = async () => {
    if (!provider || !expectedRevision) return;
    try {
      const succeeded = await onDelete(provider.id, expectedRevision);
      if (succeeded) handleOpenChange(false);
    } finally {
      clearSecret();
    }
  };

  if (!provider) return null;
  const canDelete = provider.credentialSource === "config";

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog provider-dialog provider-credential-dialog"
          aria-describedby="provider-credential-detail"
        >
          <Dialog.Title>{provider.id} API Key</Dialog.Title>
          <Dialog.Description id="provider-credential-detail">
            API Key 会保存到 ~/.pico/config.json，文件权限为 0600；不会进入会话或 App
            渲染状态。
          </Dialog.Description>
          <Dialog.Close asChild>
            <IconButton className="dialog__close" label="关闭凭证编辑器">
              <X aria-hidden="true" size={17} />
            </IconButton>
          </Dialog.Close>
          <div className="provider-credential-status">
            <span>当前状态</span>
            <strong>{credentialLabels[provider.credentialStatus]}</strong>
          </div>
          {provider.credentialSource === "environment" && (
            <InlineNotice tone="neutral">
              当前仍从环境变量 {provider.apiKeyEnv} 读取旧配置。它仅作为只读兼容来源；在这里保存
              API Key 后，用户配置将优先生效。
            </InlineNotice>
          )}
          {provider.credentialSource === "keychain" && (
            <InlineNotice tone="neutral">
              当前仍在使用旧版系统安全存储中的凭证。它仅作为只读兼容来源；在这里保存 API Key
              后，用户配置将优先生效。
            </InlineNotice>
          )}
          <form className="provider-credential-form" onSubmit={(event) => void handleSubmit(event)}>
            <label>
              <span>API Key / Token</span>
              <input
                ref={secretInputRef}
                required
                type="password"
                autoComplete="off"
                placeholder="输入新凭证"
              />
            </label>
            <div className="dialog__actions">
              {canDelete && (
                <Button type="button" variant="danger" disabled={busy} onClick={handleDelete}>
                  删除配置中的 Key
                </Button>
              )}
              <span className="provider-dialog-spacer" />
              <Dialog.Close asChild>
                <Button disabled={busy}>取消</Button>
              </Dialog.Close>
              <Button type="submit" variant="primary" disabled={busy}>
                保存凭证
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

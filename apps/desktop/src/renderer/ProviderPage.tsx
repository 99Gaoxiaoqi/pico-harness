import * as Dialog from "@radix-ui/react-dialog";
import {
  BrainCircuit,
  Check,
  ChevronRight,
  ArrowLeft,
  Plus,
  Server,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, EmptyState, IconButton, InlineNotice } from "./components.js";
import type {
  ProviderCredentialStatus,
  ProviderDraft,
  ProviderOrigin,
  ProviderProtocol,
  ProviderView,
} from "./model.js";
import type { RuntimeStore } from "./runtime.js";
import { ProviderOnboarding } from "./ProviderOnboarding.js";
import { selectedModelProtocols } from "./provider-presets.js";
import { defaultModelWebSearch } from "./web-search.js";

const protocolLabels: Readonly<Record<ProviderProtocol, string>> = {
  openai: "OpenAI-compatible",
  claude: "Anthropic-compatible",
  responses: "OpenAI Responses",
};

const protocolBaseURLPlaceholders: Readonly<Record<ProviderProtocol, string>> = {
  openai: "https://api.example.com/v1",
  claude: "https://api.example.com",
  responses: "https://api.example.com/v1",
};

const originLabels: Readonly<Record<ProviderOrigin, string>> = {
  user: "当前设备",
  environment: "当前进程环境",
};

const credentialLabels: Readonly<Record<ProviderCredentialStatus, string>> = {
  ready: "API Key 已配置",
  missing: "尚未配置 API Key",
  environment: "环境变量",
  unsupported: "当前来源不可配置",
};

const defaultApiKeyEnvs: Readonly<Record<ProviderProtocol, string>> = {
  openai: "OPENAI_API_KEY",
  claude: "ANTHROPIC_API_KEY",
  responses: "OPENAI_API_KEY",
};

function credentialTone(status: ProviderCredentialStatus): string {
  if (status === "ready" || status === "environment") return "success";
  return status === "missing" ? "warning" : "neutral";
}

function routeOptions(providers: readonly ProviderView[]) {
  return providers
    .filter((provider) => provider.origin === "user")
    .flatMap((provider) =>
      (provider.availableModels ?? provider.models)
        .filter((model) => !provider.disabledModels?.includes(model))
        .map((model) => ({
          id: `${provider.id}/${model}`,
          label: `${model} · ${provider.id}`,
        })),
    );
}

function modelCapability(provider: ProviderView, model: string): Record<string, unknown> {
  const value = provider.resolvedModelCapabilities?.[model];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function modelCapabilitySummary(provider: ProviderView, model: string): string {
  const capability = modelCapability(provider, model);
  const parts = [provider.models.includes(model) ? "已知模型" : "服务商目录"];
  if (capability.displayName && capability.displayName !== model) parts.push(model);
  if (typeof capability.contextWindowTokens === "number") {
    const count = Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 0 })
      .format(capability.contextWindowTokens);
    parts.push(`上下文 ${count}${capability.contextSource === "config" ? "（已配置）" : capability.contextSource === "catalog_snapshot" ? "（目录）" : "（Pico 运行默认）"}`);
  }
  parts.push(typeof capability.maxOutputTokens === "number"
    ? `最大输出 ${Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 0 }).format(capability.maxOutputTokens)}${capability.outputSource === "catalog_snapshot" ? "（目录）" : "（已配置）"}`
    : "最大输出未知");
  const supportLabel = (name: string, support: unknown) =>
    `${name}${support === true ? "支持" : support === false ? "不支持" : "未知"}`;
  parts.push(supportLabel("视觉", capability.vision));
  parts.push(supportLabel("思考", capability.reasoning));
  parts.push(supportLabel("工具", capability.toolCall));
  if (capability.metadataSource === "models_dev_snapshot") parts.push("models.dev 目录");
  return parts.join(" · ");
}

function providerApiKeyEnv(provider: ProviderView | undefined, protocol: ProviderProtocol): string {
  if (!provider) return defaultApiKeyEnvs[protocol];
  const current = provider.apiKeyEnv.trim();
  return !current || current === defaultApiKeyEnvs[provider.protocol]
    ? defaultApiKeyEnvs[protocol]
    : current;
}

export function ProviderPage({ runtime }: { readonly runtime: RuntimeStore }) {
  const { data, actions, busy } = runtime;
  const navigate = useNavigate();
  const { providerId: selectedProviderId } = useParams();
  const config = data.providerConfig;
  const [adding, setAdding] = useState(false);
  const [editor, setEditor] = useState<ProviderView | null>();
  const [credentialEditor, setCredentialEditor] = useState<{
    readonly provider: ProviderView;
    readonly revision: string;
  }>();
  const selectedProvider = config.providers.find((provider) => provider.id === selectedProviderId);
  const models = useMemo(() => routeOptions(config.providers), [config.providers]);
  const isBusy = Boolean(busy);
  const defaultRouteId = config.userDefaults.modelRouteId ?? config.defaultModelRouteId;
  const webSearchCapability = defaultModelWebSearch(config);

  const handleDefaultChange = (modelRouteId: string) => {
    void actions.setDefaultModelRoute(modelRouteId || undefined);
  };

  const handleDeleteProvider = (provider: ProviderView) => {
    if (
      window.confirm(
        `删除服务商/渠道“${provider.id}”？已有会话不会被删除，但恢复时可能需要重新选择模型。`,
      )
    ) {
      void actions.deleteProvider(provider.id).then((deleted) => {
        if (deleted) navigate("/settings/models");
      });
    }
  };

  if (adding) return <ProviderOnboarding runtime={runtime} onClose={() => setAdding(false)} />;

  return (
    <div className="page-stack provider-page">
      <section className="page-intro">
        <div>
          <span className="eyebrow">模型</span>
          <h2>模型连接</h2>
          <p>管理模型、API Key 与默认选择。配置只保存在当前设备，并与 Pico TUI 共用。</p>
        </div>
        {!selectedProvider && (
          <Button
            variant="primary"
            disabled={isBusy || !config.writable}
            onClick={() => setAdding(true)}
          >
            <Plus aria-hidden="true" size={16} />
            添加连接
          </Button>
        )}
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
          模型服务商配置没有完整加载，已暂停编辑以避免覆盖更新的配置。请重新加载后再试。
        </InlineNotice>
      )}

      {config.providers.some(
        (provider) =>
          provider.auth === "none" &&
          provider.baseURL.replace(/\/+$/u, "") === "https://opencode.ai/zen/v1",
      ) && (
        <div className="provider-warning-notice">
          <strong>OpenCode 匿名连接已不可用</strong>
          <p>
            OpenCode 的免费模型仅限其客户端使用，Pico 请求会返回
            403。请添加其他模型连接，切换默认模型及受影响会话的模型。
          </p>
          <a href="https://opencode.ai/docs/zen/" target="_blank" rel="noreferrer">
            查看 OpenCode Zen 接入说明
          </a>
        </div>
      )}

      {selectedProvider && (
        <ProviderDetail
          provider={selectedProvider}
          defaultRouteId={defaultRouteId}
          busy={isBusy}
          onBack={() => navigate("/settings/models")}
          onEdit={() => setEditor(selectedProvider)}
          onCredential={() =>
            setCredentialEditor({ provider: selectedProvider, revision: config.revision })
          }
          onSave={actions.upsertProvider}
          onDefault={actions.setDefaultModelRoute}
          onRefresh={actions.refreshProviders}
          onTest={actions.testProviderConnection}
          onDelete={() => handleDeleteProvider(selectedProvider)}
        />
      )}

      {config.supported && !selectedProvider && (
        <section className="panel provider-defaults" aria-labelledby="provider-default-heading">
          <div>
            <span className="provider-section-icon" aria-hidden="true">
              <BrainCircuit size={17} />
            </span>
            <div>
              <h3 id="provider-default-heading">用户默认模型</h3>
              <p>新会话优先使用这个选择；可信工作区和会话显式选择仍可覆盖它。</p>
              <p>
                原生联网搜索{webSearchCapability.available ? "可用" : "不可用"}：
                {webSearchCapability.detail}
              </p>
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
        </section>
      )}

      {config.supported && !selectedProvider && (
        <section className="panel provider-list-panel" aria-label="模型连接列表">
          {config.providers.length === 0 ? (
            <EmptyState
              icon={<Server aria-hidden="true" />}
              title="还没有模型连接"
              detail="添加连接后，Pico 会在新任务和已有会话中提供这些模型。"
              action={
                <Button
                  variant="primary"
                  disabled={!config.writable}
                  onClick={() => setAdding(true)}
                >
                  <Plus aria-hidden="true" size={16} />
                  添加第一个连接
                </Button>
              }
            />
          ) : (
            <div className="provider-list">
              {config.providers.map((provider) => {
                const defaultModel = defaultRouteId?.startsWith(`${provider.id}/`)
                  ? defaultRouteId.slice(provider.id.length + 1)
                  : undefined;
                return (
                  <article className="provider-card" key={provider.id}>
                    <button
                      type="button"
                      className="provider-card__entry"
                      aria-label={`查看 ${provider.id} 连接详情`}
                      onClick={() => navigate(`/settings/models/${encodeURIComponent(provider.id)}`)}
                    >
                      <span className="provider-card__icon" aria-hidden="true">
                        <Server size={17} />
                      </span>
                      <span className="provider-card__info">
                        <div className="provider-card__title">
                          <strong>{provider.id}</strong>
                          <span className="provider-origin">{originLabels[provider.origin]}</span>
                          {defaultModel && <span className="provider-origin">默认</span>}
                        </div>
                        <span className="provider-card__description">
                          {provider.modelProtocols
                            ? "自动适配模型"
                            : protocolLabels[provider.protocol]}{" "}
                          · {(provider.availableModels ?? provider.models).length} 个模型
                          {defaultModel ? ` · ${defaultModel}` : ""}
                        </span>
                      </span>
                      <span
                        className={`status-pill status-pill--${credentialTone(provider.credentialStatus)}`}
                      >
                        {provider.auth === "none"
                          ? "无需 API Key"
                          : credentialLabels[provider.credentialStatus]}
                      </span>
                      <span className="provider-card__open" aria-hidden="true">
                        查看详情 <ChevronRight size={16} />
                      </span>
                    </button>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      <InlineNotice tone="neutral">
        登录同步尚未开放。模型服务商配置仅在当前设备上由 App 和 TUI 共用。API Key 保存在
        ~/.pico/config.json，文件权限为 0600。
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

function providerDraft(provider: ProviderView): ProviderDraft {
  return {
    id: provider.id,
    protocol: provider.protocol,
    ...(provider.auth ? { auth: provider.auth } : {}),
    ...(provider.modelProtocols ? { modelProtocols: provider.modelProtocols } : {}),
    baseURL: provider.baseURL,
    apiKeyEnv: provider.apiKeyEnv,
    models: provider.models,
    ...(provider.disabledModels ? { disabledModels: provider.disabledModels } : {}),
    discoverModels: provider.discoverModels,
    ...(provider.modelCapabilities ? { modelCapabilities: provider.modelCapabilities } : {}),
  };
}

function ProviderDetail({
  provider,
  defaultRouteId,
  busy,
  onBack,
  onEdit,
  onCredential,
  onSave,
  onDefault,
  onRefresh,
  onTest,
  onDelete,
}: {
  readonly provider: ProviderView;
  readonly defaultRouteId?: string;
  readonly busy: boolean;
  readonly onBack: () => void;
  readonly onEdit: () => void;
  readonly onCredential: () => void;
  readonly onSave: (provider: ProviderDraft) => Promise<boolean>;
  readonly onDefault: (routeId?: string) => Promise<boolean>;
  readonly onRefresh: () => Promise<void>;
  readonly onTest: (providerId: string, model: string) => Promise<{
    readonly ok: boolean;
    readonly durationMs: number;
    readonly message: string;
  }>;
  readonly onDelete: () => void;
}) {
  const [search, setSearch] = useState("");
  const [newModel, setNewModel] = useState("");
  const [addingModel, setAddingModel] = useState(false);
  const [error, setError] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    readonly ok: boolean;
    readonly durationMs: number;
    readonly message: string;
  }>();
  const catalog = provider.availableModels ?? provider.models;
  const disabled = new Set(provider.disabledModels ?? []);
  const enabled = catalog.filter((model) => !disabled.has(model));
  const visible = catalog.filter((model) =>
    model.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  const providerDefault = defaultRouteId?.startsWith(`${provider.id}/`) ? defaultRouteId : "";
  const testModel = enabled.find((model) => `${provider.id}/${model}` === providerDefault) ?? enabled[0];
  const testConnection = async () => {
    if (!testModel) return;
    setTesting(true);
    setTestResult(undefined);
    try {
      setTestResult(await onTest(provider.id, testModel));
    } catch (cause) {
      setTestResult({
        ok: false,
        durationMs: 0,
        message: cause instanceof Error ? cause.message : "测试连接失败",
      });
    } finally {
      setTesting(false);
    }
  };

  const toggleModel = async (model: string) => {
    setError("");
    if (defaultRouteId === `${provider.id}/${model}` && !disabled.has(model)) {
      setError("请先切换默认模型，再停用当前默认模型。");
      return;
    }
    const next = new Set(disabled);
    if (next.has(model)) next.delete(model);
    else next.add(model);
    await onSave({ ...providerDraft(provider), disabledModels: [...next] });
  };

  const addModel = async () => {
    const model = newModel.trim();
    if (!model) return;
    setError("");
    const saved = await onSave({
      ...providerDraft(provider),
      models: [...new Set([...provider.models, model])],
      disabledModels: [...disabled].filter((item) => item !== model),
    });
    if (saved) {
      setNewModel("");
      setAddingModel(false);
    }
  };

  return (
    <section className="provider-detail" aria-label={`${provider.id} 连接详情`}>
      <div className="provider-detail__heading">
        <IconButton label="返回模型连接" onClick={onBack}>
          <ArrowLeft size={18} />
        </IconButton>
        <span className="provider-card__icon">
          <Server size={17} />
        </span>
        <div>
          <h3>{provider.id}</h3>
          <p>
            {protocolLabels[provider.protocol]} · {catalog.length} 个模型
          </p>
        </div>
        <span className="provider-detail__spacer" />
        <label className="provider-detail__default">
          <span>默认模型</span>
          <select
            aria-label={`${provider.id} 默认模型`}
            value={providerDefault}
            disabled={busy || provider.origin !== "user" || enabled.length === 0}
            onChange={(event) => {
              if (event.currentTarget.value) void onDefault(event.currentTarget.value);
            }}
          >
            <option value="">{providerDefault ? "选择模型" : "其他连接或未设置"}</option>
            {enabled.map((model) => (
              <option key={model} value={`${provider.id}/${model}`}>
                {model}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="provider-detail__section-head">
        <div>
          <h4>连接</h4>
          <p>密钥只保存在当前设备。</p>
        </div>
        {provider.origin === "user" && (
          <Button variant="quiet" onClick={onDelete} disabled={busy}>
            <Trash2 aria-hidden="true" size={15} />
            删除连接
          </Button>
        )}
      </div>
      <div className="provider-detail__row">
        <div>
          <strong>名称</strong>
          <small>{provider.id}</small>
        </div>
        {provider.origin === "user" && (
          <Button variant="quiet" onClick={onEdit} disabled={busy}>
            编辑
          </Button>
        )}
      </div>
      <div className="provider-detail__row">
        <div>
          <strong>API Key</strong>
          <small>
            {provider.auth === "none" ? "无需密钥" : credentialLabels[provider.credentialStatus]}
          </small>
        </div>
        {provider.origin === "user" && provider.auth !== "none" && (
          <Button variant="quiet" onClick={onCredential} disabled={busy}>
            更换
          </Button>
        )}
      </div>
      <div className="provider-detail__row">
        <div>
          <strong>服务地址</strong>
          <small className="provider-detail__url">{provider.baseURL}</small>
        </div>
        {provider.origin === "user" && (
          <Button variant="quiet" onClick={onEdit} disabled={busy}>
            编辑
          </Button>
        )}
      </div>
      <div className="provider-detail__row">
        <div>
          <strong>目录状态</strong>
          <small>
            {provider.discoverModels
              ? catalog.length > 0
                ? `已载入 ${catalog.length} 个模型`
                : "尚未获取到模型"
              : "使用手动配置的模型"}
          </small>
        </div>
      </div>
      <div className="provider-detail__row">
        <div>
          <strong>连接状态</strong>
          <small>
            {testing
              ? `正在请求 ${testModel}…`
              : testResult
                ? `${testResult.ok ? "正常" : "失败"} · ${testResult.message}${testResult.durationMs ? ` · ${testResult.durationMs} ms` : ""}`
                : "尚未测试"}
          </small>
        </div>
        <Button variant="quiet" onClick={() => void testConnection()} disabled={busy || testing || !testModel}>
          测试连接
        </Button>
      </div>

      <div className="provider-detail__section-head">
        <div>
          <h4>模型</h4>
          <p>
            已启用 {enabled.length} / {catalog.length} · 启用的模型会出现在任务选择器中。
          </p>
          <p>models.dev 目录参数供参考；Pico 的实际运行限额仍以模型配置为准。</p>
        </div>
        <div className="provider-detail__actions">
          <Button
            variant="quiet"
            onClick={() => void onRefresh()}
            disabled={busy || !provider.discoverModels}
          >
            更新模型目录
          </Button>
          <Button
            variant="quiet"
            onClick={() => setAddingModel(true)}
            disabled={busy || provider.origin !== "user"}
          >
            添加模型
          </Button>
        </div>
      </div>
      {addingModel && (
        <form
          className="provider-detail__add"
          onSubmit={(event) => {
            event.preventDefault();
            void addModel();
          }}
        >
          <input
            aria-label="新模型 ID"
            placeholder="输入模型 ID"
            value={newModel}
            onChange={(event) => setNewModel(event.currentTarget.value)}
            autoFocus
          />
          <Button type="submit" disabled={busy || !newModel.trim()}>
            添加
          </Button>
          <Button variant="quiet" onClick={() => setAddingModel(false)}>
            取消
          </Button>
        </form>
      )}
      <input
        className="provider-detail__search"
        type="search"
        aria-label="搜索模型"
        placeholder="搜索模型名称或 ID"
        value={search}
        onChange={(event) => setSearch(event.currentTarget.value)}
      />
      {error && <InlineNotice tone="warning">{error}</InlineNotice>}
      {visible.length === 0 ? (
        <p className="provider-detail__empty">
          {catalog.length ? "没有匹配的模型" : "目录为空，请检查连接凭证或手动添加模型。"}
        </p>
      ) : (
        visible.map((model) => (
          <div className="provider-detail__row provider-detail__model" key={model}>
            <div>
              <strong>{typeof modelCapability(provider, model).displayName === "string"
                ? String(modelCapability(provider, model).displayName)
                : model}</strong>
              <small>{modelCapabilitySummary(provider, model)}</small>
            </div>
            <button
              className="provider-detail__switch"
              type="button"
              role="switch"
              aria-label={`启用模型 ${model}`}
              aria-checked={!disabled.has(model)}
              disabled={busy || provider.origin !== "user"}
              onClick={() => void toggleModel(model)}
            >
              <span />
            </button>
          </div>
        ))
      )}
    </section>
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
      ...(provider?.auth ? { auth: provider.auth } : {}),
      baseURL: baseURL.trim(),
      apiKeyEnv: providerApiKeyEnv(provider, protocol),
      models: normalizedModels,
      ...(provider?.disabledModels ? { disabledModels: provider.disabledModels } : {}),
      ...(provider?.modelProtocols
        ? {
            modelProtocols: selectedModelProtocols(
              { baseURL, modelProtocols: provider.modelProtocols },
              normalizedModels,
            ),
          }
        : {}),
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
          <Dialog.Title>{provider ? `编辑 ${provider.id}` : "添加模型服务商"}</Dialog.Title>
          <Dialog.Description id="provider-editor-detail">
            {provider?.auth === "none"
              ? "此连接无需 API Key。修改模型或地址后，将继续使用匿名请求。"
              : "配置服务商或网关渠道。保存后，在服务商卡片中点击“API Key”添加凭证。"}
          </Dialog.Description>
          <Dialog.Close asChild>
            <IconButton className="dialog__close" label="关闭 Provider 编辑器">
              <X aria-hidden="true" size={17} />
            </IconButton>
          </Dialog.Close>
          <form className="provider-form" onSubmit={(event) => void handleSubmit(event)}>
            <label>
              <span>服务商 / 渠道 ID</span>
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
              <span>{provider?.modelProtocols ? "默认 API 协议" : "API 协议"}</span>
              <select
                value={protocol}
                onChange={(event) =>
                  handleProtocolChange(event.currentTarget.value as ProviderProtocol)
                }
              >
                <option value="openai">OpenAI-compatible</option>
                <option value="claude">Anthropic-compatible</option>
                <option value="responses">OpenAI Responses</option>
              </select>
              <small>
                {provider?.modelProtocols
                  ? "已配置的模型会自动使用各自的协议；此项仅用于其他模型。"
                  : "协议只决定请求格式，不限制模型厂商。"}
              </small>
            </label>
            <label className="provider-form__wide">
              <span>{protocolLabels[protocol]} Base URL</span>
              <input
                required
                type="url"
                value={baseURL}
                placeholder={protocolBaseURLPlaceholders[protocol]}
                onChange={(event) => setBaseURL(event.currentTarget.value)}
              />
              <small>填写与所选协议兼容的服务商、网关或团队渠道地址。</small>
            </label>
            <label className="provider-discovery-toggle">
              <input
                type="checkbox"
                checked={discoverModels}
                disabled={protocol !== "openai"}
                onChange={(event) => setDiscoverModels(event.currentTarget.checked)}
              />
              <span>允许从服务商动态发现模型</span>
            </label>
            <label className="provider-form__wide">
              <span>已知模型</span>
              <textarea
                aria-label="已知模型"
                required={!discoverModels}
                rows={4}
                value={models}
                placeholder={"gpt-5.4\ngpt-5.4-mini"}
                onChange={(event) => setModels(event.currentTarget.value)}
              />
              <small>
                开启动态发现时可留空；否则至少填写一个模型。每行一个，也可以使用逗号分隔。
              </small>
            </label>
            <div className="dialog__actions provider-form__wide">
              <Dialog.Close asChild>
                <Button disabled={busy}>取消</Button>
              </Dialog.Close>
              <Button type="submit" variant="primary" disabled={busy}>
                <Check aria-hidden="true" size={16} />
                {provider ? "保存更改" : "添加服务商"}
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
    if (
      !window.confirm(
        `删除 ${provider.id} 保存在当前设备上的 API Key？删除后，使用该服务商的新请求将无法发送，直到重新配置凭证。`,
      )
    ) {
      return;
    }
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
            API Key 会保存到 ~/.pico/config.json，文件权限为 0600；不会进入会话或 App 渲染状态。
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
              当前从环境变量 {provider.apiKeyEnv} 读取 API Key。在这里保存后，用户配置将优先生效。
            </InlineNotice>
          )}
          {provider.credentialSource === "keychain" && (
            <InlineNotice tone="neutral">
              当前使用 Pico 系统安全存储中的凭证。在这里保存 API Key 后，用户配置将优先生效。
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

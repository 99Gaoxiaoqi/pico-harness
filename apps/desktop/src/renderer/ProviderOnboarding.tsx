import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Network,
  Search,
  Server,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, IconButton, InlineNotice } from "./components.js";
import {
  nextProviderId,
  providerPresets,
  selectedModelProtocols,
  unsupportedProviderPresets,
  type ProviderPreset,
} from "./provider-presets.js";
import type { RuntimeStore } from "./runtime.js";
const providerMarks = import.meta.glob<string>("./assets/provider-brands/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});

function ProviderMark({ preset }: { readonly preset: ProviderPreset }) {
  const source = providerMarks[`./assets/provider-brands/${preset.icon ?? preset.id}.svg`];
  return (
    <span className="provider-catalog-mark" aria-hidden="true">
      {source ? (
        <img src={source} alt="" />
      ) : preset.category === "api" ? (
        <Server size={19} />
      ) : (
        <Network size={19} />
      )}
    </span>
  );
}

export function ProviderOnboarding({
  runtime,
  onClose,
}: {
  readonly runtime: RuntimeStore;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [preset, setPreset] = useState<ProviderPreset>();
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!preset) searchRef.current?.focus();
  }, [preset]);
  const matches = providerPresets.filter(
    (item) =>
      (category === "all" || item.category === category) &&
      `${item.name} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const unsupportedMatches =
    category === "all"
      ? unsupportedProviderPresets.filter((item) =>
          `${item.name} ${item.reason}`.toLowerCase().includes(query.trim().toLowerCase()),
        )
      : [];

  return (
    <div className="page-stack provider-page provider-onboarding">
      <section className="page-intro">
        <div>
          <h2>模型</h2>
          <p>模型连接、API Key 与默认模型管理。</p>
        </div>
      </section>
      {preset ? (
        <ProviderSetup
          key={preset.id}
          preset={preset}
          runtime={runtime}
          onBack={() => setPreset(undefined)}
          onComplete={onClose}
        />
      ) : (
        <section aria-labelledby="provider-catalog-title">
          <div className="provider-flow-heading">
            <IconButton label="返回模型连接" onClick={onClose}>
              <ArrowLeft size={16} />
            </IconButton>
            <div>
              <h3 id="provider-catalog-title">添加连接</h3>
              <p>选择模型服务商、订阅计划、聚合服务或本地模型。</p>
            </div>
          </div>
          <div className="provider-catalog-filters">
            <label className="provider-catalog-search">
              <Search size={15} aria-hidden="true" />
              <input
                ref={searchRef}
                aria-label="搜索模型服务商"
                placeholder="搜索服务商"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
            <select
              aria-label="分类"
              value={category}
              onChange={(event) => setCategory(event.currentTarget.value)}
            >
              <option value="all">全部</option>
              <option value="api">官方 API</option>
              <option value="plans">订阅计划</option>
              <option value="aggregator">聚合服务</option>
              <option value="local">本地模型</option>
              <option value="custom">自定义</option>
            </select>
          </div>
          <div className="provider-catalog-list" aria-label="模型服务商目录">
            {matches.map((item) => (
              <button
                type="button"
                className="provider-catalog-row"
                key={item.id}
                onClick={() => setPreset(item)}
              >
                <ProviderMark preset={item} />
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.description}</small>
                </span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            ))}
          </div>
          {unsupportedMatches.length > 0 && (
            <details className="provider-unavailable" open={Boolean(query.trim())}>
              <summary>其他连接方式 · 暂未支持</summary>
              {unsupportedMatches.map((item) => (
                <div key={item.id}>
                  <strong>{item.name}</strong>
                  <p>{item.reason}</p>
                </div>
              ))}
            </details>
          )}
          {matches.length === 0 && unsupportedMatches.length === 0 && (
            <div className="provider-catalog-empty" role="status">
              <p>没有匹配的服务商</p>
              <Button
                onClick={() => {
                  setQuery("");
                  setCategory("all");
                }}
              >
                清除筛选
              </Button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function ProviderSetup({
  preset,
  runtime,
  onBack,
  onComplete,
}: {
  readonly preset: ProviderPreset;
  readonly runtime: RuntimeStore;
  readonly onBack: () => void;
  readonly onComplete: () => void;
}) {
  const anonymous = preset.auth === "none";
  const free = preset.id === "opencode-free";
  const [id, setId] = useState(() =>
    nextProviderId(
      preset.id,
      runtime.data.providerConfig.providers.map((p) => p.id),
    ),
  );
  const [baseURL, setBaseURL] = useState(preset.baseURL);
  const [advanced, setAdvanced] = useState(!preset.baseURL);
  const [showSecret, setShowSecret] = useState(false);
  const [step, setStep] = useState<"credentials" | "models">(anonymous ? "models" : "credentials");
  const [selected, setSelected] = useState<readonly string[]>(preset.models.slice(0, 1));
  const [customModels, setCustomModels] = useState("");
  const [discoverModels, setDiscoverModels] = useState(false);
  const [error, setError] = useState("");
  const [attempted, setAttempted] = useState(false);
  const secretRef = useRef<HTMLInputElement>(null);
  const modelHeadingRef = useRef<HTMLHeadingElement>(null);
  const submittingRef = useRef(false);
  const busy = Boolean(runtime.busy);
  const existing = runtime.data.providerConfig.providers.some((p) => p.id === id.trim());
  const partial = attempted && existing;
  const blocked = busy || partial || !runtime.data.providerConfig.writable;

  useEffect(() => {
    if (step === "credentials") secretRef.current?.focus();
    else modelHeadingRef.current?.focus();
  }, [step]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blocked || submittingRef.current) return;
    setError("");
    if (existing) {
      setAdvanced(true);
      setError("连接 ID 已存在，请使用另一个 ID。");
      return;
    }
    if (!anonymous && !secretRef.current?.value.trim()) {
      setStep("credentials");
      setError("请输入 API Key。");
      return;
    }
    if (!id.trim() || !/^[a-zA-Z0-9_-]+$/u.test(id.trim())) {
      setAdvanced(true);
      setStep("credentials");
      setError("请填写有效的连接 ID，仅使用字母、数字、连字符或下划线。");
      return;
    }
    try {
      const endpoint = new URL(baseURL);
      if (
        /[{}<>]/u.test(baseURL) ||
        !["https:", "http:"].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password
      )
        throw new Error();
    } catch {
      setAdvanced(true);
      setStep("credentials");
      setError("请填写有效的 HTTP 或 HTTPS 服务地址。");
      return;
    }
    if (step === "credentials") {
      setStep("models");
      return;
    }
    const models = [
      ...new Set([
        ...selected,
        ...customModels
          .split(/[\n,]/u)
          .map((value) => value.trim())
          .filter(Boolean),
      ]),
    ];
    if (!models.length) {
      setError("请至少选择或填写一个模型。");
      return;
    }
    submittingRef.current = true;
    try {
      const success = await runtime.actions.upsertProvider(
        {
          id: id.trim(),
          protocol: preset.protocol,
          ...(preset.auth ? { auth: preset.auth } : {}),
          baseURL: baseURL.trim(),
          apiKeyEnv: preset.apiKeyEnv,
          models,
          ...(preset.modelProtocols
            ? { modelProtocols: selectedModelProtocols(preset, models) }
            : {}),
          discoverModels,
        },
        anonymous ? undefined : secretRef.current?.value.trim(),
        true,
      );
      if (success) onComplete();
      else {
        setAttempted(true);
        setStep("credentials");
        setError("保存未完成。请查看下方提示或返回连接列表检查最新状态。");
      }
    } finally {
      if (secretRef.current) secretRef.current.value = "";
      setShowSecret(false);
      submittingRef.current = false;
    }
  };

  return (
    <section aria-labelledby="provider-setup-title">
      <div className="provider-flow-heading">
        <IconButton label="返回服务商列表" disabled={busy} onClick={onBack}>
          <ArrowLeft size={16} />
        </IconButton>
        <ProviderMark preset={preset} />
        <div>
          <h3 id="provider-setup-title">连接 {preset.name}</h3>
          <p>完成配置后，连接会出现在模型列表中。</p>
        </div>
      </div>
      <form className="provider-setup-form" noValidate onSubmit={(event) => void submit(event)}>
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
        {partial && (
          <InlineNotice tone="warning">
            {anonymous
              ? "连接已存在，请返回模型连接检查最新保存状态，避免重复创建。"
              : "连接已存在，凭证保存状态需要检查。请返回模型连接，通过“API Key”继续配置，避免重复创建。"}
          </InlineNotice>
        )}
        {runtime.data.notices.providers && (
          <InlineNotice tone="error">{runtime.data.notices.providers}</InlineNotice>
        )}
        {free && (
          <div className="provider-free-notice">
            <strong>免费试用 · 无需 API Key</strong>
            <p>
              通过 OpenCode Zen 访问免费模型，按 IP
              限流。免费额度和可用模型可能变化；请勿提交个人或机密信息。
            </p>
            <a href="https://opencode.ai/docs/zen#privacy" target="_blank" rel="noreferrer">
              了解免费模型与数据使用说明
            </a>
          </div>
        )}
        {anonymous && !free && (
          <p className="provider-model-hint">
            此连接无需 API Key，请确认本地服务已启动并填写已安装的模型。
          </p>
        )}
        <fieldset disabled={blocked} hidden={step !== "credentials"}>
          {!anonymous && (
            <>
              <label htmlFor="provider-setup-key">
                API Key <span className="provider-required">· 必填</span>
              </label>
              <div className="provider-key-input">
                <input
                  id="provider-setup-key"
                  ref={secretRef}
                  required={step === "credentials"}
                  type={showSecret ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="输入或粘贴 API Key"
                />
                <IconButton
                  label={showSecret ? "隐藏 API Key" : "显示 API Key"}
                  onClick={() => setShowSecret(!showSecret)}
                >
                  {showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
                </IconButton>
              </div>
            </>
          )}
          <button
            type="button"
            className="provider-advanced-toggle"
            aria-expanded={advanced}
            aria-controls="provider-advanced-fields"
            onClick={() => setAdvanced(!advanced)}
          >
            {advanced ? "收起" : "展开"}高级请求设置
            <ChevronDown size={16} />
          </button>
          <div
            id="provider-advanced-fields"
            className="provider-advanced-fields"
            hidden={!advanced}
          >
            <label>
              <span>连接 ID</span>
              <input
                value={id}
                required
                pattern="[a-zA-Z0-9_-]+"
                onChange={(event) => setId(event.currentTarget.value)}
              />
            </label>
            <label>
              <span>Base URL</span>
              <input
                type="url"
                required
                value={baseURL}
                readOnly={free}
                placeholder={preset.baseURLPlaceholder ?? "https://api.example.com/v1"}
                onChange={(event) => setBaseURL(event.currentTarget.value)}
              />
            </label>
            <p>
              协议：
              {preset.modelProtocols
                ? "随模型自动适配"
                : preset.protocol === "openai"
                  ? "OpenAI Chat Completions"
                  : preset.protocol === "responses"
                    ? "OpenAI Responses"
                    : "Anthropic Messages"}
            </p>
          </div>
          {preset.docs && (
            <a className="provider-doc-link" href={preset.docs} target="_blank" rel="noreferrer">
              查看服务商接入文档
            </a>
          )}
        </fieldset>
        <fieldset disabled={blocked} hidden={step !== "models"}>
          <h4 ref={modelHeadingRef} tabIndex={-1}>
            选择模型
          </h4>
          <p className="provider-model-hint">
            {free
              ? "使用内置免费模型。服务不可用时会提示错误，不会自动切换到付费模型。"
              : preset.modelProtocols
                ? "选择要使用的模型，Pico 会自动适配连接。同一份 API Key 即可使用所选模型；可用性以账户权限为准。"
                : "预设模型可按需选择，也可填写其他模型 ID。可用性以你的账户权限为准。"}
          </p>
          <div className="provider-model-choices">
            {preset.models.map((model) => (
              <label key={model}>
                <input
                  type="checkbox"
                  checked={selected.includes(model)}
                  onChange={(event) =>
                    setSelected(
                      event.currentTarget.checked
                        ? [...selected, model]
                        : selected.filter((value) => value !== model),
                    )
                  }
                />
                <span>{model}</span>
              </label>
            ))}
          </div>
          {!free && (
            <label>
              <span>{preset.models.length ? "其他模型 ID（可选）" : "模型 ID"}</span>
              <textarea
                value={customModels}
                rows={3}
                placeholder="填写模型 ID，每行一个"
                onChange={(event) => setCustomModels(event.currentTarget.value)}
              />
            </label>
          )}
          {preset.protocol === "openai" && !free && (
            <label className="provider-discovery-toggle">
              <input
                type="checkbox"
                checked={discoverModels}
                onChange={(event) => setDiscoverModels(event.currentTarget.checked)}
              />
              <span>允许获取服务商模型列表</span>
            </label>
          )}
          {preset.docs && (
            <a className="provider-doc-link" href={preset.docs} target="_blank" rel="noreferrer">
              查看服务商文档
            </a>
          )}
        </fieldset>
        <div className="provider-setup-actions">
          {partial ? (
            <Button onClick={onComplete}>返回模型连接</Button>
          ) : (
            <>
              <Button
                disabled={busy}
                onClick={step === "models" ? () => setStep("credentials") : onBack}
              >
                {step === "models" ? (anonymous ? "连接设置" : "上一步") : "取消"}
              </Button>
              <Button type="submit" variant="primary" disabled={blocked}>
                {busy ? "正在保存…" : step === "credentials" ? "下一步" : "保存供应商"}
              </Button>
            </>
          )}
        </div>
      </form>
    </section>
  );
}

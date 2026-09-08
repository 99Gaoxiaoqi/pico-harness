import {
  isSafeSubagentPresetId,
  MAX_SUBAGENT_PRESETS,
  SUBAGENT_PRESET_DESCRIPTION_MAX_CHARS,
  SUBAGENT_PRESET_ID_MAX_CHARS,
  SUBAGENT_PRESET_NAME_MAX_CHARS,
  SUBAGENT_PROFILES,
  type RuntimeSubagentPreset,
  type RuntimeSubagentSettingsSnapshot,
  type SubagentProfile,
  type SubagentThinkingLevel,
} from "@pico/protocol";
import { ArrowLeft, Bot, ChevronRight, Plus } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button, EmptyState, InlineNotice } from "../components.js";
import {
  createSubagentDraft,
  limitSubagentText,
  selectableSubagentConnection,
  SUBAGENT_PROFILE_COPY,
  subagentPresetForWrite,
  subagentProblem,
  suggestSubagentPresetId,
} from "./subagent-settings-form.js";

export interface SubagentSettingsPageProps {
  readonly snapshot: RuntimeSubagentSettingsSnapshot;
  readonly onUpdate: (
    presets: readonly RuntimeSubagentPreset[],
    expectedRevision: string,
  ) => Promise<RuntimeSubagentSettingsSnapshot>;
}

type PageRoute = { kind: "list" } | { kind: "create" } | { kind: "edit"; id: string };

/** Parent owns the Host snapshot and refresh notifications; the page owns only unsaved UI state. */
export function SubagentSettingsPage({ snapshot, onUpdate }: SubagentSettingsPageProps) {
  const [route, setRoute] = useState<PageRoute>({ kind: "list" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const savingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const returnFocusId = useRef<string | undefined>(undefined);
  const previousLevel = useRef("list");
  const titleId = useId();
  const preset =
    route.kind === "edit" ? snapshot.presets.find((item) => item.id === route.id) : undefined;
  const level = route.kind === "edit" && !preset ? "list" : route.kind;

  useEffect(() => {
    // A deletion can remove the edit route while its write is still pending.
    // Wait until navigation is enabled before restoring focus to a list control.
    if (saving || level === previousLevel.current) return;
    previousLevel.current = level;
    if (level !== "list") {
      detailRef.current?.focus();
    } else {
      const target = [
        ...(rootRef.current?.querySelectorAll<HTMLButtonElement>("[data-subagent-preset]") ?? []),
      ].find((button) => button.dataset.subagentPreset === returnFocusId.current);
      (target ?? addButtonRef.current)?.focus();
      returnFocusId.current = undefined;
    }
  }, [level, saving]);

  async function persist(
    next: readonly RuntimeSubagentPreset[],
    expectPresent?: string,
  ): Promise<boolean> {
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setError(undefined);
    try {
      const result = await onUpdate(next.map(subagentPresetForWrite), snapshot.revision);
      if (expectPresent && !result.presets.some((item) => item.id === expectPresent)) {
        throw new Error("保存结果中未找到此配置，请检查配置内容后重试。");
      }
      return true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "无法保存子 Agent 配置，请重试。");
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function open(next: PageRoute) {
    returnFocusId.current = next.kind === "edit" ? next.id : undefined;
    setError(undefined);
    setRoute(next);
  }

  const addButton = (
    <Button
      ref={addButtonRef}
      variant="primary"
      disabled={saving || snapshot.presets.length >= MAX_SUBAGENT_PRESETS}
      title={
        snapshot.presets.length >= MAX_SUBAGENT_PRESETS
          ? "最多可创建 64 个子 Agent 配置"
          : undefined
      }
      onClick={() => open({ kind: "create" })}
    >
      <Plus aria-hidden="true" size={16} />
      新建子 Agent
    </Button>
  );

  return (
    <div ref={rootRef} className="page-stack subagent-settings">
      {level === "list" ? (
        <>
          <header className="page-intro">
            <div>
              <span className="eyebrow">协作能力</span>
              <h2>子 Agent</h2>
              <p>已配置 {snapshot.presets.length} 个子 Agent</p>
            </div>
            {snapshot.presets.length > 0 && addButton}
          </header>
          {error && <InlineNotice tone="error">{error}</InlineNotice>}
          <section
            className="panel subagent-settings__list"
            aria-label="子 Agent 配置列表"
            aria-busy={saving}
          >
            {snapshot.presets.length === 0 ? (
              <EmptyState
                icon={<Bot aria-hidden="true" />}
                title="还没有子 Agent"
                detail="为主 Agent 配置可委派的能力和模型。"
                action={addButton}
              />
            ) : (
              snapshot.presets.map((item) => {
                const problem = subagentProblem(item);
                return (
                  <div key={item.id} className="subagent-settings__row">
                    <div className="subagent-settings__row-copy">
                      <div className="subagent-settings__row-title">
                        <strong>{item.name}</strong>
                        {problem && <span className="subagent-settings__badge">{problem}</span>}
                      </div>
                      <p>{item.description || "说明何时适合将任务交给这个子 Agent。"}</p>
                    </div>
                    <label className="subagent-settings__switch">
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label={`启用：${item.name}`}
                        checked={item.enabled}
                        disabled={saving}
                        onChange={(event) =>
                          void persist(
                            snapshot.presets.map((candidate) =>
                              candidate.id === item.id
                                ? { ...candidate, enabled: event.target.checked }
                                : candidate,
                            ),
                          )
                        }
                      />
                      <span aria-hidden="true" />
                    </label>
                    <Button
                      variant="quiet"
                      aria-label={`配置 ${item.name}`}
                      title={`配置 ${item.name}`}
                      data-subagent-preset={item.id}
                      disabled={saving}
                      onClick={() => open({ kind: "edit", id: item.id })}
                    >
                      <ChevronRight size={18} aria-hidden="true" />
                    </Button>
                  </div>
                );
              })
            )}
          </section>
        </>
      ) : (
        <section
          ref={detailRef}
          tabIndex={-1}
          aria-labelledby={titleId}
          className="subagent-settings__detail"
        >
          <header className="subagent-settings__detail-header">
            <Button
              variant="quiet"
              aria-label="返回子 Agent 列表"
              disabled={saving}
              onClick={() => setRoute({ kind: "list" })}
            >
              <ArrowLeft size={18} aria-hidden="true" />
              返回
            </Button>
            <div>
              <h2 id={titleId}>{preset?.name ?? "新建子 Agent"}</h2>
              <p>
                {preset
                  ? "调整这个子 Agent 的能力和模型。"
                  : "设置用途、能力和模型，供主 Agent 委派任务。"}
              </p>
            </div>
          </header>
          {error && <InlineNotice tone="error">{error}</InlineNotice>}
          <SubagentPresetEditor
            key={preset?.id ?? "new"}
            preset={preset}
            snapshot={snapshot}
            saving={saving}
            onCancel={() => setRoute({ kind: "list" })}
            onSave={async (next) => {
              const nextPresets = preset
                ? snapshot.presets.map((item) => (item.id === preset.id ? next : item))
                : [...snapshot.presets, next];
              if (await persist(nextPresets, next.id)) setRoute({ kind: "list" });
            }}
            onDelete={
              preset
                ? async () => {
                    if (
                      !window.confirm(
                        `删除子 Agent“${preset.name}”？此操作不会删除已完成的任务记录。`,
                      )
                    )
                      return;
                    if (await persist(snapshot.presets.filter((item) => item.id !== preset.id)))
                      setRoute({ kind: "list" });
                  }
                : undefined
            }
          />
        </section>
      )}
    </div>
  );
}

function SubagentPresetEditor({
  preset,
  snapshot,
  saving,
  onCancel,
  onSave,
  onDelete,
}: {
  readonly preset: RuntimeSubagentPreset | undefined;
  readonly snapshot: RuntimeSubagentSettingsSnapshot;
  readonly saving: boolean;
  readonly onCancel: () => void;
  readonly onSave: (next: RuntimeSubagentPreset) => Promise<void>;
  readonly onDelete: (() => Promise<void>) | undefined;
}) {
  const [draft, setDraft] = useState(() => createSubagentDraft(preset, snapshot.connections));
  const [idWasEdited, setIdWasEdited] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const formId = useId();
  const existingIds = new Set(
    snapshot.presets.filter((item) => item.id !== preset?.id).map((item) => item.id),
  );
  const usableConnections = snapshot.connections.filter(selectableSubagentConnection);
  const connection = snapshot.connections.find((item) => item.id === draft.connectionSlug);
  const models = connection?.models.filter((item) => item.offerable) ?? [];
  const thinkingLevels =
    connection?.models.find((item) => item.id === draft.model)?.thinkingLevels ?? [];
  const validConnection = Boolean(connection && selectableSubagentConnection(connection));
  const validModel = models.some((item) => item.id === draft.model);
  const validId = isSafeSubagentPresetId(draft.id.trim());
  const duplicateId = existingIds.has(draft.id.trim());
  const atLimit = !preset && snapshot.presets.length >= MAX_SUBAGENT_PRESETS;
  const errors = {
    name: !draft.name.trim() ? "请输入名称。" : undefined,
    id: !validId
      ? `ID 仅支持字母、数字、点、下划线、冒号和连字符，最多 ${SUBAGENT_PRESET_ID_MAX_CHARS} 个字符。`
      : duplicateId
        ? "此 ID 已存在，请使用其他 ID。"
        : undefined,
    connection: !validConnection ? "请选择可用的连接。" : undefined,
    model: validConnection && !validModel ? "请选择可用的模型。" : undefined,
  };
  const errorNode = (field: keyof typeof errors) =>
    submitted && errors[field] ? (
      <small
        className="subagent-settings__field-error"
        id={`${formId}-${field}-error`}
        role="alert"
      >
        {errors[field]}
      </small>
    ) : null;
  const errorId = (field: keyof typeof errors) =>
    submitted && errors[field] ? `${formId}-${field}-error` : undefined;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (
      saving ||
      atLimit ||
      errors.name ||
      (!preset && errors.id) ||
      !validConnection ||
      !validModel
    )
      return;
    await onSave({
      id: preset?.id ?? draft.id.trim(),
      name: draft.name.trim(),
      description: draft.description.trim(),
      profile: draft.profile,
      connectionSlug: draft.connectionSlug,
      model: draft.model,
      ...(draft.thinkingLevel && thinkingLevels.includes(draft.thinkingLevel)
        ? { thinkingLevel: draft.thinkingLevel }
        : {}),
      enabled: draft.enabled,
    });
  }

  return (
    <form
      className="subagent-settings__form"
      noValidate
      onSubmit={(event) => void submit(event)}
      aria-busy={saving}
    >
      <fieldset className="panel subagent-settings__group" disabled={saving}>
        <legend>用途</legend>
        <label>
          <span>名称</span>
          <input
            value={draft.name}
            placeholder="例如：代码审查"
            aria-invalid={Boolean(submitted && errors.name)}
            aria-describedby={errorId("name")}
            onChange={(event) => {
              const name = limitSubagentText(event.target.value, SUBAGENT_PRESET_NAME_MAX_CHARS);
              setDraft((current) => ({
                ...current,
                name,
                ...(!preset && !idWasEdited
                  ? { id: suggestSubagentPresetId(name, existingIds) }
                  : {}),
              }));
            }}
          />
          {errorNode("name")}
        </label>
        <label>
          <span>使用说明（可选）</span>
          <textarea
            rows={3}
            placeholder="描述主 Agent 应在什么情况下使用它。"
            value={draft.description}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                description: limitSubagentText(
                  event.target.value,
                  SUBAGENT_PRESET_DESCRIPTION_MAX_CHARS,
                ),
              }))
            }
          />
          <small className="subagent-settings__counter">
            {draft.description.trim().length} / {SUBAGENT_PRESET_DESCRIPTION_MAX_CHARS}
          </small>
        </label>
        {preset ? (
          <div className="subagent-settings__id">
            <span>ID</span>
            <code>{preset.id}</code>
            <small>创建后保持不变，主 Agent 和历史任务会用它识别此配置。</small>
          </div>
        ) : (
          <label>
            <span>ID</span>
            <input
              value={draft.id}
              placeholder="例如：code-review"
              aria-invalid={Boolean(submitted && errors.id)}
              aria-describedby={errorId("id")}
              onChange={(event) => {
                setIdWasEdited(true);
                setDraft((current) => ({ ...current, id: event.target.value }));
              }}
            />
            <small>创建后保持不变，主 Agent 和历史任务会用它识别此配置。</small>
            {errorNode("id")}
          </label>
        )}
      </fieldset>
      <fieldset className="panel subagent-settings__group" disabled={saving}>
        <legend>能力与模型</legend>
        <label>
          <span>能力</span>
          <select
            value={draft.profile}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                profile: event.target.value as SubagentProfile,
              }))
            }
          >
            {SUBAGENT_PROFILES.map((profile) => (
              <option key={profile} value={profile}>
                {SUBAGENT_PROFILE_COPY[profile].label}
              </option>
            ))}
          </select>
          <small>{SUBAGENT_PROFILE_COPY[draft.profile].description}</small>
        </label>
        {draft.profile === "implementation" && (
          <InlineNotice tone="warning">
            实现代码可以写文件和执行命令，并会在隔离 worktree 中运行。
          </InlineNotice>
        )}
        <label>
          <span>连接</span>
          <select
            value={draft.connectionSlug}
            disabled={saving || usableConnections.length === 0}
            aria-invalid={Boolean(submitted && errors.connection)}
            aria-describedby={errorId("connection")}
            onChange={(event) => {
              const connectionSlug = event.target.value;
              const next = usableConnections.find((item) => item.id === connectionSlug);
              setDraft((current) => ({
                ...current,
                connectionSlug,
                model: next?.models.find((item) => item.offerable)?.id ?? "",
                thinkingLevel: "",
              }));
            }}
          >
            {!draft.connectionSlug && <option value="">请选择连接</option>}
            {draft.connectionSlug && !connection && (
              <option value={draft.connectionSlug} disabled>
                {draft.connectionSlug} · 连接已删除
              </option>
            )}
            {snapshot.connections.map((item) => (
              <option key={item.id} value={item.id} disabled={!selectableSubagentConnection(item)}>
                {item.name}
                {item.retired ? " · 服务商已停止支持" : !item.enabled ? " · 已停用" : ""}
              </option>
            ))}
          </select>
          {usableConnections.length === 0 && <small>请先在模型设置中添加并启用连接。</small>}
          {errorNode("connection")}
        </label>
        <label>
          <span>模型</span>
          <select
            value={draft.model}
            disabled={saving || models.length === 0}
            aria-invalid={Boolean(submitted && errors.model)}
            aria-describedby={errorId("model")}
            onChange={(event) =>
              setDraft((current) => ({ ...current, model: event.target.value, thinkingLevel: "" }))
            }
          >
            {!draft.model && <option value="">请选择模型</option>}
            {draft.model && !validModel && (
              <option value={draft.model} disabled>
                {draft.model} · 模型不可用
              </option>
            )}
            {models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id}
              </option>
            ))}
          </select>
          {models.length === 0 && <small>此连接没有可用模型。</small>}
          {errorNode("model")}
        </label>
        {thinkingLevels.length > 0 && (
          <label>
            <span>思考级别</span>
            <select
              value={
                draft.thinkingLevel && thinkingLevels.includes(draft.thinkingLevel)
                  ? draft.thinkingLevel
                  : ""
              }
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  thinkingLevel: event.target.value as SubagentThinkingLevel | "",
                }))
              }
            >
              <option value="">跟随模型默认</option>
              {thinkingLevels.map((level) => (
                <option key={level} value={level}>
                  {
                    {
                      off: "关闭",
                      minimal: "最少",
                      low: "低",
                      medium: "中",
                      high: "高",
                      xhigh: "更高",
                      max: "最高",
                    }[level]
                  }
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="subagent-settings__enabled">
          <input
            type="checkbox"
            role="switch"
            checked={draft.enabled}
            onChange={(event) =>
              setDraft((current) => ({ ...current, enabled: event.target.checked }))
            }
          />
          <span>启用此子 Agent</span>
        </label>
        <small>启用后，主 Agent 可以选择此配置来委派任务。</small>
      </fieldset>
      {atLimit && (
        <InlineNotice tone="warning">
          最多可创建 64 个子 Agent 配置，请先删除不再使用的配置。
        </InlineNotice>
      )}
      <div className="button-row">
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? "正在保存…" : preset ? "保存" : "创建"}
        </Button>
        <Button disabled={saving} onClick={onCancel}>
          取消
        </Button>
      </div>
      {onDelete && (
        <section className="panel subagent-settings__danger">
          <h3>删除此子 Agent</h3>
          <p>删除配置后，主 Agent 将无法再选择它，已有任务记录会保留。</p>
          <Button variant="danger" disabled={saving} onClick={() => void onDelete()}>
            删除子 Agent
          </Button>
        </section>
      )}
    </form>
  );
}

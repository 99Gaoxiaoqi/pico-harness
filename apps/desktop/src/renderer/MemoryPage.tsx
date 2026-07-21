import {
  Archive,
  ArchiveRestore,
  BrainCircuit,
  Check,
  CircleOff,
  Pencil,
  RefreshCw,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type {
  RuntimeMemoryFact,
  RuntimeMemoryProposal,
  RuntimeMemorySettings,
} from "@pico/protocol";
import { Button, EmptyState, IconButton, InlineNotice } from "./components.js";
import type { RuntimeStore } from "./runtime.js";

const panels = ["pending", "enabled", "archived"] as const;
type PanelId = (typeof panels)[number];

const panelLabels: Readonly<Record<PanelId, string>> = {
  pending: "待审核",
  enabled: "已启用",
  archived: "未启用与归档",
};

const kindLabels: Readonly<Record<RuntimeMemoryFact["kind"], string>> = {
  preference: "偏好",
  correction: "纠正",
  project_fact: "项目事实",
  reference: "参考",
};

export function nextMemoryTabIndex(current: number, key: string, count = panels.length): number {
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowRight") return (current + 1) % count;
  if (key === "ArrowLeft") return (current - 1 + count) % count;
  return current;
}

function useNarrowLayout(forceNarrow?: boolean): boolean {
  const [narrow, setNarrow] = useState(
    () =>
      forceNarrow ??
      (typeof window !== "undefined" && window.matchMedia("(max-width: 860px)").matches),
  );
  useEffect(() => {
    if (forceNarrow !== undefined || typeof window === "undefined") return;
    const query = window.matchMedia("(max-width: 860px)");
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [forceNarrow]);
  return forceNarrow ?? narrow;
}

type UndoAction = Readonly<{ label: string; run: () => Promise<void> }>;
type EditorState = Readonly<{
  type: "fact" | "proposal";
  id: string;
  title: string;
  content: string;
}>;

export function MemoryPage({
  runtime,
  forceNarrow,
}: {
  readonly runtime: RuntimeStore;
  readonly forceNarrow?: boolean;
}) {
  const { data, actions, busy } = runtime;
  const memory = data.memory;
  const narrow = useNarrowLayout(forceNarrow);
  const [activePanel, setActivePanel] = useState<PanelId>("pending");
  const [editor, setEditor] = useState<EditorState>();
  const [undo, setUndo] = useState<UndoAction>();
  const [announcement, setAnnouncement] = useState("");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pending = memory.proposals.filter((proposal) => proposal.status === "pending");
  const enabled = memory.facts.filter((fact) => fact.state === "active");
  const archived = memory.facts.filter(
    (fact) => fact.state === "disabled" || fact.state === "archived",
  );
  const counts = useMemo(
    () => ({ pending: pending.length, enabled: enabled.length, archived: archived.length }),
    [archived.length, enabled.length, pending.length],
  );

  useEffect(() => {
    if (
      data.trusted &&
      data.workspacePath &&
      (memory.workspacePath !== data.workspacePath || memory.status === "idle")
    ) {
      void actions.refreshMemory();
    }
  }, [actions, data.trusted, data.workspacePath, memory.status, memory.workspacePath]);

  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo(undefined), 8_000);
    return () => window.clearTimeout(timer);
  }, [undo]);

  const announceUndo = (next: UndoAction, message: string) => {
    setUndo(next);
    setAnnouncement(message);
  };

  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = nextMemoryTabIndex(index, event.key);
    setActivePanel(panels[next]!);
    tabRefs.current[next]?.focus();
  };

  const updateFactState = async (
    fact: RuntimeMemoryFact,
    state: "active" | "disabled" | "archived",
  ) => {
    const updated = await actions.updateMemoryFact(fact.factId, fact.version, { state });
    if (!updated) return;
    const previousState = fact.state === "forgotten" ? "disabled" : fact.state;
    announceUndo(
      {
        label: "撤销状态更改",
        run: async () => {
          await actions.updateMemoryFact(updated.factId, updated.version, { state: previousState });
        },
      },
      "记忆状态已更新，可在 8 秒内撤销。",
    );
  };

  const saveFact = async (fact: RuntimeMemoryFact) => {
    if (!editor || editor.type !== "fact" || editor.id !== fact.factId) return;
    const updated = await actions.updateMemoryFact(fact.factId, fact.version, {
      title: editor.title.trim(),
      content: editor.content.trim(),
    });
    if (!updated) return;
    setEditor(undefined);
    announceUndo(
      {
        label: "撤销编辑",
        run: async () => {
          await actions.updateMemoryFact(updated.factId, updated.version, {
            title: fact.title ?? "",
            content: fact.content ?? "",
          });
        },
      },
      "记忆已编辑，可在 8 秒内撤销。",
    );
  };

  const resolveProposal = async (proposal: RuntimeMemoryProposal, edited = false) => {
    const resolution = "accepted" as const;
    const patch =
      edited && editor?.type === "proposal" && editor.id === proposal.proposalId
        ? { title: editor.title.trim(), content: editor.content.trim() }
        : undefined;
    const result = await actions.resolveMemoryProposal(
      proposal.proposalId,
      proposal.version,
      resolution,
      patch,
    );
    if (!result) return;
    const fact = result.fact;
    setEditor(undefined);
    if (fact) {
      const acceptedFact = fact;
      announceUndo(
        {
          label: "撤销启用",
          run: async () => {
            await actions.updateMemoryFact(acceptedFact.factId, acceptedFact.version, {
              state: "disabled",
            });
          },
        },
        "建议已批准。可以撤销启用；审核记录仍会保留。",
      );
    }
  };

  const updateSetting = async (
    key: "enabled" | "autoPropose" | "autoCommit" | "injectionEnabled",
    value: boolean,
  ) => {
    const settings = memory.settings;
    if (!settings) return;
    if (key === "autoCommit") {
      const updated = await actions.updateMemorySettings(settings.version, { autoCommit: false });
      if (updated) setAnnouncement("自动批准已关闭。此开关无法从 App 重新启用。");
      return;
    }
    const patch =
      key === "enabled"
        ? { enabled: value }
        : key === "autoPropose"
          ? { autoPropose: value }
          : { injectionEnabled: value };
    const updated = await actions.updateMemorySettings(settings.version, patch);
    if (!updated) return;
    announceUndo(
      {
        label: "撤销设置更改",
        run: async () => {
          await actions.updateMemorySettings(
            updated.version,
            key === "enabled"
              ? { enabled: settings.enabled }
              : key === "autoPropose"
                ? { autoPropose: settings.autoPropose }
                : { injectionEnabled: settings.injectionEnabled },
          );
        },
      },
      "记忆设置已更新，可在 8 秒内撤销。",
    );
  };

  const updateReviewMode = async (reviewMode: RuntimeMemorySettings["reviewMode"]) => {
    const settings = memory.settings;
    if (!settings || settings.reviewMode === reviewMode) return;
    const updated = await actions.updateMemorySettings(settings.version, { reviewMode });
    if (!updated) return;
    announceUndo(
      {
        label: "撤销审核模式更改",
        run: async () => {
          await actions.updateMemorySettings(updated.version, { reviewMode: settings.reviewMode });
        },
      },
      "自动审核模式已更新，可在 8 秒内撤销。",
    );
  };

  const permanentlyForget = async (fact: RuntimeMemoryFact) => {
    if (
      typeof window === "undefined" ||
      !window.confirm(`永久删除“${fact.title || "未命名记忆"}”？此操作会安全删除数据且无法撤销。`)
    ) {
      return;
    }
    setUndo(undefined);
    const forgotten = await actions.forgetMemoryFact(fact.factId, fact.version);
    if (forgotten) setAnnouncement("记忆已永久删除，无法撤销。");
  };

  const panelContent: Readonly<Record<PanelId, ReactNode>> = {
    pending: (
      <MemoryListEmpty
        items={pending}
        title="没有待审核建议"
        detail="自动建议会先留在这里，只有你批准后才会启用。"
        render={(proposal) => (
          <ProposalCard
            key={proposal.proposalId}
            proposal={proposal}
            editor={editor}
            busy={Boolean(busy)}
            onEdit={(next) => setEditor(next)}
            onCancel={() => setEditor(undefined)}
            onApprove={() => void resolveProposal(proposal, false)}
            onEditApprove={() => void resolveProposal(proposal, true)}
            onReject={() =>
              void actions
                .resolveMemoryProposal(proposal.proposalId, proposal.version, "rejected")
                .then((result) => {
                  if (result) setAnnouncement("建议已拒绝。审核结果不可撤销。");
                })
            }
          />
        )}
      />
    ),
    enabled: (
      <MemoryListEmpty
        items={enabled}
        title="还没有已启用记忆"
        detail="批准建议后，工作区记忆会显示在这里。"
        render={(fact) => (
          <FactCard
            key={fact.factId}
            fact={fact}
            editor={editor}
            busy={Boolean(busy)}
            onEdit={(next) => setEditor(next)}
            onCancel={() => setEditor(undefined)}
            onSave={() => void saveFact(fact)}
            onDisable={() => void updateFactState(fact, "disabled")}
            onArchive={() => void updateFactState(fact, "archived")}
            onRestore={() => void updateFactState(fact, "active")}
            onForget={() => void permanentlyForget(fact)}
          />
        )}
      />
    ),
    archived: (
      <MemoryListEmpty
        items={archived}
        title="没有停用或归档的记忆"
        detail="停用和归档的内容不会注入会话，但仍可恢复。"
        render={(fact) => (
          <FactCard
            key={fact.factId}
            fact={fact}
            editor={editor}
            busy={Boolean(busy)}
            onEdit={(next) => setEditor(next)}
            onCancel={() => setEditor(undefined)}
            onSave={() => void saveFact(fact)}
            onDisable={() => void updateFactState(fact, "disabled")}
            onArchive={() => void updateFactState(fact, "archived")}
            onRestore={() => void updateFactState(fact, "active")}
            onForget={() => void permanentlyForget(fact)}
          />
        )}
      />
    ),
  };

  return (
    <section className="memory-page" aria-labelledby="memory-page-title">
      <header className="memory-page__intro">
        <div>
          <span className="eyebrow">Workspace memory</span>
          <h2 id="memory-page-title">工作区记忆</h2>
          <p>审核 Pico 建议保留的信息，并决定哪些内容可以在后续会话中使用。</p>
        </div>
        <Button
          variant="quiet"
          disabled={Boolean(busy)}
          onClick={() => void actions.refreshMemory()}
        >
          <RefreshCw aria-hidden="true" size={15} /> 刷新
        </Button>
      </header>

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      {undo && (
        <div className="memory-undo" role="status">
          <span>{announcement}</span>
          <Button
            variant="quiet"
            onClick={() => {
              const current = undo;
              setUndo(undefined);
              void current.run();
            }}
          >
            {undo.label}
          </Button>
        </div>
      )}

      {memory.status === "degraded" && <InlineNotice tone="warning">{memory.error}</InlineNotice>}
      {memory.status === "error" && <InlineNotice tone="error">{memory.error}</InlineNotice>}
      {runtime.message?.includes("记忆已在另一处更新") && (
        <div className="inline-notice inline-notice--error" role="alert">
          {runtime.message}
        </div>
      )}
      {memory.status === "loading" && memory.facts.length === 0 && pending.length === 0 ? (
        <div className="memory-loading" role="status">
          正在读取工作区记忆…
        </div>
      ) : (
        <>
          {narrow ? (
            <div className="memory-tabs">
              <div role="tablist" aria-label="记忆状态" className="memory-tablist">
                {panels.map((panel, index) => (
                  <button
                    key={panel}
                    ref={(node) => {
                      tabRefs.current[index] = node;
                    }}
                    type="button"
                    role="tab"
                    id={`memory-tab-${panel}`}
                    aria-controls={`memory-panel-${panel}`}
                    aria-selected={activePanel === panel}
                    tabIndex={activePanel === panel ? 0 : -1}
                    onClick={() => setActivePanel(panel)}
                    onKeyDown={(event) => handleTabKey(event, index)}
                  >
                    {panelLabels[panel]} <span>{counts[panel]}</span>
                  </button>
                ))}
              </div>
              <section
                role="tabpanel"
                id={`memory-panel-${activePanel}`}
                aria-labelledby={`memory-tab-${activePanel}`}
                className="memory-panel"
              >
                {panelContent[activePanel]}
              </section>
            </div>
          ) : (
            <div className="memory-board" aria-label="工作区记忆状态">
              {panels.map((panel) => (
                <section
                  className="memory-column"
                  key={panel}
                  aria-labelledby={`memory-column-${panel}`}
                >
                  <header>
                    <h3 id={`memory-column-${panel}`}>{panelLabels[panel]}</h3>
                    <span aria-label={`${counts[panel]} 项`}>{counts[panel]}</span>
                  </header>
                  {panelContent[panel]}
                </section>
              ))}
            </div>
          )}
        </>
      )}

      <MemorySettings
        settings={memory.settings}
        busy={Boolean(busy)}
        onChange={(key, value) => void updateSetting(key, value)}
        onReviewModeChange={(mode) => void updateReviewMode(mode)}
      />
    </section>
  );
}

function MemoryListEmpty<T>({
  items,
  title,
  detail,
  render,
}: {
  readonly items: readonly T[];
  readonly title: string;
  readonly detail: string;
  readonly render: (item: T) => ReactNode;
}) {
  if (items.length === 0) {
    return <EmptyState icon={<BrainCircuit aria-hidden="true" />} title={title} detail={detail} />;
  }
  return (
    <div className="memory-list" role="list">
      {items.map(render)}
    </div>
  );
}

function ProposalCard({
  proposal,
  editor,
  busy,
  onEdit,
  onCancel,
  onApprove,
  onEditApprove,
  onReject,
}: {
  readonly proposal: RuntimeMemoryProposal;
  readonly editor?: EditorState | undefined;
  readonly busy: boolean;
  readonly onEdit: (editor: EditorState) => void;
  readonly onCancel: () => void;
  readonly onApprove: () => void;
  readonly onEditApprove: () => void;
  readonly onReject: () => void;
}) {
  const editing = editor?.type === "proposal" && editor.id === proposal.proposalId;
  return (
    <article className="memory-card" role="listitem">
      <MemoryCardHeader kind={proposal.kind} confidence={proposal.confidence} />
      {editing ? (
        <MemoryEditor editor={editor} onChange={onEdit} />
      ) : (
        <>
          <h4>{proposal.title || "未命名建议"}</h4>
          <p>{proposal.content || "没有可显示的内容。"}</p>
        </>
      )}
      {proposal.reason && <p className="memory-card__reason">建议原因：{proposal.reason}</p>}
      <SourceDetails sourceId={proposal.sourceId} />
      <div className="memory-card__actions">
        {editing ? (
          <>
            <Button variant="primary" disabled={busy} onClick={onEditApprove}>
              保存并批准
            </Button>
            <Button variant="quiet" disabled={busy} onClick={onCancel}>
              取消
            </Button>
          </>
        ) : (
          <>
            <Button variant="primary" disabled={busy} onClick={onApprove}>
              <Check aria-hidden="true" size={14} />
              批准
            </Button>
            <Button
              variant="quiet"
              disabled={busy}
              onClick={() =>
                onEdit({
                  type: "proposal",
                  id: proposal.proposalId,
                  title: proposal.title ?? "",
                  content: proposal.content ?? "",
                })
              }
            >
              <Pencil aria-hidden="true" size={14} />
              编辑后批准
            </Button>
            <Button variant="quiet" disabled={busy} onClick={onReject}>
              <X aria-hidden="true" size={14} />
              拒绝
            </Button>
          </>
        )}
      </div>
    </article>
  );
}

function FactCard({
  fact,
  editor,
  busy,
  onEdit,
  onCancel,
  onSave,
  onDisable,
  onArchive,
  onRestore,
  onForget,
}: {
  readonly fact: RuntimeMemoryFact;
  readonly editor?: EditorState | undefined;
  readonly busy: boolean;
  readonly onEdit: (editor: EditorState) => void;
  readonly onCancel: () => void;
  readonly onSave: () => void;
  readonly onDisable: () => void;
  readonly onArchive: () => void;
  readonly onRestore: () => void;
  readonly onForget: () => void;
}) {
  const editing = editor?.type === "fact" && editor.id === fact.factId;
  const expired = Boolean(fact.expiresAt && Date.parse(fact.expiresAt) <= Date.now());
  return (
    <article className="memory-card" role="listitem">
      <MemoryCardHeader kind={fact.kind} confidence={fact.confidence} />
      <div className="memory-card__flags" aria-label="记忆状态">
        <span>
          {fact.state === "active" ? "已启用" : fact.state === "disabled" ? "已停用" : "已归档"}
        </span>
        {fact.pinned && <span>已置顶</span>}
        {expired && <span>已过期</span>}
      </div>
      {editing ? (
        <MemoryEditor editor={editor} onChange={onEdit} />
      ) : (
        <>
          <h4>{fact.title || "未命名记忆"}</h4>
          <p>{fact.content || "没有可显示的内容。"}</p>
        </>
      )}
      <SourceDetails sourceId={fact.sourceId} source={fact.source} />
      <div className="memory-card__actions">
        {editing ? (
          <>
            <Button variant="primary" disabled={busy} onClick={onSave}>
              保存
            </Button>
            <Button variant="quiet" disabled={busy} onClick={onCancel}>
              取消
            </Button>
          </>
        ) : (
          <>
            <IconButton
              label={`编辑 ${fact.title || "记忆"}`}
              disabled={busy}
              onClick={() =>
                onEdit({
                  type: "fact",
                  id: fact.factId,
                  title: fact.title ?? "",
                  content: fact.content ?? "",
                })
              }
            >
              <Pencil aria-hidden="true" />
            </IconButton>
            {fact.state === "active" ? (
              <IconButton
                label={`停用 ${fact.title || "记忆"}`}
                disabled={busy}
                onClick={onDisable}
              >
                <CircleOff aria-hidden="true" />
              </IconButton>
            ) : (
              <IconButton
                label={`恢复 ${fact.title || "记忆"}`}
                disabled={busy}
                onClick={onRestore}
              >
                <ArchiveRestore aria-hidden="true" />
              </IconButton>
            )}
            {fact.state !== "archived" && (
              <IconButton
                label={`归档 ${fact.title || "记忆"}`}
                disabled={busy}
                onClick={onArchive}
              >
                <Archive aria-hidden="true" />
              </IconButton>
            )}
            <IconButton
              label={`永久删除 ${fact.title || "记忆"}`}
              disabled={busy}
              onClick={onForget}
            >
              <Trash2 aria-hidden="true" />
            </IconButton>
          </>
        )}
      </div>
    </article>
  );
}

function MemoryEditor({
  editor,
  onChange,
}: {
  readonly editor: EditorState;
  readonly onChange: (editor: EditorState) => void;
}) {
  return (
    <div className="memory-editor">
      <label>
        标题
        <input
          value={editor.title}
          onChange={(event) => onChange({ ...editor, title: event.target.value })}
        />
      </label>
      <label>
        内容
        <textarea
          rows={4}
          value={editor.content}
          onChange={(event) => onChange({ ...editor, content: event.target.value })}
        />
      </label>
    </div>
  );
}

function MemoryCardHeader({
  kind,
  confidence,
}: {
  readonly kind: RuntimeMemoryFact["kind"];
  readonly confidence: number;
}) {
  return (
    <header className="memory-card__meta">
      <span>{kindLabels[kind]}</span>
      <span>置信度 {Math.round(confidence * 100)}%</span>
    </header>
  );
}

function SourceDetails({
  sourceId,
  source,
}: {
  readonly sourceId?: string | undefined;
  readonly source?: RuntimeMemoryFact["source"] | undefined;
}) {
  if (!sourceId && !source)
    return <p className="memory-source memory-source--unavailable">来源不可用</p>;
  if (!source) {
    return <p className="memory-source">来源 ID：{sourceId}（详情未提供）</p>;
  }
  const availability = source?.availability;
  const label =
    availability === "available"
      ? "来源可用"
      : availability === "rewound"
        ? "来源已回退"
        : "来源不可用";
  return (
    <details className="memory-source">
      <summary>{label}</summary>
      <dl>
        <div>
          <dt>来源 ID</dt>
          <dd>{source?.sourceId ?? sourceId}</dd>
        </div>
        {source?.sessionId && (
          <div>
            <dt>会话</dt>
            <dd>{source.sessionId}</dd>
          </div>
        )}
        {source?.branchId && (
          <div>
            <dt>分支</dt>
            <dd>{source.branchId}</dd>
          </div>
        )}
        {source?.invalidationCode && (
          <div>
            <dt>失效原因</dt>
            <dd>{source.invalidationCode}</dd>
          </div>
        )}
      </dl>
    </details>
  );
}

function MemorySettings({
  settings,
  busy,
  onChange,
  onReviewModeChange,
}: {
  readonly settings: RuntimeStore["data"]["memory"]["settings"];
  readonly busy: boolean;
  readonly onChange: (
    key: "enabled" | "autoPropose" | "autoCommit" | "injectionEnabled",
    value: boolean,
  ) => void;
  readonly onReviewModeChange: (mode: RuntimeMemorySettings["reviewMode"]) => void;
}) {
  if (!settings) return null;
  return (
    <section className="memory-settings" aria-labelledby="memory-settings-title">
      <div>
        <h3 id="memory-settings-title">记忆设置</h3>
        <p>所有设置只作用于当前工作区。</p>
      </div>
      <fieldset disabled={busy}>
        <legend className="sr-only">工作区记忆开关</legend>
        <label>
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(event) => onChange("enabled", event.target.checked)}
          />
          <span>
            <strong>启用记忆</strong>
            <small>关闭后不会产生额外模型调用，也不会向会话注入记忆。</small>
          </span>
        </label>
        <div className="memory-settings__review-mode">
          <strong>自动审核模式</strong>
          <p>
            {settings.autoPropose
              ? "只控制自动建议的模型预算，不影响记忆总开关或会话注入。"
              : "自动提出建议已关闭；当前模式暂不生效。"}
          </p>
        </div>
        <label>
          <input
            type="radio"
            name="memory-review-mode"
            value="eco"
            checked={settings.reviewMode === "eco"}
            onChange={() => onReviewModeChange("eco")}
          />
          <span>
            <strong>节能</strong>
            <small>仅生成规则提案，不调用模型审核模糊表达。</small>
          </span>
        </label>
        <label>
          <input
            type="radio"
            name="memory-review-mode"
            value="balanced"
            checked={settings.reviewMode === "balanced"}
            onChange={() => onReviewModeChange("balanced")}
          />
          <span>
            <strong>均衡（推荐）</strong>
            <small>滚动 24 小时内最多 8 次模型审核，兼顾成本与召回。</small>
          </span>
        </label>
        <label>
          <input
            type="radio"
            name="memory-review-mode"
            value="quality"
            checked={settings.reviewMode === "quality"}
            onChange={() => onReviewModeChange("quality")}
          />
          <span>
            <strong>质量优先</strong>
            <small>提高模糊表达的召回，滚动 24 小时内最多 16 次模型审核。</small>
          </span>
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.autoPropose}
            onChange={(event) => onChange("autoPropose", event.target.checked)}
          />
          <span>
            <strong>自动提出建议</strong>
            <small>候选内容仍须在待审核列中由你批准。</small>
          </span>
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.injectionEnabled}
            onChange={(event) => onChange("injectionEnabled", event.target.checked)}
          />
          <span>
            <strong>向会话注入已启用记忆</strong>
            <small>停用或归档的内容不会注入。</small>
          </span>
        </label>
        <label className="is-locked">
          <input type="checkbox" checked={settings.autoCommit} disabled />
          <span>
            <strong>自动批准</strong>
            <small>
              <ShieldAlert aria-hidden="true" size={14} />
              固定关闭，普通用户无法启用。
            </small>
          </span>
        </label>
        {settings.autoCommit && (
          <div className="memory-settings__warning" role="alert">
            <span>检测到旧配置仍开启自动批准，请立即关闭。</span>
            <Button variant="danger" onClick={() => onChange("autoCommit", false)}>
              立即关闭自动批准
            </Button>
          </div>
        )}
      </fieldset>
    </section>
  );
}

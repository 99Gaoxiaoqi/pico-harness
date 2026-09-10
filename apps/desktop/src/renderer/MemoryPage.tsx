import {
  Archive,
  ArchiveRestore,
  BrainCircuit,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import type { RuntimeAtomicMemoryDetails, RuntimeMemoryFact } from "@pico/protocol";
import { Button, EmptyState, IconButton, InlineNotice } from "./components.js";
import type { RuntimeStore } from "./runtime.js";

const panels = ["saved", "archived"] as const;
type PanelId = (typeof panels)[number];
const panelLabels = { saved: "已保存", archived: "已归档" };
const kindLabels: Record<RuntimeAtomicMemoryDetails["kind"], string> = {
  preference: "偏好",
  identity: "身份",
  context: "背景",
  knowledge: "知识",
  failure: "失败经验",
  note: "笔记",
};
const statementLabels = { fact: "事实", plan: "计划", prediction: "预测" };
const temporalLabels = {
  undated: "未注明时间",
  point: "时间点",
  interval: "时间区间",
  open_ended: "持续有效",
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
  const [activePanel, setActivePanel] = useState<PanelId>("saved");
  const [editor, setEditor] = useState<{ id: string; content: string }>();
  const [announcement, setAnnouncement] = useState("");
  const [draft, setDraft] = useState<{ workspacePath: string; content: string }>();
  const [creationNotice, setCreationNotice] = useState("");
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const returnFocusRef = useRef(false);
  const creatingRef = useRef(false);
  const workspaceRef = useRef(data.workspacePath);
  workspaceRef.current = data.workspacePath;
  const adding = Boolean(draft && draft.workspacePath === data.workspacePath);
  useEffect(() => {
    returnFocusRef.current = false;
    setDraft(undefined);
    setCreationNotice("");
  }, [data.workspacePath]);
  useEffect(() => {
    if (adding) {
      returnFocusRef.current = true;
      contentRef.current?.focus();
    } else if (returnFocusRef.current && !busy) {
      returnFocusRef.current = false;
      addButtonRef.current?.focus();
    }
  }, [adding, busy]);
  const openAdd = () => {
    if (!data.workspacePath || !data.trusted || busy) return;
    setCreationNotice("");
    setDraft({ workspacePath: data.workspacePath, content: "" });
  };
  const cancelAdd = () => {
    if (creatingRef.current) return;
    setDraft(undefined);
  };
  const create = async () => {
    if (!draft || !adding || !draft.content.trim() || busy || creatingRef.current) return;
    const submitted = draft;
    creatingRef.current = true;
    try {
      const fact = await actions.createMemoryFact(submitted.content.trim());
      if (!fact || workspaceRef.current !== submitted.workspacePath) return;
      setDraft((current) => (current === submitted ? undefined : current));
      setActivePanel("saved");
      setCreationNotice("记忆已保存到当前工作区。");
      setAnnouncement("记忆已保存到当前工作区。");
    } finally {
      creatingRef.current = false;
    }
  };
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const groups = {
    saved: memory.facts.filter((fact) => fact.state === "active"),
    archived: memory.facts.filter((fact) => fact.state === "archived" || fact.state === "disabled"),
  };
  useEffect(() => {
    if (
      data.trusted &&
      data.workspacePath &&
      (memory.workspacePath !== data.workspacePath || memory.status === "idle")
    )
      void actions.refreshMemory();
  }, [actions, data.trusted, data.workspacePath, memory.status, memory.workspacePath]);

  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = nextMemoryTabIndex(index, event.key);
    setActivePanel(panels[next]!);
    tabRefs.current[next]?.focus();
  };
  const changeState = async (fact: RuntimeMemoryFact) => {
    const state = fact.state === "active" ? "archived" : "active";
    if (await actions.updateMemoryFact(fact.factId, fact.version, { state }))
      setAnnouncement(state === "active" ? "记忆已恢复。" : "记忆已归档，不再参与召回。");
  };
  const save = async (fact: RuntimeMemoryFact) => {
    if (!editor || editor.id !== fact.factId || !editor.content.trim()) return;
    if (
      await actions.updateMemoryFact(fact.factId, fact.version, { content: editor.content.trim() })
    ) {
      setEditor(undefined);
      setAnnouncement("记忆已保存。");
    }
  };
  const forget = async (fact: RuntimeMemoryFact) => {
    if (
      typeof window === "undefined" ||
      !window.confirm(
        "删除这条记忆？将从长期记忆中删除，无法恢复。原聊天记录仍会保留；之后重新提供或要求记住的信息仍可保存。",
      )
    )
      return;
    if (await actions.forgetMemoryFact(fact.factId, fact.version)) {
      setEditor(undefined);
      setAnnouncement("记忆已删除。");
    }
  };
  const renderList = (panel: PanelId) =>
    groups[panel].length ? (
      <div className="memory-list" role="list">
        {groups[panel].map((fact) => (
          <article className="memory-card" role="listitem" key={fact.factId}>
            <header className="memory-card__meta">
              <span>{fact.atomic ? kindLabels[fact.atomic.kind] : "记忆"}</span>
              <span>{fact.atomic?.scopeType === "global" ? "全局 · 跨工作区" : "当前工作区"}</span>
              {fact.atomic && <span>{statementLabels[fact.atomic.statementType]}</span>}
            </header>
            {editor?.id === fact.factId ? (
              <div className="memory-editor">
                <label>
                  记忆内容
                  <textarea
                    rows={5}
                    maxLength={2000}
                    value={editor.content}
                    onChange={(event) =>
                      setEditor({ id: fact.factId, content: event.target.value })
                    }
                  />
                </label>
              </div>
            ) : (
              <p>{fact.content || "没有可显示的内容。"}</p>
            )}
            <SourceDetails fact={fact} />
            <div className="memory-card__actions">
              {editor?.id === fact.factId ? (
                <>
                  <Button
                    variant="primary"
                    disabled={Boolean(busy) || !editor.content.trim()}
                    onClick={() => void save(fact)}
                  >
                    保存
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={Boolean(busy)}
                    onClick={() => setEditor(undefined)}
                  >
                    取消
                  </Button>
                </>
              ) : (
                <>
                  <IconButton
                    label={`编辑 ${fact.title || "记忆"}`}
                    disabled={Boolean(busy)}
                    onClick={() => setEditor({ id: fact.factId, content: fact.content ?? "" })}
                  >
                    <Pencil aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    label={`${fact.state === "active" ? "归档" : "恢复"} ${fact.title || "记忆"}`}
                    disabled={Boolean(busy)}
                    onClick={() => void changeState(fact)}
                  >
                    {fact.state === "active" ? (
                      <Archive aria-hidden="true" />
                    ) : (
                      <ArchiveRestore aria-hidden="true" />
                    )}
                  </IconButton>
                  <IconButton
                    label={`删除记忆 ${fact.title || "记忆"}`}
                    disabled={Boolean(busy)}
                    onClick={() => void forget(fact)}
                  >
                    <Trash2 aria-hidden="true" />
                  </IconButton>
                </>
              )}
            </div>
          </article>
        ))}
      </div>
    ) : (
      <EmptyState
        icon={<BrainCircuit aria-hidden="true" />}
        title={panel === "saved" ? "还没有已保存的记忆" : "没有已归档的记忆"}
        detail={
          panel === "saved"
            ? "可以手动添加项目约定或偏好，也可以在对话中请 Pico 记住一条信息。"
            : "归档条目不会参与会话召回，可以随时恢复。"
        }
      />
    );

  return (
    <section className="memory-page" aria-labelledby="memory-page-title">
      <header className="memory-page__intro">
        <div>
          <span className="eyebrow">Memory</span>
          <h2 id="memory-page-title">工作区记忆</h2>
          <p>管理已保存的信息。全局记忆可跨工作区使用，归档后不再参与召回。</p>
        </div>
        <div className="memory-page__actions">
          <Button
            ref={addButtonRef}
            variant="primary"
            disabled={Boolean(busy) || !data.trusted || !data.workspacePath || adding}
            aria-expanded={adding}
            aria-controls="memory-add-form"
            onClick={openAdd}
          >
            <Plus aria-hidden="true" size={14} />
            添加记忆
          </Button>
          <Button
            variant="quiet"
            disabled={Boolean(busy) || !data.trusted}
            onClick={() => void actions.refreshMemory()}
          >
            <RefreshCw aria-hidden="true" size={14} />
            刷新
          </Button>
        </div>
      </header>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      {runtime.message && (
        <InlineNotice
          tone={
            ["记忆已更新。", "记忆设置已更新。", "记忆已删除，无法撤销。"].includes(runtime.message)
              ? "success"
              : "error"
          }
        >
          {runtime.message}
        </InlineNotice>
      )}
      {memory.error && <InlineNotice tone="error">{memory.error}</InlineNotice>}
      {!data.trusted ? (
        <InlineNotice tone="warning">信任当前工作区后可管理记忆。</InlineNotice>
      ) : (
        <>
          {creationNotice && <InlineNotice tone="success">{creationNotice}</InlineNotice>}
          {adding && draft && (
            <form
              id="memory-add-form"
              className="memory-add-form"
              aria-labelledby="memory-add-title"
              aria-busy={busy === "memory-create"}
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelAdd();
                }
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void create();
                }
              }}
            >
              <h3 id="memory-add-title">添加记忆</h3>
              <p id="memory-add-help">
                保存到当前工作区：{data.workspacePath}
                。内容直接保存，不调用模型；在相关对话中按需召回。相同内容会复用已有记忆，归档内容会恢复。
              </p>
              <div className="memory-editor">
                <label htmlFor="memory-add-content">记忆内容</label>
                <textarea
                  id="memory-add-content"
                  ref={contentRef}
                  rows={4}
                  maxLength={2000}
                  required
                  disabled={Boolean(busy)}
                  aria-describedby="memory-add-help memory-add-length"
                  placeholder="例如：项目发布前必须运行 npm run verify。"
                  value={draft.content}
                  onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                />
                <small id="memory-add-length">{draft.content.length} / 2000</small>
              </div>
              {(!memory.settings?.enabled || !memory.settings?.injectionEnabled) &&
                memory.settings && (
                  <InlineNotice>
                    当前记忆或会话召回已关闭，仍可保存；开启后才会参与召回。
                  </InlineNotice>
                )}
              <div className="memory-page__actions">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={Boolean(busy) || !draft.content.trim()}
                >
                  {busy === "memory-create" ? "保存中…" : "保存记忆"}
                </Button>
                <Button variant="quiet" disabled={Boolean(busy)} onClick={cancelAdd}>
                  取消
                </Button>
              </div>
            </form>
          )}
          {narrow ? (
            <div className="memory-tabs">
              <div className="memory-tablist" role="tablist" aria-label="记忆状态">
                {panels.map((panel, index) => (
                  <button
                    key={panel}
                    ref={(element) => {
                      tabRefs.current[index] = element;
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
                    {panelLabels[panel]} <span>{groups[panel].length}</span>
                  </button>
                ))}
              </div>
              <section
                role="tabpanel"
                id={`memory-panel-${activePanel}`}
                aria-labelledby={`memory-tab-${activePanel}`}
                className="memory-panel"
              >
                {renderList(activePanel)}
              </section>
            </div>
          ) : (
            <div
              className="memory-board"
              style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}
              aria-label="记忆状态"
            >
              {panels.map((panel) => (
                <section
                  className="memory-column"
                  key={panel}
                  aria-labelledby={`memory-column-${panel}`}
                >
                  <header>
                    <h3 id={`memory-column-${panel}`}>{panelLabels[panel]}</h3>
                    <span aria-label={`${groups[panel].length} 项`}>{groups[panel].length}</span>
                  </header>
                  {renderList(panel)}
                </section>
              ))}
            </div>
          )}
        </>
      )}
      <Link className="button" to="/settings/memory">
        用户级记忆设置
      </Link>
    </section>
  );
}

function SourceDetails({ fact }: { readonly fact: RuntimeMemoryFact }) {
  const atomic = fact.atomic;
  return (
    <details className="memory-source">
      <summary>
        {atomic?.origin === "user_requested"
          ? fact.source
            ? "用户保存"
            : "手动保存"
          : atomic?.origin === "agent_extracted"
            ? "对话提取"
            : "来源信息"}
      </summary>
      <dl>
        {fact.source ? (
          <>
            <div>
              <dt>来源会话</dt>
              <dd>{fact.source.sessionId}</dd>
            </div>
            <div>
              <dt>来源引用</dt>
              <dd>{fact.source.sourceId}</dd>
            </div>
          </>
        ) : (
          <div>
            <dt>来源</dt>
            <dd>
              {atomic?.origin === "user_requested" ? "手动内容，无会话引用" : "来源详情未提供"}
            </dd>
          </div>
        )}
        {fact.source?.availability === "unavailable" && (
          <div>
            <dt>会话状态</dt>
            <dd>来源不可用，已保存内容仍保留</dd>
          </div>
        )}
        {atomic && (
          <>
            <div>
              <dt>作用域</dt>
              <dd>{atomic.scopeType === "global" ? "全局" : "当前工作区"}</dd>
            </div>
            <div>
              <dt>时间类型</dt>
              <dd>{temporalLabels[atomic.temporalType]}</dd>
            </div>
            <div>
              <dt>记录时间</dt>
              <dd>{formatTime(atomic.observedAt)}</dd>
            </div>
            {atomic.eventStartedAt !== null && (
              <div>
                <dt>开始</dt>
                <dd>{formatTime(atomic.eventStartedAt)}</dd>
              </div>
            )}
            {atomic.eventEndedAt !== null && (
              <div>
                <dt>结束</dt>
                <dd>{formatTime(atomic.eventEndedAt)}</dd>
              </div>
            )}
          </>
        )}
      </dl>
    </details>
  );
}
function formatTime(value: number): string {
  return new Date(value).toLocaleString("zh-CN");
}

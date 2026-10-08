import { TabList, Tab } from "@astryxdesign/core/TabList";
import { SelectField, TextAreaField, TextField } from "./ui-controls.js";
import {
  Archive,
  ArchiveRestore,
  BrainCircuit,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { RuntimeMemoryItem, RuntimeMemoryListItem, RuntimeResult } from "@pico/protocol";
import { Button, EmptyState, IconButton, InlineNotice } from "./components.js";
import type { RuntimeStore } from "./runtime.js";

const panels = ["saved", "archived"] as const;
type PanelId = (typeof panels)[number];
const panelLabels = { saved: "已保存", archived: "已归档" };
const kindLabels: Record<RuntimeMemoryItem["kind"], string> = {
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
  open_ended: "已知起点，未注明结束",
};
type MemoryListItem = RuntimeMemoryItem | RuntimeMemoryListItem;
type TimeChoice = "preserve" | "clear" | "point" | "interval" | "open_ended";
interface MemoryEditor {
  readonly id: string;
  readonly version: number;
  readonly workspacePath: string;
  readonly content: string;
  readonly statementType: RuntimeMemoryItem["statementType"];
  readonly timeChoice: TimeChoice;
  readonly start: string;
  readonly end: string;
}
const sourceLabels = {
  "user-evidence": "用户原始陈述",
  manual: "手动内容，无会话引用",
  "assistant-note": "用户保留的助手笔记（未经独立核实）",
};
const matchLabels = { key: "关键词匹配", content: "正文匹配", preference: "常驻偏好" };
const diagnosticLabels = {
  selected: "已选入",
  duplicate: "重复展示已省略",
  budget: "超过 Token 预算",
  item_limit: "超过条数限制",
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
  const [editor, setEditor] = useState<MemoryEditor>();
  const [editorError, setEditorError] = useState("");
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<{
    key: string;
    query: string;
    result: RuntimeResult<"memory.context.preview">;
  }>();
  const [previewError, setPreviewError] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewSequence = useRef(0);
  const contextKey = JSON.stringify([
    data.workspacePath,
    data.trusted,
    memory.settings?.version,
    memory.settings?.enabled,
    memory.settings?.recallEnabled,
    memory.pageInfo?.revision,
  ]);
  const contextKeyRef = useRef(contextKey);
  contextKeyRef.current = contextKey;
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
    setEditor(undefined);
    setEditorError("");
    setQuery("");
    setCreationNotice("");
  }, [data.workspacePath]);
  useEffect(() => {
    previewSequence.current += 1;
    setPreview(undefined);
    setPreviewError("");
    setPreviewLoading(false);
    return () => {
      previewSequence.current += 1;
    };
  }, [contextKey]);
  const clearPreview = () => {
    previewSequence.current += 1;
    setPreview(undefined);
    setPreviewError("");
    setPreviewLoading(false);
  };
  const queryPreview = async () => {
    const submitted = query.trim();
    if (!submitted || !data.workspacePath || !data.trusted) return;
    const sequence = ++previewSequence.current;
    const key = contextKey;
    setPreview(undefined);
    setPreviewError("");
    setPreviewLoading(true);
    try {
      const result = await actions.queryMemoryContext(submitted);
      if (sequence !== previewSequence.current || key !== contextKeyRef.current) return;
      if (result) setPreview({ key, query: submitted, result });
      else setPreviewError("无法读取召回预览，请重试。");
    } catch {
      if (sequence === previewSequence.current && key === contextKeyRef.current)
        setPreviewError("无法读取召回预览，请重试。");
    } finally {
      if (sequence === previewSequence.current && key === contextKeyRef.current)
        setPreviewLoading(false);
    }
  };
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
      const item = await actions.createMemoryItem(submitted.content.trim());
      if (!item || workspaceRef.current !== submitted.workspacePath) return;
      setDraft((current) => (current === submitted ? undefined : current));
      setActivePanel("saved");
      setCreationNotice("记忆已保存到当前工作区。");
      setAnnouncement("记忆已保存到当前工作区。");
      clearPreview();
    } finally {
      creatingRef.current = false;
    }
  };
  const groups = {
    saved: memory.items.filter((item) => item.lifecycleState === "active"),
    archived: memory.items.filter((item) => item.lifecycleState === "archived"),
  };
  useEffect(() => {
    if (
      data.trusted &&
      data.workspacePath &&
      (memory.workspacePath !== data.workspacePath || memory.status === "idle")
    )
      void actions.refreshMemory();
  }, [actions, data.trusted, data.workspacePath, memory.status, memory.workspacePath]);

  const changeState = async (item: MemoryListItem) => {
    const lifecycleState = item.lifecycleState === "active" ? "archived" : "active";
    if (await actions.updateMemoryItem(item.itemId, item.version, { lifecycleState })) {
      setAnnouncement(lifecycleState === "active" ? "记忆已恢复。" : "记忆已归档，不再参与召回。");
      clearPreview();
    }
  };
  const save = async (item: MemoryListItem) => {
    if (!editor || editor.id !== item.itemId || !editor.content.trim() || busy) return;
    const submitted = editor;
    if (submitted.workspacePath !== data.workspacePath) return;
    setEditorError("");
    const patch: Parameters<typeof actions.updateMemoryItem>[2] = {
      content: submitted.content.trim(),
      statementType: submitted.statementType,
    };
    if (submitted.timeChoice === "clear") {
      Object.assign(patch, { temporalType: "undated", eventStartedAt: null, eventEndedAt: null });
    } else if (submitted.timeChoice !== "preserve") {
      const start = parseEventTime(submitted.start);
      const end =
        submitted.timeChoice === "open_ended" || !submitted.end.trim()
          ? null
          : parseEventTime(submitted.end);
      if (
        start === null ||
        (submitted.timeChoice !== "open_ended" && submitted.end.trim() && end === null) ||
        (end !== null && end <= start) ||
        (submitted.timeChoice === "interval" && end === null)
      ) {
        setEditorError(
          "请填写有效的事件开始时间；结束时间必须晚于开始时间，时间区间必须有结束时间。",
        );
        return;
      }
      Object.assign(patch, {
        temporalType: submitted.timeChoice,
        eventStartedAt: start,
        eventEndedAt: submitted.timeChoice === "open_ended" ? null : end,
      });
    }
    try {
      const updated = await actions.updateMemoryItem(submitted.id, submitted.version, patch);
      if (workspaceRef.current !== submitted.workspacePath) return;
      if (!updated) {
        setEditorError("更正未保存，请检查内容或刷新后重试。输入已保留。");
        return;
      }
      setEditor((current) => (current === submitted ? undefined : current));
      setAnnouncement("记忆已更正。");
      clearPreview();
    } catch {
      if (workspaceRef.current === submitted.workspacePath)
        setEditorError("更正未保存，请检查内容或刷新后重试。输入已保留。");
    }
  };
  const deleteItem = async (item: MemoryListItem) => {
    if (
      typeof window === "undefined" ||
      !window.confirm(
        "删除这条记忆？将从长期记忆中删除，无法恢复。原聊天记录仍会保留；之后重新提供或要求记住的信息仍可保存。",
      )
    )
      return;
    if (await actions.deleteMemoryItem(item.itemId, item.version)) {
      setEditor(undefined);
      setAnnouncement("记忆已删除。");
      clearPreview();
    }
  };
  const renderList = (panel: PanelId) =>
    groups[panel].length ? (
      <div className="memory-list" role="list">
        {groups[panel].map((item) => (
          <article
            className="memory-card"
            role="listitem"
            key={item.itemId}
            id={`memory-${encodeURIComponent(item.itemId)}`}
          >
            <header className="memory-card__meta">
              <span>{kindLabels[item.kind]}</span>
              <span>{item.scopeType === "global" ? "全局 · 跨工作区" : "当前工作区"}</span>
              <span>{statementLabels[item.statementType]}</span>
            </header>
            {editor?.id === item.itemId ? (
              <div className="memory-editor">
                <p>
                  更正这条记忆。事件时间默认保留，保存后内容由你确认，旧会话引用不再作为更正内容的来源。
                </p>
                <p>如果情况已经变化，请添加新记忆，必要时单独归档旧条目。</p>
                <div className="settings-field">
                  记忆内容
                  <TextAreaField
                    label="记忆内容"
                    rows={5}
                    maxLength={2000}
                    value={editor.content}
                    onChange={(event) => setEditor({ ...editor, content: event.target.value })}
                  />
                </div>
                <div className="settings-field">
                  陈述类型
                  <SelectField
                    label="更正后的陈述类型"
                    value={editor.statementType}
                    disabled={Boolean(busy)}
                    options={Object.entries(statementLabels).map(([value, label]) => ({
                      value,
                      label,
                    }))}
                    onValueChange={(value) =>
                      setEditor({
                        ...editor,
                        statementType: value as MemoryEditor["statementType"],
                      })
                    }
                  />
                </div>
                <div className="settings-field">
                  事件时间
                  <SelectField
                    label="更正事件时间"
                    value={editor.timeChoice}
                    disabled={Boolean(busy)}
                    options={[
                      { value: "preserve", label: "保留原事件时间" },
                      { value: "clear", label: "清除事件时间（未注明）" },
                      { value: "point", label: "指定时间点" },
                      { value: "interval", label: "指定时间区间" },
                      { value: "open_ended", label: "指定起点，未注明结束" },
                    ]}
                    onValueChange={(value) =>
                      setEditor({ ...editor, timeChoice: value as TimeChoice })
                    }
                  />
                </div>
                {editor.timeChoice !== "preserve" && editor.timeChoice !== "clear" && (
                  <>
                    <div className="settings-field">
                      事件开始时间（本地时间）
                      <TextField
                        label="更正事件开始时间"
                        type="datetime-local"
                        step="0.001"
                        value={editor.start}
                        disabled={Boolean(busy)}
                        onValueChange={(start) => setEditor({ ...editor, start })}
                      />
                    </div>
                    {editor.timeChoice !== "open_ended" && (
                      <div className="settings-field">
                        事件结束时间（本地时间）{editor.timeChoice === "point" ? "，可留空" : ""}
                        <TextField
                          label="更正事件结束时间"
                          type="datetime-local"
                          step="0.001"
                          value={editor.end}
                          disabled={Boolean(busy)}
                          onValueChange={(end) => setEditor({ ...editor, end })}
                        />
                      </div>
                    )}
                  </>
                )}
                {editorError && <InlineNotice tone="error">{editorError}</InlineNotice>}
              </div>
            ) : (
              <p>{item.content}</p>
            )}
            <SourceDetails item={item} />
            <div className="memory-card__actions">
              {editor?.id === item.itemId ? (
                <>
                  <Button
                    variant="primary"
                    disabled={Boolean(busy) || !editor.content.trim()}
                    onClick={() => void save(item)}
                  >
                    保存更正
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
                    label={`更正 ${memoryItemLabel(item)}`}
                    disabled={Boolean(busy)}
                    onClick={() => {
                      if (!data.workspacePath) return;
                      setEditorError("");
                      setEditor({
                        id: item.itemId,
                        version: item.version,
                        workspacePath: data.workspacePath,
                        content: item.content,
                        statementType: item.statementType,
                        timeChoice: "preserve",
                        start: eventTimeInput(item.eventStartedAt),
                        end: eventTimeInput(item.eventEndedAt),
                      });
                    }}
                  >
                    <Pencil aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    label={`${item.lifecycleState === "active" ? "归档" : "恢复"} ${memoryItemLabel(item)}`}
                    disabled={Boolean(busy)}
                    onClick={() => void changeState(item)}
                  >
                    {item.lifecycleState === "active" ? (
                      <Archive aria-hidden="true" />
                    ) : (
                      <ArchiveRestore aria-hidden="true" />
                    )}
                  </IconButton>
                  <IconButton
                    label={`删除记忆 ${memoryItemLabel(item)}`}
                    disabled={Boolean(busy)}
                    onClick={() => void deleteItem(item)}
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
        title={
          memory.pageInfo?.nextCursor
            ? `已加载的条目中没有${panelLabels[panel]}记忆`
            : panel === "saved"
              ? "还没有已保存的记忆"
              : "没有已归档的记忆"
        }
        detail={
          memory.pageInfo?.nextCursor
            ? "继续加载可查看后续记忆。"
            : panel === "saved"
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
          <p>
            {memory.pageInfo
              ? `已加载 ${memory.items.length} / ${memory.pageInfo.counts.total} 条`
              : `已加载 ${memory.items.length} 条，总数未知；更新电脑端可加载更多`}
          </p>
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
      {/* Action feedback is displayed by the app toast; only memory-scoped load
          errors belong here. A global message may come from another page. */}
      {memory.error && <InlineNotice tone="error">{memory.error}</InlineNotice>}
      {!data.trusted ? (
        <InlineNotice tone="warning">信任当前工作区后可管理记忆。</InlineNotice>
      ) : (
        <>
          {creationNotice && <InlineNotice tone="success">{creationNotice}</InlineNotice>}
          <section className="memory-add-form" aria-labelledby="memory-preview-title">
            <h3 id="memory-preview-title">召回预览</h3>
            <p>输入一个问题，查看当前策略下会提供给模型的记忆引用。此操作不调用模型。</p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void queryPreview();
              }}
            >
              <div className="settings-field">
                预览问题
                <TextField
                  label="召回预览问题"
                  type="search"
                  maxLength={4096}
                  value={query}
                  onValueChange={(value) => {
                    setQuery(value);
                    clearPreview();
                  }}
                />
              </div>
              <Button type="submit" disabled={!query.trim() || Boolean(busy)}>
                {previewLoading ? "正在查询…" : "查询召回"}
              </Button>
            </form>
            {previewError && <InlineNotice tone="error">{previewError}</InlineNotice>}
            {previewLoading && <p role="status">正在读取召回预览…</p>}
            {preview?.key === contextKey && (
              <RecallPreview query={preview.query} result={preview.result} />
            )}
          </section>
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
                <span className="settings-field-label">记忆内容</span>
                <TextAreaField
                  label="记忆内容"
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
              {(!memory.settings?.enabled || !memory.settings?.recallEnabled) &&
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
              <TabList
                className="memory-tablist"
                role="tablist"
                aria-label="记忆状态"
                value={activePanel}
                onChange={(value) => setActivePanel(value as PanelId)}
              >
                {panels.map((panel) => (
                  <Tab
                    key={panel}
                    value={panel}
                    onFocus={() => setActivePanel(panel)}
                    id={`memory-tab-${panel}`}
                    panelId={`memory-panel-${panel}`}
                    label={panelLabels[panel]}
                    endContent={
                      <span>
                        {memory.pageInfo?.counts[panel === "saved" ? "active" : "archived"] ??
                          groups[panel].length}
                      </span>
                    }
                  />
                ))}
              </TabList>
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
                    <span
                      aria-label={`${memory.pageInfo?.counts[panel === "saved" ? "active" : "archived"] ?? groups[panel].length} 项`}
                    >
                      {memory.pageInfo?.counts[panel === "saved" ? "active" : "archived"] ??
                        groups[panel].length}
                    </span>
                  </header>
                  {renderList(panel)}
                </section>
              ))}
            </div>
          )}
          {memory.pageInfo?.nextCursor && (
            <Button
              variant="quiet"
              disabled={Boolean(busy) || memory.status === "loading"}
              onClick={() => void actions.loadMoreMemory()}
            >
              {memory.status === "loading" ? "正在加载…" : "加载更多记忆"}
            </Button>
          )}
        </>
      )}
      <Link className="button" to="/settings/memory">
        用户级记忆设置
      </Link>
    </section>
  );
}

function SourceDetails({ item }: { readonly item: MemoryListItem }) {
  const source = Array.isArray(item.sources) ? item.sources[0] : item.firstSource;
  const sourceCount = Array.isArray(item.sources) ? item.sources.length : item.sourceCount;
  return (
    <details className="memory-source">
      <summary>
        {item.origin === "user_requested"
          ? source
            ? "用户保存"
            : "手动保存"
          : item.origin === "agent_extracted"
            ? "对话提取"
            : "来源信息"}
      </summary>
      <dl>
        {typeof sourceCount === "number" && sourceCount > 0 && (
          <div>
            <dt>来源数量</dt>
            <dd>{sourceCount}</dd>
          </div>
        )}
        {source ? (
          <>
            <div>
              <dt>来源会话</dt>
              <dd>{source.sessionId}</dd>
            </div>
            <div>
              <dt>来源引用</dt>
              <dd>{source.eventId}</dd>
            </div>
          </>
        ) : (
          <div>
            <dt>来源</dt>
            <dd>{item.origin === "user_requested" ? "手动内容，无会话引用" : "来源详情未提供"}</dd>
          </div>
        )}
        <>
          <div>
            <dt>作用域</dt>
            <dd>{item.scopeType === "global" ? "全局" : "当前工作区"}</dd>
          </div>
          <div>
            <dt>时间类型</dt>
            <dd>{temporalLabels[item.temporalType]}</dd>
          </div>
          <div>
            <dt>{source ? "来源观察时间" : "记录时间"}</dt>
            <dd>{formatTime(item.observedAt)}</dd>
          </div>
          <div>
            <dt>最近修改时间</dt>
            <dd>{formatTime(item.updatedAt)}</dd>
          </div>
          {item.eventStartedAt !== null && (
            <div>
              <dt>开始</dt>
              <dd>{formatTime(item.eventStartedAt)}</dd>
            </div>
          )}
          {item.eventEndedAt !== null && (
            <div>
              <dt>结束</dt>
              <dd>{formatTime(item.eventEndedAt)}</dd>
            </div>
          )}
        </>
      </dl>
      <p>记录和修改时间不代表事实开始生效；事件时间仅表示这条信息注明的发生时间。</p>
    </details>
  );
}
function memoryItemLabel(item: MemoryListItem): string {
  return [...item.content].slice(0, 60).join("") || "记忆";
}
function formatTime(value: number): string {
  return new Date(value).toLocaleString("zh-CN");
}

function eventTimeInput(value: number | null): string {
  if (value === null) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const local = new Date(value - date.getTimezoneOffset() * 60_000);
  return Number.isFinite(local.getTime()) ? local.toISOString().slice(0, -1) : "";
}

function parseEventTime(value: string): number | null {
  if (!value.trim()) return null;
  const timestamp = new Date(value).getTime();
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
}

function RecallPreview({
  query,
  result,
}: {
  query: string;
  result: RuntimeResult<"memory.context.preview">;
}) {
  return (
    <div className="memory-preview-result" role="region" aria-label="召回预览结果">
      <p>问题：{query}</p>
      <p>
        选入 {result.budget.usedItems} / {result.budget.maxItems} 条 · {result.budget.usedTokens} /{" "}
        {result.budget.maxTokens} Token
        {result.budget.truncated ? " · 部分候选未选入" : ""}
      </p>
      {result.references === undefined ? (
        <p>当前服务未提供实际引用详情，请更新电脑端后重试。</p>
      ) : result.references.length === 0 ? (
        <p>当前问题没有选入记忆。相关条目可能未匹配，或记忆/召回已关闭。</p>
      ) : (
        <div className="memory-list">
          {result.references.map((reference) => (
            <article className="memory-card" key={reference.itemId}>
              <header className="memory-card__meta">
                <span>{sourceLabels[reference.source]}</span>
                <span>{matchLabels[reference.match]}</span>
              </header>
              <p>{reference.content}</p>
              <small>
                条目：{reference.itemId} · {reference.excerpt ? "原文节选" : "完整引用"} · 字符范围
                [{reference.range.start}, {reference.range.end}) / {reference.range.total}
              </small>
            </article>
          ))}
        </div>
      )}
      {(result.diagnostics?.length ?? 0) > 0 && (
        <details className="memory-source">
          <summary>候选说明</summary>
          {result.diagnostics?.map((diagnostic) => (
            <p key={`${diagnostic.itemId}:${diagnostic.reason}`}>
              {diagnostic.itemId}：{diagnosticLabels[diagnostic.reason]} ·{" "}
              {matchLabels[diagnostic.match]}
            </p>
          ))}
        </details>
      )}
    </div>
  );
}

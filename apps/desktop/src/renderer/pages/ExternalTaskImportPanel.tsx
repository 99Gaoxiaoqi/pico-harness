import { useEffect, useRef, useState } from "react";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import type { RuntimeParams } from "@pico/protocol";
import { Button, EmptyState, InlineNotice } from "../components.js";
import { SelectField, TextField } from "../ui-controls.js";
import { formatRelative } from "../view-format.js";
import { useRuntime } from "../runtime-context.js";

const SOURCE_LABELS: Readonly<Record<RuntimeParams<"externalSessions.list">["adapterId"], string>> =
  {
    codex: "Codex",
    "claude-code": "Claude Code",
    opencode: "OpenCode",
  };

export function ExternalTaskImportPanel() {
  const { actions, preview } = useRuntime();
  const [sources, setSources] = useState<
    Awaited<ReturnType<typeof actions.listExternalSessionSources>>
  >([]);
  const [adapterId, setAdapterId] =
    useState<RuntimeParams<"externalSessions.list">["adapterId"]>("codex");
  const [items, setItems] = useState<
    Awaited<ReturnType<typeof actions.listExternalSessions>>["sessions"]
  >([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedItems, setSelectedItems] = useState<Map<string, (typeof items)[number]>>(
    () => new Map(),
  );
  const [importedItemIds, setImportedItemIds] = useState<Set<string>>(() => new Set());
  const [importing, setImporting] = useState(false);
  const [importingItemId, setImportingItemId] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState({ completed: 0, total: 0 });
  const [error, setError] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const requestRevision = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void actions
      .listExternalSessionSources()
      .then((found) => {
        if (cancelled) return;
        setSources(found);
        const available = found.find((source) => source.available);
        if (available) setAdapterId(available.id);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [actions]);

  useEffect(() => {
    const selected = sources.find((source) => source.id === adapterId);
    if (!selected?.available) {
      requestRevision.current += 1;
      setItems([]);
      setNextCursor(null);
      setSelectedItems(new Map());
      setLoading(false);
      setLoadingMore(false);
      return;
    }
    requestRevision.current += 1;
    setItems([]);
    setNextCursor(null);
    setSelectedItems(new Map());
    setLoading(true);
    setLoadingMore(false);
    const timer = window.setTimeout(() => {
      void loadPage(adapterId, query, undefined);
    }, 150);
    return () => window.clearTimeout(timer);
    // Source and query changes trigger a debounced first-page search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapterId, query, sources]);

  async function loadPage(
    sourceId: RuntimeParams<"externalSessions.list">["adapterId"],
    text: string,
    pageCursor: string | undefined,
  ) {
    const revision = ++requestRevision.current;
    const isLoadingMore = Boolean(pageCursor);
    if (isLoadingMore) {
      setLoadingMore(true);
    } else {
      setSelectedItems(new Map());
      setItems([]);
      setLoading(true);
      setLoadingMore(false);
    }
    setError("");
    setStatusMessage("");
    try {
      const result = await actions.listExternalSessions({
        adapterId: sourceId,
        ...(text.trim() ? { text: text.trim() } : {}),
        ...(pageCursor ? { cursor: pageCursor } : {}),
      });
      if (revision !== requestRevision.current) return;
      setItems((current) => {
        if (!isLoadingMore) return result.sessions;
        const existingIds = new Set(current.map((item) => item.id));
        return [...current, ...result.sessions.filter((item) => !existingIds.has(item.id))];
      });
      setNextCursor(result.nextCursor);
    } catch (cause) {
      if (revision === requestRevision.current) setError(errorMessage(cause));
    } finally {
      if (revision === requestRevision.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }

  function setItemSelected(item: (typeof items)[number], selected: boolean) {
    setSelectedItems((current) => {
      const next = new Map(current);
      if (selected) next.set(item.id, item);
      else next.delete(item.id);
      return next;
    });
  }

  const selectableItems = items.filter(
    (item) => item.cwd.trim().length > 0 && !importedItemIds.has(importedKey(adapterId, item.id)),
  );
  const selectedLoaded = items.filter((item) => selectedItems.has(item.id)).length;
  const selectAllValue: boolean | "indeterminate" =
    selectedLoaded === 0
      ? false
      : selectedLoaded === selectableItems.length
        ? true
        : "indeterminate";

  const controlsDisabled = loading || loadingMore || importing;

  async function importSelected() {
    const selected = [...selectedItems.values()];
    if (selected.length === 0) return;
    setImporting(true);
    setImportProgress({ completed: 0, total: selected.length });
    setError("");
    setStatusMessage("");
    const importedIds = new Set<string>();
    const failures: string[] = [];
    for (const [index, item] of selected.entries()) {
      try {
        await actions.importExternalSession({
          adapterId,
          sourceSessionId: item.id,
        });
        importedIds.add(item.id);
        setImportedItemIds((current) => new Set(current).add(importedKey(adapterId, item.id)));
      } catch (cause) {
        failures.push(`${item.title}：${errorMessage(cause)}`);
      }
      setImportProgress({ completed: index + 1, total: selected.length });
    }
    setSelectedItems((current) => {
      const remaining = new Map(current);
      for (const id of importedIds) remaining.delete(id);
      return remaining;
    });
    if (failures.length > 0) {
      setError(
        `已导入 ${importedIds.size} 项，${failures.length} 项失败：${failures.slice(0, 3).join("；")}`,
      );
    } else {
      setStatusMessage(`已导入 ${importedIds.size} 项任务。`);
    }
    setImporting(false);
  }

  async function importOne(item: (typeof items)[number]) {
    setImporting(true);
    setImportingItemId(item.id);
    setError("");
    setStatusMessage("");
    try {
      await actions.importExternalSession({
        adapterId,
        sourceSessionId: item.id,
      });
      setImportedItemIds((current) => new Set(current).add(importedKey(adapterId, item.id)));
      setSelectedItems((current) => {
        const next = new Map(current);
        next.delete(item.id);
        return next;
      });
      setStatusMessage("已导入任务。");
    } catch (cause) {
      setError(`导入失败：${item.title}：${errorMessage(cause)}`);
    } finally {
      setImportingItemId(null);
      setImporting(false);
    }
  }

  const availableSources = sources.filter((source) => source.available);
  return (
    <section className="external-task-import" aria-labelledby="external-task-import-title">
      <header className="external-task-import__header">
        <div>
          <span className="eyebrow">只读来源</span>
          <h2 id="external-task-import-title">导入外部任务</h2>
          <p>将历史对话复制为 Pico 任务。导入不会修改或持续同步来源会话。</p>
        </div>
      </header>
      {preview && <InlineNotice tone="warning">预览模式不会读取本机外部会话。</InlineNotice>}
      <div className="external-task-import__controls">
        <SelectField
          label="来源"
          name="external-task-source"
          value={adapterId}
          disabled={controlsDisabled || availableSources.length === 0}
          onValueChange={(value) => {
            if (value === "codex" || value === "claude-code" || value === "opencode") {
              setSelectedItems(new Map());
              setAdapterId(value);
            }
          }}
          options={sources.map((source) => ({
            value: source.id,
            label: `${source.name}${source.available ? "" : "（未检测到）"}`,
            disabled: !source.available,
          }))}
        />
        <TextField
          label="搜索外部任务"
          name="external-task-search"
          value={query}
          onValueChange={setQuery}
          placeholder="搜索标题、项目路径或 ID"
          autoComplete="off"
          disabled={importing || availableSources.length === 0}
        />
      </div>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {statusMessage && <InlineNotice tone="success">{statusMessage}</InlineNotice>}
      {availableSources.length === 0 ? (
        <EmptyState
          title="没有检测到外部任务"
          detail="支持 Codex、Claude Code 和 OpenCode 的本机会话记录。"
        />
      ) : loading ? (
        <p role="status" className="external-task-import__status">
          正在读取 {SOURCE_LABELS[adapterId]} 会话…
        </p>
      ) : items.length === 0 ? (
        <EmptyState
          title="没有匹配的外部任务"
          detail="尝试其他关键词，或选择另一个已检测到的来源。"
        />
      ) : (
        <>
          <div className="external-task-import__selection">
            <CheckboxInput
              className="check-control"
              label="全选"
              value={selectAllValue}
              isDisabled={controlsDisabled || selectableItems.length === 0}
              onChange={(checked) => {
                setSelectedItems((current) => {
                  const next = new Map(current);
                  for (const item of items) {
                    if (!item.cwd.trim() || importedItemIds.has(importedKey(adapterId, item.id)))
                      continue;
                    if (checked) next.set(item.id, item);
                    else next.delete(item.id);
                  }
                  return next;
                });
              }}
            />
            <span className="external-task-import__selection-count">
              已选 {selectedItems.size} 项
            </span>
            <Button
              className="external-task-import__action"
              disabled={controlsDisabled || selectedItems.size === 0}
              onClick={() => void importSelected()}
            >
              {importing
                ? `正在导入 ${importProgress.completed}/${importProgress.total}…`
                : "导入所选"}
            </Button>
          </div>
          <div className="external-task-import__list">
            {items.map((item) => (
              <article className="external-task-import__row" key={`${adapterId}:${item.id}`}>
                <CheckboxInput
                  className="check-control"
                  label={`选择任务：${item.title}`}
                  isLabelHidden
                  value={selectedItems.has(item.id)}
                  isDisabled={
                    controlsDisabled ||
                    !item.cwd.trim() ||
                    importedItemIds.has(importedKey(adapterId, item.id))
                  }
                  onChange={(checked) => setItemSelected(item, checked)}
                />
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.cwd || "未记录项目路径，无法导入"}</p>
                  <small>
                    {SOURCE_LABELS[adapterId]} · 更新于 {formatRelative(item.updatedAt)}
                    {item.archived ? " · 已归档" : ""}
                    {importedItemIds.has(importedKey(adapterId, item.id)) ? " · 已导入" : ""}
                  </small>
                </div>
                <Button
                  className="external-task-import__action"
                  disabled={
                    controlsDisabled ||
                    !item.cwd.trim() ||
                    importedItemIds.has(importedKey(adapterId, item.id))
                  }
                  onClick={() => void importOne(item)}
                >
                  {importingItemId === item.id
                    ? "导入中…"
                    : importedItemIds.has(importedKey(adapterId, item.id))
                      ? "已导入"
                      : "导入"}
                </Button>
              </article>
            ))}
          </div>
        </>
      )}
      {(nextCursor || loadingMore) && !loading && (
        <footer className="external-task-import__footer">
          <span>已加载 {items.length} 项</span>
          <Button
            className="external-task-import__action"
            disabled={controlsDisabled || !nextCursor}
            onClick={() => {
              if (nextCursor) void loadPage(adapterId, query, nextCursor);
            }}
          >
            {loadingMore ? "正在加载…" : "加载更多"}
          </Button>
        </footer>
      )}
    </section>
  );
}

function importedKey(adapterId: RuntimeParams<"externalSessions.list">["adapterId"], id: string) {
  return `${adapterId}:${id}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/^[A-Z_]+:\s*/u, "");
  return "无法读取或导入外部会话。";
}

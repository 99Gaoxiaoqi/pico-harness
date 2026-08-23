import type {
  DesktopRuntimeMethod,
  RuntimeParams,
  RuntimeResult,
  RuntimeSessionArtifact,
  RuntimeSessionContextSnapshot,
  RuntimeSessionSubscriptionFrame,
  RuntimeSessionTask,
  RuntimeTerminalSession,
} from "@pico/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DesktopRuntimeApi } from "../../preload/contract.js";
import {
  FilesWorkbarPanel,
  type WorkbarArtifact,
  type WorkbarArtifactContent,
} from "./FilesWorkbarPanel.js";
import {
  InspectorWorkbarPanel,
  type InspectorContextSnapshot,
  type InspectorToolPreview,
  type InspectorTraceItem,
} from "./InspectorWorkbarPanel.js";
import {
  ReviewWorkbarPanel,
  type ReviewChangedFile,
  type ReviewDiffView,
  type ReviewSelection,
  type ReviewSnapshot,
} from "./ReviewWorkbarPanel.js";
import {
  TasksWorkbarPanel,
  type WorkbarTaskCreateRequest,
  type WorkbarTaskItem,
  type WorkbarTaskLedger,
  type WorkbarTaskUpdateRequest,
} from "./TasksWorkbarPanel.js";
import {
  TerminalWorkbarPanel,
  type WorkbarTerminalGrid,
  type WorkbarTerminalInstance,
  type WorkbarTerminalOutput,
} from "./TerminalWorkbarPanel.js";

const ARTIFACT_CHUNK_BYTES = 32 * 1024;
const TERMINAL_POLL_MS = 400;
const TERMINAL_ATTACH_BYTES = 64 * 1024;
const TERMINAL_OUTPUT_BYTES = 512 * 1024;
const QUERY_PAGE_SIZE = 200;

export type WorkbarPanelHostKind = "inspector" | "review" | "tasks" | "files" | "terminal";

export interface WorkbarPanelHostProps {
  readonly kind: WorkbarPanelHostKind;
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly active: boolean;
  readonly readOnly: boolean;
}

interface WorkbarScope {
  readonly workspacePath: string;
  readonly sessionId: string;
}

export class WorkbarPanelRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "WorkbarPanelRuntimeError";
  }
}

export class WorkbarReviewConflictError extends Error {
  constructor(
    readonly stagedRevision: string,
    readonly unstagedRevision: string,
  ) {
    super(`Git 快照版本冲突：staged ${stagedRevision}，unstaged ${unstagedRevision}`);
    this.name = "WorkbarReviewConflictError";
  }
}

export async function invokeWorkbarRuntime<Method extends DesktopRuntimeMethod>(
  runtime: DesktopRuntimeApi,
  method: Method,
  params: RuntimeParams<Method>,
): Promise<RuntimeResult<Method>> {
  const result = await runtime[method](params);
  if (!result.ok) {
    throw new WorkbarPanelRuntimeError(
      result.error.code,
      result.error.message,
      result.error.retryable,
    );
  }
  return result.value;
}

export interface WorkbarResourceGate {
  readonly active: boolean;
  readonly sessionId: string;
  readonly resource: "tasks" | "artifacts" | "trace" | "context";
  readonly revision?: number;
  readonly watermark?: number;
}

export function shouldRefreshWorkbarResource(
  frame: RuntimeSessionSubscriptionFrame,
  gate: WorkbarResourceGate,
): boolean {
  if (
    !gate.active ||
    frame.type !== "subscription.resource_changed" ||
    frame.sessionId !== gate.sessionId ||
    frame.resource !== gate.resource
  ) {
    return false;
  }
  if (
    frame.revision !== undefined &&
    gate.revision !== undefined &&
    frame.revision <= gate.revision
  ) {
    return false;
  }
  if (
    frame.watermark !== undefined &&
    gate.watermark !== undefined &&
    frame.watermark <= gate.watermark
  ) {
    return false;
  }
  return true;
}

export function WorkbarPanelHost(props: WorkbarPanelHostProps) {
  const key = `${props.workspacePath}:${props.sessionId}:${props.instanceId}`;
  switch (props.kind) {
    case "inspector":
      return <InspectorPanelController key={key} {...props} />;
    case "review":
      return <ReviewPanelController key={key} {...props} />;
    case "tasks":
      return <TasksPanelController key={key} {...props} />;
    case "files":
      return <FilesPanelController key={key} {...props} />;
    case "terminal":
      return <TerminalPanelController key={key} {...props} />;
  }
}

function TasksPanelController({
  workspacePath,
  sessionId,
  instanceId,
  active,
  readOnly,
}: WorkbarPanelHostProps) {
  const runtime = window.pico.runtime;
  const scope = useMemo(() => ({ workspacePath, sessionId }), [workspacePath, sessionId]);
  const [ledger, setLedger] = useState<WorkbarTaskLedger>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [updatingTaskIds, setUpdatingTaskIds] = useState<ReadonlySet<string>>(new Set());
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await queryAllWorkbarTasks(runtime, scope);
      if (request === requestRef.current) setLedger(next);
    } catch (cause) {
      if (request === requestRef.current) setError(workbarErrorMessage(cause));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [runtime, scope]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  useResourceFrame(
    {
      active,
      sessionId,
      resource: "tasks",
      revision: ledger?.revision,
    },
    refresh,
  );

  const create = useCallback(
    async (request: WorkbarTaskCreateRequest) => {
      if (readOnly || creating) return;
      setCreating(true);
      setError(undefined);
      try {
        await invokeWorkbarRuntime(runtime, "session.tasks.command", {
          ...scope,
          action: "create",
          title: request.title,
          expectedRevision: request.expectedLedgerRevision,
          idempotencyKey: workbarIdempotencyKey(instanceId, "task-create"),
        });
        await refresh();
      } catch (cause) {
        setError(workbarErrorMessage(cause));
      } finally {
        setCreating(false);
      }
    },
    [creating, instanceId, readOnly, refresh, runtime, scope],
  );

  const update = useCallback(
    async (request: WorkbarTaskUpdateRequest) => {
      if (readOnly || updatingTaskIds.has(request.taskId)) return;
      const current = ledger?.tasks.find((task) => task.id === request.taskId);
      if (!current || current.revision !== request.expectedTaskRevision) {
        setError("待办已被其他操作更新，请刷新后重试。");
        return;
      }
      setUpdatingTaskIds((ids) => new Set(ids).add(request.taskId));
      setError(undefined);
      try {
        await invokeWorkbarRuntime(runtime, "session.tasks.command", {
          ...scope,
          action: "update",
          taskId: request.taskId,
          status: request.status,
          expectedRevision: request.expectedLedgerRevision,
          idempotencyKey: workbarIdempotencyKey(instanceId, `task-update:${request.taskId}`),
        });
        await refresh();
      } catch (cause) {
        setError(workbarErrorMessage(cause));
      } finally {
        setUpdatingTaskIds((ids) => {
          const next = new Set(ids);
          next.delete(request.taskId);
          return next;
        });
      }
    },
    [instanceId, ledger?.tasks, readOnly, refresh, runtime, scope, updatingTaskIds],
  );

  return (
    <TasksWorkbarPanel
      ledger={ledger}
      loading={loading}
      error={error}
      readOnly={readOnly}
      creating={creating}
      updatingTaskIds={updatingTaskIds}
      onRefresh={() => void refresh()}
      onCreate={(request) => void create(request)}
      onUpdate={(request) => void update(request)}
    />
  );
}

export async function queryAllWorkbarTasks(
  runtime: DesktopRuntimeApi,
  scope: WorkbarScope,
): Promise<WorkbarTaskLedger> {
  let cursor: string | undefined;
  let revision: number | undefined;
  const tasks: WorkbarTaskItem[] = [];
  do {
    const page = await invokeWorkbarRuntime(runtime, "session.tasks.query", {
      ...scope,
      limit: QUERY_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
      ...(revision === undefined ? {} : { revision }),
    });
    revision ??= page.revision;
    if (page.revision !== revision) throw new Error("待办分页版本发生变化，请重试。");
    tasks.push(...page.tasks.map(taskView));
    cursor = page.nextCursor;
  } while (cursor);
  return { revision: revision ?? 0, tasks };
}

function taskView(task: RuntimeSessionTask): WorkbarTaskItem {
  return {
    id: task.taskId,
    title: task.title,
    status: task.status,
    revision: task.version,
    ...(task.detail ? { description: task.detail } : {}),
    updatedAt: timestampText(task.updatedAt),
  };
}

function FilesPanelController({ workspacePath, sessionId, active }: WorkbarPanelHostProps) {
  const runtime = window.pico.runtime;
  const scope = useMemo(() => ({ workspacePath, sessionId }), [workspacePath, sessionId]);
  const [artifacts, setArtifacts] = useState<readonly WorkbarArtifact[]>([]);
  const [revision, setRevision] = useState<number>();
  const [selectedArtifactId, setSelectedArtifactId] = useState<string>();
  const [content, setContent] = useState<WorkbarArtifactContent>();
  const [loading, setLoading] = useState(false);
  const [contentLoading, setContentLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [contentError, setContentError] = useState<string>();
  const streamRef = useRef<ArtifactStreamAccumulator | undefined>(undefined);
  const requestRef = useRef(0);
  const contentRequestRef = useRef(0);
  const selectedArtifactRef = useRef<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await queryAllWorkbarArtifacts(runtime, scope);
      if (request !== requestRef.current) return;
      setArtifacts(next.artifacts);
      setRevision(next.revision);
      setSelectedArtifactId((selected) => {
        if (selected && next.artifacts.some((artifact) => artifact.id === selected))
          return selected;
        selectedArtifactRef.current = undefined;
        contentRequestRef.current += 1;
        streamRef.current = undefined;
        setContent(undefined);
        return undefined;
      });
    } catch (cause) {
      if (request === requestRef.current) setError(workbarErrorMessage(cause));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [runtime, scope]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  useResourceFrame({ active, sessionId, resource: "artifacts", revision }, refresh);

  const loadChunk = useCallback(
    async (artifactId: string, offset: number) => {
      if (!active) return;
      const request = ++contentRequestRef.current;
      setContentLoading(true);
      setContentError(undefined);
      try {
        const value = await invokeWorkbarRuntime(runtime, "session.artifacts.query", {
          ...scope,
          action: "read_chunk",
          artifactId,
          offsetBytes: offset,
          limitBytes: ARTIFACT_CHUNK_BYTES,
        });
        if (request !== contentRequestRef.current || selectedArtifactRef.current !== artifactId) {
          return;
        }
        const envelope = parseArtifactChunk(value);
        const artifact = artifacts.find((candidate) => candidate.id === artifactId);
        if (!artifact) throw new Error("生成文件已从当前 Session 移除。");
        const previous = offset === 0 ? undefined : streamRef.current;
        const next = appendArtifactStreamChunk(previous, artifact, envelope);
        streamRef.current = next;
        setContent(artifactContentView(next));
      } catch (cause) {
        if (request === contentRequestRef.current) setContentError(workbarErrorMessage(cause));
      } finally {
        if (request === contentRequestRef.current) setContentLoading(false);
      }
    },
    [active, artifacts, runtime, scope],
  );

  const selectArtifact = useCallback(
    (artifactId: string) => {
      selectedArtifactRef.current = artifactId;
      setSelectedArtifactId(artifactId);
      streamRef.current = undefined;
      setContent(undefined);
      void loadChunk(artifactId, 0);
    },
    [loadChunk],
  );

  return (
    <FilesWorkbarPanel
      artifacts={artifacts}
      selectedArtifactId={selectedArtifactId}
      content={content}
      loading={loading}
      contentLoading={contentLoading}
      error={error}
      contentError={contentError}
      onRefresh={() => void refresh()}
      onSelectArtifact={selectArtifact}
      onLoadChunk={(artifactId, offset) => void loadChunk(artifactId, offset)}
    />
  );
}

interface ArtifactListResult {
  readonly revision: number;
  readonly artifacts: readonly WorkbarArtifact[];
}

export async function queryAllWorkbarArtifacts(
  runtime: DesktopRuntimeApi,
  scope: WorkbarScope,
): Promise<ArtifactListResult> {
  let cursor: string | undefined;
  let revision: number | undefined;
  const artifacts: WorkbarArtifact[] = [];
  do {
    const value = await invokeWorkbarRuntime(runtime, "session.artifacts.query", {
      ...scope,
      action: "list",
      limit: QUERY_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
      ...(revision === undefined ? {} : { revision }),
    });
    const page = parseArtifactPage(value);
    revision ??= page.revision;
    if (page.revision !== revision) throw new Error("生成文件分页版本发生变化，请重试。");
    artifacts.push(...page.artifacts.map(artifactView));
    cursor = page.nextCursor;
  } while (cursor);
  return { revision: revision ?? 0, artifacts };
}

export interface ArtifactChunkEnvelope {
  readonly contentBase64: string;
  readonly offsetBytes: number;
  readonly endOffsetBytes: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
  readonly nextOffsetBytes?: number;
}

export interface ArtifactStreamAccumulator {
  readonly artifactId: string;
  readonly encoding: "utf8" | "base64";
  readonly bytes: Uint8Array;
  readonly nextOffset: number;
  readonly totalSize: number;
  readonly complete: boolean;
  readonly truncated: boolean;
}

export function appendArtifactStreamChunk(
  previous: ArtifactStreamAccumulator | undefined,
  artifact: WorkbarArtifact,
  chunk: ArtifactChunkEnvelope,
): ArtifactStreamAccumulator {
  const expectedOffset = previous?.nextOffset ?? 0;
  if (previous && previous.artifactId !== artifact.id) {
    throw new Error("生成文件分块不能跨 Artifact 合并。");
  }
  if (chunk.offsetBytes !== expectedOffset || chunk.endOffsetBytes < chunk.offsetBytes) {
    throw new Error(`生成文件分块不连续：expected ${expectedOffset}, actual ${chunk.offsetBytes}`);
  }
  const decoded = decodeBase64(chunk.contentBase64);
  if (decoded.byteLength !== chunk.endOffsetBytes - chunk.offsetBytes) {
    throw new Error("生成文件分块长度与 authority 返回的字节范围不一致。");
  }
  const bytes = concatBytes(previous?.bytes, decoded);
  const nextOffset = chunk.nextOffsetBytes ?? chunk.endOffsetBytes;
  const complete = !chunk.truncated || nextOffset >= chunk.totalBytes;
  return {
    artifactId: artifact.id,
    encoding: isTextArtifact(artifact.mimeType) ? "utf8" : "base64",
    bytes,
    nextOffset,
    totalSize: chunk.totalBytes,
    complete,
    truncated: !complete,
  };
}

export function artifactContentView(stream: ArtifactStreamAccumulator): WorkbarArtifactContent {
  return {
    artifactId: stream.artifactId,
    encoding: stream.encoding,
    content:
      stream.encoding === "utf8"
        ? new TextDecoder().decode(stream.bytes, { stream: !stream.complete })
        : encodeBase64(stream.bytes),
    offset: 0,
    nextOffset: stream.nextOffset,
    totalSize: stream.totalSize,
    complete: stream.complete,
    truncated: stream.truncated,
  };
}

function artifactView(artifact: RuntimeSessionArtifact): WorkbarArtifact {
  return {
    id: artifact.artifactId,
    name: artifact.title,
    mimeType: artifact.mimeType,
    size: artifact.sizeBytes,
    createdAt: timestampText(artifact.createdAt),
    digest: artifact.digest,
  };
}

function InspectorPanelController({ workspacePath, sessionId, active }: WorkbarPanelHostProps) {
  const runtime = window.pico.runtime;
  const scope = useMemo(() => ({ workspacePath, sessionId }), [workspacePath, sessionId]);
  const [context, setContext] = useState<InspectorContextSnapshot>();
  const [trace, setTrace] = useState<readonly InspectorTraceItem[]>([]);
  const [traceRecords, setTraceRecords] = useState<ReadonlyMap<string, Record<string, unknown>>>(
    new Map(),
  );
  const [throughSequence, setThroughSequence] = useState(0);
  const [nextAfterSequence, setNextAfterSequence] = useState<number>();
  const [selectedTraceId, setSelectedTraceId] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const requestRef = useRef(0);
  const contextRequestRef = useRef(0);
  const traceRequestRef = useRef(0);
  const contextGeneratedAtRef = useRef(0);
  const traceWatermarkRef = useRef(0);

  const refreshContext = useCallback(async () => {
    const request = ++contextRequestRef.current;
    const value = await invokeWorkbarRuntime(runtime, "session.context.get", scope);
    if (request !== contextRequestRef.current) return;
    if (value.context.generatedAt < contextGeneratedAtRef.current) return;
    contextGeneratedAtRef.current = value.context.generatedAt;
    setContext(contextView(value.context));
  }, [runtime, scope]);

  const refreshTrace = useCallback(
    async (watermark?: number) => {
      const request = ++traceRequestRef.current;
      const page = await invokeWorkbarRuntime(runtime, "session.trace.query", {
        ...scope,
        limit: 100,
        ...(watermark === undefined ? {} : { throughSequence: watermark }),
      });
      if (request !== traceRequestRef.current) return;
      if (page.throughSequence < traceWatermarkRef.current) return;
      const parsed = tracePageView(page.events);
      traceWatermarkRef.current = page.throughSequence;
      setTrace(parsed.items);
      setTraceRecords(parsed.records);
      setThroughSequence(page.throughSequence);
      setNextAfterSequence(page.nextAfterSequence);
      setSelectedTraceId((selected) =>
        selected && parsed.records.has(selected) ? selected : undefined,
      );
    },
    [runtime, scope],
  );

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setError(undefined);
    try {
      await Promise.all([refreshContext(), refreshTrace()]);
    } catch (cause) {
      if (request === requestRef.current) setError(workbarErrorMessage(cause));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [refreshContext, refreshTrace]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  useResourceFrame({ active, sessionId, resource: "context" }, refreshContext, setError);
  useResourceFrame(
    { active, sessionId, resource: "trace", watermark: throughSequence },
    refreshTrace,
    setError,
  );

  const loadMore = useCallback(async () => {
    if (!active || nextAfterSequence === undefined) return;
    const request = ++traceRequestRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const page = await invokeWorkbarRuntime(runtime, "session.trace.query", {
        ...scope,
        throughSequence,
        afterSequence: nextAfterSequence,
        limit: 100,
      });
      if (request !== traceRequestRef.current) return;
      if (page.throughSequence !== throughSequence) {
        throw new Error("Trace 分页水位已经变化，请刷新后重试。");
      }
      const parsed = tracePageView(page.events);
      setTrace((items) => [...items, ...parsed.items]);
      setTraceRecords((records) => new Map([...records, ...parsed.records]));
      setNextAfterSequence(page.nextAfterSequence);
    } catch (cause) {
      setError(workbarErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [active, nextAfterSequence, runtime, scope, throughSequence]);

  const preview = useMemo<InspectorToolPreview | undefined>(() => {
    if (!selectedTraceId) return undefined;
    const record = traceRecords.get(selectedTraceId);
    return record ? tracePreview(record) : undefined;
  }, [selectedTraceId, traceRecords]);

  return (
    <InspectorWorkbarPanel
      context={context}
      trace={trace}
      selectedTraceId={selectedTraceId}
      preview={preview}
      loading={loading}
      error={error}
      hasMore={nextAfterSequence !== undefined}
      onRefresh={() => void refresh()}
      onSelectTrace={setSelectedTraceId}
      onOpenPreview={setSelectedTraceId}
      onLoadMore={() => void loadMore()}
    />
  );
}

function contextView(context: RuntimeSessionContextSnapshot): InspectorContextSnapshot {
  return {
    version: context.version,
    routeId: stringField(context, "routeId"),
    estimatedInputTokens: numberField(context, "estimatedInputTokens"),
    inputBudgetTokens: numberField(context, "inputBudgetTokens"),
    remainingTokens: numberField(context, "remainingTokens"),
    contextWindowTokens: numberField(context, "contextWindowTokens"),
    usedPercent: numberField(context, "usedPercent"),
    estimation: context["estimation"] === "estimated" ? "estimated" : "unknown",
  };
}

interface ParsedTracePage {
  readonly items: readonly InspectorTraceItem[];
  readonly records: ReadonlyMap<string, Record<string, unknown>>;
}

export function tracePageView(events: readonly Record<string, unknown>[]): ParsedTracePage {
  const items: InspectorTraceItem[] = [];
  const records = new Map<string, Record<string, unknown>>();
  for (const record of events) {
    const sequence = numberField(record, "sequence");
    const id = stringField(record, "eventId");
    if (sequence === undefined || !id) continue;
    const event = recordField(record, "event");
    const kind = stringField(record, "kind") ?? stringField(event, "kind") ?? "runtime.event";
    const data = recordField(event, "data");
    const title =
      stringField(data, "title") ??
      stringField(data, "toolName") ??
      stringField(data, "name") ??
      traceKindLabel(kind);
    items.push({
      id,
      sequence,
      createdAt: stringField(record, "at") ?? stringField(event, "at") ?? "",
      kind,
      title,
      summary: traceSummary(data),
      status: traceStatus(data),
      toolCallId: stringField(data, "toolCallId"),
    });
    records.set(id, record);
  }
  return { items, records };
}

function tracePreview(record: Record<string, unknown>): InspectorToolPreview {
  const event = recordField(record, "event");
  const data = recordField(event, "data");
  const id = stringField(record, "eventId") ?? "trace";
  const kind = stringField(record, "kind") ?? stringField(event, "kind") ?? "runtime.event";
  return {
    id,
    title: stringField(data, "title") ?? stringField(data, "toolName") ?? traceKindLabel(kind),
    subtitle: kind,
    input: printableField(data, ["input", "args", "arguments"]),
    output: printableField(data, ["output", "result", "message"]),
    error: printableField(data, ["error"]),
    truncated: Boolean(record["partial"]),
  };
}

function ReviewPanelController({ workspacePath, active }: WorkbarPanelHostProps) {
  const runtime = window.pico.runtime;
  const [snapshot, setSnapshot] = useState<ReviewSnapshot>();
  const [selection, setSelection] = useState<ReviewSelection>();
  const [diff, setDiff] = useState<ReviewDiffView>();
  const [loading, setLoading] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [diffError, setDiffError] = useState<string>();
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const next = await loadConsistentReviewSnapshot(runtime, workspacePath);
      if (request !== requestRef.current) return;
      setSnapshot(next);
      setDiff(undefined);
      setDiffError(undefined);
      setSelection((current) => {
        if (current && reviewContains(next, current)) return current;
        setDiff(undefined);
        setDiffError(undefined);
        return undefined;
      });
    } catch (cause) {
      if (request === requestRef.current) setError(workbarErrorMessage(cause));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [runtime, workspacePath]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const select = useCallback(
    async (next: ReviewSelection) => {
      setSelection(next);
      setDiff(undefined);
      setDiffError(undefined);
      if (!snapshot) return;
      setDiffLoading(true);
      try {
        setDiff(await loadReviewDiff(runtime, workspacePath, snapshot.revision, next));
      } catch (cause) {
        setDiffError(workbarErrorMessage(cause));
      } finally {
        setDiffLoading(false);
      }
    },
    [runtime, snapshot, workspacePath],
  );

  return (
    <ReviewWorkbarPanel
      snapshot={snapshot}
      selection={selection}
      diff={diff}
      loading={loading}
      diffLoading={diffLoading}
      error={error}
      diffError={diffError}
      onRefresh={() => void refresh()}
      onSelectFile={(next) => void select(next)}
    />
  );
}

export async function loadConsistentReviewSnapshot(
  runtime: DesktopRuntimeApi,
  workspacePath: string,
  attempts = 2,
): Promise<ReviewSnapshot> {
  let lastConflict: WorkbarReviewConflictError | undefined;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    const [staged, unstaged] = await Promise.all([
      invokeWorkbarRuntime(runtime, "git.review.snapshot", { workspacePath, source: "staged" }),
      invokeWorkbarRuntime(runtime, "git.review.snapshot", { workspacePath, source: "unstaged" }),
    ]);
    if (staged.revision === unstaged.revision) {
      return {
        revision: staged.revision,
        branch: staged.branch || unstaged.branch,
        staged: staged.files.map(reviewFileView),
        unstaged: unstaged.files.map(reviewFileView),
      };
    }
    lastConflict = new WorkbarReviewConflictError(staged.revision, unstaged.revision);
  }
  throw lastConflict ?? new Error("Git 快照不可用。");
}

export async function loadReviewDiff(
  runtime: DesktopRuntimeApi,
  workspacePath: string,
  expectedRevision: string,
  selection: ReviewSelection,
): Promise<ReviewDiffView> {
  const value = await invokeWorkbarRuntime(runtime, "git.review.diff", {
    workspacePath,
    path: selection.path,
    source: selection.source,
    expectedRevision,
  });
  if (value.revision !== expectedRevision) {
    throw new WorkbarReviewConflictError(expectedRevision, value.revision);
  }
  return {
    path: value.path,
    source: selection.source,
    revision: value.revision,
    content: value.patch,
    truncated: value.truncated,
  };
}

function reviewFileView(
  file: RuntimeResult<"git.review.snapshot">["files"][number],
): ReviewChangedFile {
  return {
    path: file.path,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
  };
}

function reviewContains(snapshot: ReviewSnapshot, selection: ReviewSelection): boolean {
  const files = selection.source === "staged" ? snapshot.staged : snapshot.unstaged;
  return files.some((file) => file.path === selection.path);
}

interface TerminalAttachmentState {
  readonly epoch: string;
  readonly sequence: number;
  readonly text: string;
  readonly truncated: boolean;
}

export interface WorkbarTerminalInstanceScope extends WorkbarScope {
  readonly instanceId: string;
}

export interface WorkbarTerminalBinding {
  readonly terminalId: string;
  readonly resourceEpoch: string;
}

const terminalBindings = new Map<string, Map<string, string>>();

export function listWorkbarTerminalBindings(
  scope: WorkbarTerminalInstanceScope,
): readonly WorkbarTerminalBinding[] {
  return [...(terminalBindings.get(terminalBindingKey(scope)) ?? new Map())].map(
    ([terminalId, resourceEpoch]) => ({ terminalId, resourceEpoch }),
  );
}

/** Called by the Workbar close action before it removes a Terminal tab. */
export async function stopWorkbarTerminalInstance(
  runtime: DesktopRuntimeApi,
  scope: WorkbarTerminalInstanceScope,
): Promise<number> {
  const key = terminalBindingKey(scope);
  const bindings = [...(terminalBindings.get(key) ?? new Map())];
  let stopped = 0;
  for (const [terminalId, resourceEpoch] of bindings) {
    try {
      await invokeWorkbarRuntime(runtime, "terminal.stop", {
        workspacePath: scope.workspacePath,
        sessionId: scope.sessionId,
        terminalId,
        resourceEpoch,
      });
      stopped += 1;
      terminalBindings.get(key)?.delete(terminalId);
    } catch (cause) {
      if (!isEpochConflict(cause)) throw cause;
      const attached = await invokeWorkbarRuntime(runtime, "terminal.attach", {
        workspacePath: scope.workspacePath,
        sessionId: scope.sessionId,
        terminalId,
        maxBytes: 1,
      });
      await invokeWorkbarRuntime(runtime, "terminal.stop", {
        workspacePath: scope.workspacePath,
        sessionId: scope.sessionId,
        terminalId,
        resourceEpoch: attached.resourceEpoch,
      });
      stopped += 1;
      terminalBindings.get(key)?.delete(terminalId);
    }
  }
  if (terminalBindings.get(key)?.size === 0) terminalBindings.delete(key);
  return stopped;
}

function TerminalPanelController({
  workspacePath,
  sessionId,
  instanceId,
  active,
  readOnly,
}: WorkbarPanelHostProps) {
  const runtime = window.pico.runtime;
  const scope = useMemo(() => ({ workspacePath, sessionId }), [workspacePath, sessionId]);
  const [terminals, setTerminals] = useState<readonly WorkbarTerminalInstance[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string>();
  const [output, setOutput] = useState<WorkbarTerminalOutput>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [pollingActive, setPollingActive] = useState(false);
  const initializedRef = useRef(false);
  const activeTerminalIdRef = useRef<string | undefined>(undefined);
  const attachmentsRef = useRef(new Map<string, TerminalAttachmentState>());
  const pollInFlightRef = useRef(false);

  const applyAttachment = useCallback(
    (
      value: RuntimeResult<"terminal.attach"> | RuntimeResult<"terminal.create">,
      replace: boolean,
    ) => {
      const current = attachmentsRef.current.get(value.terminal.terminalId);
      const text = replace
        ? value.snapshot
        : appendTerminalOutput(current?.text ?? "", value.snapshot, TERMINAL_OUTPUT_BYTES);
      const attachment = {
        epoch: value.resourceEpoch,
        sequence: value.sequence,
        text,
        truncated: value.truncated || current?.truncated === true,
      } satisfies TerminalAttachmentState;
      attachmentsRef.current.set(value.terminal.terminalId, attachment);
      const key = terminalBindingKey({ workspacePath, sessionId, instanceId });
      const bindings = terminalBindings.get(key);
      if (bindings?.has(value.terminal.terminalId)) {
        bindings.set(value.terminal.terminalId, value.resourceEpoch);
      }
      setTerminals((items) => upsertTerminal(items, terminalView(value.terminal, true)));
      setOutput((currentOutput) =>
        activeTerminalIdRef.current === value.terminal.terminalId || !currentOutput
          ? terminalOutputView(value.terminal.terminalId, attachment)
          : currentOutput,
      );
      return attachment;
    },
    [instanceId, sessionId, workspacePath],
  );

  const attach = useCallback(
    async (terminalId: string, incremental = false) => {
      const current = attachmentsRef.current.get(terminalId);
      let value: RuntimeResult<"terminal.attach">;
      try {
        value = await invokeWorkbarRuntime(runtime, "terminal.attach", {
          ...scope,
          terminalId,
          maxBytes: TERMINAL_ATTACH_BYTES,
          ...(incremental && current ? { afterSequence: current.sequence } : {}),
        });
      } catch (cause) {
        if (!incremental || !current || !isEpochConflict(cause)) throw cause;
        value = await invokeWorkbarRuntime(runtime, "terminal.attach", {
          ...scope,
          terminalId,
          maxBytes: TERMINAL_ATTACH_BYTES,
        });
        return applyAttachment(value, true);
      }
      if (incremental && current && value.resourceEpoch !== current.epoch) {
        value = await invokeWorkbarRuntime(runtime, "terminal.attach", {
          ...scope,
          terminalId,
          maxBytes: TERMINAL_ATTACH_BYTES,
        });
        return applyAttachment(value, true);
      }
      return applyAttachment(value, !incremental || !current);
    },
    [applyAttachment, runtime, scope],
  );

  const create = useCallback(async () => {
    if (readOnly) {
      setError("当前任务只读，不能新建终端。");
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const value = await invokeWorkbarRuntime(runtime, "terminal.create", scope);
      bindTerminalToInstance(
        { workspacePath, sessionId, instanceId },
        value.terminal.terminalId,
        value.resourceEpoch,
      );
      activeTerminalIdRef.current = value.terminal.terminalId;
      setActiveTerminalId(value.terminal.terminalId);
      applyAttachment(value, true);
    } catch (cause) {
      setError(workbarErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [applyAttachment, instanceId, readOnly, runtime, scope, sessionId, workspacePath]);

  const initialize = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const listed = await invokeWorkbarRuntime(runtime, "terminal.list", scope);
      setTerminals(listed.terminals.map((terminal) => terminalView(terminal, false)));
      const bindingScope = { workspacePath, sessionId, instanceId };
      const knownIds = new Set(listed.terminals.map((terminal) => terminal.terminalId));
      const key = terminalBindingKey(bindingScope);
      const bindings = terminalBindings.get(key);
      for (const terminalId of bindings?.keys() ?? []) {
        if (!knownIds.has(terminalId)) bindings?.delete(terminalId);
      }
      if (bindings?.size === 0) terminalBindings.delete(key);
      const bound = listed.terminals.find((terminal) => bindings?.has(terminal.terminalId));
      const selected = bound ?? (readOnly ? listed.terminals[0] : undefined);
      if (selected) {
        activeTerminalIdRef.current = selected.terminalId;
        setActiveTerminalId(selected.terminalId);
        await attach(selected.terminalId);
      } else if (!readOnly) {
        await create();
      }
    } catch (cause) {
      setError(workbarErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [attach, create, instanceId, readOnly, runtime, scope, sessionId, workspacePath]);

  useEffect(() => {
    if (!active || initializedRef.current) return;
    initializedRef.current = true;
    void initialize();
  }, [active, initialize]);

  useEffect(() => {
    if (!active || !pollingActive || !activeTerminalId) return;
    const poll = () => {
      if (pollInFlightRef.current) return;
      pollInFlightRef.current = true;
      void attach(activeTerminalId, true)
        .catch((cause: unknown) => setError(workbarErrorMessage(cause)))
        .finally(() => {
          pollInFlightRef.current = false;
        });
    };
    poll();
    const interval = window.setInterval(poll, TERMINAL_POLL_MS);
    return () => window.clearInterval(interval);
  }, [active, activeTerminalId, attach, pollingActive]);

  useEffect(
    () => () => {
      for (const [terminalId, attachment] of attachmentsRef.current) {
        void invokeWorkbarRuntime(runtime, "terminal.detach", {
          ...scope,
          terminalId,
          resourceEpoch: attachment.epoch,
        }).catch(() => undefined);
      }
      attachmentsRef.current.clear();
    },
    [runtime, scope],
  );

  const select = useCallback(
    (terminalId: string) => {
      activeTerminalIdRef.current = terminalId;
      setActiveTerminalId(terminalId);
      const attachment = attachmentsRef.current.get(terminalId);
      setOutput(attachment ? terminalOutputView(terminalId, attachment) : undefined);
      if (!attachment && active) {
        void attach(terminalId).catch((cause: unknown) => setError(workbarErrorMessage(cause)));
      }
    },
    [active, attach],
  );

  const withAttachment = useCallback(
    async (
      terminalId: string,
      operation: (attachment: TerminalAttachmentState) => Promise<void>,
    ) => {
      let attachment = attachmentsRef.current.get(terminalId);
      if (!attachment) attachment = await attach(terminalId);
      try {
        await operation(attachment);
      } catch (cause) {
        if (!isEpochConflict(cause)) throw cause;
        attachment = await attach(terminalId);
        await operation(attachment);
      }
    },
    [attach],
  );

  const input = useCallback(
    async (terminalId: string, data: string) => {
      if (readOnly) {
        setError("当前任务只读，不能写入终端。");
        return;
      }
      setError(undefined);
      try {
        await withAttachment(terminalId, async (attachment) => {
          await invokeWorkbarRuntime(runtime, "terminal.input", {
            ...scope,
            terminalId,
            resourceEpoch: attachment.epoch,
            data: data.endsWith("\n") || data.endsWith("\r") ? data : `${data}\r`,
          });
        });
      } catch (cause) {
        setError(workbarErrorMessage(cause));
      }
    },
    [readOnly, runtime, scope, withAttachment],
  );

  const resize = useCallback(
    async (terminalId: string, grid: WorkbarTerminalGrid) => {
      if (readOnly) return;
      try {
        await withAttachment(terminalId, async (attachment) => {
          await invokeWorkbarRuntime(runtime, "terminal.resize", {
            ...scope,
            terminalId,
            resourceEpoch: attachment.epoch,
            cols: grid.columns,
            rows: grid.rows,
          });
        });
      } catch (cause) {
        setError(workbarErrorMessage(cause));
      }
    },
    [readOnly, runtime, scope, withAttachment],
  );

  const stop = useCallback(
    async (terminalId: string) => {
      if (readOnly) {
        setError("当前任务只读，不能停止终端。");
        return;
      }
      setError(undefined);
      try {
        await withAttachment(terminalId, async (attachment) => {
          const value = await invokeWorkbarRuntime(runtime, "terminal.stop", {
            ...scope,
            terminalId,
            resourceEpoch: attachment.epoch,
          });
          setTerminals((items) => upsertTerminal(items, terminalView(value.terminal, true)));
          terminalBindings
            .get(terminalBindingKey({ workspacePath, sessionId, instanceId }))
            ?.delete(terminalId);
        });
      } catch (cause) {
        setError(workbarErrorMessage(cause));
      }
    },
    [instanceId, readOnly, runtime, scope, sessionId, withAttachment, workspacePath],
  );

  return (
    <TerminalWorkbarPanel
      terminals={terminals}
      activeTerminalId={activeTerminalId}
      output={output}
      active={active}
      loading={loading}
      error={error}
      onCreate={() => void create()}
      onSelect={select}
      onAttach={(terminalId) =>
        void attach(terminalId).catch((cause: unknown) => setError(workbarErrorMessage(cause)))
      }
      onInput={(terminalId, data) => void input(terminalId, data)}
      onResize={(terminalId, grid) => void resize(terminalId, grid)}
      onStop={(terminalId) => void stop(terminalId)}
      onSetPollingActive={setPollingActive}
    />
  );
}

export function appendTerminalOutput(current: string, chunk: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(current + chunk);
  if (bytes.byteLength <= maxBytes) return current + chunk;
  let start = bytes.byteLength - maxBytes;
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return new TextDecoder().decode(bytes.subarray(start));
}

function terminalView(
  terminal: RuntimeTerminalSession,
  attached: boolean,
): WorkbarTerminalInstance {
  return {
    id: terminal.terminalId,
    title: stringField(terminal, "title") ?? `Shell ${terminal.terminalId.slice(0, 6)}`,
    status: terminal.status,
    attached,
    sequence: terminal.sequence,
    cwd: stringField(terminal, "cwd"),
    exitCode: terminal.exitCode,
  };
}

function upsertTerminal(
  terminals: readonly WorkbarTerminalInstance[],
  next: WorkbarTerminalInstance,
): readonly WorkbarTerminalInstance[] {
  const index = terminals.findIndex((terminal) => terminal.id === next.id);
  if (index < 0) return [...terminals, next];
  return terminals.map((terminal, candidate) => (candidate === index ? next : terminal));
}

function terminalOutputView(
  terminalId: string,
  attachment: TerminalAttachmentState,
): WorkbarTerminalOutput {
  return {
    terminalId,
    text: attachment.text,
    sequence: attachment.sequence,
    truncated: attachment.truncated,
  };
}

function terminalBindingKey(scope: WorkbarTerminalInstanceScope): string {
  return JSON.stringify([scope.workspacePath, scope.sessionId, scope.instanceId]);
}

function bindTerminalToInstance(
  scope: WorkbarTerminalInstanceScope,
  terminalId: string,
  resourceEpoch: string,
): void {
  const key = terminalBindingKey(scope);
  const bindings = terminalBindings.get(key) ?? new Map<string, string>();
  bindings.set(terminalId, resourceEpoch);
  terminalBindings.set(key, bindings);
}

function useResourceFrame(
  gate: WorkbarResourceGate,
  refresh: (watermark?: number) => unknown,
  onError?: (message: string) => void,
) {
  const refreshRef = useRef(refresh);
  const errorRef = useRef(onError);
  refreshRef.current = refresh;
  errorRef.current = onError;
  useEffect(() => {
    const subscription = window.pico.sessionFrames.subscribe((frame) => {
      if (!shouldRefreshWorkbarResource(frame, gate)) return;
      try {
        void Promise.resolve(
          refreshRef.current(
            frame.type === "subscription.resource_changed" ? frame.watermark : undefined,
          ),
        ).catch((cause: unknown) => errorRef.current?.(workbarErrorMessage(cause)));
      } catch (cause) {
        errorRef.current?.(workbarErrorMessage(cause));
      }
    });
    return () => subscription.dispose();
  }, [gate.active, gate.resource, gate.revision, gate.sessionId, gate.watermark]);
}

function workbarIdempotencyKey(instanceId: string, operation: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `desktop-workbar:${instanceId}:${operation}:${suffix}`;
}

function isEpochConflict(cause: unknown): boolean {
  return (
    cause instanceof WorkbarPanelRuntimeError &&
    (cause.code === "CONFLICT" || cause.message.toLowerCase().includes("epoch"))
  );
}

function workbarErrorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  return "工作栏 authority 请求失败。";
}

function timestampText(value: number): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordField(value: unknown, key: string): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const field = value[key];
  return isRecord(field) ? field : {};
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function parseArtifactPage(value: unknown): {
  readonly revision: number;
  readonly artifacts: readonly RuntimeSessionArtifact[];
  readonly nextCursor?: string;
} {
  if (!isRecord(value)) throw new Error("生成文件 authority 返回了无效列表。");
  const revision = numberField(value, "revision");
  if (revision === undefined || !Array.isArray(value["artifacts"])) {
    throw new Error("生成文件 authority 返回了无效列表。");
  }
  const artifacts = value["artifacts"].filter(isRuntimeArtifact);
  if (artifacts.length !== value["artifacts"].length) {
    throw new Error("生成文件列表包含无效条目。");
  }
  return {
    revision,
    artifacts,
    ...(stringField(value, "nextCursor") ? { nextCursor: stringField(value, "nextCursor") } : {}),
  };
}

function parseArtifactChunk(value: unknown): ArtifactChunkEnvelope {
  if (!isRecord(value)) throw new Error("生成文件 authority 返回了无效分块。");
  const contentBase64 =
    typeof value["contentBase64"] === "string" ? value["contentBase64"] : undefined;
  const offsetBytes = numberField(value, "offsetBytes");
  const endOffsetBytes = numberField(value, "endOffsetBytes");
  const totalBytes = numberField(value, "totalBytes");
  if (
    contentBase64 === undefined ||
    offsetBytes === undefined ||
    endOffsetBytes === undefined ||
    totalBytes === undefined
  ) {
    throw new Error("生成文件 authority 返回了无效分块。");
  }
  return {
    contentBase64,
    offsetBytes,
    endOffsetBytes,
    totalBytes,
    truncated: value["truncated"] === true,
    ...(numberField(value, "nextOffsetBytes") === undefined
      ? {}
      : { nextOffsetBytes: numberField(value, "nextOffsetBytes") }),
  };
}

function isRuntimeArtifact(value: unknown): value is RuntimeSessionArtifact {
  return (
    isRecord(value) &&
    Boolean(stringField(value, "artifactId")) &&
    Boolean(stringField(value, "title")) &&
    Boolean(stringField(value, "mimeType")) &&
    Boolean(stringField(value, "digest")) &&
    numberField(value, "sizeBytes") !== undefined &&
    numberField(value, "createdAt") !== undefined &&
    numberField(value, "updatedAt") !== undefined
  );
}

function isTextArtifact(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  return (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized === "application/xml" ||
    normalized === "application/javascript" ||
    normalized.endsWith("+json") ||
    normalized.endsWith("+xml")
  );
}

function decodeBase64(value: string): Uint8Array {
  try {
    const binary = globalThis.atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error("生成文件分块不是有效 Base64。");
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const block = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += block) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + block));
  }
  return globalThis.btoa(binary);
}

function concatBytes(left: Uint8Array | undefined, right: Uint8Array): Uint8Array {
  if (!left || left.byteLength === 0) return right;
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left, 0);
  result.set(right, left.byteLength);
  return result;
}

function traceSummary(data: Record<string, unknown>): string | undefined {
  const direct = stringField(data, "summary") ?? stringField(data, "detail");
  if (direct) return direct;
  const message = recordField(data, "message");
  return stringField(message, "content");
}

function traceStatus(data: Record<string, unknown>): InspectorTraceItem["status"] {
  const status = stringField(data, "status");
  if (
    status === "pending" ||
    status === "running" ||
    status === "completed" ||
    status === "failed" ||
    status === "interrupted"
  ) {
    return status;
  }
  return "completed";
}

function traceKindLabel(kind: string): string {
  if (kind === "message.committed") return "消息已提交";
  if (kind.startsWith("tool.")) return "工具调用";
  if (kind.startsWith("run.")) return "运行状态";
  return kind;
}

function printableField(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
    if (candidate !== undefined) {
      try {
        return JSON.stringify(candidate, null, 2);
      } catch {
        return String(candidate);
      }
    }
  }
  return undefined;
}

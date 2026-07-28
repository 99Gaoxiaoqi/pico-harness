import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  EvidenceArchive,
  MAX_EVIDENCE_PAGE_LIMIT_BYTES,
  parseEvidenceUri,
} from "../context/evidence-archive.js";
import type { RuntimeEvidenceReference } from "../engine/tool-result-contract.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import type { TranscriptToolCallProjection as TuiToolCallProjection } from "../presentation/transcript-event-store.js";
import type { DialogRequest } from "./dialog-arbiter.js";
import { truncateTerminalText } from "./terminal-width.js";

const DEFAULT_PAGE_BYTES = 16 * 1024;
const MIN_PAGE_BYTES = 256;
const MAX_PAGE_BYTES = MAX_EVIDENCE_PAGE_LIMIT_BYTES;

export type InspectorSource = InlineInspectorSource | EvidenceInspectorSource;

export interface InlineInspectorSource {
  kind: "inline";
  title: string;
  content: string;
  availability: "complete" | "unavailable";
}

export interface EvidenceInspectorContext {
  /** 拥有当前 canonical ToolResult 的 session；fork 可引用 source-session Evidence。 */
  currentSessionId: string;
  /** 由当前 workspace 推导的 Evidence 根目录。 */
  evidenceBaseDir: string;
}

export interface EvidenceInspectorSource {
  kind: "evidence";
  title: string;
  uri: string;
  ref: RuntimeEvidenceReference;
  currentSessionId: string;
  evidenceBaseDir: string;
}

export interface InspectorPageRequest {
  offsetBytes?: number;
  limitBytes?: number;
}

export interface InspectorPage {
  title: string;
  content: string;
  offsetBytes: number;
  nextOffsetBytes: number;
  totalBytes: number;
  eof: boolean;
  truncated: boolean;
  /** 宿主可直接交给剪贴板动作。 */
  copyText: string;
  evidenceUri?: string;
  availability?: "complete" | "unavailable";
}

export interface InspectorProps {
  page: InspectorPage;
  maxLines?: number;
  startLine?: number;
  renderWidth?: number;
}

export function Inspector({
  page,
  maxLines = 40,
  startLine = 0,
  renderWidth = 80,
}: InspectorProps): React.ReactNode {
  const allLines = page.content.split("\n");
  const safeMaxLines = Math.max(1, maxLines);
  const safeStartLine = Math.min(
    Math.max(0, startLine),
    Math.max(0, allLines.length - safeMaxLines),
  );
  const visibleLines = allLines.slice(safeStartLine, safeStartLine + safeMaxLines);
  return (
    <Box flexDirection="column">
      <Text bold>{truncateTerminalText(page.title, renderWidth)}</Text>
      <Text dimColor>
        {truncateTerminalText(
          `bytes ${page.offsetBytes}-${page.nextOffsetBytes} / ${page.totalBytes}${
            allLines.length > safeMaxLines
              ? ` · lines ${safeStartLine + 1}-${safeStartLine + visibleLines.length}/${allLines.length}`
              : ""
          }`,
          renderWidth,
        )}
      </Text>
      {visibleLines.map((line, index) => (
        <Text key={`${index}:${line}`} wrap="truncate">
          {line}
        </Text>
      ))}
      <Text dimColor>
        {truncateTerminalText(
          page.availability === "unavailable"
            ? "Complete result unavailable"
            : page.eof
              ? "End"
              : "More bytes available",
          renderWidth,
        )}
      </Text>
    </Box>
  );
}

export interface InspectorDialogContentProps {
  source: InspectorSource;
  pageBytes?: number;
  visibleLines?: number;
  renderWidth?: number;
  compact?: boolean;
  onClose: () => void;
  onCopy?: (text: string) => void | Promise<void>;
  /** 可注入 Session 层分页器；默认使用 EvidenceArchive 的安全分页 API。 */
  loadPage?: typeof readInspectorPage;
}

export function InspectorDialogContent({
  source,
  pageBytes = DEFAULT_PAGE_BYTES,
  visibleLines = 5,
  renderWidth = 80,
  compact = false,
  onClose,
  onCopy,
  loadPage: loadPageCallback = readInspectorPage,
}: InspectorDialogContentProps): React.ReactNode {
  const [page, setPage] = useState<InspectorPage>();
  const [lineOffset, setLineOffset] = useState(0);
  const [pageHistory, setPageHistory] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const pendingLoad = useRef(false);
  const requestSequence = useRef(0);
  const mounted = useRef(true);

  const loadOffset = useCallback(
    async (offsetBytes: number, nextHistory: number[]): Promise<void> => {
      if (pendingLoad.current) return;
      pendingLoad.current = true;
      const requestId = ++requestSequence.current;
      if (mounted.current) {
        setLoading(true);
        setError(undefined);
      }
      try {
        const nextPage = await loadPageCallback(source, {
          offsetBytes,
          limitBytes: pageBytes,
        });
        if (!mounted.current || requestId !== requestSequence.current) return;
        setPage(nextPage);
        setPageHistory(nextHistory);
        setLineOffset(0);
      } catch (loadError) {
        if (mounted.current && requestId === requestSequence.current) {
          setError(errorMessage(loadError));
        }
      } finally {
        if (requestId === requestSequence.current) pendingLoad.current = false;
        if (mounted.current && requestId === requestSequence.current) setLoading(false);
      }
    },
    [loadPageCallback, pageBytes, source],
  );

  useEffect(() => {
    mounted.current = true;
    requestSequence.current++;
    pendingLoad.current = false;
    setPage(undefined);
    setPageHistory([]);
    setLineOffset(0);
    setError(undefined);
    void loadOffset(0, []);
    return () => {
      mounted.current = false;
      requestSequence.current++;
      pendingLoad.current = false;
    };
  }, [loadOffset]);

  const maxLineOffset = Math.max(
    0,
    (page?.content.split("\n").length ?? 0) - Math.max(1, visibleLines),
  );

  useInput((input, key) => {
    if (key.escape || input === "\u001b") {
      onClose();
      return;
    }
    if (key.upArrow) {
      setLineOffset((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setLineOffset((current) => Math.min(maxLineOffset, current + 1));
      return;
    }
    if (key.pageUp || input === "[") {
      const previousOffset = pageHistory.at(-1);
      if (previousOffset !== undefined && !pendingLoad.current) {
        void loadOffset(previousOffset, pageHistory.slice(0, -1));
      }
      return;
    }
    if (key.pageDown || input === "]") {
      if (page && !page.eof && !pendingLoad.current) {
        void loadOffset(page.nextOffsetBytes, [...pageHistory, page.offsetBytes]);
      }
      return;
    }
    if (input === "c" && page && onCopy) {
      invokeDialogAction(
        () => onCopy(page.copyText),
        (message) => {
          if (mounted.current) setError(message);
        },
      );
    }
  });

  return (
    <Box flexDirection="column">
      {compact ? (
        <>
          <Text bold>{truncateTerminalText(source.title, renderWidth)}</Text>
          <Text color={error ? "red" : undefined} wrap="truncate">
            {truncateTerminalText(
              error ??
                (page
                  ? (page.content.split("\n")[lineOffset] ?? "")
                  : loading
                    ? "Loading page…"
                    : "No content"),
              renderWidth,
            )}
          </Text>
          <Text dimColor>
            {truncateTerminalText("↑/↓ scroll · PgUp/PgDn bytes · Esc close", renderWidth)}
          </Text>
        </>
      ) : (
        <>
          {source.kind === "inline" && source.availability === "unavailable" ? (
            <Text color="yellow">
              {truncateTerminalText("This view contains only a compact summary.", renderWidth)}
            </Text>
          ) : null}
          {!page ? <Text bold>{truncateTerminalText(source.title, renderWidth)}</Text> : null}
          {page ? (
            <Inspector
              page={page}
              maxLines={visibleLines}
              startLine={lineOffset}
              renderWidth={renderWidth}
            />
          ) : null}
          {loading ? <Text dimColor>Loading page…</Text> : null}
          {error ? <Text color="red">{truncateTerminalText(error, renderWidth)}</Text> : null}
          <Text dimColor>
            {truncateTerminalText(
              `↑/↓ scroll · PgUp/[ previous bytes · PgDn/] next bytes${
                onCopy ? " · c copy" : ""
              } · Esc close`,
              renderWidth,
            )}
          </Text>
        </>
      )}
    </Box>
  );
}

export function createInspectorDialogRequest(
  props: InspectorDialogContentProps,
  options: { id?: string; priority?: number } = {},
): DialogRequest {
  return {
    id: options.id ?? "local-ui:tool-inspector",
    layer: "modal",
    priority: options.priority ?? 30,
    content: <InspectorDialogContent {...props} />,
  };
}

export function createInlineInspectorSource(title: string, content: string): InlineInspectorSource {
  return { kind: "inline", title, content, availability: "complete" };
}

export function createEvidenceInspectorContext(input: {
  workDir: string;
  sessionId: string;
  evidenceBaseDir?: string;
}): EvidenceInspectorContext {
  if (!input.sessionId.trim()) throw new Error("Inspector sessionId must not be empty");
  return Object.freeze({
    currentSessionId: input.sessionId,
    evidenceBaseDir: input.evidenceBaseDir ?? resolvePicoPaths(input.workDir).workspace.evidence,
  });
}

function createEvidenceInspectorSource(input: {
  title: string;
  uri: string;
  ref: RuntimeEvidenceReference;
  context: EvidenceInspectorContext;
}): EvidenceInspectorSource | undefined {
  let parsed: RuntimeEvidenceReference;
  try {
    parsed = {
      ...parseEvidenceUri(input.uri),
      kind: "tool-exchange",
    };
  } catch {
    return undefined;
  }
  if (
    parsed.sessionId !== input.ref.sessionId ||
    parsed.contentHash !== input.ref.contentHash ||
    parsed.kind !== input.ref.kind ||
    parsed.schemaVersion !== input.ref.schemaVersion
  ) {
    return undefined;
  }
  return Object.freeze({
    kind: "evidence",
    title: input.title,
    uri: input.uri,
    ref: Object.freeze({ ...input.ref }),
    currentSessionId: input.context.currentSessionId,
    evidenceBaseDir: input.context.evidenceBaseDir,
  });
}

/** 把权威 ToolResult envelope 转为 Inspector 数据源。 */
export function createToolInspectorSource(
  tool: TuiToolCallProjection,
  context: EvidenceInspectorContext,
): InspectorSource | undefined {
  const title = `${tool.name} result`;
  const envelope = tool.resultEnvelope;
  if (tool.resultAvailability === "evidence" && envelope?.evidence) {
    const evidence = createEvidenceInspectorSource({
      title,
      uri: envelope.evidence.uri,
      ref: envelope.evidence.ref,
      context,
    });
    if (evidence) return evidence;
    return createUnavailableInspectorSource(
      title,
      `${tool.summary ?? "Evidence result"}\nEvidence is unavailable for the current session.`,
    );
  }
  if (tool.resultAvailability === "unavailable") {
    return createUnavailableInspectorSource(
      title,
      tool.summary ?? "Complete inline result is no longer available in the Inspector.",
    );
  }
  const content =
    tool.result ??
    envelope?.projection.text ??
    (tool.output.length > 0 ? tool.output : tool.summary);
  return content === undefined ? undefined : createInlineInspectorSource(title, content);
}

export async function readInspectorPage(
  source: InspectorSource,
  request: InspectorPageRequest = {},
): Promise<InspectorPage> {
  const offsetBytes = normalizeOffset(request.offsetBytes);
  const limitBytes = normalizeLimit(request.limitBytes);
  if (source.kind === "inline") {
    const buffer = Buffer.from(source.content, "utf8");
    const page = readBufferPage(buffer, offsetBytes, limitBytes);
    return {
      title: source.title,
      ...page,
      truncated: !page.eof,
      copyText: page.content,
      availability: source.availability,
    };
  }

  const parsed = parseEvidenceUri(source.uri);
  if (
    parsed.sessionId !== source.ref.sessionId ||
    parsed.contentHash !== source.ref.contentHash ||
    parsed.schemaVersion !== source.ref.schemaVersion
  ) {
    throw new Error("Evidence URI does not match its canonical reference");
  }
  const page = await new EvidenceArchive({
    baseDir: source.evidenceBaseDir,
  }).readEvidencePage(source.ref, { offsetBytes, limitBytes });
  if (page.kind !== "tool-exchange") {
    throw new Error("Evidence reference is not a ToolResult exchange");
  }
  return {
    title: source.title,
    content: page.content,
    offsetBytes: page.offsetBytes,
    nextOffsetBytes: page.endOffsetBytes,
    totalBytes: page.totalBytes,
    eof: !page.truncated,
    truncated: page.truncated,
    copyText: page.content,
    evidenceUri: source.uri,
    availability: "complete",
  };
}

function readBufferPage(
  buffer: Buffer,
  offsetBytes: number,
  limitBytes: number,
): Omit<InspectorPage, "title" | "truncated" | "copyText"> {
  const localOffset = alignUtf8StartForward(buffer, Math.min(offsetBytes, buffer.length));
  const available = buffer.subarray(localOffset, Math.min(buffer.length, localOffset + limitBytes));
  const reachesEof = localOffset + available.length >= buffer.length;
  const utf8Length = validUtf8PrefixLength(available, reachesEof);
  const content = available.subarray(0, utf8Length).toString("utf8");
  return {
    content,
    offsetBytes: localOffset,
    nextOffsetBytes: localOffset + utf8Length,
    totalBytes: buffer.length,
    eof: localOffset + utf8Length >= buffer.length,
  };
}

function alignUtf8StartForward(buffer: Buffer, offset: number): number {
  let aligned = Math.min(Math.max(0, offset), buffer.length);
  while (aligned < buffer.length && (buffer[aligned]! & 0xc0) === 0x80) aligned++;
  return aligned;
}

function validUtf8PrefixLength(buffer: Buffer, requireComplete: boolean): number {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const maxTrim = requireComplete ? 0 : Math.min(3, buffer.length);
  for (let trim = 0; trim <= maxTrim; trim++) {
    const length = buffer.length - trim;
    try {
      decoder.decode(buffer.subarray(0, length));
      return length;
    } catch {
      // UTF-8 code point may cross a non-EOF page boundary; at most three bytes trail it.
    }
  }
  throw new Error("Inspector source is not valid UTF-8 text");
}

function createUnavailableInspectorSource(title: string, content: string): InlineInspectorSource {
  return { kind: "inline", title, content, availability: "unavailable" };
}

function invokeDialogAction(
  action: () => void | Promise<void>,
  reportError: (message: string | undefined) => void,
): void {
  reportError(undefined);
  void Promise.resolve()
    .then(action)
    .catch((error: unknown) => reportError(errorMessage(error)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_PAGE_BYTES;
  return Math.min(MAX_PAGE_BYTES, Math.max(MIN_PAGE_BYTES, Math.floor(value)));
}

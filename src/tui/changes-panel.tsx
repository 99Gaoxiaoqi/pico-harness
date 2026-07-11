import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type {
  FileHistoryChanges,
  FileHistoryDiffFileStatus,
  FileHistoryFilePatch,
} from "../safety/file-history.js";
import { DiffPreview } from "./diff-preview.js";
import type { DialogRequest } from "./dialog-arbiter.js";
import { truncateTerminalText } from "./terminal-width.js";

export interface ChangesRestoreFileAction {
  kind: "restore-file";
  messageId: string;
  filePath: string;
  expectedCurrentFingerprint: string;
  label: string;
  description: string;
}

export interface ChangesJumpToRewindAction {
  kind: "jump-to-rewind";
  messageId: string;
  label: string;
  description: string;
}

export interface ChangesFileModel extends FileHistoryFilePatch {
  restoreAction: ChangesRestoreFileAction;
}

export interface ChangesPanelModel {
  messageId: string;
  files: ChangesFileModel[];
  fullPatch: string;
  addedLines: number;
  removedLines: number;
  partial: boolean;
  warnings: string[];
  rewindAction: ChangesJumpToRewindAction;
}

export interface ChangesPanelProps {
  model: ChangesPanelModel;
  /** 默认显示完整 patch；宿主滚动窗口可传入可见行数。 */
  maxPatchLines?: number;
  /** 对话框中传入后高亮文件，并只显示它的 patch。 */
  selectedIndex?: number;
  /** 选中模式下围绕当前文件的可见窗口。 */
  maxVisibleFiles?: number;
  compact?: boolean;
  renderWidth?: number;
  showPatch?: boolean;
  showWarnings?: boolean;
}

export function ChangesPanel({
  model,
  maxPatchLines,
  selectedIndex,
  maxVisibleFiles,
  compact = false,
  renderWidth = 80,
  showPatch = true,
  showWarnings = true,
}: ChangesPanelProps): React.ReactNode {
  const safeSelectedIndex =
    selectedIndex === undefined ? undefined : normalizeSelectedIndex(selectedIndex, model);
  const selectedFile = safeSelectedIndex === undefined ? undefined : model.files[safeSelectedIndex];
  const visiblePatch = selectedFile?.patch ?? model.fullPatch;
  const patchLineCount = visiblePatch.length === 0 ? 0 : visiblePatch.split("\n").length;
  const visibleFiles = selectVisibleFiles(model, safeSelectedIndex, maxVisibleFiles);
  if (compact) {
    return (
      <Box flexDirection="column">
        <Text bold>
          {truncateTerminalText(
            `Partial rewind · ${model.files.length} file(s) · +${model.addedLines} -${model.removedLines}`,
            renderWidth,
          )}
        </Text>
        {showWarnings && model.warnings[0] ? (
          <Text color="yellow">{truncateTerminalText(`⚠ ${model.warnings[0]}`, renderWidth)}</Text>
        ) : null}
        {selectedFile ? (
          <Text inverse>
            {truncateTerminalText(
              `${statusGlyph(selectedFile.status)} ${selectedFile.filePath} +${selectedFile.addedLines} -${selectedFile.removedLines}`,
              renderWidth,
            )}
          </Text>
        ) : (
          <Text dimColor>No code changes.</Text>
        )}
        {showPatch && visiblePatch ? (
          <DiffPreview diff={visiblePatch} maxLines={maxPatchLines ?? 1} />
        ) : null}
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text bold>Changes · partial rewind preview</Text>
      <Text color={model.partial ? "yellow" : undefined}>
        {model.partial ? "Capture incomplete · " : ""}
        {model.files.length} file(s) · +{model.addedLines} -{model.removedLines}
      </Text>
      {model.warnings[0] ? (
        <Text color="yellow">{truncateTerminalText(`⚠ ${model.warnings[0]}`, renderWidth)}</Text>
      ) : null}
      {model.warnings.length > 1 ? (
        <Text color="yellow">
          {truncateTerminalText(`… ${model.warnings.length - 1} more warning(s)`, renderWidth)}
        </Text>
      ) : null}
      {visibleFiles.map(({ file, index }) => (
        <Box key={file.filePath} flexDirection="column">
          <Text inverse={selectedFile !== undefined && index === safeSelectedIndex}>
            {truncateTerminalText(
              `${statusGlyph(file.status)} ${file.filePath} +${file.addedLines} -${file.removedLines}`,
              renderWidth,
            )}
          </Text>
          {safeSelectedIndex === undefined || index === safeSelectedIndex ? (
            <Text dimColor>
              {truncateTerminalText(file.restoreAction.description, renderWidth)}
            </Text>
          ) : null}
        </Box>
      ))}
      {visibleFiles.length < model.files.length ? (
        <Text dimColor>
          {truncateTerminalText(
            `… ${model.files.length - visibleFiles.length} file(s) outside this window`,
            renderWidth,
          )}
        </Text>
      ) : null}
      {visiblePatch ? (
        <DiffPreview diff={visiblePatch} maxLines={maxPatchLines ?? Math.max(1, patchLineCount)} />
      ) : (
        <Text dimColor>No code changes.</Text>
      )}
      <Text dimColor>{truncateTerminalText(model.rewindAction.description, renderWidth)}</Text>
    </Box>
  );
}

export interface ChangesDialogContentProps {
  model: ChangesPanelModel;
  maxPatchLines?: number;
  maxVisibleFiles?: number;
  compact?: boolean;
  renderWidth?: number;
  showPatch?: boolean;
  showWarnings?: boolean;
  onRestoreFile: (action: ChangesRestoreFileAction) => void | Promise<void>;
  onJumpToRewind: (action: ChangesJumpToRewindAction) => void | Promise<void>;
  onClose: () => void;
}

export function ChangesDialogContent({
  model,
  maxPatchLines = 4,
  maxVisibleFiles = 3,
  compact = false,
  renderWidth = 80,
  showPatch = true,
  showWarnings = true,
  onRestoreFile,
  onJumpToRewind,
  onClose,
}: ChangesDialogContentProps): React.ReactNode {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pendingFilePath, setPendingFilePath] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [armedFilePath, setArmedFilePath] = useState<string>();
  const actionPending = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    setSelectedIndex((current) => normalizeSelectedIndex(current, model));
    return () => {
      mounted.current = false;
    };
  }, [model]);

  const selectedFile = model.files[normalizeSelectedIndex(selectedIndex, model)];

  useInput((input, key) => {
    if (actionPending.current) return;
    if (key.escape || input === "\u001b") {
      if (armedFilePath) {
        setArmedFilePath(undefined);
        setMessage(undefined);
        return;
      }
      onClose();
      return;
    }
    if (key.upArrow) {
      setArmedFilePath(undefined);
      setSelectedIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setArmedFilePath(undefined);
      setSelectedIndex((current) => Math.min(Math.max(0, model.files.length - 1), current + 1));
      return;
    }
    if ((key.return || input === "r") && selectedFile) {
      if (armedFilePath !== selectedFile.filePath) {
        setArmedFilePath(selectedFile.filePath);
        setError(undefined);
        setMessage("Press Enter/r again to confirm this partial rewind.");
        return;
      }
      actionPending.current = true;
      setArmedFilePath(undefined);
      setPendingFilePath(selectedFile.filePath);
      setError(undefined);
      setMessage(undefined);
      void Promise.resolve()
        .then(() => onRestoreFile(selectedFile.restoreAction))
        .then(() => {
          if (mounted.current) setMessage(`Restored ${selectedFile.filePath}`);
        })
        .catch((restoreError: unknown) => {
          if (mounted.current) setError(toErrorMessage(restoreError));
        })
        .finally(() => {
          actionPending.current = false;
          if (mounted.current) setPendingFilePath(undefined);
        });
      return;
    }
    if (input === "w") {
      actionPending.current = true;
      setError(undefined);
      setMessage("Opening Rewind…");
      void Promise.resolve()
        .then(() => onJumpToRewind(model.rewindAction))
        .catch((rewindError: unknown) => {
          if (mounted.current) setError(toErrorMessage(rewindError));
        })
        .finally(() => {
          actionPending.current = false;
          if (mounted.current) setMessage(undefined);
        });
    }
  });

  return (
    <Box flexDirection="column">
      <ChangesPanel
        model={model}
        maxPatchLines={maxPatchLines}
        selectedIndex={selectedIndex}
        maxVisibleFiles={maxVisibleFiles}
        compact={compact}
        renderWidth={renderWidth}
        showPatch={
          showPatch &&
          pendingFilePath === undefined &&
          message === undefined &&
          error === undefined &&
          armedFilePath === undefined
        }
        showWarnings={showWarnings}
      />
      {pendingFilePath ? <Text dimColor>Restoring {pendingFilePath}…</Text> : null}
      {message ? <Text color="green">{message}</Text> : null}
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>
        {truncateTerminalText(
          armedFilePath
            ? "Enter/r confirm · Esc cancel"
            : "↑/↓ select · Enter/r partial rewind · w Rewind · Esc close",
          renderWidth,
        )}
      </Text>
    </Box>
  );
}

export function createChangesDialogRequest(
  props: ChangesDialogContentProps,
  options: { id?: string; priority?: number } = {},
): DialogRequest {
  return {
    id: options.id ?? "local-ui:changes",
    layer: "modal",
    priority: options.priority ?? 30,
    content: <ChangesDialogContent {...props} />,
  };
}

export function createChangesPanelModel(changes: FileHistoryChanges): ChangesPanelModel {
  return {
    messageId: changes.messageId,
    files: changes.files.map((file) => ({
      ...file,
      restoreAction: {
        kind: "restore-file",
        messageId: changes.messageId,
        filePath: file.filePath,
        expectedCurrentFingerprint: file.currentFingerprint,
        label: `Restore ${fileName(file.filePath)}`,
        description: `Partial rewind: restore ${file.filePath} to before this message; later edits to this file will be overwritten.`,
      },
    })),
    fullPatch: changes.patch,
    addedLines: changes.addedLines,
    removedLines: changes.removedLines,
    partial: changes.incomplete === true,
    warnings: [...(changes.warnings ?? [])],
    rewindAction: {
      kind: "jump-to-rewind",
      messageId: changes.messageId,
      label: "Open Rewind",
      description: changes.incomplete
        ? "Open Rewind to choose a Partial restore action for known files and/or conversation."
        : "Open Rewind to restore all listed files and/or the conversation.",
    },
  };
}

function statusGlyph(status: FileHistoryDiffFileStatus): string {
  if (status === "created") return "A";
  if (status === "deleted") return "D";
  return "M";
}

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/u).at(-1) ?? filePath;
}

function normalizeSelectedIndex(index: number, model: ChangesPanelModel): number {
  if (model.files.length === 0) return 0;
  return Math.min(Math.max(0, Math.floor(index)), model.files.length - 1);
}

function selectVisibleFiles(
  model: ChangesPanelModel,
  selectedIndex: number | undefined,
  maxVisibleFiles: number | undefined,
): Array<{ file: ChangesFileModel; index: number }> {
  const indexed = model.files.map((file, index) => ({ file, index }));
  if (selectedIndex === undefined || maxVisibleFiles === undefined) return indexed;
  const windowSize = Math.min(model.files.length, Math.max(1, Math.floor(maxVisibleFiles)));
  const start = Math.min(
    Math.max(0, selectedIndex - Math.floor(windowSize / 2)),
    Math.max(0, model.files.length - windowSize),
  );
  return indexed.slice(start, start + windowSize);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type {
  FileHistoryChanges,
  FileHistoryDiffFileStatus,
  FileHistoryFilePatch,
} from "../safety/file-history.js";
import { DiffPreview } from "./diff-preview.js";
import type { DialogRequest } from "./dialog-arbiter.js";

export interface ChangesRestoreFileAction {
  kind: "restore-file";
  messageId: string;
  filePath: string;
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
}

export function ChangesPanel({
  model,
  maxPatchLines,
  selectedIndex,
}: ChangesPanelProps): React.ReactNode {
  const safeSelectedIndex =
    selectedIndex === undefined ? undefined : normalizeSelectedIndex(selectedIndex, model);
  const selectedFile = safeSelectedIndex === undefined ? undefined : model.files[safeSelectedIndex];
  const visiblePatch = selectedFile?.patch ?? model.fullPatch;
  const patchLineCount = visiblePatch.length === 0 ? 0 : visiblePatch.split("\n").length;
  return (
    <Box flexDirection="column">
      <Text bold>Changes</Text>
      <Text color={model.partial ? "yellow" : undefined}>
        {model.partial ? "Partial restore · " : ""}
        {model.files.length} file(s) · +{model.addedLines} -{model.removedLines}
      </Text>
      {model.warnings.map((warning, index) => (
        <Text key={`${index}:${warning}`} color="yellow">
          ⚠ {warning}
        </Text>
      ))}
      {model.files.map((file, index) => (
        <Box key={file.filePath} flexDirection="column">
          <Text inverse={selectedFile !== undefined && index === safeSelectedIndex}>
            {statusGlyph(file.status)} {file.filePath} +{file.addedLines} -{file.removedLines}
          </Text>
          <Text dimColor>{file.restoreAction.description}</Text>
        </Box>
      ))}
      {visiblePatch ? (
        <DiffPreview diff={visiblePatch} maxLines={maxPatchLines ?? Math.max(1, patchLineCount)} />
      ) : (
        <Text dimColor>No code changes.</Text>
      )}
      <Text dimColor>{model.rewindAction.description}</Text>
    </Box>
  );
}

export interface ChangesDialogContentProps {
  model: ChangesPanelModel;
  maxPatchLines?: number;
  onRestoreFile: (action: ChangesRestoreFileAction) => void | Promise<void>;
  onJumpToRewind: (action: ChangesJumpToRewindAction) => void | Promise<void>;
  onClose: () => void;
}

export function ChangesDialogContent({
  model,
  maxPatchLines = 24,
  onRestoreFile,
  onJumpToRewind,
  onClose,
}: ChangesDialogContentProps): React.ReactNode {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pendingFilePath, setPendingFilePath] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const restorePending = useRef(false);
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
    if (key.escape || input === "\u001b") {
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((current) => Math.min(Math.max(0, model.files.length - 1), current + 1));
      return;
    }
    if ((key.return || input === "r") && selectedFile && !restorePending.current) {
      restorePending.current = true;
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
          restorePending.current = false;
          if (mounted.current) setPendingFilePath(undefined);
        });
      return;
    }
    if (input === "w") {
      setError(undefined);
      void Promise.resolve()
        .then(() => onJumpToRewind(model.rewindAction))
        .catch((rewindError: unknown) => {
          if (mounted.current) setError(toErrorMessage(rewindError));
        });
    }
  });

  return (
    <Box flexDirection="column">
      <ChangesPanel model={model} maxPatchLines={maxPatchLines} selectedIndex={selectedIndex} />
      {pendingFilePath ? <Text dimColor>Restoring {pendingFilePath}…</Text> : null}
      {message ? <Text color="green">{message}</Text> : null}
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>↑/↓ select file · Enter/r restore selected · w open Rewind · Esc close</Text>
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
        label: `Restore ${fileName(file.filePath)}`,
        description: `Restore only ${file.filePath} to its state before this rewind point.`,
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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

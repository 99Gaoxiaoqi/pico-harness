import React from "react";
import { Box, Text } from "ink";
import type {
  FileHistoryChanges,
  FileHistoryDiffFileStatus,
  FileHistoryFilePatch,
} from "../safety/file-history.js";
import { DiffPreview } from "./diff-preview.js";

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
}

export function ChangesPanel({ model, maxPatchLines }: ChangesPanelProps): React.ReactNode {
  const patchLineCount = model.fullPatch.length === 0 ? 0 : model.fullPatch.split("\n").length;
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
      {model.files.map((file) => (
        <Box key={file.filePath} flexDirection="column">
          <Text>
            {statusGlyph(file.status)} {file.filePath} +{file.addedLines} -{file.removedLines}
          </Text>
          <Text dimColor>{file.restoreAction.description}</Text>
        </Box>
      ))}
      {model.fullPatch ? (
        <DiffPreview
          diff={model.fullPatch}
          maxLines={maxPatchLines ?? Math.max(1, patchLineCount)}
        />
      ) : (
        <Text dimColor>No code changes.</Text>
      )}
      <Text dimColor>{model.rewindAction.description}</Text>
    </Box>
  );
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

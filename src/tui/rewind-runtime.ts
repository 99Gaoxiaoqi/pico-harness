import type { FileHistorySnapshotSummary, RewindMode } from "../cli/file-history.js";
import type { Session } from "../engine/session.js";
import type { TuiReporter } from "./tui-reporter.js";

export interface TuiRewindResult {
  inputText?: string;
  interactionMode?: string;
}

export interface TuiInputReplacement {
  sequence: number;
  text: string;
}

export function rewindInputReplacement(
  current: TuiInputReplacement | undefined,
  result: TuiRewindResult,
): TuiInputReplacement | undefined {
  if (result.inputText === undefined) return current;
  return {
    sequence: (current?.sequence ?? 0) + 1,
    text: result.inputText,
  };
}

/**
 * 把 Session、活动文件历史和可见 transcript 收敛到同一个用户消息边界。
 * code-only 保留对话和输入；conversation/both 会 fork 并回填原 prompt。
 */
export async function applyTuiRewind(input: {
  session: Session;
  reporter: TuiReporter;
  snapshot: FileHistorySnapshotSummary;
  mode: RewindMode;
  onRestoreInteractionMode?: (mode: string) => void;
}): Promise<TuiRewindResult> {
  const { session, reporter, snapshot, mode } = input;
  if (mode === "code") {
    await session.rewindCode(snapshot.messageId);
    return {};
  }

  if (snapshot.messageIndex === undefined) {
    throw new Error("This legacy checkpoint cannot restore the conversation precisely.");
  }
  if (snapshot.transcriptIndex === undefined) {
    throw new Error(
      "This legacy checkpoint has no TUI transcript boundary. Restore code only, or choose a newer user-message checkpoint.",
    );
  }
  const transcriptIndex =
    snapshot.transcriptIndex <= reporter.getEntryCount() ? snapshot.transcriptIndex : 0;

  if (mode === "both") {
    await session.rewindBoth(snapshot.messageId, snapshot.messageIndex);
  } else {
    await session.rewindConversation(snapshot.messageIndex, snapshot.messageId);
  }

  reporter.truncateTo(transcriptIndex);
  if (snapshot.interactionMode) {
    input.onRestoreInteractionMode?.(snapshot.interactionMode);
  }
  return {
    inputText: snapshot.userPrompt,
    ...(snapshot.interactionMode ? { interactionMode: snapshot.interactionMode } : {}),
  };
}

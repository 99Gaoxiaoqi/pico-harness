import type { FileHistorySnapshotSummary, RewindMode } from "../cli/file-history.js";
import type { Session } from "../engine/session.js";
import type { TuiReporter } from "./tui-reporter.js";
import { hydrateTuiReporter } from "./session-hydration.js";

export interface TuiRewindResult {
  inputText?: string;
  interactionMode?: string;
  prePlanMode?: string;
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
  onRestoreInteractionMode?: (mode: string, prePlanMode?: string) => void;
}): Promise<TuiRewindResult> {
  const { session, reporter, snapshot, mode } = input;
  if (mode === "code") {
    await session.rewindCode(snapshot.messageId);
    reporter.pushSystemMessage(formatRewindSuccess(snapshot, mode));
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
  // Rewind saga 必须在此前的 transcript 写入全部落盘后才能确定截断边界。
  await reporter.flushDurableTranscript();

  if (mode === "both") {
    await session.rewindBoth(snapshot.messageId, snapshot.messageIndex);
  } else {
    await session.rewindConversation(snapshot.messageIndex, snapshot.messageId);
  }

  // Rehydrate from the durable branch instead of applying an absolute historical
  // index to the current local segment. `/clear` deliberately changes only that
  // segment, so local truncation cannot identify the durable rewind boundary.
  const hydration = await session.readHydrationSnapshot();
  reporter.withoutDurableTranscript(() => {
    hydrateTuiReporter(reporter, hydration, { replace: true });
  });
  if (snapshot.interactionMode) {
    input.onRestoreInteractionMode?.(snapshot.interactionMode, snapshot.prePlanMode);
  }
  reporter.pushSystemMessage(formatRewindSuccess(snapshot, mode));
  return {
    inputText: snapshot.userPrompt,
    ...(snapshot.interactionMode ? { interactionMode: snapshot.interactionMode } : {}),
    ...(snapshot.prePlanMode ? { prePlanMode: snapshot.prePlanMode } : {}),
  };
}

function formatRewindSuccess(snapshot: FileHistorySnapshotSummary, mode: RewindMode): string {
  const prompt = (snapshot.userPrompt ?? snapshot.messageId).replace(/\s+/gu, " ").trim();
  const target = prompt.length <= 72 ? prompt : `${prompt.slice(0, 71)}…`;
  if (mode === "code") {
    return `Rewind complete: restored code to before “${target}”; conversation kept.`;
  }
  if (mode === "conversation") {
    return `Rewind complete: restored conversation to before “${target}”; code kept. Original prompt is ready to edit.`;
  }
  return `Rewind complete: restored code and conversation to before “${target}”. Original prompt is ready to edit.`;
}

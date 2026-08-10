import { randomUUID } from "node:crypto";
import type { FileHistorySnapshotSummary, RewindMode } from "../cli/file-history.js";
import type { SessionForkRuntimePort } from "../engine/session-fork-runtime-port.js";
import type { Session } from "../engine/session.js";
import type { TuiReporter } from "./tui-reporter.js";
import { hydrateTuiReporter } from "./session-hydration.js";

export interface TuiRewindResult {
  inputText?: string;
  interactionMode?: string;
  prePlanMode?: string;
  /** Non-destructive rewind 创建了新 Session；调用方需切换到该 session。 */
  forkedSessionId?: string;
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
 * Rewind 入口：conversation/both 模式走 non-destructive fork——
 * 原 Session 完全不变，创建新 Session 继承切片状态。code 模式只回滚文件。
 *
 * `forkRuntimePort` 与 `createTargetSessionId` 仅在 conversation/both 模式下被使用。
 * 返回 `forkedSessionId` 时，调用方应切换 TUI 到该新 Session；
 * 不返回（code 模式）时，行为与旧破坏性 code rewind 一致。
 */
export async function applyTuiRewind(input: {
  session: Session;
  reporter: TuiReporter;
  snapshot: FileHistorySnapshotSummary;
  mode: RewindMode;
  forkRuntimePort: SessionForkRuntimePort;
  createTargetSessionId?: () => string;
  onRestoreInteractionMode?: (mode: string, prePlanMode?: string) => void;
}): Promise<TuiRewindResult> {
  const { session, reporter, snapshot, mode } = input;

  if (mode === "code") {
    // code 模式没有对话副作用：非破坏性地回滚工作区文件即可。
    const fork = await session.forkFromCheckpoint(
      snapshot.messageId,
      "code",
      input.forkRuntimePort,
      input.createTargetSessionId ?? defaultTargetSessionId,
    );
    reporter.pushSystemMessage(formatRewindSuccess(snapshot, mode));
    return { ...(fork.targetSessionId !== session.id ? { forkedSessionId: fork.targetSessionId } : {}) };
  }

  if (snapshot.transcriptIndex === undefined) {
    throw new Error(
      "This checkpoint has no TUI transcript boundary. Restore code only, or use its originating host.",
    );
  }
  // Rewind saga 必须在此前的 transcript 写入全部落盘后才能确定截���边界。
  await reporter.flushDurableTranscript();

  const modeParam = mode === "both" ? "both" : "conversation";
  const fork = await session.forkFromCheckpoint(
    snapshot.messageId,
    modeParam,
    input.forkRuntimePort,
    input.createTargetSessionId ?? defaultTargetSessionId,
  );

  // fork 创建了新 Session。旧 Session 的 reporter 不再代表活跃对话；
  // 调用方必须切换到 forkedSessionId 才能看到截断后的 transcript。
  // 这里仍然回填原 prompt，供切换后的新 session 使用。
  if (snapshot.interactionMode) {
    input.onRestoreInteractionMode?.(snapshot.interactionMode, snapshot.prePlanMode);
  }
  reporter.pushSystemMessage(formatRewindSuccess(snapshot, mode));
  return {
    forkedSessionId: fork.targetSessionId,
    inputText: snapshot.userPrompt,
    ...(snapshot.interactionMode ? { interactionMode: snapshot.interactionMode } : {}),
    ...(snapshot.prePlanMode ? { prePlanMode: snapshot.prePlanMode } : {}),
  };
}

function defaultTargetSessionId(): string {
  // 派生一个稳定的随机 id；与 TUI 现有 fork 入口一致使用 console: 前缀之外的随机串。
  return `tui-rewind:${randomUUID()}`;
}

/**
 * 当调用方需要为新 fork 的 Session 重建 hydration 时使用。
 * 旧 applyTuiRewind 直接在原 session 上 rehydrate；fork 模式下原 session 不变，
 * 新 session 由调用方在切换时构建，不再需要这个 rehydrate 路径。
 */
export async function rehydrateReporterFromSession(
  session: Session,
  reporter: TuiReporter,
): Promise<void> {
  const hydration = await session.readHydrationSnapshot();
  reporter.withoutDurableTranscript(() => {
    hydrateTuiReporter(reporter, hydration, { replace: true });
  });
}

function formatRewindSuccess(snapshot: FileHistorySnapshotSummary, mode: RewindMode): string {
  const prompt = snapshot.userPrompt.replace(/\s+/gu, " ").trim();
  const target = prompt.length <= 72 ? prompt : `${prompt.slice(0, 71)}…`;
  if (mode === "code") {
    return `Rewind complete: restored code to before “${target}”; conversation kept.`;
  }
  if (mode === "conversation") {
    return `Rewind complete: forked conversation to before “${target}”; code kept. Original prompt is ready to edit.`;
  }
  return `Rewind complete: forked code and conversation to before “${target}”. Original prompt is ready to edit.`;
}

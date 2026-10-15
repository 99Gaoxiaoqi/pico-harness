import { resolve } from "node:path";
import type { TaskExperienceCandidate, TaskExperienceStore, TaskExperienceTask } from "@pico/core";
import { memoryTextContainsSecret } from "@pico/runtime/atomic-memory/extraction-evidence";

export interface ReviewedExperienceTarget {
  readonly candidateId: string;
  readonly contentVersion: number;
  readonly recordRevision: number;
  readonly maturity?: "trial" | "active";
  /** Host-authored preparation must survive recall intact, in code points. */
  readonly requiredPrefixLength?: number;
}

/** Every returned identity is checked against current Host permissions and task conditions. */
export async function taskExperienceRecallTargets(options: {
  readonly store: TaskExperienceStore;
  readonly workspaceKey: string;
  readonly workDir: string;
  readonly query?: string;
  readonly toolAllowed: (name: string) => boolean;
  /** Host has checked that this task belongs to the currently executing canonical Run. */
  readonly currentTask?: Pick<TaskExperienceTask, "taskId" | "taskVersion" | "sessionId" | "runId">;
  readonly nativeEvidenceMatches?: (candidate: TaskExperienceCandidate) => Promise<boolean>;
  readonly conditionMatches?: (candidate: TaskExperienceCandidate) => Promise<boolean | "unknown">;
}): Promise<readonly ReviewedExperienceTarget[]> {
  const query = options.query?.trim();
  if (!query) return [];
  const targets: ReviewedExperienceTarget[] = [];
  const excluded = new Set<string>();
  if (options.currentTask) {
    const task = options.currentTask;
    for (const receipt of await options.store.listTaskExperienceReuse(
      options.workspaceKey,
      task.sessionId,
    )) {
      if (
        receipt.excluded &&
        receipt.taskId === task.taskId &&
        receipt.taskVersion === task.taskVersion &&
        receipt.sessionId === task.sessionId
      )
        excluded.add(JSON.stringify([receipt.candidateId, receipt.contentVersion]));
    }
  }
  for (const candidate of await options.store.queryTaskExperiences(options.workspaceKey, {
    limit: 100,
  })) {
    const approved = candidate.review === "approved";
    const trial =
      candidate.review === "unneeded" && candidate.maturity === "trial" && candidate.risk === "low";
    if (
      candidate.kind !== "task-lesson" ||
      excluded.has(JSON.stringify([candidate.candidateId, candidate.contentVersion])) ||
      candidate.workspaceKey !== options.workspaceKey ||
      resolve(candidate.workDir) !== resolve(options.workDir) ||
      candidate.state !== "saved" ||
      candidate.lifecycleState !== "active" ||
      !candidate.enabled ||
      (!approved && !trial) ||
      !candidate.itemId ||
      !candidate.content.trim() ||
      candidate.validation === "fail" ||
      candidate.validation === "stale" ||
      memoryTextContainsSecret(candidate.content) ||
      /pico:\/\/artifact\/|artifact[_-]id\s*[:=]/iu.test(candidate.content)
    )
      continue;
    if (candidate.nativeEvidence && !(await options.nativeEvidenceMatches?.(candidate))) continue;
    const applicability = candidate.applicability;
    if (
      !applicability ||
      !Array.isArray(applicability.toolNames) ||
      !Array.isArray(applicability.conditions) ||
      applicability.toolNames.length > 8 ||
      applicability.conditions.length > 8 ||
      !applicability.conditions.every(
        (condition) => typeof condition === "string" && !memoryTextContainsSecret(condition),
      ) ||
      !applicability.toolNames.every(
        (name) => typeof name === "string" && options.toolAllowed(name),
      )
    )
      continue;
    if (
      trial &&
      (!applicability.toolNames.length ||
        (applicability.taskFamily === "general" && !applicability.conditions.length))
    )
      continue;
    if (
      applicability.taskFamily === "spreadsheet" &&
      !/(?:excel|xlsx|sheet|表格|电子表|求和|合计)/iu.test(query)
    )
      continue;
    if (
      applicability.taskFamily === "coding" &&
      !/(?:代码|编程|测试|配置|依赖|修复|bug|test|node|code|config|build)/iu.test(query)
    )
      continue;
    if (!["general", "coding", "spreadsheet"].includes(applicability.taskFamily)) continue;
    if (applicability.spreadsheet || applicability.conditions.length) {
      const match = options.conditionMatches
        ? await options.conditionMatches(candidate)
        : "unknown";
      if (
        match === false ||
        (applicability.spreadsheet && match !== true) ||
        (trial && applicability.conditions.length > 0 && match !== true)
      )
        continue;
    }
    targets.push({
      candidateId: candidate.candidateId,
      contentVersion: candidate.contentVersion,
      recordRevision: candidate.recordRevision,
      maturity: trial ? "trial" : "active",
      ...(candidate.nativeEvidence &&
      candidate.content.startsWith("本工作区同一检查范围的准备记录（不代表整段建议已验证）：")
        ? {
            requiredPrefixLength: Array.from(
              candidate.content.slice(
                0,
                candidate.content.lastIndexOf("方法：") >= 0
                  ? candidate.content.lastIndexOf("方法：")
                  : candidate.content.length,
              ),
            ).length,
          }
        : {}),
    });
  }
  return targets;
}

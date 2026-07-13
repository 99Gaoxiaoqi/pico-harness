import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/engine/session.js";
import { JobService } from "../src/tasks/job-service.js";
import { TaskHostRuntime } from "../src/tasks/task-runtime.js";
import type { DelegationCompletionEnvelope } from "../src/tools/delegation-manager.js";
import {
  createDelegationCompletionMessage,
  createTuiRuntimeState,
} from "../src/tui/runtime-state.js";

const exec = promisify(execFile);

describe("durable completion outbox integration", () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("acks after a restart without reinjecting and never crosses the owner session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pico-completion-outbox-"));
    cleanups.push(root);
    const repo = join(root, "repo");
    await mkdir(repo);
    await git(["init", "-b", "main"], repo);
    await git(["config", "user.name", "Pico Integration"], repo);
    await git(["config", "user.email", "pico@example.test"], repo);
    await writeFile(join(repo, ".gitignore"), ".claw/\n.worktrees/\n", "utf8");
    await writeFile(join(repo, "README.md"), "completion outbox\n", "utf8");
    await git(["add", "."], repo);
    await git(["commit", "-m", "initial"], repo);

    const firstJobs = await JobService.create({ workDir: repo, ownerId: "first-host" });
    const ownerEnvelope = completionEnvelope("job-owner", "owner-session", 11);
    finishOptional(firstJobs.service, ownerEnvelope);
    const otherEnvelope = completionEnvelope("job-other", "other-session", 12);
    finishOptional(firstJobs.service, otherEnvelope);

    // 故障窗口：Session JSONL 已 fdatasync，但 completion_outbox 尚未 ack。
    const firstSession = await new SessionManager().getOrCreate("owner-session", repo, {
      persistence: true,
    });
    await firstSession.commitMessageOnce(
      ownerEnvelope.completionId,
      createDelegationCompletionMessage(ownerEnvelope),
    );
    await firstSession.close();
    firstJobs.service.close();

    const taskRuntime = await TaskHostRuntime.create({ workDir: repo });
    const reopened = await new SessionManager().getOrCreate("owner-session", repo, {
      persistence: true,
    });
    const tuiRuntime = await createTuiRuntimeState({
      workDir: repo,
      sessionId: reopened.id,
      session: reopened,
      taskHostRuntime: taskRuntime,
    });
    try {
      const pending = tuiRuntime.delegationCompletionQueue.pendingCompletionSeqs();
      expect(pending).toEqual([ownerEnvelope.completionSeq]);
      await tuiRuntime.delegationCompletionQueue.deliverPendingCompletionSeqs(pending);

      const injected = reopened
        .getHistory()
        .filter((message) => message.providerData?.picoKind === "subagent_completion");
      expect(injected).toHaveLength(1);
      expect(taskRuntime.jobService.pendingCompletions({ ownerSessionId: "owner-session" })).toEqual(
        [],
      );
      expect(
        taskRuntime.jobService.pendingCompletions({ ownerSessionId: "other-session" }),
      ).toHaveLength(1);
    } finally {
      await tuiRuntime.dispose();
      await reopened.close();
      await taskRuntime.close();
    }
  });
});

function completionEnvelope(
  jobId: string,
  ownerSessionId: string,
  completionSeq: number,
): DelegationCompletionEnvelope {
  return {
    completionId: `completion:${jobId}:1`,
    jobId,
    ownerSessionId,
    completionSeq,
    activityIds: [`activity:${jobId}`],
    completionPolicy: "optional",
    status: "completed",
    outputSummary: `result:${jobId}`,
  };
}

function finishOptional(service: JobService, envelope: DelegationCompletionEnvelope): void {
  const job = service.dispatch({
    jobId: envelope.jobId,
    type: "local_agent",
    executionClass: "host_bound",
    completionPolicy: "optional",
    description: envelope.jobId,
    ownerSessionId: envelope.ownerSessionId,
  });
  const started = service.start(job.jobId, { expectedVersion: job.version });
  service.terminal({
    jobId: job.jobId,
    attemptId: started.attempt.attemptId,
    status: "succeeded",
    expectedJobVersion: started.job.version,
    expectedAttemptVersion: started.attempt.version,
    leaseEpoch: started.lease.leaseEpoch,
    completionId: envelope.completionId,
    completionPayload: { delegationCompletion: envelope },
  });
}

async function git(args: readonly string[], cwd: string): Promise<void> {
  await exec("git", [...args], { cwd, encoding: "utf8" });
}

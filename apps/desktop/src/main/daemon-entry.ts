import {
  candidateStartupFailureExitCode,
  classifyCandidateStartupFailure,
  runRuntimeHostProcessLifecycle,
} from "@pico/runtime-host";
import {
  parsePicoDaemonCandidateArguments,
  startPicoDaemonRuntimeHostCandidate,
} from "../../../../src/daemon/runtime-host-candidate.js";

async function runDesktopDaemonCandidate(): Promise<void> {
  const options = parsePicoDaemonCandidateArguments(process.argv.slice(2));
  const result = await startPicoDaemonRuntimeHostCandidate(options);
  if (result.kind === "legacy_daemon_running") {
    process.stderr.write(`${result.message}\n`);
    process.exit(3);
  }
  if (result.kind === "loser") process.exit(2);
  await runRuntimeHostProcessLifecycle(result.host);
}

void runDesktopDaemonCandidate().catch((error: unknown) => {
  const failure = classifyCandidateStartupFailure(error);
  process.stderr.write(
    `Pico daemon 启动失败: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(candidateStartupFailureExitCode(failure));
});

import {
  candidateStartupFailureExitCode,
  classifyCandidateStartupFailure,
  parseRuntimeHostCandidateArguments,
  runRuntimeHostProcessLifecycle,
} from "@pico/runtime-host";
import { startPicoDaemonRuntimeHostCandidate } from "../../../../src/daemon/runtime-host-candidate.js";

async function runDesktopDaemonCandidate(): Promise<void> {
  const options = parseRuntimeHostCandidateArguments(process.argv.slice(2));
  const result = await startPicoDaemonRuntimeHostCandidate(options);
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

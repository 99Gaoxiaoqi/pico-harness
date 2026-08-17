#!/usr/bin/env node
import { startRuntimeHostCandidate } from './server/candidate.js';
import { runRuntimeHostProcessLifecycle } from './server/process-lifecycle.js';
import { parseRuntimeHostCandidateArguments } from './candidate-cli.js';
import {
  candidateStartupFailureExitCode,
  classifyCandidateStartupFailure,
} from './candidate-startup-failure.js';

const options = parseRuntimeHostCandidateArguments(process.argv.slice(2));
let result: Awaited<ReturnType<typeof startRuntimeHostCandidate>>;
try {
  result = await startRuntimeHostCandidate(options);
} catch (error) {
  console.error('[runtime-host] startup failed:', error);
  process.exit(candidateStartupFailureExitCode(classifyCandidateStartupFailure(error)));
}
if (result.kind === 'loser') process.exit(2);

try {
  await runRuntimeHostProcessLifecycle(result.host);
} catch {
  process.exitCode = 1;
}

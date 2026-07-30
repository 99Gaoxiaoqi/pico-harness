export const harborTrialMaxRetries = 0;

export function harborTrialRetryArgs() {
  return ["--max-retries", String(harborTrialMaxRetries)];
}

export function assertHarborTrialRetriesDisabled(args) {
  if (!Array.isArray(args)) {
    throw new Error("Terminal-Bench Harbor arguments are invalid");
  }
  const maxRetryValues = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--max-retries") {
      maxRetryValues.push(args[index + 1]);
      index += 1;
      continue;
    }
    if (
      arg === "-r" ||
      /^-r(?:=)?\d+$/u.test(arg ?? "") ||
      arg?.startsWith("--max-retries=") ||
      arg === "--retry-include" ||
      arg?.startsWith("--retry-include=") ||
      arg === "--retry-exclude" ||
      arg?.startsWith("--retry-exclude=")
    ) {
      throw new Error("Terminal-Bench Harbor trial retry arguments are forbidden");
    }
  }
  if (maxRetryValues.length !== 1 || maxRetryValues[0] !== String(harborTrialMaxRetries)) {
    throw new Error("Terminal-Bench Harbor trial max retries must be exactly zero");
  }
}

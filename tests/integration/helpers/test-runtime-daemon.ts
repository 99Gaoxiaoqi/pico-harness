import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  readHostRegistration,
  removeHostRegistration,
  resolveRootControlNamespace,
  resolveStorageRoot,
} from "@pico/runtime-host";

const GRACEFUL_EXIT_TIMEOUT_MS = 12_000;
const FORCED_EXIT_TIMEOUT_MS = 5_000;
const SUCCESSOR_QUIET_WINDOW_MS = 2_000;

/**
 * Stops the daemon registered to an isolated test PICO_HOME and waits for the
 * exact PID to exit before the caller removes the temporary root.
 *
 * This helper intentionally does not use process-name matching: production and
 * test daemons share the same entrypoint, so the isolated storage-root
 * registration is the authority for the only PID teardown may signal.
 */
export async function stopRegisteredTestDaemon(picoHome: string): Promise<readonly number[]> {
  await assertTemporaryTestRoot(picoHome);
  const capability = await resolveStorageRoot({ path: picoHome, kind: "interactive" });
  const controlDirectory = join(resolveRootControlNamespace(), capability.rootId);
  const stoppedPids = new Set<number>();
  let quietSince: number | undefined;

  for (;;) {
    const registration = await readHostRegistration(controlDirectory).catch(() => undefined);
    if (!registration) {
      if (stoppedPids.size === 0) return [];
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= SUCCESSOR_QUIET_WINDOW_MS) return [...stoppedPids];
      await delay(50);
      continue;
    }
    // Some candidate tests host the kernel in the test process itself. Their
    // test-local host handle owns cleanup; teardown must never signal itself.
    if (registration.pid === process.pid) return [...stoppedPids];

    quietSince = undefined;
    await stopExactTestDaemon(registration.pid);
    stoppedPids.add(registration.pid);
    await removeHostRegistration(controlDirectory, registration.hostEpoch).catch(() => undefined);
  }
}

/** Stops a PID captured directly from a test-owned child process. */
export async function stopExactTestDaemon(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    throw new Error(`Refusing to stop invalid test daemon PID ${String(pid)}`);
  }
  if (!isProcessAlive(pid)) return;

  signalExactProcess(pid, "SIGTERM");
  if (await waitForProcessExit(pid, GRACEFUL_EXIT_TIMEOUT_MS)) return;

  signalExactProcess(pid, "SIGKILL");
  if (await waitForProcessExit(pid, FORCED_EXIT_TIMEOUT_MS)) return;
  throw new Error(`Test daemon PID ${pid} did not exit after SIGTERM and SIGKILL`);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(50);
  }
  return true;
}

function signalExactProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!isNodeError(error, "ESRCH")) throw error;
  }
}

async function assertTemporaryTestRoot(picoHome: string): Promise<void> {
  const temporaryRoot = await realpath(tmpdir());
  const candidate = await realpath(picoHome);
  const childPath = relative(temporaryRoot, candidate);
  if (childPath === "" || childPath.startsWith("..") || isAbsolute(childPath)) {
    throw new Error(`Refusing to stop daemon outside the test temp root: ${picoHome}`);
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

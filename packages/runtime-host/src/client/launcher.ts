import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DetachedCandidateInput {
  rootPath: string;
  expectedRootId: string;
  legacyConfigurationRoot?: string;
  idleGraceMs?: number;
  handshakeTimeoutMs?: number;
  executable?: string;
  entrypoint?: string | URL;
  env?: NodeJS.ProcessEnv;
}

export interface DetachedCandidateAttempt {
  pid: number;
}

export interface DetachedCandidateLaunch {
  spawned: Promise<DetachedCandidateAttempt>;
}

export type CandidateLauncher = (input: DetachedCandidateInput) => DetachedCandidateLaunch;

/**
 * Resolve the default candidate entrypoint for the current runtime form.
 *
 * - Compiled (dist): `candidate-main.js` sits next to the compiled client and is
 *   run directly by node.
 * - Source (tsx): only `candidate-main.ts` exists. The candidate is a detached
 *   `node` process, so it needs the tsx ESM loader registered via `--import tsx`
 *   (resolved from the process cwd's node_modules). Without this the spawned
 *   child dies with ERR_MODULE_NOT_FOUND and the election loop only ever sees a
 *   bare `startup_timeout`.
 */
function resolveDefaultEntrypoint(): { path: string; needsTsLoader: boolean } {
  const compiledPath = fileURLToPath(new URL('../candidate-main.js', import.meta.url));
  if (existsSync(compiledPath)) return { path: compiledPath, needsTsLoader: false };
  const sourcePath = fileURLToPath(new URL('../candidate-main.ts', import.meta.url));
  if (existsSync(sourcePath)) return { path: sourcePath, needsTsLoader: true };
  // Let node surface a clear module-not-found rather than the election loop
  // timing out with no information.
  return { path: compiledPath, needsTsLoader: false };
}

export function launchDetachedRuntimeHostCandidate(
  input: DetachedCandidateInput,
): DetachedCandidateLaunch {
  const executable = input.executable ?? process.execPath;
  const entrypoint = input.entrypoint ?? resolveDefaultEntrypoint().path;
  const entrypointPath = typeof entrypoint === 'string' ? entrypoint : fileURLToPath(entrypoint);
  const needsTsLoader =
    input.entrypoint === undefined && resolveDefaultEntrypoint().needsTsLoader;
  const args = [
    // 源码模式下为 detached node 子进程注册 tsx ESM loader（cwd 需能解析 tsx）。
    ...(needsTsLoader ? ['--import', 'tsx'] : []),
    entrypointPath,
    '--root',
    input.rootPath,
    '--expected-root-id',
    input.expectedRootId,
  ];
  appendArgument(args, '--idle-grace-ms', input.idleGraceMs);
  appendArgument(args, '--handshake-timeout-ms', input.handshakeTimeoutMs);
  appendArgument(args, '--legacy-configuration-root', input.legacyConfigurationRoot);

  // spawn() commits the side effect synchronously; spawned only reports that commit's outcome.
  const child = spawn(executable, args, {
    cwd: needsTsLoader ? process.cwd() : dirname(isAbsolute(executable) ? executable : process.execPath),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      ...input.env,
    },
  });
  const spawned = new Promise<DetachedCandidateAttempt>((resolve, reject) => {
    const onSpawn = () => {
      child.off('error', onError);
      const pid = child.pid;
      if (pid === undefined) {
        reject(new Error('Runtime Host candidate did not receive a process id'));
        return;
      }
      child.unref();
      resolve({ pid });
    };
    const onError = (error: Error) => {
      child.off('spawn', onSpawn);
      reject(error);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
  return { spawned };
}

function appendArgument(args: string[], key: string, value: string | number | undefined): void {
  if (value === undefined) return;
  args.push(key, String(value));
}

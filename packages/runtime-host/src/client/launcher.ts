import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface DetachedCandidateInput {
  rootPath: string;
  expectedRootId: string;
  legacyConfigurationRoot?: string;
  idleGraceMs?: number;
  handshakeTimeoutMs?: number;
  operationDeadlineMs?: number;
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
 *   `node` process, so it needs the tsx ESM loader registered via `--import`.
 *   The loader is resolved to an absolute path from this module's own location
 *   (createRequire) so the spawn does not depend on the child's cwd being able
 *   to resolve the bare `tsx` specifier. Without the loader the spawned child
 *   dies with ERR_MODULE_NOT_FOUND and the election loop only ever sees a bare
 *   `startup_timeout`.
 */
function resolveDefaultEntrypoint(): { path: string; tsxLoaderPath?: string } {
  const compiledPath = fileURLToPath(new URL('../candidate-main.js', import.meta.url));
  if (existsSync(compiledPath)) return { path: compiledPath };
  const sourcePath = fileURLToPath(new URL('../candidate-main.ts', import.meta.url));
  if (existsSync(sourcePath)) return { path: sourcePath, tsxLoaderPath: resolveTsxLoaderPath() };
  // Let node surface a clear module-not-found rather than the election loop
  // timing out with no information.
  return { path: compiledPath };
}

function resolveTsxLoaderPath(): string {
  try {
    const resolved = createRequire(import.meta.url).resolve('tsx');
    // node --import 需要 file:// URL（Windows 裸绝对路径会被当作 URL scheme 报
    // ERR_UNSUPPORTED_ESM_URL_SCHEME），故转为 file URL。
    return pathToFileURL(resolved).href;
  } catch {
    // Fall back to the bare specifier; the child then resolves tsx from its own
    // cwd's node_modules (works when spawned from within the workspace).
    return 'tsx';
  }
}

export function launchDetachedRuntimeHostCandidate(
  input: DetachedCandidateInput,
): DetachedCandidateLaunch {
  const executable = input.executable ?? process.execPath;
  // Resolve the default entrypoint once; path and loader must come from the same
  // resolution to avoid a TOCTOU between the two existsSync checks.
  const resolvedDefault = resolveDefaultEntrypoint();
  const usesDefaultEntrypoint = input.entrypoint === undefined;
  const entrypointPath =
    input.entrypoint === undefined
      ? resolvedDefault.path
      : typeof input.entrypoint === 'string'
        ? input.entrypoint
        : fileURLToPath(input.entrypoint);
  const tsxLoaderPath = usesDefaultEntrypoint ? resolvedDefault.tsxLoaderPath : undefined;
  const args = [
    // 源码模式下为 detached node 子进程注册 tsx ESM loader（绝对路径，不依赖子进程 cwd）。
    ...(tsxLoaderPath ? ['--import', tsxLoaderPath] : []),
    entrypointPath,
    '--root',
    input.rootPath,
    '--expected-root-id',
    input.expectedRootId,
  ];
  appendArgument(args, '--idle-grace-ms', input.idleGraceMs);
  appendArgument(args, '--handshake-timeout-ms', input.handshakeTimeoutMs);
  appendArgument(args, '--operation-deadline-ms', input.operationDeadlineMs);
  appendArgument(args, '--legacy-configuration-root', input.legacyConfigurationRoot);

  // spawn() commits the side effect synchronously; spawned only reports that commit's outcome.
  const child = spawn(executable, args, {
    cwd: tsxLoaderPath
      ? process.cwd()
      : dirname(isAbsolute(executable) ? executable : process.execPath),
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

import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  GraphManagedGitPort,
  GraphManagedGitRequest,
  GraphManagedGitResult,
} from "@pico/core/agent-output-contracts";
import type { AgentGraphWorkspaceResourceRecord } from "@pico/core/agent-graph-store-contracts";
import { buildSafeGitEnvironment, hardenGitArgs } from "@pico/runtime/git-safety";
import { parseGraphManagedGitRequest } from "@pico/runtime";

const exec = promisify(execFile);
const busyWorktrees = new Set<string>();

/** Created only after the authority has verified the registered repository/worktree identity. */
export async function createGraphManagedGitPort(options: {
  readonly resource: AgentGraphWorkspaceResourceRecord;
  readonly assertActive: () => Promise<void>;
  readonly assertWorkspace: () => Promise<void>;
}): Promise<GraphManagedGitPort> {
  const { resource } = options;
  await options.assertWorkspace();
  const worktree = await realpath(resource.worktreePath);
  if (!(await lstat(join(worktree, ".git"))).isFile())
    throw new Error("Managed Git requires a physical gitfile");
  const gitFile = await readFile(join(worktree, ".git"), "utf8");
  const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(gitFile);
  if (!match) throw new Error("Managed Git requires a linked worktree");
  const gitDir = await realpath(resolve(worktree, match[1]!));
  const commonDir = await realpath(
    resolve(gitDir, (await readFile(join(gitDir, "commondir"), "utf8")).trim()),
  );
  const ref = `refs/heads/${resource.branch}`;
  if (!/^refs\/heads\/pico\/graph-[0-9a-f]{24}$/.test(ref))
    throw new Error("Invalid managed branch");
  if (!isWithin(join(commonDir, "worktrees"), gitDir))
    throw new Error("Invalid managed Git directory");
  const environment = {
    ...buildSafeGitEnvironment(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_LITERAL_PATHSPECS: "1",
  };
  async function guard(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await options.assertActive();
    if (
      (await realpath(resource.worktreePath)) !== worktree ||
      !(await lstat(join(worktree, ".git"))).isFile() ||
      (await readFile(join(worktree, ".git"), "utf8")) !== gitFile ||
      (await realpath(gitDir)) !== gitDir ||
      (await realpath(
        resolve(gitDir, (await readFile(join(gitDir, "commondir"), "utf8")).trim()),
      )) !== commonDir ||
      (await readFile(join(gitDir, "HEAD"), "utf8")).trim() !== `ref: ${ref}`
    ) {
      throw new Error("Managed Git worktree identity changed");
    }
    signal?.throwIfAborted();
  }
  return {
    async execute(
      raw: GraphManagedGitRequest,
      signal?: AbortSignal,
    ): Promise<GraphManagedGitResult> {
      // Validate again at the host capability boundary, not only at tool parsing.
      const request = parseGraphManagedGitRequest(JSON.stringify(raw));
      await guard(signal);
      if (busyWorktrees.has(gitDir)) throw new Error("Managed Git operation already in progress");
      busyWorktrees.add(gitDir);
      let temporary: string | undefined;
      let indexLock: Awaited<ReturnType<typeof open>> | undefined;
      let ownsIndexLock = false;
      const indexLockPath = join(gitDir, "index.lock");
      try {
        // Git's own lock also excludes external Git writers; a stale lock fails closed.
        indexLock = await open(indexLockPath, "wx", 0o600);
        ownsIndexLock = true;
        // Operator sandboxes can write /tmp; keep every trusted command input in
        // the host-owned Git metadata that their ordinary shell cannot access.
        temporary = await mkdtemp(join(gitDir, "pico-graph-git-"));
        const scratch = join(temporary, "metadata");
        await mkdir(join(scratch, "objects"), { recursive: true });
        await mkdir(join(scratch, "refs"));
        await writeFile(join(scratch, "HEAD"), "ref: refs/heads/snapshot\n");
        // No repository, global or system config is loaded while reading the worktree.
        // This prevents includes, filters, fsmonitor, signing and diff drivers from executing.
        await writeFile(
          join(scratch, "config"),
          "[core]\nrepositoryformatversion = 0\nbare = false\n",
        );
        const git = async (args: readonly string[], original = false): Promise<string> => {
          await guard(signal);
          const result = await exec(
            "git",
            hardenGitArgs(
              [
                `--git-dir=${original ? gitDir : scratch}`,
                `--work-tree=${worktree}`,
                "-c",
                "core.bare=false",
                "-c",
                `core.worktree=${worktree}`,
                "-c",
                "core.attributesFile=",
                "-c",
                "core.excludesFile=",
                "-c",
                "diff.external=",
                "-c",
                "core.pager=cat",
                ...args,
              ],
              join(temporary!, "disabled-hooks"),
            ),
            {
              cwd: temporary,
              env: original
                ? environment
                : { ...environment, GIT_OBJECT_DIRECTORY: join(commonDir, "objects") },
              encoding: "utf8",
              maxBuffer: 4 * 1024 * 1024,
              timeout: 30_000,
              ...(signal ? { signal } : {}),
            },
          );
          return result.stdout;
        };
        const head = (await git(["rev-parse", "--verify", `${ref}^{commit}`], true)).trim();
        if (head.length === 64)
          await writeFile(
            join(scratch, "config"),
            "[core]\nrepositoryformatversion = 1\nbare = false\n[extensions]\nobjectformat = sha256\n",
          );
        if (request.operation === "commit" && head !== request.expected_head)
          throw new Error("Managed Git expected_head is stale; read status again");
        await git(["read-tree", head]);
        // ls-files never runs clean/diff drivers. Retain the real repository's ignore
        // rules (including info/exclude), without loading its config in the staging process.
        const paths = [
          ...(await git(["ls-files", "--cached", "-z"])).split("\0"),
          ...(
            await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], true)
          ).split("\0"),
        ].filter(Boolean);
        if (paths.some((path) => path.includes("\ufffd")))
          throw new Error("Managed Git cannot safely decode file names");
        if (paths.length) {
          const pathspec = join(temporary, "paths");
          await writeFile(pathspec, [...new Set(paths)].join("\0") + "\0");
          // Git stores symlinks as links. Pathspecs are NUL-delimited and literal.
          await git(["add", "--all", `--pathspec-from-file=${pathspec}`, "--pathspec-file-nul"]);
        }
        const entries = await git(["ls-files", "--stage", "-z"]);
        if (entries.split("\0").some((entry) => entry.startsWith("160000 "))) {
          throw new Error("Managed Git does not commit submodules or nested repositories");
        }
        const tree = (await git(["write-tree"])).trim();
        const output = await git([
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          request.operation === "diff" ? "--patch" : "--stat",
          head,
          tree,
          "--",
        ]);
        if (request.operation !== "commit") return { branch: resource.branch, head, output };
        if (tree === (await git(["rev-parse", `${head}^{tree}`])).trim())
          throw new Error("Managed Git has no changes to commit");
        const authorName = (
          await git(["config", "--local", "--no-includes", "--get", "user.name"], true)
        ).trim();
        const authorEmail = (
          await git(["config", "--local", "--no-includes", "--get", "user.email"], true)
        ).trim();
        if (
          !authorName ||
          !authorEmail ||
          /[\r\n\0<>]/.test(authorName + authorEmail) ||
          authorName.length > 1024 ||
          authorEmail.length > 1024
        ) {
          throw new Error("Managed Git requires valid repository-local user.name and user.email");
        }
        Object.assign(environment, {
          GIT_AUTHOR_NAME: authorName,
          GIT_COMMITTER_NAME: authorName,
          GIT_AUTHOR_EMAIL: authorEmail,
          GIT_COMMITTER_EMAIL: authorEmail,
        });
        const commit = (await git(["commit-tree", tree, "-p", head, "-m", request.message])).trim();
        // Prepare the new index before publishing the branch, then atomically install it.
        await indexLock.writeFile(await readFile(join(scratch, "index")));
        await indexLock.sync();
        await guard(signal);
        await git(["update-ref", "--no-deref", ref, commit, head], true);
        await indexLock.close();
        indexLock = undefined;
        await rename(indexLockPath, join(gitDir, "index"));
        ownsIndexLock = false;
        return { branch: resource.branch, head: commit, output };
      } finally {
        await indexLock?.close();
        if (ownsIndexLock) await rm(indexLockPath, { force: true });
        if (temporary) await rm(temporary, { recursive: true, force: true });
        busyWorktrees.delete(gitDir);
      }
    },
  };
}

function isWithin(root: string, path: string): boolean {
  const offset = relative(root, path);
  return Boolean(offset) && !offset.startsWith("..") && !isAbsolute(offset);
}

# Process sandbox

Pico routes every model-triggerable local process through `ManagedProcessLauncher`. The policy has
three profiles: `read-only`, `workspace-write`, and `danger-full-access`. Plan and Explore use
`read-only`; normal agents, workers, background jobs, MCP servers, and command hooks use
`workspace-write`; the main agent in Yolo uses the launcher without an OS sandbox and still passes
the Hardline checks.

The model process plane includes Bash, background Bash, stdio MCP, command Hooks, LSP, ripgrep,
and subagent tools. Daemon installation, credential access, Git/worktree integration, updates, and
Desktop system actions remain host control-plane operations. The architecture check rejects a
runtime `child_process` import in a model process entrypoint.

Restricted processes inherit ordinary host variables, while Pico rewrites home, temporary, and
cache locations into a session scratch directory. Workspace roots are readable; `workspace-write`
also makes them writable. Files such as `.git`, `.env`, and `AGENTS.md` do not receive a special
OS-level rule when they are inside an authorized workspace. `/dev/null`, `/dev/tty`, and Windows
`NUL` are treated as devices rather than external write paths.

## Native backends

- macOS compiles a deny-by-default Seatbelt profile with explicit workspace, scratch, system
  runtime, and resolved toolchain roots.
- Linux packages Bubblewrap for x64 and arm64. The build script pins the upstream release and
  source digest, creates mount/user/PID/IPC/UTS namespaces, and packages the exact corresponding
  source archive and license.
- Windows packages Pico's MIT-licensed Rust x64 one-shot AppContainer Broker. It creates an
  ephemeral AppContainer, grants a process-specific capability SID to policy roots, supplies no
  network capability to restricted profiles, uses a kill-on-close Job Object, and journals
  temporary ACL changes for idempotent recovery. The Broker is launched per target process and is
  not installed as a persistent Windows service.

If a restricted backend or its verified sidecar checksum is missing, process startup fails closed.
There is no fallback to an unsandboxed host process. Native binaries are produced on their target
CI runners and are verified before packaging.

## Licensing and provenance

The sandbox policy and Broker are original Pico implementations based on public operating-system
interfaces and general process-isolation architecture. They do not copy Maka source, tests,
comments, or policy text. Bubblewrap remains a separate executable under GNU Library GPL v2; the
distribution includes its copyright/license, exact corresponding source, checksum, and the build
script used by Pico. See `resources/licenses/THIRD_PARTY_NOTICES.md`.

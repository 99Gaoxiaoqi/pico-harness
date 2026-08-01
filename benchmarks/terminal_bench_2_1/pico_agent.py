from __future__ import annotations

import asyncio
import base64
import fcntl
import hashlib
import hmac
import http.client
import json
import math
import os
import re
import secrets
import shlex
import socket
import stat
import subprocess
import threading
import time
import tomllib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from typing import Any, NamedTuple, override

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.environments.docker.docker import (
    DockerEnvironment,
    _sanitize_docker_compose_project_name,
)
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

from benchmarks.terminal_bench_2_1.harbor_runtime import (
    PUBLIC_EGRESS_PROXY_ENV_NAMES,
    activate_verifier_egress,
    clear_verifier_egress_activation,
    clear_verifier_exec_env,
    register_verifier_egress_activation,
    set_verifier_exec_env,
)
from benchmarks.terminal_bench_2_1.runtime_limits import (
    MAX_TASK_AGENT_TIMEOUT_SEC,
    MAX_TASK_VERIFIER_TIMEOUT_SEC,
)

_SUPERVISOR_CONFIG: dict[str, str] | None = None
_RELAY_IMAGE_ID = "sha256:5647be709086c696ff32edaaf1c70cd26d1da6ab2b39c32f3c7b4c4a31957e37"
_PUBLIC_EGRESS_PROXY_POLICY_VERSION = 1
_PUBLIC_EGRESS_MAX_CONNECTIONS = 32
_PUBLIC_EGRESS_MAX_REQUESTS = 4_096
_PUBLIC_EGRESS_MAX_TOTAL_BYTES = 1_073_741_824
_PUBLIC_EGRESS_NO_PROXY = "pico-gateway,main,localhost,127.0.0.1,::1"
_AGENT_CONTROLLED_PROXY_GATE_ENV = "PICO_TB_AGENT_CONTROLLED_PROXY"
_AGENT_CONTROLLED_PROXY_GATE_ENABLED = "terminal-bench-agent-v1"
_AGENT_CONTROLLED_PROXY_GATE_DISABLED = "disabled"
_AGENT_CONTROLLED_PROXY_URL = re.compile(
    r"http://pico:[0-9a-f]{64}@pico-egress:8081"
)
_PUBLIC_EGRESS_RELAY_SCRIPT = (
    "const net=require('node:net');"
    "const port=Number(process.argv[1]);"
    "if(!Number.isInteger(port)||port<1||port>65535)process.exit(2);"
    "net.createServer(client=>{"
    "const upstream=net.connect(port,'host.docker.internal');"
    "client.pipe(upstream);upstream.pipe(client);"
    "const close=()=>{client.destroy();upstream.destroy()};"
    "client.on('error',close);upstream.on('error',close);"
    "}).listen(8081,'0.0.0.0');"
)
_MAX_RUN_COST_MICRO_CNY = 1_000_000_000_000
_MAX_BASH_TIMEOUT_MS = 900_000
_MIN_RUNTIME_RETRY_EXECUTION_MS = 30_000
_VERIFIER_SERVICE_MANIFEST_BASENAME = ".pico-verifier-service.json"
_VERIFIER_SERVICE_PORT = 8_080
_VERIFIER_SERVICE_HELPER_SENTINEL = "pico-verifier-helper"
_TRUSTED_NODE_EXEC_ENV = {
    "LD_AUDIT": "",
    "LD_LIBRARY_PATH": "",
    "LD_PRELOAD": "",
    "NODE_OPTIONS": "",
    "NODE_PATH": "",
}
_VERIFIER_SERVICE_EXECUTABLES = {
    "/installed-agent/pico-node/bin/node": ".cjs",
    "/usr/bin/python3": ".py",
    "/usr/local/bin/python3": ".py",
    "/usr/bin/node": ".cjs",
}
_VERIFIER_SERVICE_HELPER = r"""
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path').posix;
const argumentOffset = ['inspect', 'launch'].includes(process.argv[1]) ? 1 : 2;
const helperArguments = process.argv.slice(argumentOffset);
const [mode, manifestPath, workspace, nonce] = helperArguments;
const basename = '.pico-verifier-service.json';
const allowed = new Map([
  ['/installed-agent/pico-node/bin/node', ['.cjs']],
  ['/usr/bin/python3', ['.py']],
  ['/usr/local/bin/python3', ['.py']],
  ['/usr/bin/node', ['.cjs']],
]);
function reject(code = 2) { process.exit(code); }
function bounded(candidate, root) {
  return path.isAbsolute(candidate) && path.normalize(candidate) === candidate &&
    (candidate === root || candidate.startsWith(`${root}/`));
}
function readScriptSnapshot(candidate) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      candidate,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_CLOEXEC,
    );
  } catch { reject(); }
  try {
    const info = fs.fstatSync(descriptor);
    if (!info.isFile()) reject();
    let physicalPath;
    try { physicalPath = fs.realpathSync(`/proc/self/fd/${descriptor}`); } catch {}
    if (process.platform !== 'linux') physicalPath = fs.realpathSync(candidate);
    if (physicalPath !== candidate) reject();
    const maximumBytes = 1024 * 1024;
    const snapshot = Buffer.allocUnsafe(maximumBytes + 1);
    let size = 0;
    while (size < snapshot.length) {
      const count = fs.readSync(descriptor, snapshot, size, snapshot.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size < 1 || size > maximumBytes) reject();
    return snapshot.subarray(0, size);
  } finally {
    fs.closeSync(descriptor);
  }
}
function parse() {
  if (!['inspect', 'launch'].includes(mode) ||
      helperArguments.length !== (mode === 'inspect' ? 3 : 4) ||
      (mode === 'launch' && !/^[0-9a-f]{64}$/u.test(nonce)) ||
      !path.isAbsolute(workspace) ||
      path.normalize(workspace) !== workspace ||
      manifestPath !== path.join(workspace, basename)) reject();
  let descriptor;
  try {
    descriptor = fs.openSync(
      manifestPath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_CLOEXEC,
    );
  } catch (error) {
    if (error && error.code === 'ENOENT') reject(44);
    reject();
  }
  let raw;
  try {
    const info = fs.fstatSync(descriptor);
    if (!info.isFile() || info.size < 2 || info.size > 16 * 1024) reject();
    raw = fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
  let value;
  try { value = JSON.parse(raw); } catch { reject(); }
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      Object.keys(value).sort().join(',') !== 'argv,cwd,port,schemaVersion' ||
      value.schemaVersion !== 1 || value.port !== 8080 ||
      typeof value.cwd !== 'string' || !bounded(value.cwd, workspace) ||
      fs.realpathSync(value.cwd) !== value.cwd || !fs.statSync(value.cwd).isDirectory() ||
      !Array.isArray(value.argv) || value.argv.length < 2 || value.argv.length > 32 ||
      value.argv.some((entry) => typeof entry !== 'string' || entry.length < 1 ||
        entry.length > 4096 || /[\0\r\n]/u.test(entry))) reject();
  const suffixes = allowed.get(value.argv[0]);
  const script = value.argv[1];
  if (!suffixes || !bounded(script, value.cwd) ||
      path.dirname(script) !== value.cwd ||
      !suffixes.some((suffix) => script.endsWith(suffix)) ||
      fs.realpathSync(value.cwd) !== value.cwd) reject();
  const source = readScriptSnapshot(script);
  const manifest = Object.freeze({
    schemaVersion: 1,
    argv: Object.freeze([...value.argv]),
    cwd: value.cwd,
    port: 8080,
  });
  return {manifest, source};
}
let parsed;
try { parsed = parse(); } catch { reject(); }
const {manifest, source} = parsed;
if (mode === 'inspect') {
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
  process.exit(0);
}
const pythonRunner = [
  'import builtins,sys',
  'script=sys.argv[1]',
  'sys.argv=sys.argv[1:]',
  'source=sys.stdin.buffer.read()',
  "scope={'__name__':'__main__','__file__':script,'__package__':None," +
    "'__spec__':None,'__builtins__':builtins.__dict__}",
  "exec(compile(source,script,'exec'),scope,scope)",
].join('\n');
const nodeRunner = [
  "const fs=require('node:fs')",
  "const path=require('node:path')",
  "const Module=require('node:module')",
  'const script=process.argv[1]',
  'const args=process.argv.slice(2)',
  "const source=fs.readFileSync(0,'utf8')",
  'process.argv=[process.execPath,script,...args]',
  'const main=new Module(script)',
  "main.id='.'",
  'main.filename=script',
  'main.paths=Module._nodeModulePaths(path.dirname(script))',
  'Module._cache[script]=main',
  'process.mainModule=main',
  'main._compile(source,script)',
  'main.loaded=true',
].join(';');
const executable = manifest.argv[0];
const script = manifest.argv[1];
const child = spawn(executable, [
  executable.endsWith('python3') ? '-c' : '-e',
  executable.endsWith('python3') ? pythonRunner : nodeRunner,
  script,
  ...manifest.argv.slice(2),
], {
  cwd: manifest.cwd,
  env: process.env,
  stdio: ['pipe', 'ignore', 'ignore'],
});
child.stdin.on('error', () => {});
child.stdin.end(source);
let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  try { child.kill(signal); } catch {}
  setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000).unref();
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
child.once('error', () => process.exit(2));
child.once('exit', (code, signal) => process.exit(signal ? 128 : (code ?? 2)));
""".strip()
_VERIFIER_SERVICE_PROBE = r"""
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const [nonce, manifestPath, workspace, helperSha256] = process.argv.slice(1);
if (!/^[0-9a-f]{64}$/u.test(nonce || '') || !manifestPath || !workspace ||
    !/^[0-9a-f]{64}$/u.test(helperSha256 || '')) process.exit(2);
const supervisorNode = '/installed-agent/pico-node/bin/node';
const helperSentinel = 'pico-verifier-helper';
let attempt = 0;
function numericPids() {
  return fs.readdirSync('/proc').filter((entry) => /^[0-9]+$/u.test(entry));
}
function commandLine(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`).toString().split('\0').filter(Boolean);
  } catch { return []; }
}
function hasCleanSupervisorEnvironment(pid) {
  let entries;
  try {
    entries = fs.readFileSync(`/proc/${pid}/environ`).toString().split('\0');
  } catch { return false; }
  return ['LD_AUDIT', 'LD_LIBRARY_PATH', 'LD_PRELOAD', 'NODE_OPTIONS', 'NODE_PATH']
    .every((name) => entries.includes(`${name}=`));
}
function hasTrustedNodeMappings(raw, expectedInode) {
  const mappings = raw.split('\n').map((line) => line.trim().split(/\s+/u))
    .filter((fields) => fields.length === 6 && fields[5] === supervisorNode &&
      fields[4] === String(expectedInode));
  return mappings.some((fields) => /^0+$/u.test(fields[2]) && fields[1] === 'r--p') &&
    mappings.some((fields) => fields[1] === 'r-xp');
}
function usesTrustedSupervisorExecutable(pid) {
  let expected;
  try {
    expected = fs.statSync(supervisorNode);
  } catch { return false; }
  try {
    const actual = fs.statSync(`/proc/${pid}/exe`);
    if (expected.dev === actual.dev && expected.ino === actual.ino &&
        fs.realpathSync(`/proc/${pid}/exe`) === fs.realpathSync(supervisorNode)) {
      return true;
    }
  } catch {}
  try {
    const actual = fs.statSync(`/proc/${pid}/exe`);
    const current = fs.statSync('/proc/self/exe');
    const reset = fs.statSync('/proc/.reset');
    return process.execPath === supervisorNode && expected.isFile() &&
      (expected.mode & 0o222) === 0 &&
      fs.realpathSync('/proc/self/exe') === fs.realpathSync(supervisorNode) &&
      fs.readlinkSync(`/proc/${pid}/exe`) === '/run/rosetta/rosetta' &&
      actual.dev === current.dev && actual.ino === current.ino &&
      reset.isFile() && reset.size === 0 && reset.uid === 0 && reset.gid === 0 &&
      (reset.mode & 0o022) === 0 && reset.dev === fs.statSync('/proc').dev &&
      hasTrustedNodeMappings(fs.readFileSync('/proc/self/maps', 'utf8'), expected.ino) &&
      hasTrustedNodeMappings(fs.readFileSync(`/proc/${pid}/maps`, 'utf8'), expected.ino);
  } catch { return false; }
}
function hasTrustedSupervisorArguments(argv) {
  let offset;
  if (argv[0] === supervisorNode && argv[1] === '-e') {
    offset = 2;
  } else if (argv[0] === supervisorNode && argv[1] === '--no-opt' &&
      argv[2] === '-r' && argv[3] === '/proc/.reset' && argv[4] === '-e') {
    offset = 5;
  } else {
    return false;
  }
  const payload = argv.slice(offset);
  return payload.length === 6 &&
    crypto.createHash('sha256').update(payload[0] || '').digest('hex') === helperSha256 &&
    payload[1] === helperSentinel && payload[2] === 'launch' &&
    payload[3] === manifestPath && payload[4] === workspace && payload[5] === nonce;
}
function parentPid(pid) {
  try {
    const match = /^PPid:\s+([0-9]+)$/mu.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
    return match ? match[1] : null;
  } catch { return null; }
}
function descendants(root, pids) {
  const values = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const pid of pids) {
      if (!values.has(pid) && values.has(parentPid(pid))) {
        values.add(pid);
        changed = true;
      }
    }
  }
  values.delete(root);
  return values;
}
function listeningSocketInodes() {
  const inodes = new Set();
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let lines;
    try { lines = fs.readFileSync(table, 'utf8').trim().split('\n').slice(1); }
    catch { continue; }
    for (const line of lines) {
      const fields = line.trim().split(/\s+/u);
      const local = fields[1] || '';
      if (fields[3] === '0A' && local.endsWith(':1F90') && fields[9]) {
        inodes.add(fields[9]);
      }
    }
  }
  return inodes;
}
function socketOwnership(inodes, pids) {
  const owners = new Set();
  const ownedInodes = new Set();
  for (const pid of pids) {
    let descriptors;
    try { descriptors = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const descriptor of descriptors) {
      let target;
      try { target = fs.readlinkSync(`/proc/${pid}/fd/${descriptor}`); } catch { continue; }
      const match = /^socket:\[([0-9]+)\]$/u.exec(target);
      if (match && inodes.has(match[1])) {
        owners.add(pid);
        ownedInodes.add(match[1]);
      }
    }
  }
  return {owners, ownedInodes};
}
function listenerBelongsToFreshSupervisor() {
  const pids = numericPids();
  const supervisors = pids.filter((pid) => {
    const argv = commandLine(pid);
    return hasTrustedSupervisorArguments(argv) &&
      hasCleanSupervisorEnvironment(pid) &&
      usesTrustedSupervisorExecutable(pid);
  });
  if (supervisors.length !== 1) return false;
  const ownedDescendants = descendants(supervisors[0], pids);
  if (ownedDescendants.size === 0) return false;
  const inodes = listeningSocketInodes();
  if (inodes.size === 0) return false;
  const {owners, ownedInodes} = socketOwnership(inodes, pids);
  return ownedInodes.size === inodes.size && owners.size > 0 &&
    [...owners].every((pid) => ownedDescendants.has(pid));
}
function retry() {
  if (++attempt >= 50) process.exit(2);
  setTimeout(probe, 100);
}
function probe() {
  if (!listenerBelongsToFreshSupervisor()) return retry();
  const socket = net.connect({host: '127.0.0.1', port: 8080});
  let settled = false;
  const done = (ok) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    if (ok && listenerBelongsToFreshSupervisor()) process.exit(0);
    retry();
  };
  socket.setTimeout(250, () => done(false));
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
}
probe();
""".strip()
_VERIFIER_SERVICE_ASSERT_CLOSED = r"""
const net = require('node:net');
const socket = net.connect({host: '127.0.0.1', port: 8080});
socket.setTimeout(300, () => { socket.destroy(); process.exit(0); });
socket.once('connect', () => { socket.destroy(); process.exit(2); });
socket.once('error', () => process.exit(0));
""".strip()
_BENCHMARK_OUTPUT_TOKENS_BY_ROUTE = {
    "codex-oauth/gpt-5.4": 8_192,
    "codex-oauth/gpt-5.6-terra": 8_192,
}


class TrialNetworks(NamedTuple):
    task: str
    gateway: str


class VerifierServiceManifest(NamedTuple):
    argv: tuple[str, ...]
    cwd: str
    port: int


class PicoInstalledAgent(BaseInstalledAgent):
    """Harbor 0.20 adapter for Pico's internal Headless One-shot entry."""

    SUPPORTS_ATIF = False
    _REMOTE_ROOT = PurePosixPath("/installed-agent/pico")
    _REMOTE_NODE = PurePosixPath("/installed-agent/pico-node")
    _BOOTSTRAP_RESULT = PurePosixPath(EnvironmentPaths.agent_dir / "bootstrap-result.json")
    _PICO_RESULT = PurePosixPath(EnvironmentPaths.agent_dir / "pico-result.json")
    _EXIT_CODE = PurePosixPath(EnvironmentPaths.agent_dir / "pico-exit-code.txt")
    _TRACE_EXPORT = PurePosixPath(EnvironmentPaths.agent_dir / "trace.json")
    _SUPERVISOR_SOCKET_FD = 3
    _SECRET_ENV = "PICO_TB_GATEWAY_TOKEN"
    _POLICY_DENIAL_MODE = "incident"
    _NODE_VERSION = "22.14.0"
    _NODE_SHA256 = {
        "x64": "9d942932535988091034dc94cc5f42b6dc8784d6366df3a36c4c9ccb3996f0c2",
        "arm64": "8cf30ff7250f9463b53c18f89c6c606dfda70378215b2c905d0a9a8b08bd45e0",
    }

    @staticmethod
    @override
    def name() -> str:
        return "pico-headless"

    def __init__(
        self,
        bundle_path: str,
        bundle_sha256: str,
        bundle_lockfile_sha256: str,
        route_config_path: str,
        resource_registry_path: str,
        node_x64_path: str,
        node_arm64_path: str,
        pico_commit: str,
        bash_timeout_ms: int = 180_000,
        max_turns: int = 50,
        runtime_retry_count: int = 1,
        shutdown_grace_ms: int = 30_000,
        result_flush_margin_ms: int = 5_000,
        *args: Any,
        **kwargs: Any,
    ):
        super().__init__(*args, version=pico_commit[:12], **kwargs)
        if self._extra_env:
            raise ValueError("AgentConfig.env/--agent-env is forbidden for Pico benchmarks")
        self._bundle_path = require_file(bundle_path, "bundle_path")
        self._bundle_sha256 = require_digest(bundle_sha256, "bundle_sha256")
        self._bundle_lockfile_sha256 = require_digest(
            bundle_lockfile_sha256, "bundle_lockfile_sha256"
        )
        if sha256_file(self._bundle_path) != self._bundle_sha256:
            raise ValueError("bundle_path does not match bundle_sha256")
        self._route_config_path = require_file(route_config_path, "route_config_path")
        self._resource_registry_path = Path(resource_registry_path).resolve()
        if not self._resource_registry_path.parent.is_dir():
            raise ValueError("resource_registry_path parent must exist")
        self._node_archives = {
            "x64": require_file(node_x64_path, "node_x64_path"),
            "arm64": require_file(node_arm64_path, "node_arm64_path"),
        }
        self._pico_commit = require_hex(pico_commit, "pico_commit")
        self._bash_timeout_ms = require_bounded_int(
            bash_timeout_ms, "bash_timeout_ms", 1_000, _MAX_BASH_TIMEOUT_MS
        )
        self._max_turns = require_bounded_int(max_turns, "max_turns", 1, 200)
        self._runtime_retry_count = require_bounded_int(
            runtime_retry_count, "runtime_retry_count", 0, 1
        )
        self._shutdown_grace_ms = require_positive_int(
            shutdown_grace_ms, "shutdown_grace_ms"
        )
        self._result_flush_margin_ms = require_positive_int(
            result_flush_margin_ms, "result_flush_margin_ms"
        )
        self._trial_networks: TrialNetworks | None = None
        self._route_config = load_route_config(self._route_config_path)
        self._supervisor_config = read_supervisor_config(self._SUPERVISOR_SOCKET_FD)
        if self.model_name != self._route_config["modelRouteId"]:
            raise ValueError("Harbor --model must exactly match route_config.modelRouteId")

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        assert_secure_docker_environment(environment)
        register_compose_project(
            self._resource_registry_path,
            self._supervisor_config["runId"],
            _sanitize_docker_compose_project_name(environment.session_id),
        )
        container_ids = await assert_running_container_policy(
            environment,
            self.logs_dir,
            self._supervisor_config["runId"],
        )
        self._trial_networks = await isolate_container_network(
            environment,
            container_ids,
            self._supervisor_config["runId"],
        )
        try:
            await self._install_node(environment)
            remote_bundle = "/installed-agent/pico-bundle.tar.gz"
            await environment.upload_file(self._bundle_path, remote_bundle)
            await self.exec_as_root(
                environment,
                command=(
                    "set -eu; "
                    f"printf '%s  %s\\n' {shlex.quote(self._bundle_sha256)} "
                    f"{shlex.quote(remote_bundle)} "
                    "| sha256sum -c -; "
                    f"tar -tzf {shlex.quote(remote_bundle)} "
                    "| awk '/^\\// || /(^|\\/)\\.\\.($|\\/)/ {{ exit 2 }}'; "
                    f"tar -tvzf {shlex.quote(remote_bundle)} "
                    "| awk 'substr($1,1,1) == \"l\" || substr($1,1,1) == \"h\" "
                    "{{ exit 2 }}'; "
                    f"rm -rf {self._REMOTE_ROOT.as_posix()}; "
                    f"mkdir -p {self._REMOTE_ROOT.as_posix()}; "
                    f"tar -xzf {shlex.quote(remote_bundle)} -C {self._REMOTE_ROOT.as_posix()}; "
                    f"printf '%s  %s\\n' {shlex.quote(self._bundle_lockfile_sha256)} "
                    f"{self._REMOTE_ROOT.as_posix()}/package-lock.json | sha256sum -c -; "
                    f"chmod -R a-w {self._REMOTE_ROOT.as_posix()}"
                ),
            )
        except BaseException:
            await remove_owned_trial_networks(
                environment,
                self._trial_networks,
                self._supervisor_config["runId"],
            )
            self._trial_networks = None
            raise

    async def _install_node(self, environment: BaseEnvironment) -> None:
        architecture = await environment.exec(command="uname -m")
        machine = (architecture.stdout or "").strip()
        if machine in {"x86_64", "amd64"}:
            arch = "x64"
        elif machine in {"aarch64", "arm64"}:
            arch = "arm64"
        else:
            raise RuntimeError("unsupported Node runtime architecture")
        remote_archive = f"/tmp/node-v{self._NODE_VERSION}-linux-{arch}.tar.gz"
        await environment.upload_file(self._node_archives[arch], remote_archive)
        script = f"""
set -eu
printf '%s  %s\\n' {self._NODE_SHA256[arch]} {remote_archive} | sha256sum -c -
tar -tzf {remote_archive} | awk '/^\\// || /(^|\\/)\\.\\.($|\\/)/ {{ exit 2 }}'
rm -rf {self._REMOTE_NODE.as_posix()}
mkdir -m 0755 {self._REMOTE_NODE.as_posix()}
tar -xzf {remote_archive} -C {self._REMOTE_NODE.as_posix()} --strip-components=1
[ "$({self._REMOTE_NODE.as_posix()}/bin/node -p 'process.versions.node')" = "{self._NODE_VERSION}" ]
chmod -R a-w {self._REMOTE_NODE.as_posix()}
rm -f {remote_archive}
"""
        await self.exec_as_root(environment, command=script, timeout_sec=300)

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        assert_secure_docker_environment(environment)
        if self._trial_networks is None:
            raise RuntimeError("Trial networks were not initialized")
        networks = self._trial_networks
        gateway: ProviderGateway | None = None
        public_egress: PublicEgressAccess | None = None
        context_id: str | None = None
        verifier_timeout_sec: float | None = None
        try:
            loop = asyncio.get_running_loop()
            started_at = loop.time()
            outer_timeout_sec = task_agent_timeout(environment)
            verifier_timeout_sec = task_verifier_timeout(environment)
            outer_deadline = started_at + outer_timeout_sec
            await assert_running_container_policy(
                environment,
                self.logs_dir,
                self._supervisor_config["runId"],
            )
            workspace_result = await environment.exec(command="pwd -P")
            if workspace_result.return_code != 0 or not workspace_result.stdout:
                raise RuntimeError("Could not resolve the Harbor task workspace")
            workspace = workspace_result.stdout.strip()
            if self.context_id is None:
                raise RuntimeError("Harbor did not assign the trial context_id")
            context_id = safe_trial_key(str(self.context_id))
            trial_key = safe_trial_key(f"{self.session_id or 'session'}-{context_id}")
            pico_home = f"/tmp/pico-tb21/{trial_key}/pico-home"
            request_id = f"tb21.{context_id}.{trial_key}"
            session_id = f"tb21-{context_id[:24]}-{trial_key[:24]}"
            route_config = self._route_config
            public_egress = public_egress_access_for_task(
                environment,
                run_id=self._supervisor_config["runId"],
                network_name=networks.gateway,
                context_id=context_id,
                ttl_sec=outer_timeout_sec,
                receipt_path=self.logs_dir / "public-egress-agent-receipt.json",
            )
            gateway = ProviderGateway(
                protocol=route_config["provider"]["protocol"],
                supervisor_socket=self._supervisor_config["socketPath"],
                capability_seed=self._supervisor_config["capabilitySeed"],
                run_id=self._supervisor_config["runId"],
                network_name=networks.gateway,
                context_id=context_id,
                ttl_sec=outer_timeout_sec,
                pricing_sha256=route_config["pricingSha256"],
                receipt_path=self.logs_dir / "gateway-accounting-receipt.json",
            )
            gateway.start()
            await gateway.start_relay(environment)
            await gateway.enroll(environment)
            if public_egress is not None:
                await public_egress.start(environment)
                self._extra_env["PICO_TB_AGENT_EGRESS_TOKEN"] = (
                    public_egress.scrub_secret
                )
            await self._run_with_gateway(
                instruction=instruction,
                environment=environment,
                context=context,
                gateway=gateway,
                route_config=route_config,
                workspace=workspace,
                pico_home=pico_home,
                request_id=request_id,
                session_id=session_id,
                context_id=context_id,
                outer_timeout_sec=outer_timeout_sec,
                outer_deadline=outer_deadline,
                loop=loop,
                public_proxy_env=(
                    public_egress.container_env
                    if public_egress is not None
                    else {}
                ),
            )
            await launch_verifier_service_if_requested(
                environment,
                workspace=workspace,
                outer_deadline=outer_deadline,
                loop=loop,
            )
        finally:
            try:
                verifier_scrub_secret = await cleanup_trial_resources(
                    environment,
                    networks=networks,
                    run_id=self._supervisor_config["runId"],
                    context=context,
                    gateway=gateway,
                    public_egress=public_egress,
                    context_id=context_id,
                    verifier_timeout_sec=verifier_timeout_sec,
                    verifier_receipt_path=(
                        self.logs_dir / "public-egress-verifier-receipt.json"
                    ),
                )
                if verifier_scrub_secret is not None:
                    self._extra_env["PICO_TB_VERIFIER_EGRESS_TOKEN"] = (
                        verifier_scrub_secret
                    )
            finally:
                self._trial_networks = None

    async def _run_with_gateway(
        self,
        *,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
        gateway: ProviderGateway,
        route_config: dict[str, Any],
        workspace: str,
        pico_home: str,
        request_id: str,
        session_id: str,
        context_id: str,
        outer_timeout_sec: float,
        outer_deadline: float,
        loop: asyncio.AbstractEventLoop,
        public_proxy_env: dict[str, str],
    ) -> None:
        route_output = _BENCHMARK_OUTPUT_TOKENS_BY_ROUTE.get(
            route_config["modelRouteId"]
        )
        bootstrap_route = {
            "id": route_config["modelRouteId"],
            "protocol": route_config["provider"]["protocol"],
            "baseURL": gateway.base_url,
            "apiKeyEnv": self._SECRET_ENV,
            **({"output": route_output} if route_output is not None else {}),
        }
        bootstrap_request = {
            "schemaVersion": 1,
            "workspacePath": workspace,
            "picoHome": pico_home,
            "route": bootstrap_route,
        }
        write_private_json(self.logs_dir / "bootstrap-request.json", bootstrap_request)

        bootstrap_budget = remaining_budget(outer_deadline, loop.time())
        bootstrap = await environment.exec(
            command=(
                "set -eu; umask 077; "
                f"mkdir -m 700 -p {shlex.quote(pico_home)}; "
                f"tmp={self._BOOTSTRAP_RESULT.as_posix()}.tmp.$$; "
                f"{self._REMOTE_NODE.as_posix()}/bin/node "
                f"{self._REMOTE_ROOT.as_posix()}/dist/internal/"
                "headless-bootstrap-main.js "
                f"< {EnvironmentPaths.agent_dir.as_posix()}/bootstrap-request.json "
                "> \"$tmp\"; status=$?; "
                f"chmod 600 \"$tmp\"; mv -f \"$tmp\" {self._BOOTSTRAP_RESULT.as_posix()}; "
                "exit \"$status\""
            ),
            timeout_sec=min(60, bootstrap_budget),
        )
        if bootstrap.return_code != 0:
            raise RuntimeError("Pico isolated bootstrap failed")

        attempts: list[dict[str, Any]] = []
        final_result: dict[str, Any] | None = None
        final_exit_code: int | None = None
        final_inner_timeout_ms = 0
        final_bash_timeout_ms = 0
        for attempt in range(1, self._runtime_retry_count + 2):
            remaining_sec = remaining_budget(outer_deadline, loop.time())
            inner_timeout_ms = int(
                remaining_sec * 1000
                - self._shutdown_grace_ms
                - self._result_flush_margin_ms
            )
            if inner_timeout_ms < 1_000:
                raise RuntimeError("outer_timeout_budget_violation")
            bash_timeout_ms = min(self._bash_timeout_ms, inner_timeout_ms)
            attempt_request_id = bounded_attempt_identity(request_id, attempt)
            attempt_session_id = bounded_attempt_identity(session_id, attempt)
            headless_request = {
                "schemaVersion": 1,
                "requestId": attempt_request_id,
                "workspacePath": workspace,
                "picoHome": pico_home,
                "sessionId": attempt_session_id,
                "prompt": benchmark_instruction(instruction, workspace),
                "modelRouteId": route_config["modelRouteId"],
                "providerRequestMode": "single_non_stream",
                **(
                    {"thinkingEffort": route_config["thinkingEffort"]}
                    if route_config.get("thinkingEffort")
                    else {}
                ),
                "permissionMode": "yolo",
                "policyDenialMode": self._POLICY_DENIAL_MODE,
                "allowedTools": [
                    "bash",
                    "read_file",
                    "write_file",
                    "edit_file",
                    "glob",
                    "grep",
                    "read_evidence",
                    "task_list",
                    "task_output",
                    "task_stop",
                ],
                "bashTimeoutMs": bash_timeout_ms,
                "timeoutMs": inner_timeout_ms,
                "shutdownGraceMs": self._shutdown_grace_ms,
                "maxTurns": self._max_turns,
                "trace": True,
            }
            attempt_dir = self.logs_dir / "attempts" / f"attempt-{attempt}"
            write_private_json(self.logs_dir / "headless-request.json", headless_request)
            write_private_json(attempt_dir / "headless-request.json", headless_request)
            result, exit_code = await self._run_headless_attempt(
                environment=environment,
                gateway=gateway,
                request_id=attempt_request_id,
                attempt=attempt,
                attempt_dir=attempt_dir,
                outer_deadline=outer_deadline,
                loop=loop,
                public_proxy_env=public_proxy_env,
            )
            result_error = result.get("error")
            error_code = (
                result_error.get("code")
                if isinstance(result_error, dict)
                else None
            )
            attempts.append(
                {
                    "attempt": attempt,
                    "requestId": attempt_request_id,
                    "status": result["status"],
                    "errorCode": error_code,
                    "terminationConfirmed": result["terminationConfirmed"],
                    "durationMs": result["durationMs"],
                }
            )
            final_result = result
            final_exit_code = exit_code
            final_inner_timeout_ms = inner_timeout_ms
            final_bash_timeout_ms = bash_timeout_ms
            if not should_retry_runtime_failure(
                result,
                retries_used=attempt - 1,
                retry_limit=self._runtime_retry_count,
                remaining_sec=max(0.0, outer_deadline - loop.time()),
                shutdown_grace_ms=self._shutdown_grace_ms,
                result_flush_margin_ms=self._result_flush_margin_ms,
            ):
                break

        if final_result is None or final_exit_code is None:
            raise RuntimeError("Pico headless result is missing")
        result = final_result
        exit_code = final_exit_code
        retry_count = len(attempts) - 1
        usage = result["usage"]
        context.n_input_tokens = int(usage["promptTokens"])
        context.n_output_tokens = int(usage["completionTokens"])
        context.metadata = {
            "pico": {
                "schemaVersion": result["schemaVersion"],
                "requestId": result["requestId"],
                "status": result["status"],
                "exitCode": exit_code,
                "errorCode": (
                    result["error"].get("code")
                    if isinstance(result.get("error"), dict)
                    else None
                ),
                "terminationConfirmed": result["terminationConfirmed"],
                "durationMs": result["durationMs"],
                "costCNY": usage["costCNY"],
                "modelRouteId": route_config["modelRouteId"],
                "picoCommit": self._pico_commit,
                "harborContextId": context_id,
                "innerTimeoutMs": final_inner_timeout_ms,
                "bashTimeoutMs": final_bash_timeout_ms,
                "outerTimeoutSec": outer_timeout_sec,
                "attempts": attempts,
                "retryCount": retry_count,
                "signedGatewayUsageRequired": (
                    retry_count > 0 or is_zero_usage_terminal_failure(result)
                ),
                "localCanaryOnly": True,
                "leaderboardComparable": False,
            }
        }
        if result["terminationConfirmed"] is not True:
            raise RuntimeError("Pico could not confirm runtime termination")
        result_error = result.get("error")
        if (
            isinstance(result_error, dict)
            and result_error.get("code") == "RUNTIME_EMPTY_RESPONSE"
        ):
            raise RuntimeError("Pico provider returned an empty model response")

    async def _run_headless_attempt(
        self,
        *,
        environment: BaseEnvironment,
        gateway: ProviderGateway,
        request_id: str,
        attempt: int,
        attempt_dir: Path,
        outer_deadline: float,
        loop: asyncio.AbstractEventLoop,
        public_proxy_env: dict[str, str],
    ) -> tuple[dict[str, Any], int]:
        cleared_trace = await environment.exec(
            command=f"rm -f -- {shlex.quote(self._TRACE_EXPORT.as_posix())}"
        )
        if cleared_trace.return_code != 0:
            raise RuntimeError("Pico trace reset failed")
        await docker_exec_secret_stdin(
            environment,
            gateway.capability.encode("utf-8"),
            timeout_sec=remaining_budget(outer_deadline, loop.time()),
            secret_env_names={self._SECRET_ENV},
            container_env=public_proxy_env,
        )
        raw_result = await environment.exec(command=f"cat {self._PICO_RESULT.as_posix()}")
        raw_exit = await environment.exec(command=f"cat {self._EXIT_CODE.as_posix()}")
        if raw_result.return_code != 0 or not raw_result.stdout:
            raise RuntimeError("Pico headless result is missing")
        result = parse_single_json_line(raw_result.stdout)
        exit_code = parse_exit_code(raw_exit.stdout)
        validate_headless_result(result, exit_code, request_id)
        write_private_json(attempt_dir / "pico-result.json", result)
        write_private_text(attempt_dir / "pico-exit-code.txt", f"{exit_code}\n")
        trace_path = result.get("tracePath")
        if isinstance(trace_path, str) and trace_path:
            remote_attempt_trace = PurePosixPath(
                EnvironmentPaths.agent_dir
                / "attempts"
                / f"attempt-{attempt}"
                / "trace.json"
            )
            copied = await environment.exec(
                command=(
                    f"test -f {shlex.quote(trace_path)} && "
                    f"test ! -L {shlex.quote(trace_path)} && "
                    f"mkdir -p {shlex.quote(remote_attempt_trace.parent.as_posix())} && "
                    f"cp -- {shlex.quote(trace_path)} "
                    f"{shlex.quote(remote_attempt_trace.as_posix())} && "
                    f"cp -- {shlex.quote(remote_attempt_trace.as_posix())} "
                    f"{self._TRACE_EXPORT.as_posix()}"
                )
            )
            if copied.return_code != 0:
                raise RuntimeError("Pico trace export failed")
        return result, exit_code


def apply_gateway_accounting(
    context: AgentContext, receipt: dict[str, Any]
) -> None:
    actual = receipt["actual"]
    runtime_input_tokens = context.n_input_tokens
    runtime_output_tokens = context.n_output_tokens
    metadata = context.metadata if isinstance(context.metadata, dict) else {}
    pico = metadata.get("pico")
    if not isinstance(pico, dict):
        pico = {}
    runtime_reported_cost = pico.get("costCNY")
    runtime_usage_matches = (
        runtime_input_tokens == actual["inputTokens"]
        and runtime_output_tokens == actual["outputTokens"]
    )
    terminal_zero_usage_fallback = (
        not runtime_usage_matches
        and receipt["status"] == "reconciled"
        and receipt["withinBudget"] is True
        and (pico.get("status"), pico.get("errorCode"))
        in {("failed", "RUNTIME_FAILED"), ("timed_out", "TIMEOUT")}
        and pico.get("terminationConfirmed") is True
        and runtime_input_tokens == 0
        and runtime_output_tokens == 0
        and not isinstance(runtime_reported_cost, bool)
        and isinstance(runtime_reported_cost, (int, float))
        and math.isfinite(runtime_reported_cost)
        and runtime_reported_cost == 0
        and actual["inputTokens"] + actual["outputTokens"] > 0
    )
    signed_gateway_usage_eligible = (
        pico.get("signedGatewayUsageRequired") is True
        or terminal_zero_usage_fallback
    )
    signed_gateway_usage_required = (
        signed_gateway_usage_eligible and not runtime_usage_matches
    )
    use_signed_gateway_actual = (
        signed_gateway_usage_required
        and receipt["status"] == "reconciled"
        and receipt["withinBudget"] is True
    )
    pico["runtimeReportedCostCNY"] = runtime_reported_cost
    pico["runtimeReportedUsage"] = {
        "promptTokens": runtime_input_tokens,
        "completionTokens": runtime_output_tokens,
        "costCNY": runtime_reported_cost,
    }
    pico["costCNY"] = actual["costCNY"]
    pico["signedGatewayUsageRequired"] = signed_gateway_usage_required
    pico["gatewayAccounting"] = {
        "schemaVersion": receipt["schemaVersion"],
        "status": receipt["status"],
        "withinBudget": receipt["withinBudget"],
        "pricingSha256": receipt["pricingSha256"],
        "receiptSha256": receipt["receiptSha256"],
        "costMicroCNY": actual["costMicroCNY"],
        "costCNY": actual["costCNY"],
        "usageFallback": use_signed_gateway_actual,
        "usageSource": (
            "signed_gateway_actual"
            if use_signed_gateway_actual
            else "runtime"
        ),
    }
    metadata["pico"] = pico
    context.metadata = metadata
    if receipt["status"] != "reconciled":
        raise RuntimeError("Gateway accounting could not be reconciled")
    if receipt["withinBudget"] is not True:
        raise RuntimeError("Gateway usage exceeded the configured budget or quota")
    if not runtime_usage_matches and not use_signed_gateway_actual:
        raise RuntimeError("Gateway accounting tokens do not match runtime usage")
    if use_signed_gateway_actual:
        context.n_input_tokens = actual["inputTokens"]
        context.n_output_tokens = actual["outputTokens"]


def validate_gateway_accounting_receipt(
    value: Any,
    *,
    expected_run_id: str,
    expected_trial_id: str,
    expected_protocol: str,
    expected_pricing_sha256: str,
    capability_seed: str,
) -> dict[str, Any]:
    expected_keys = {
        "schemaVersion",
        "runId",
        "trialId",
        "protocol",
        "modelRouteId",
        "pricing",
        "pricingSha256",
        "rounding",
        "status",
        "withinBudget",
        "requests",
        "requestEntries",
        "reservation",
        "actual",
        "refund",
        "supplement",
        "unreconciledReservation",
        "receiptSha256",
        "auth",
    }
    if not isinstance(value, dict) or set(value) != expected_keys:
        raise ValueError("Gateway accounting receipt schema is invalid")
    if (
        value["schemaVersion"] != 1
        or value["runId"] != expected_run_id
        or value["trialId"] != expected_trial_id
        or value["protocol"] != expected_protocol
        or not isinstance(value["modelRouteId"], str)
        or not value["modelRouteId"]
        or value["pricingSha256"] != expected_pricing_sha256
        or value["rounding"] != "ceil-per-request"
        or value["status"] not in {"reconciled", "unreconciled"}
        or not isinstance(value["withinBudget"], bool)
    ):
        raise ValueError("Gateway accounting receipt identity is invalid")
    pricing = value["pricing"]
    if not isinstance(pricing, dict):
        raise ValueError("Gateway accounting receipt pricing is invalid")
    pricing_digest = hashlib.sha256(
        json.dumps(
            pricing,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode()
    ).hexdigest()
    if not hmac.compare_digest(pricing_digest, expected_pricing_sha256):
        raise ValueError("Gateway accounting receipt pricing digest is invalid")
    auth = value["auth"]
    expected_tag = hmac.new(
        capability_seed.encode(),
        b"pico-gateway-accounting-receipt-v1\0"
        + canonical_gateway_accounting_receipt(value, include_auth=False),
        "sha256",
    ).hexdigest()
    if (
        not isinstance(auth, dict)
        or set(auth) != {"algorithm", "keyId", "tag"}
        or auth["algorithm"] != "hmac-sha256"
        or auth["keyId"] != "run-capability-v1"
        or not isinstance(auth["tag"], str)
        or not hmac.compare_digest(auth["tag"], expected_tag)
    ):
        raise ValueError("Gateway accounting receipt authentication is invalid")
    receipt_digest = value["receiptSha256"]
    expected_receipt_digest = hashlib.sha256(
        canonical_gateway_accounting_receipt(value, include_auth=True)
    ).hexdigest()
    if (
        not isinstance(receipt_digest, str)
        or not hmac.compare_digest(receipt_digest, expected_receipt_digest)
    ):
        raise ValueError("Gateway accounting receipt digest is invalid")
    requests = value["requests"]
    if (
        not isinstance(requests, dict)
        or set(requests) != {"attempted", "reconciled", "unreconciled"}
    ):
        raise ValueError("Gateway accounting request totals are invalid")
    for field in requests:
        require_nonnegative_int(requests[field], f"requests.{field}")
    if requests["attempted"] != requests["reconciled"] + requests["unreconciled"]:
        raise ValueError("Gateway accounting request totals are inconsistent")
    buckets = (
        "reservation",
        "actual",
        "refund",
        "supplement",
        "unreconciledReservation",
    )
    for bucket_name in buckets:
        bucket = value[bucket_name]
        expected_bucket_keys = {"inputTokens", "outputTokens", "costMicroCNY"}
        if bucket_name == "actual":
            expected_bucket_keys.add("costCNY")
        if not isinstance(bucket, dict) or set(bucket) != expected_bucket_keys:
            raise ValueError("Gateway accounting token totals are invalid")
        for field in ("inputTokens", "outputTokens", "costMicroCNY"):
            require_nonnegative_int(bucket[field], f"{bucket_name}.{field}")
    entries = value["requestEntries"]
    if not isinstance(entries, list) or len(entries) != requests["attempted"]:
        raise ValueError("Gateway accounting request entries are invalid")
    entry_totals = {
        bucket_name: {
            "inputTokens": 0,
            "outputTokens": 0,
            "costMicroCNY": 0,
        }
        for bucket_name in buckets
    }
    observed_reconciled = 0
    observed_unreconciled = 0
    for index, entry in enumerate(entries, start=1):
        if (
            not isinstance(entry, dict)
            or set(entry)
            != {
                "sequence",
                "status",
                "reservation",
                "actual",
                "refund",
                "supplement",
                "unreconciledReservation",
            }
            or entry["sequence"] != index
            or entry["status"] not in {"reconciled", "unreconciled"}
        ):
            raise ValueError("Gateway accounting request entry is invalid")
        for bucket_name in buckets:
            bucket = entry[bucket_name]
            if (
                not isinstance(bucket, dict)
                or set(bucket)
                != {"inputTokens", "outputTokens", "costMicroCNY"}
            ):
                raise ValueError("Gateway accounting request bucket is invalid")
            for field in ("inputTokens", "outputTokens", "costMicroCNY"):
                require_nonnegative_int(
                    bucket[field], f"requestEntries.{bucket_name}.{field}"
                )
                entry_totals[bucket_name][field] += bucket[field]
        for field in ("inputTokens", "outputTokens", "costMicroCNY"):
            if (
                entry["reservation"][field]
                + entry["supplement"][field]
                - entry["refund"][field]
                - entry["unreconciledReservation"][field]
                != entry["actual"][field]
            ):
                raise ValueError("Gateway accounting request is inconsistent")
        if entry["status"] == "reconciled":
            observed_reconciled += 1
            expected_cost = (
                entry["actual"]["inputTokens"] * pricing["input"]
                + entry["actual"]["outputTokens"] * pricing["output"]
                + 999_999
            ) // 1_000_000
            if (
                entry["actual"]["costMicroCNY"] != expected_cost
                or any(entry["unreconciledReservation"].values())
            ):
                raise ValueError("Gateway accounting request cost is invalid")
        else:
            observed_unreconciled += 1
            if (
                any(entry["actual"].values())
                or any(entry["refund"].values())
                or any(entry["supplement"].values())
                or entry["unreconciledReservation"] != entry["reservation"]
            ):
                raise ValueError("Gateway accounting ambiguity is invalid")
    if (
        observed_reconciled != requests["reconciled"]
        or observed_unreconciled != requests["unreconciled"]
        or any(
            entry_totals[bucket_name][field] != value[bucket_name][field]
            for bucket_name in buckets
            for field in ("inputTokens", "outputTokens", "costMicroCNY")
        )
    ):
        raise ValueError("Gateway accounting request totals are inconsistent")
    actual = value["actual"]
    if (
        isinstance(actual["costCNY"], bool)
        or not isinstance(actual["costCNY"], (int, float))
        or actual["costCNY"] != actual["costMicroCNY"] / 1_000_000
    ):
        raise ValueError("Gateway accounting cost projection is invalid")
    for field in ("inputTokens", "outputTokens", "costMicroCNY"):
        if (
            value["reservation"][field]
            + value["supplement"][field]
            - value["refund"][field]
            - value["unreconciledReservation"][field]
            != actual[field]
        ):
            raise ValueError("Gateway accounting reconciliation is invalid")
    if (
        (value["status"] == "reconciled") != (requests["unreconciled"] == 0)
        or (requests["attempted"] == 0 and actual["costMicroCNY"] != 0)
    ):
        raise ValueError("Gateway accounting status is inconsistent")
    return value


def canonical_gateway_accounting_receipt(
    value: dict[str, Any], *, include_auth: bool
) -> bytes:
    payload = json.loads(json.dumps(value, separators=(",", ":")))
    payload.pop("receiptSha256", None)
    if not include_auth:
        payload.pop("auth", None)
    payload["actual"].pop("costCNY", None)
    return json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode()


def require_nonnegative_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{field} must be a nonnegative integer")
    return value


def create_public_egress_proxy(
    *,
    token: str,
    ttl_sec: float,
) -> Any:
    from benchmarks.terminal_bench_2_1.public_egress import PublicEgressProxy

    return PublicEgressProxy(
        token=token,
        ttl_sec=ttl_sec,
        max_connections=_PUBLIC_EGRESS_MAX_CONNECTIONS,
        max_requests=_PUBLIC_EGRESS_MAX_REQUESTS,
        max_total_bytes=_PUBLIC_EGRESS_MAX_TOTAL_BYTES,
    )


class PublicEgressAccess:
    def __init__(
        self,
        *,
        run_id: str,
        network_name: str,
        context_id: str,
        ttl_sec: float,
        receipt_path: Path,
    ):
        self._run_id = run_id
        self._network_name = network_name
        self._context_digest = hashlib.sha256(context_id.encode()).hexdigest()[:20]
        self._ttl_sec = ttl_sec
        self._receipt_path = receipt_path
        self._relay_name = f"pico-tb-egress-{self._context_digest}"
        # This random per-trial credential is only accepted by the bounded public
        # proxy for this trial and expires with the trial TTL.
        self._token = secrets.token_hex(32)
        self._proxy: Any | None = None
        self._relay_started = False
        self._stopped = False

    @property
    def relay_name(self) -> str:
        return self._relay_name

    @property
    def scrub_secret(self) -> str:
        if not self._token:
            raise RuntimeError("Public egress scrub secret is unavailable")
        return self._token

    @property
    def container_env(self) -> dict[str, str]:
        if self._proxy is None or not self._relay_started:
            raise RuntimeError("Public egress is not ready")
        proxy_url = f"http://pico:{self._token}@pico-egress:8081"
        return {
            "HTTP_PROXY": proxy_url,
            "HTTPS_PROXY": proxy_url,
            "http_proxy": proxy_url,
            "https_proxy": proxy_url,
            "NO_PROXY": _PUBLIC_EGRESS_NO_PROXY,
            "no_proxy": _PUBLIC_EGRESS_NO_PROXY,
        }

    async def start(self, environment: DockerEnvironment) -> None:
        if self._proxy is not None or self._stopped:
            raise RuntimeError("Public egress was already started")
        self._proxy = create_public_egress_proxy(
            token=self._token,
            ttl_sec=self._ttl_sec,
        )
        try:
            host_port = self._proxy.start()
            if (
                isinstance(host_port, bool)
                or not isinstance(host_port, int)
                or not 1 <= host_port <= 65_535
            ):
                raise RuntimeError("Public egress proxy returned an invalid host port")
            await start_public_egress_relay(
                environment,
                relay_name=self._relay_name,
                network_name=self._network_name,
                run_id=self._run_id,
                context_digest=self._context_digest,
                host_port=host_port,
            )
            self._relay_started = True
        except BaseException as startup_error:
            try:
                await asyncio.shield(self.stop(environment))
            except BaseException as cleanup_error:
                raise cleanup_error from startup_error
            raise

    async def stop(self, environment: DockerEnvironment) -> None:
        if self._stopped:
            return
        cleanup_errors: list[BaseException] = []
        proxy = self._proxy
        if proxy is not None:
            try:
                proxy.revoke()
            except BaseException as error:
                cleanup_errors.append(error)
        relay_removed = False
        try:
            await remove_public_egress_relay(
                environment,
                relay_name=self._relay_name,
                run_id=self._run_id,
                context_digest=self._context_digest,
            )
        except BaseException as error:
            cleanup_errors.append(error)
        else:
            relay_removed = True
            self._relay_started = False

        # Never release the host listener while a relay might still be able to
        # reach it: a reused ephemeral port could otherwise become an egress
        # capability for the stale relay.
        if relay_removed and proxy is not None:
            try:
                receipt = proxy.stop()
                if (
                    not isinstance(receipt, dict)
                    or receipt.get("schemaVersion")
                    != _PUBLIC_EGRESS_PROXY_POLICY_VERSION
                ):
                    raise RuntimeError("Public egress proxy returned an invalid receipt")
                write_private_json_once(self._receipt_path, receipt)
                self._proxy = None
            except BaseException as error:
                cleanup_errors.append(error)

        if relay_removed and (proxy is None or self._proxy is None):
            self._token = ""
            self._stopped = True
        if cleanup_errors:
            raise RuntimeError("Could not stop public egress cleanly") from cleanup_errors[0]


def public_egress_access_for_task(
    environment: BaseEnvironment,
    *,
    run_id: str,
    network_name: str,
    context_id: str,
    ttl_sec: float,
    receipt_path: Path,
) -> PublicEgressAccess | None:
    if not task_allows_internet(environment):
        return None
    return PublicEgressAccess(
        run_id=run_id,
        network_name=network_name,
        context_id=context_id,
        ttl_sec=ttl_sec,
        receipt_path=receipt_path,
    )


async def start_public_egress_relay(
    environment: DockerEnvironment,
    *,
    relay_name: str,
    network_name: str,
    run_id: str,
    context_digest: str,
    host_port: int,
) -> None:
    _, network_stdout, _ = await run_docker(
        ["network", "inspect", network_name],
        environment,
    )
    network_values = json.loads(network_stdout)
    if (
        len(network_values) != 1
        or network_values[0].get("Name") != network_name
        or not is_owned_trial_network(network_values[0], run_id)
    ):
        raise RuntimeError("Public egress relay network identity is invalid")
    await run_docker(
        [
            "run",
            "--detach",
            "--pull",
            "never",
            "--name",
            relay_name,
            "--label",
            f"pico.terminal-bench.run={run_id}",
            "--label",
            "pico.terminal-bench.role=public-egress-relay",
            "--label",
            f"pico.terminal-bench.trial={context_digest}",
            "--read-only",
            "--user",
            "65534:65534",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--pids-limit",
            "64",
            "--memory",
            "64m",
            "--network",
            network_name,
            "--network-alias",
            "pico-egress",
            _RELAY_IMAGE_ID,
            "node",
            "-e",
            _PUBLIC_EGRESS_RELAY_SCRIPT,
            str(host_port),
        ],
        environment,
    )
    await run_docker(
        ["network", "connect", "bridge", relay_name],
        environment,
    )
    _, image_stdout, _ = await run_docker(
        ["inspect", "--format", "{{.Image}}", relay_name],
        environment,
    )
    if image_stdout.decode().strip() != _RELAY_IMAGE_ID:
        raise RuntimeError("Public egress relay image identity is invalid")
    _, inspect_stdout, _ = await run_docker(
        ["inspect", relay_name],
        environment,
    )
    values = json.loads(inspect_stdout)
    if len(values) != 1 or not is_valid_public_egress_relay(
        values[0],
        relay_name=relay_name,
        network_name=network_name,
        run_id=run_id,
        context_digest=context_digest,
        host_port=host_port,
    ):
        raise RuntimeError("Public egress relay isolation is invalid")


def is_valid_public_egress_relay(
    value: dict[str, Any],
    *,
    relay_name: str,
    network_name: str,
    run_id: str,
    context_digest: str,
    host_port: int,
) -> bool:
    config = value.get("Config") or {}
    labels = config.get("Labels") or {}
    host = value.get("HostConfig") or {}
    networks = (value.get("NetworkSettings") or {}).get("Networks") or {}
    gateway_aliases = (networks.get(network_name) or {}).get("Aliases") or []
    return (
        value.get("Name") == f"/{relay_name}"
        and value.get("Image") == _RELAY_IMAGE_ID
        and value.get("State", {}).get("Running") is True
        and labels.get("pico.terminal-bench.run") == run_id
        and labels.get("pico.terminal-bench.role") == "public-egress-relay"
        and labels.get("pico.terminal-bench.trial") == context_digest
        and set(networks) == {network_name, "bridge"}
        and "pico-egress" in gateway_aliases
        and config.get("User") == "65534:65534"
        and not value.get("Mounts")
        and not host.get("Binds")
        and not host.get("Mounts")
        and host.get("Privileged") is False
        and not host.get("CapAdd")
        and set(host.get("CapDrop") or []) == {"ALL"}
        and host.get("ReadonlyRootfs") is True
        and set(host.get("SecurityOpt") or []) == {"no-new-privileges"}
        and host.get("Memory") == 67_108_864
        and host.get("PidsLimit") == 64
        and host.get("NetworkMode") == network_name
        and not host.get("Devices")
        and not host.get("PortBindings")
        and not config.get("ExposedPorts")
        and config.get("Cmd")
        == ["node", "-e", _PUBLIC_EGRESS_RELAY_SCRIPT, str(host_port)]
    )


def is_owned_public_egress_relay(
    value: dict[str, Any],
    *,
    relay_name: str,
    run_id: str,
    context_digest: str,
) -> bool:
    labels = (value.get("Config") or {}).get("Labels") or {}
    return (
        value.get("Name") == f"/{relay_name}"
        and value.get("Image") == _RELAY_IMAGE_ID
        and labels.get("pico.terminal-bench.run") == run_id
        and labels.get("pico.terminal-bench.role") == "public-egress-relay"
        and labels.get("pico.terminal-bench.trial") == context_digest
    )


async def remove_public_egress_relay(
    environment: DockerEnvironment,
    *,
    relay_name: str,
    run_id: str,
    context_digest: str,
) -> None:
    inspect_code, inspect_stdout, inspect_stderr = await run_docker(
        ["inspect", relay_name],
        environment,
        allowed_exit_codes={0, 1},
    )
    if inspect_code == 1:
        if is_missing_docker_container_error(inspect_stderr):
            return
        raise RuntimeError("Could not inspect the public egress relay")
    values = json.loads(inspect_stdout)
    if len(values) != 1 or not is_owned_public_egress_relay(
        values[0],
        relay_name=relay_name,
        run_id=run_id,
        context_digest=context_digest,
    ):
        raise RuntimeError("Refusing to remove an unowned public egress relay")
    remove_code, _, remove_stderr = await run_docker(
        ["rm", "--force", relay_name],
        environment,
        allowed_exit_codes={0, 1},
    )
    if remove_code != 0 and not is_missing_docker_container_error(remove_stderr):
        raise RuntimeError("Could not remove the public egress relay")
    verify_code, _, verify_stderr = await run_docker(
        ["inspect", relay_name],
        environment,
        allowed_exit_codes={0, 1},
    )
    if verify_code == 0 or not is_missing_docker_container_error(verify_stderr):
        raise RuntimeError("Public egress relay removal was not confirmed")


def is_missing_docker_container_error(stderr: bytes) -> bool:
    message = stderr.decode(errors="replace").lower()
    return "no such container" in message or "no such object" in message or (
        "container " in message and " not found" in message
    )


class ProviderGateway:
    def __init__(
        self,
        *,
        protocol: str,
        supervisor_socket: str,
        capability_seed: str,
        run_id: str,
        network_name: str,
        context_id: str,
        ttl_sec: float,
        pricing_sha256: str,
        receipt_path: Path,
    ):
        self._protocol = protocol
        self._supervisor_socket = supervisor_socket
        self._run_id = run_id
        self._network_name = network_name
        self._context_id = context_id
        self._ttl_sec = ttl_sec
        self._pricing_sha256 = pricing_sha256
        self._receipt_path = receipt_path
        self._capability_seed = capability_seed
        self._expires_at = time.monotonic() + ttl_sec
        self._request_lock = threading.Lock()
        self._request_slot = threading.BoundedSemaphore(1)
        self._revoked = False
        self.capability = "pico-workload-identity"
        self._enrollment_token = secrets.token_hex(32)
        self._workload_peer: str | None = None
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self._relay_name = (
            f"pico-tb-relay-{hashlib.sha256(context_id.encode()).hexdigest()[:20]}"
        )
        self._host_port = 0
        self.base_url = ""

    @property
    def relay_name(self) -> str:
        return self._relay_name

    def start(self) -> None:
        self._signed_supervisor_request(
            {
                "action": "register",
                "trialId": self._context_id,
                "ttlSec": self._ttl_sec,
                "protocol": self._protocol,
            }
        )
        gateway = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self) -> None:
                if self.path == "/__pico_enroll__":
                    gateway._enroll(self)
                else:
                    gateway._proxy(self)

            def log_message(self, _format: str, *args: Any) -> None:
                del args

        self._server = ThreadingHTTPServer(("0.0.0.0", 0), Handler)
        self._server.daemon_threads = True
        self._host_port = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    async def start_relay(self, environment: DockerEnvironment) -> None:
        script = (
            "const net=require('node:net');"
            "const port=Number(process.argv[1]);"
            "net.createServer(client=>{"
            "const upstream=net.connect(port,'host.docker.internal');"
            "client.pipe(upstream);upstream.pipe(client);"
            "const close=()=>{client.destroy();upstream.destroy()};"
            "client.on('error',close);upstream.on('error',close);"
            "}).listen(8080,'0.0.0.0');"
        )
        await run_docker(
            [
                "run",
                "--detach",
                "--pull",
                "never",
                "--name",
                self._relay_name,
                "--label",
                f"pico.terminal-bench.run={self._run_id}",
                "--network",
                self._network_name,
                "--network-alias",
                "pico-gateway",
                _RELAY_IMAGE_ID,
                "node",
                "-e",
                script,
                str(self._host_port),
            ],
            environment,
        )
        await run_docker(
            ["network", "connect", "bridge", self._relay_name],
            environment,
        )
        _, relay_image_stdout, _ = await run_docker(
            ["inspect", "--format", "{{.Image}}", self._relay_name],
            environment,
        )
        if relay_image_stdout.decode().strip() != _RELAY_IMAGE_ID:
            raise RuntimeError("Pico workload relay image identity is invalid")
        _, inspect_stdout, _ = await run_docker(
            ["inspect", self._relay_name],
            environment,
        )
        relay = json.loads(inspect_stdout)[0]
        if (
            relay.get("State", {}).get("Running") is not True
            or set((relay.get("NetworkSettings", {}).get("Networks") or {}))
            != {self._network_name, "bridge"}
        ):
            raise RuntimeError("Pico workload relay isolation is invalid")
        self.base_url = "http://pico-gateway:8080"

    async def enroll(self, environment: DockerEnvironment) -> None:
        await docker_enroll_gateway(
            environment,
            self.base_url,
            self._enrollment_token.encode(),
        )
        if self._workload_peer is None:
            raise RuntimeError("Pico could not bind the gateway workload identity")

    def stop(self) -> dict[str, Any]:
        with self._request_lock:
            self._revoked = True
        try:
            response = self._signed_supervisor_request(
                {
                    "action": "revoke",
                    "trialId": self._context_id,
                }
            )
            receipt = validate_gateway_accounting_receipt(
                response.get("accountingReceipt"),
                expected_run_id=self._run_id,
                expected_trial_id=self._context_id,
                expected_protocol=self._protocol,
                expected_pricing_sha256=self._pricing_sha256,
                capability_seed=self._capability_seed,
            )
            write_private_json_once(self._receipt_path, receipt)
        finally:
            if self._server is not None:
                self._server.shutdown()
                self._server.server_close()
            if self._thread is not None:
                self._thread.join(timeout=5)
            subprocess.run(
                ["docker", "rm", "--force", self._relay_name],
                env=compose_subprocess_env_from_host(),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        return receipt

    def _proxy(self, handler: BaseHTTPRequestHandler) -> None:
        if not self._request_slot.acquire(blocking=False):
            handler.send_error(429, "Pico benchmark gateway concurrency limit")
            return
        try:
            if (
                self._workload_peer is None
                or handler.client_address[0] != self._workload_peer
            ):
                raise ValueError("gateway workload identity mismatch")
            length = int(handler.headers.get("content-length", "0"))
            if length < 1 or length > 8 * 1024 * 1024:
                raise ValueError("request body is outside the gateway limit")
            with self._request_lock:
                if self._revoked or time.monotonic() >= self._expires_at:
                    raise ValueError("gateway capability expired")
            response = self._signed_supervisor_request(
                {
                    "action": "proxy",
                    "trialId": self._context_id,
                    "protocol": self._protocol,
                    "path": handler.path,
                    "headers": {
                        "content-type": handler.headers.get(
                            "content-type", "application/json"
                        ),
                        "accept": handler.headers.get("accept", "*/*"),
                        "anthropic-version": handler.headers.get(
                            "anthropic-version"
                        ),
                    },
                    "body": base64.b64encode(handler.rfile.read(length)).decode(),
                }
            )
            handler.send_response(int(response["status"]))
            for name, value in response.get("headers", []):
                handler.send_header(str(name), str(value))
            body = base64.b64decode(response.get("body", ""), validate=True)
            handler.send_header("Content-Length", str(len(body)))
            handler.send_header("Connection", "close")
            handler.end_headers()
            handler.wfile.write(body)
            handler.wfile.flush()
            handler.close_connection = True
        except Exception:
            handler.send_error(502, "Pico benchmark credential gateway rejected the request")
        finally:
            self._request_slot.release()

    def _enroll(self, handler: BaseHTTPRequestHandler) -> None:
        with self._request_lock:
            if (
                self._workload_peer is not None
                or not hmac.compare_digest(
                    handler.headers.get("x-pico-enrollment", ""),
                    self._enrollment_token,
                )
            ):
                handler.send_error(403, "Pico gateway enrollment rejected")
                return
            self._workload_peer = handler.client_address[0]
            self._enrollment_token = ""
        handler.send_response(204)
        handler.send_header("Content-Length", "0")
        handler.send_header("Connection", "close")
        handler.end_headers()
        handler.close_connection = True

    def _signed_supervisor_request(self, value: dict[str, Any]) -> dict[str, Any]:
        now = int(time.time())
        auth = {
            "runId": self._run_id,
            "trialId": self._context_id,
            "nonce": secrets.token_hex(16),
            "issuedAt": now,
            "expiresAt": now + min(int(self._ttl_sec), MAX_TASK_AGENT_TIMEOUT_SEC),
        }
        value["auth"] = auth
        signature = hmac.new(
            self._capability_seed.encode(),
            json.dumps(
                value,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
            ).encode(),
            hashlib.sha256,
        ).hexdigest()
        value["auth"] = {**auth, "signature": signature}
        return self._supervisor_request(value)

    def _supervisor_request(self, value: dict[str, Any]) -> dict[str, Any]:
        data = json.dumps(value, separators=(",", ":")).encode()
        connection = UnixHTTPConnection(self._supervisor_socket, timeout=130)
        try:
            connection.request(
                "POST",
                "/",
                body=data,
                headers={
                    "Content-Type": "application/json",
                    "Content-Length": str(len(data)),
                },
            )
            response = connection.getresponse()
            body = response.read(96 * 1024 * 1024 + 1)
            if response.status != 200 or len(body) > 96 * 1024 * 1024:
                raise ValueError("gateway supervisor rejected the request")
            parsed = json.loads(body)
            if not isinstance(parsed, dict):
                raise ValueError("gateway supervisor returned invalid data")
            return parsed
        finally:
            connection.close()


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, path: str, timeout: float):
        super().__init__("localhost", timeout=timeout)
        self._path = path

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self._path)


async def docker_enroll_gateway(
    environment: DockerEnvironment,
    base_url: str,
    enrollment_token: bytes,
) -> None:
    assert_secure_docker_environment(environment)
    command = [
        "docker",
        "compose",
        "--project-name",
        _sanitize_docker_compose_project_name(environment.session_id),
        "--project-directory",
        str(environment.environment_dir.resolve().absolute()),
    ]
    for path in environment._docker_compose_paths:
        command.extend(["-f", str(path.resolve().absolute())])
    script = (
        "let data='';"
        "process.stdin.setEncoding('utf8');"
        "process.stdin.on('data',chunk=>data+=chunk);"
        "process.stdin.on('end',async()=>{"
        "for(let attempt=0;attempt<50;attempt++){try{"
        "const response=await fetch(process.argv[1]+'/__pico_enroll__',"
        "{method:'POST',headers:{'x-pico-enrollment':data}});"
        "if(response.status===204)return;"
        "}catch{}await new Promise(resolve=>setTimeout(resolve,100));}"
        "process.exit(2);"
        "});"
    )
    command.extend(
        [
            "exec",
            "-T",
            "-u",
            str(environment.default_user or "root"),
            "main",
            f"{PicoInstalledAgent._REMOTE_NODE.as_posix()}/bin/node",
            "-e",
            script,
            base_url,
        ]
    )
    process = await asyncio.create_subprocess_exec(
        *command,
        env=compose_subprocess_env(environment),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await asyncio.wait_for(
        process.communicate(input=enrollment_token),
        timeout=15,
    )
    if process.returncode != 0 or enrollment_token in stdout or enrollment_token in stderr:
        raise RuntimeError("Pico gateway workload enrollment failed")


def verifier_service_manifest_path(workspace: str) -> str:
    path = PurePosixPath(workspace)
    if (
        not workspace.startswith("/")
        or "\0" in workspace
        or ".." in path.parts
        or path.as_posix() != workspace
    ):
        raise RuntimeError("Terminal-Bench workspace path is invalid")
    return (PurePosixPath(workspace) / _VERIFIER_SERVICE_MANIFEST_BASENAME).as_posix()


def is_bounded_posix_path(candidate: str, root: str) -> bool:
    if not candidate.startswith("/") or "\0" in candidate:
        return False
    path = PurePosixPath(candidate)
    if ".." in path.parts:
        return False
    normalized = path.as_posix()
    return normalized == candidate and (
        candidate == root or candidate.startswith(f"{root}/")
    )


def parse_verifier_service_manifest(
    value: Any,
    *,
    workspace: str,
) -> VerifierServiceManifest:
    verifier_service_manifest_path(workspace)
    if not isinstance(value, dict) or set(value) != {
        "schemaVersion",
        "argv",
        "cwd",
        "port",
    }:
        raise ValueError("Verifier service manifest schema is invalid")
    if (
        type(value["schemaVersion"]) is not int
        or value["schemaVersion"] != 1
        or type(value["port"]) is not int
        or value["port"] != _VERIFIER_SERVICE_PORT
    ):
        raise ValueError("Verifier service manifest identity is invalid")
    cwd = value["cwd"]
    argv = value["argv"]
    if (
        not isinstance(cwd, str)
        or not is_bounded_posix_path(cwd, workspace)
        or not isinstance(argv, list)
        or not 2 <= len(argv) <= 32
        or any(
            not isinstance(entry, str)
            or not 1 <= len(entry) <= 4_096
            or any(character in entry for character in ("\0", "\r", "\n"))
            for entry in argv
        )
    ):
        raise ValueError("Verifier service manifest launch contract is invalid")
    executable = argv[0]
    suffixes = _VERIFIER_SERVICE_EXECUTABLES.get(executable)
    script = argv[1]
    accepted_suffixes = (suffixes,) if isinstance(suffixes, str) else suffixes
    if (
        accepted_suffixes is None
        or not is_bounded_posix_path(script, cwd)
        or PurePosixPath(script).parent.as_posix() != cwd
        or not script.endswith(accepted_suffixes)
    ):
        raise ValueError("Verifier service manifest executable is invalid")
    return VerifierServiceManifest(tuple(argv), cwd, _VERIFIER_SERVICE_PORT)


async def docker_compose_exec_argv(
    environment: DockerEnvironment,
    argv: list[str],
    *,
    detached: bool = False,
    working_dir: str | None = None,
    container_env: dict[str, str] | None = None,
    timeout_sec: float = 15.0,
    allowed_exit_codes: set[int] = {0},
) -> tuple[int, bytes, bytes]:
    assert_secure_docker_environment(environment)
    command = docker_compose_exec_command(
        environment,
        argv,
        detached=detached,
        working_dir=working_dir,
        container_env=container_env,
    )
    process = await asyncio.create_subprocess_exec(
        *command,
        env=compose_subprocess_env(environment),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(), timeout=timeout_sec
        )
    except TimeoutError:
        process.kill()
        await process.communicate()
        raise RuntimeError("Verifier service Docker exec timed out") from None
    if process.returncode not in allowed_exit_codes:
        raise RuntimeError("Verifier service Docker exec failed")
    return process.returncode, stdout, stderr


def docker_compose_exec_command(
    environment: DockerEnvironment,
    argv: list[str],
    *,
    detached: bool = False,
    working_dir: str | None = None,
    container_env: dict[str, str] | None = None,
) -> list[str]:
    if not argv or any(not isinstance(entry, str) or "\0" in entry for entry in argv):
        raise RuntimeError("Docker exec argv is invalid")
    command = [
        "docker",
        "compose",
        "--project-name",
        _sanitize_docker_compose_project_name(environment.session_id),
        "--project-directory",
        str(environment.environment_dir.resolve().absolute()),
    ]
    for path in environment._docker_compose_paths:
        command.extend(["-f", str(path.resolve().absolute())])
    command.extend(["exec", "-T"])
    if detached:
        command.append("--detach")
    command.extend(["-u", str(environment.default_user or "root")])
    if working_dir is not None:
        command.extend(["--workdir", working_dir])
    if container_env is not None:
        if any(
            not isinstance(name, str)
            or not re.fullmatch(r"[A-Z][A-Z0-9_]*", name)
            or not isinstance(value, str)
            or "\0" in value
            for name, value in container_env.items()
        ):
            raise RuntimeError("Docker exec environment is invalid")
        for name in sorted(container_env):
            command.extend(["--env", f"{name}={container_env[name]}"])
    command.extend(["main", *argv])
    return command


async def read_verifier_service_manifest(
    environment: DockerEnvironment,
    *,
    workspace: str,
    timeout_sec: float,
) -> VerifierServiceManifest | None:
    manifest_path = verifier_service_manifest_path(workspace)
    return_code, stdout, _ = await docker_compose_exec_argv(
        environment,
        [
            PicoInstalledAgent._REMOTE_NODE.as_posix() + "/bin/node",
            "-e",
            _VERIFIER_SERVICE_HELPER,
            _VERIFIER_SERVICE_HELPER_SENTINEL,
            "inspect",
            manifest_path,
            workspace,
        ],
        working_dir=workspace,
        container_env=_TRUSTED_NODE_EXEC_ENV,
        timeout_sec=timeout_sec,
        allowed_exit_codes={0, 44},
    )
    if return_code == 44:
        return None
    try:
        value = parse_single_json_line(stdout.decode("utf-8"))
        return parse_verifier_service_manifest(value, workspace=workspace)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RuntimeError) as error:
        raise RuntimeError("Verifier service manifest is invalid") from error


async def launch_verifier_service_if_requested(
    environment: DockerEnvironment,
    *,
    workspace: str,
    outer_deadline: float,
    loop: asyncio.AbstractEventLoop,
) -> bool:
    manifest = await read_verifier_service_manifest(
        environment,
        workspace=workspace,
        timeout_sec=verifier_service_step_timeout(outer_deadline, loop),
    )
    if manifest is None:
        return False
    node = PicoInstalledAgent._REMOTE_NODE.as_posix() + "/bin/node"
    manifest_path = verifier_service_manifest_path(workspace)
    supervisor_nonce = secrets.token_hex(32)
    helper_sha256 = hashlib.sha256(_VERIFIER_SERVICE_HELPER.encode()).hexdigest()
    listener_status, _, _ = await docker_compose_exec_argv(
        environment,
        [node, "-e", _VERIFIER_SERVICE_ASSERT_CLOSED],
        container_env=_TRUSTED_NODE_EXEC_ENV,
        timeout_sec=verifier_service_step_timeout(outer_deadline, loop),
        allowed_exit_codes={0, 2},
    )
    if listener_status == 2:
        # Preserve the existing unmanaged task-service path. Never adopt or
        # terminate an already-listening process as the trusted supervisor.
        return False
    await docker_compose_exec_argv(
        environment,
        [
            node,
            "-e",
            _VERIFIER_SERVICE_HELPER,
            _VERIFIER_SERVICE_HELPER_SENTINEL,
            "launch",
            manifest_path,
            workspace,
            supervisor_nonce,
        ],
        detached=True,
        working_dir=manifest.cwd,
        container_env=_TRUSTED_NODE_EXEC_ENV,
        timeout_sec=verifier_service_step_timeout(outer_deadline, loop),
    )
    await docker_compose_exec_argv(
        environment,
        [
            node,
            "-e",
            _VERIFIER_SERVICE_PROBE,
            supervisor_nonce,
            manifest_path,
            workspace,
            helper_sha256,
        ],
        container_env=_TRUSTED_NODE_EXEC_ENV,
        timeout_sec=verifier_service_step_timeout(outer_deadline, loop),
    )
    return True


def verifier_service_step_timeout(
    outer_deadline: float,
    loop: asyncio.AbstractEventLoop,
) -> float:
    return min(15.0, remaining_budget(outer_deadline, loop.time()))


async def docker_exec_secret_stdin(
    environment: DockerEnvironment,
    secret: bytes,
    *,
    timeout_sec: float,
    secret_env_names: set[str],
    container_env: dict[str, str] | None = None,
) -> asyncio.subprocess.Process:
    assert_secure_docker_environment(environment)
    full_command = [
        "docker",
        "compose",
        "--project-name",
        _sanitize_docker_compose_project_name(environment.session_id),
        "--project-directory",
        str(environment.environment_dir.resolve().absolute()),
    ]
    for path in environment._docker_compose_paths:
        full_command.extend(["-f", str(path.resolve().absolute())])
    full_command.extend(
        [
            "exec",
            "-T",
            "-u",
            str(environment.default_user or "root"),
        ]
    )
    if container_env:
        verified_proxy_env = validate_agent_controlled_proxy_env(container_env)
        full_command.extend(
            [
                "-e",
                (
                    f"{_AGENT_CONTROLLED_PROXY_GATE_ENV}="
                    f"{_AGENT_CONTROLLED_PROXY_GATE_ENABLED}"
                ),
            ]
        )
        for name in PUBLIC_EGRESS_PROXY_ENV_NAMES:
            value = verified_proxy_env[name]
            full_command.extend(["-e", f"{name}={value}"])
    else:
        # Always override any task-image value. Without an adapter-created egress
        # capability, the launcher cannot mint the process-local Runtime authority.
        full_command.extend(
            [
                "-e",
                (
                    f"{_AGENT_CONTROLLED_PROXY_GATE_ENV}="
                    f"{_AGENT_CONTROLLED_PROXY_GATE_DISABLED}"
                ),
            ]
        )
    full_command.extend(
        [
            "main",
            f"{PicoInstalledAgent._REMOTE_NODE.as_posix()}/bin/node",
            f"{PicoInstalledAgent._REMOTE_ROOT.as_posix()}/container-launcher.mjs",
        ]
    )
    child_env = compose_subprocess_env(environment)
    for name in secret_env_names:
        child_env.pop(name, None)
    process = await asyncio.create_subprocess_exec(
        *full_command,
        env=child_env,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    frame = f"{len(secret):08x}\n".encode("ascii") + secret
    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(input=frame), timeout=timeout_sec
        )
    except asyncio.CancelledError:
        try:
            await asyncio.shield(terminate_container_launcher(environment, child_env))
        finally:
            await asyncio.shield(terminate_host_process(process))
        raise
    except TimeoutError:
        try:
            await terminate_container_launcher(environment, child_env)
        finally:
            await terminate_host_process(process)
        raise RuntimeError("outer_timeout_budget_violation") from None
    if secret in stdout or secret in stderr:
        raise RuntimeError("Secret launcher leaked its input")
    return process


def validate_agent_controlled_proxy_env(values: dict[str, str]) -> dict[str, str]:
    if set(values) != set(PUBLIC_EGRESS_PROXY_ENV_NAMES):
        raise RuntimeError("Container public proxy environment is incomplete")
    verified = dict(values)
    proxy_url = verified["HTTP_PROXY"]
    if (
        not isinstance(proxy_url, str)
        or _AGENT_CONTROLLED_PROXY_URL.fullmatch(proxy_url) is None
        or any(verified[name] != proxy_url for name in PUBLIC_EGRESS_PROXY_ENV_NAMES[:4])
        or verified["NO_PROXY"] != _PUBLIC_EGRESS_NO_PROXY
        or verified["no_proxy"] != _PUBLIC_EGRESS_NO_PROXY
    ):
        raise RuntimeError("Container public proxy environment is invalid")
    return verified


async def terminate_host_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    try:
        process.terminate()
    except ProcessLookupError:
        return
    try:
        await asyncio.wait_for(process.wait(), timeout=5)
    except TimeoutError:
        try:
            process.kill()
        except ProcessLookupError:
            return
        await process.wait()


async def terminate_container_launcher(
    environment: DockerEnvironment, child_env: dict[str, str]
) -> None:
    command = [
        "docker",
        "compose",
        "--project-name",
        _sanitize_docker_compose_project_name(environment.session_id),
        "--project-directory",
        str(environment.environment_dir.resolve().absolute()),
    ]
    for path in environment._docker_compose_paths:
        command.extend(["-f", str(path.resolve().absolute())])
    command.extend(
        [
            "exec",
            "-T",
            "-u",
            str(environment.default_user or "root"),
            "main",
            "sh",
            "-c",
            (
                "pids=$(pgrep -f '^/installed-agent/pico-node/bin/node "
                "/installed-agent/pico/container-launcher.mjs$' || true); "
                "[ -z \"$pids\" ] && exit 0; "
                "kill -TERM $pids; "
                "i=0; while [ $i -lt 50 ] && kill -0 $pids 2>/dev/null; "
                "do i=$((i+1)); sleep 0.1; done; "
                "kill -KILL $pids 2>/dev/null || true; "
                "sleep 0.1; ! kill -0 $pids 2>/dev/null"
            ),
        ]
    )
    process = await asyncio.create_subprocess_exec(
        *command,
        env=child_env,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        await asyncio.wait_for(process.communicate(), timeout=10)
    except TimeoutError:
        process.kill()
        await process.wait()
        raise RuntimeError("container_launcher_termination_unconfirmed") from None
    if process.returncode != 0:
        raise RuntimeError("container_launcher_termination_unconfirmed")


def compose_subprocess_env(environment: DockerEnvironment) -> dict[str, str]:
    child_env = environment._compose_env_vars(include_os_env=False)
    for name in [
        "PATH",
        "HOME",
        "TMPDIR",
        "DOCKER_HOST",
        "DOCKER_CONTEXT",
        "DOCKER_CONFIG",
        "XDG_CONFIG_HOME",
    ]:
        value = os.environ.get(name)
        if value is not None:
            child_env[name] = value
    return child_env


def compose_subprocess_env_from_host() -> dict[str, str]:
    return {
        name: value
        for name in [
            "PATH",
            "HOME",
            "TMPDIR",
            "DOCKER_HOST",
            "DOCKER_CONTEXT",
            "DOCKER_CONFIG",
            "XDG_CONFIG_HOME",
        ]
        if (value := os.environ.get(name)) is not None
    }


def assert_secure_docker_environment(environment: BaseEnvironment) -> None:
    if type(environment) is not DockerEnvironment:
        raise RuntimeError("Pico benchmark requires the exact Harbor Docker backend")
    if environment._keep_containers:
        raise RuntimeError("Pico benchmark forbids keep_containers")
    if environment.extra_docker_compose_paths:
        raise RuntimeError("Pico benchmark forbids extra Docker compose overlays")


async def assert_running_container_policy(
    environment: DockerEnvironment,
    logs_dir: Path,
    run_id: str,
) -> list[str]:
    command = [
        "docker",
        "compose",
        "--project-name",
        _sanitize_docker_compose_project_name(environment.session_id),
        "--project-directory",
        str(environment.environment_dir.resolve().absolute()),
    ]
    for path in environment._docker_compose_paths:
        command.extend(["-f", str(path.resolve().absolute())])
    command.extend(["ps", "-q"])
    probe = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=compose_subprocess_env(environment),
    )
    stdout, _ = await probe.communicate()
    container_ids = stdout.decode().split()
    if probe.returncode != 0 or len(container_ids) != 1 or any(
        not re.fullmatch(r"[0-9a-f]{12,64}", item) for item in container_ids
    ):
        raise RuntimeError("Could not identify the isolated Harbor container")
    inspect = await asyncio.create_subprocess_exec(
        "docker",
        "inspect",
        *container_ids,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=compose_subprocess_env(environment),
    )
    raw, _ = await inspect.communicate()
    if inspect.returncode != 0:
        raise RuntimeError("Could not inspect the isolated Harbor container")
    allowed_roots = {
        environment.environment_dir.resolve(),
        logs_dir.resolve().parent,
    }
    for value in json.loads(raw):
        labels = value.get("Config", {}).get("Labels") or {}
        if (
            labels.get("com.docker.compose.service") != "main"
            or labels.get("pico.terminal-bench.run") != run_id
        ):
            raise RuntimeError("Harbor container ownership identity is invalid")
        host = value.get("HostConfig") or {}
        if (
            host.get("Privileged")
            or host.get("NetworkMode") == "host"
            or host.get("PidMode") == "host"
            or host.get("IpcMode") == "host"
            or host.get("UTSMode") == "host"
            or host.get("CgroupnsMode") == "host"
            or host.get("UsernsMode") == "host"
            or host.get("CapAdd")
            or host.get("Devices")
            or host.get("DeviceRequests")
            or host.get("SecurityOpt")
            or host.get("VolumesFrom")
            or host.get("PortBindings")
            or any("docker.sock" in item for item in host.get("Binds") or [])
        ):
            raise RuntimeError("Harbor container violates the Pico yolo isolation policy")
        configured_env = value.get("Config", {}).get("Env") or []
        if any(item.startswith("PICO_TB_PROVIDER_API_KEY=") for item in configured_env):
            raise RuntimeError("Harbor container received the host provider credential")
        for mount in value.get("Mounts") or []:
            source = mount.get("Source")
            destination = mount.get("Destination")
            if "docker.sock" in str(source) or "docker.sock" in str(destination):
                raise RuntimeError("Harbor container exposes the Docker control socket")
            if mount.get("Type") not in {"bind", "volume", "tmpfs"}:
                raise RuntimeError("Harbor container has an unsupported mount type")
            if not isinstance(destination, str) or not destination.startswith("/"):
                raise RuntimeError("Harbor container has an invalid mount destination")
            if not allowed_mount_destination(destination):
                raise RuntimeError("Harbor container has a sensitive mount destination")
            if mount.get("Type") != "bind":
                continue
            if not source:
                raise RuntimeError("Harbor container has an invalid host mount")
            source_path = Path(source).resolve()
            try:
                source_info = Path(source).lstat()
            except OSError as error:
                raise RuntimeError("Harbor container host mount is unavailable") from error
            if not (stat.S_ISREG(source_info.st_mode) or stat.S_ISDIR(source_info.st_mode)):
                raise RuntimeError("Harbor container host mount has an unsafe type")
            if not any(
                source_path == root or root in source_path.parents for root in allowed_roots
            ):
                raise RuntimeError("Harbor container has an unexpected host mount")
    return container_ids


async def isolate_container_network(
    environment: DockerEnvironment,
    container_ids: list[str],
    run_id: str,
) -> TrialNetworks:
    suffix = hashlib.sha256(environment.session_id.encode()).hexdigest()[:18]
    task_network = f"pico-tb-task-{suffix}"
    gateway_network = f"pico-tb-gw-{suffix}"
    networks = TrialNetworks(task=task_network, gateway=gateway_network)
    owned_networks: list[str] = []
    try:
        for network_name in networks:
            create_code, _, create_stderr = await run_docker(
                [
                    "network",
                    "create",
                    "--internal",
                    "--label",
                    f"pico.terminal-bench.run={run_id}",
                    network_name,
                ],
                environment,
                allowed_exit_codes={0, 1},
            )
            if create_code == 1 and "already exists" not in create_stderr.decode():
                raise RuntimeError("Could not create the isolated trial network")
            _, network_stdout, _ = await run_docker(
                ["network", "inspect", network_name],
                environment,
            )
            network_config = json.loads(network_stdout)[0]
            if not is_owned_trial_network(network_config, run_id):
                raise RuntimeError("Trial network identity or isolation is invalid")
            owned_networks.append(network_name)
        _, inspect_stdout, _ = await run_docker(["inspect", *container_ids], environment)
        values = json.loads(inspect_stdout)
        initial_networks = sorted(
            {
                network
                for value in values
                for network in (
                    value.get("NetworkSettings", {}).get("Networks") or {}
                )
            }
        )
        if not initial_networks:
            raise RuntimeError("Harbor container pre-start network isolation is missing")
        _, initial_network_stdout, _ = await run_docker(
            ["network", "inspect", *initial_networks],
            environment,
        )
        compose_project = _sanitize_docker_compose_project_name(environment.session_id)
        initial_network_values = json.loads(initial_network_stdout)
        if len(initial_network_values) != 1 or any(
            network.get("Internal") is not True
            or (network.get("Labels") or {}).get("pico.terminal-bench.run") != run_id
            or (network.get("Labels") or {}).get("com.docker.compose.project")
            != compose_project
            or set((network.get("Containers") or {}).keys()) != set(container_ids)
            for network in initial_network_values
        ):
            raise RuntimeError("Harbor container started with provider egress")
        main_values = [
            value
            for value in values
            if (value.get("Config", {}).get("Labels") or {}).get(
                "com.docker.compose.service"
            )
            == "main"
        ]
        if len(main_values) != 1:
            raise RuntimeError("Harbor Compose must contain exactly one main workload")
        main_id = main_values[0]["Id"]
        for value in values:
            container_id = value["Id"]
            service = (value.get("Config", {}).get("Labels") or {}).get(
                "com.docker.compose.service"
            )
            connect_args = ["network", "connect"]
            if service:
                connect_args.extend(["--alias", service])
            connect_args.extend([task_network, container_id])
            await run_docker(connect_args, environment, allowed_exit_codes={0, 1})
            if container_id == main_id:
                await run_docker(
                    [
                        "network",
                        "connect",
                        "--alias",
                        "main",
                        gateway_network,
                        container_id,
                    ],
                    environment,
                    allowed_exit_codes={0, 1},
                )
        for value in values:
            container_id = value["Id"]
            for existing_network in (
                value.get("NetworkSettings", {}).get("Networks") or {}
            ):
                if existing_network not in set(networks):
                    await run_docker(
                        ["network", "disconnect", existing_network, container_id],
                        environment,
                    )
        _, verify_stdout, _ = await run_docker(["inspect", *container_ids], environment)
        for value in json.loads(verify_stdout):
            connected_networks = set(
                (value.get("NetworkSettings", {}).get("Networks") or {})
            )
            expected = (
                {task_network, gateway_network}
                if value["Id"] == main_id
                else {task_network}
            )
            if connected_networks != expected:
                raise RuntimeError("Harbor container retained direct provider egress")
        return networks
    except BaseException:
        await remove_owned_trial_networks(
            environment,
            TrialNetworks(
                task=task_network if task_network in owned_networks else "",
                gateway=gateway_network if gateway_network in owned_networks else "",
            ),
            run_id,
        )
        raise


def is_owned_trial_network(network: dict[str, Any], run_id: str) -> bool:
    return (
        network.get("Internal") is True
        and (network.get("Labels") or {}).get("pico.terminal-bench.run") == run_id
    )


async def remove_owned_trial_networks(
    environment: DockerEnvironment,
    networks: TrialNetworks,
    run_id: str,
) -> None:
    failures: list[str] = []
    for network_name in reversed(networks):
        if not network_name:
            continue
        inspect_code, inspect_stdout, inspect_stderr = await run_docker(
            ["network", "inspect", network_name],
            environment,
            allowed_exit_codes={0, 1},
        )
        if inspect_code == 1:
            if not is_missing_docker_network_error(inspect_stderr):
                failures.append(network_name)
            continue
        network_values = json.loads(inspect_stdout)
        if len(network_values) != 1 or not is_owned_trial_network(
            network_values[0], run_id
        ):
            failures.append(network_name)
            continue
        for container_id in (network_values[0].get("Containers") or {}):
            await run_docker(
                ["network", "disconnect", "--force", network_name, container_id],
                environment,
                allowed_exit_codes={0, 1},
            )
        remove_code, _, remove_stderr = await run_docker(
            ["network", "rm", network_name],
            environment,
            allowed_exit_codes={0, 1},
        )
        if remove_code != 0 and not is_missing_docker_network_error(remove_stderr):
            failures.append(network_name)
    if failures:
        raise RuntimeError(
            "Could not remove owned trial networks: " + ", ".join(failures)
        )


def is_missing_docker_network_error(stderr: bytes) -> bool:
    message = stderr.decode(errors="replace").lower()
    return "no such network" in message or (
        "network " in message and " not found" in message
    )


async def cleanup_trial_resources(
    environment: DockerEnvironment,
    *,
    networks: TrialNetworks,
    run_id: str,
    context: AgentContext,
    gateway: ProviderGateway | None,
    public_egress: PublicEgressAccess | None,
    context_id: str | None,
    verifier_timeout_sec: float | None,
    verifier_receipt_path: Path,
) -> str | None:
    cleanup_errors: list[BaseException] = []
    if public_egress is not None:
        try:
            await public_egress.stop(environment)
        except BaseException as error:
            cleanup_errors.append(error)
    if gateway is not None:
        try:
            accounting_receipt = gateway.stop()
            apply_gateway_accounting(context, accounting_receipt)
        except BaseException as error:
            cleanup_errors.append(error)
        try:
            await assert_container_absent(environment, gateway.relay_name)
        except BaseException as error:
            cleanup_errors.append(error)

    if cleanup_errors:
        try:
            await restore_verifier_and_remove_trial_networks(
                environment,
                networks,
                run_id,
            )
        except BaseException as error:
            cleanup_errors.append(error)
        raise RuntimeError("Terminal-Bench trial cleanup failed") from cleanup_errors[0]

    if public_egress is None:
        await restore_verifier_and_remove_trial_networks(
            environment,
            networks,
            run_id,
        )
        return None
    if context_id is None or verifier_timeout_sec is None:
        await restore_verifier_and_remove_trial_networks(
            environment,
            networks,
            run_id,
        )
        raise RuntimeError("Terminal-Bench verifier egress identity is unavailable")

    verifier_egress = PublicEgressAccess(
        run_id=run_id,
        network_name=networks.gateway,
        context_id=f"{context_id}-verifier",
        ttl_sec=verifier_timeout_sec,
        receipt_path=verifier_receipt_path,
    )
    try:
        install_verifier_egress_lifecycle(
            environment,
            networks=networks,
            run_id=run_id,
            verifier_egress=verifier_egress,
        )
        return verifier_egress.scrub_secret
    except BaseException as startup_error:
        cleanup_errors = []
        try:
            await verifier_egress.stop(environment)
        except BaseException as error:
            cleanup_errors.append(error)
        try:
            await restore_verifier_and_remove_trial_networks(
                environment,
                networks,
                run_id,
            )
        except BaseException as error:
            cleanup_errors.append(error)
        if cleanup_errors:
            raise RuntimeError(
                "Terminal-Bench verifier egress startup cleanup failed"
            ) from startup_error
        raise


async def assert_container_absent(
    environment: DockerEnvironment,
    container_name: str,
) -> None:
    inspect_code, _, inspect_stderr = await run_docker(
        ["inspect", container_name],
        environment,
        allowed_exit_codes={0, 1},
    )
    if inspect_code == 0 or not is_missing_docker_container_error(inspect_stderr):
        raise RuntimeError("Provider gateway relay removal was not confirmed")


async def assert_verifier_egress_topology(
    environment: DockerEnvironment,
    *,
    networks: TrialNetworks,
    run_id: str,
    verifier_egress: PublicEgressAccess,
) -> None:
    _, network_stdout, _ = await run_docker(
        ["network", "inspect", networks.task, networks.gateway],
        environment,
    )
    network_values = json.loads(network_stdout)
    by_name = {
        value.get("Name"): value
        for value in network_values
        if isinstance(value, dict)
    }
    if (
        set(by_name) != set(networks)
        or any(not is_owned_trial_network(by_name[name], run_id) for name in networks)
    ):
        raise RuntimeError("Verifier trial network identity is invalid")

    _, relay_stdout, _ = await run_docker(
        ["inspect", verifier_egress.relay_name],
        environment,
    )
    relay_values = json.loads(relay_stdout)
    if (
        len(relay_values) != 1
        or not isinstance(relay_values[0].get("Id"), str)
        or not relay_values[0]["Id"]
    ):
        raise RuntimeError("Verifier public egress relay identity is invalid")
    relay_id = relay_values[0]["Id"]
    task_ids = set((by_name[networks.task].get("Containers") or {}).keys())
    gateway_ids = set((by_name[networks.gateway].get("Containers") or {}).keys())
    main_ids = task_ids & gateway_ids
    if (
        len(main_ids) != 1
        or relay_id in task_ids
        or gateway_ids != main_ids | {relay_id}
    ):
        raise RuntimeError("Verifier public egress network topology is invalid")

    workload_ids = sorted(task_ids)
    if not workload_ids:
        raise RuntimeError("Verifier workload network topology is empty")
    _, workload_stdout, _ = await run_docker(
        ["inspect", *workload_ids],
        environment,
    )
    workload_values = json.loads(workload_stdout)
    if len(workload_values) != len(workload_ids):
        raise RuntimeError("Verifier workload network inspection is invalid")
    main_id = next(iter(main_ids))
    for value in workload_values:
        container_id = value.get("Id")
        connected_networks = set(
            ((value.get("NetworkSettings") or {}).get("Networks") or {}).keys()
        )
        expected = (
            {networks.task, networks.gateway}
            if container_id == main_id
            else {networks.task}
        )
        if connected_networks != expected:
            raise RuntimeError("Verifier workload retained direct public egress")


def install_verifier_egress_lifecycle(
    environment: DockerEnvironment,
    *,
    networks: TrialNetworks,
    run_id: str,
    verifier_egress: PublicEgressAccess,
) -> None:
    assert_secure_docker_environment(environment)
    original_stop = environment.stop
    activation_lock = asyncio.Lock()
    activation_state = "pending"
    stop_task: asyncio.Task[None] | None = None
    stop_delete: bool | None = None

    async def activate() -> None:
        nonlocal activation_state
        async with activation_lock:
            if activation_state == "active":
                return
            if activation_state != "pending":
                raise RuntimeError("Terminal-Bench verifier egress cannot be activated")
            activation_state = "starting"
            try:
                await verifier_egress.start(environment)
                await assert_verifier_egress_topology(
                    environment,
                    networks=networks,
                    run_id=run_id,
                    verifier_egress=verifier_egress,
                )
                set_verifier_exec_env(environment, verifier_egress.container_env)
            except BaseException as startup_error:
                activation_state = "failed"
                cleanup_errors: list[BaseException] = []
                try:
                    clear_verifier_exec_env(environment)
                except BaseException as error:
                    cleanup_errors.append(error)
                try:
                    await asyncio.shield(verifier_egress.stop(environment))
                except BaseException as error:
                    cleanup_errors.append(error)
                if cleanup_errors:
                    raise RuntimeError(
                        "Terminal-Bench verifier egress activation cleanup failed"
                    ) from startup_error
                raise
            activation_state = "active"

    async def stop_once(*, delete: bool) -> None:
        nonlocal activation_state
        cleanup_errors: list[BaseException] = []
        try:
            clear_verifier_egress_activation(environment)
        except BaseException as error:
            cleanup_errors.append(error)
        try:
            async with activation_lock:
                activation_state = "stopping"
                try:
                    clear_verifier_exec_env(environment)
                except BaseException as error:
                    cleanup_errors.append(error)
                try:
                    await verifier_egress.stop(environment)
                except BaseException as error:
                    cleanup_errors.append(error)
        except BaseException as error:
            cleanup_errors.append(error)
        try:
            await restore_verifier_and_remove_trial_networks(
                environment,
                networks,
                run_id,
            )
        except BaseException as error:
            cleanup_errors.append(error)
        try:
            await original_stop(delete=delete)
        except BaseException as error:
            cleanup_errors.append(error)
        if cleanup_errors:
            raise RuntimeError(
                "Terminal-Bench verifier egress cleanup failed"
            ) from cleanup_errors[0]

    async def stop_with_verifier_egress(*, delete: bool) -> None:
        nonlocal stop_delete, stop_task
        if stop_task is None:
            stop_delete = delete
            stop_task = asyncio.create_task(stop_once(delete=delete))
        elif delete != stop_delete:
            raise RuntimeError("Harbor verifier cleanup delete policy changed")
        try:
            await asyncio.shield(stop_task)
        except asyncio.CancelledError as cancellation:
            try:
                await stop_task
            except BaseException as cleanup_error:
                raise cleanup_error from cancellation
            raise

    register_verifier_egress_activation(environment, activate)
    try:
        environment.stop = stop_with_verifier_egress
    except BaseException:
        clear_verifier_egress_activation(environment)
        raise


async def restore_verifier_and_remove_trial_networks(
    environment: DockerEnvironment,
    networks: TrialNetworks,
    run_id: str,
) -> None:
    await remove_owned_trial_networks(environment, networks, run_id)


def allowed_mount_destination(destination: str) -> bool:
    if destination == "/tmp/pico-tb21" or destination.startswith("/tmp/pico-tb21/"):
        return False
    return any(
        destination == root or destination.startswith(f"{root}/")
        for root in ["/workspace", "/logs", "/tests", "/solution", "/tmp"]
    )


async def run_docker(
    args: list[str],
    environment: DockerEnvironment,
    *,
    allowed_exit_codes: set[int] = {0},
) -> tuple[int, bytes, bytes]:
    process = await asyncio.create_subprocess_exec(
        "docker",
        *args,
        env=compose_subprocess_env(environment),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    if process.returncode not in allowed_exit_codes:
        raise RuntimeError(f"Docker command failed: {' '.join(args[:2])}")
    return process.returncode, stdout, stderr


def read_supervisor_config(descriptor: int) -> dict[str, str]:
    global _SUPERVISOR_CONFIG
    if _SUPERVISOR_CONFIG is not None:
        return _SUPERVISOR_CONFIG
    try:
        chunks: list[bytes] = []
        size = 0
        while True:
            chunk = os.read(descriptor, min(8 * 1024, 64 * 1024 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size >= 64 * 1024:
                raise ValueError("Gateway supervisor descriptor is too large")
        raw = b"".join(chunks)
    except OSError as error:
        raise ValueError("Gateway supervisor descriptor is unavailable") from error
    finally:
        try:
            os.close(descriptor)
        except OSError:
            pass
    if not raw or b"\n" in raw or len(raw) >= 64 * 1024:
        raise ValueError("Gateway supervisor descriptor must contain one frame")
    value = json.loads(raw)
    if (
        not isinstance(value, dict)
        or set(value) != {"socketPath", "capabilitySeed", "runId"}
        or not isinstance(value["socketPath"], str)
        or not isinstance(value["runId"], str)
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", value["runId"])
        or not re.fullmatch(r"[0-9a-f]{64}", value["capabilitySeed"])
    ):
        raise ValueError("Gateway supervisor descriptor is invalid")
    path = Path(value["socketPath"])
    if not path.is_socket():
        raise ValueError("Gateway supervisor socket is unavailable")
    _SUPERVISOR_CONFIG = {
        "socketPath": str(path),
        "capabilitySeed": value["capabilitySeed"],
        "runId": value["runId"],
    }
    return _SUPERVISOR_CONFIG


def require_file(value: str, field: str) -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise ValueError(f"{field} must be an existing file")
    return path


def require_hex(value: str, field: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{40}", value):
        raise ValueError(f"{field} must be a full lowercase git SHA")
    return value


def require_digest(value: str, field: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{64}", value):
        raise ValueError(f"{field} must be a lowercase SHA-256 digest")
    return value


def require_positive_int(value: Any, field: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise ValueError(f"{field} must be positive")
    return parsed


def require_bounded_int(value: Any, field: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{field} must be an integer from {minimum} to {maximum}")
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise ValueError(
            f"{field} must be an integer from {minimum} to {maximum}"
        ) from None
    if str(parsed) != str(value) or parsed < minimum or parsed > maximum:
        raise ValueError(f"{field} must be an integer from {minimum} to {maximum}")
    return parsed


def load_route_config(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("route config must be an object")
    allowed = {
        "schemaVersion",
        "modelRouteId",
        "providerId",
        "provider",
        "pricing",
        "pricingSha256",
        "runBudget",
        "thinkingEffort",
    }
    if set(value) - allowed or value.get("schemaVersion") != 1:
        raise ValueError("route config contains unsupported fields")
    provider = value.get("provider")
    if not isinstance(provider, dict) or "apiKey" in provider:
        raise ValueError("route config must contain a secret-free provider")
    required_provider = {"protocol", "baseURL", "models", "discoverModels"}
    if not required_provider.issubset(provider):
        raise ValueError("route config provider is incomplete")
    validate_benchmark_route_contract(value, provider)
    run_budget = value.get("runBudget")
    if (
        not isinstance(run_budget, dict)
        or set(run_budget) != {"currency", "maxCostMicroCNY"}
        or run_budget.get("currency") != "CNY"
    ):
        raise ValueError("route config run budget is invalid")
    require_bounded_int(
        run_budget.get("maxCostMicroCNY"),
        "runBudget.maxCostMicroCNY",
        0,
        _MAX_RUN_COST_MICRO_CNY,
    )
    return value


def validate_benchmark_route_contract(
    value: dict[str, Any], provider: dict[str, Any]
) -> None:
    model_route_id = value.get("modelRouteId")
    expected_output = _BENCHMARK_OUTPUT_TOKENS_BY_ROUTE.get(model_route_id)
    if expected_output is None:
        return
    provider_id, model = model_route_id.split("/", 1)
    capabilities = provider.get("modelCapabilities")
    models = provider.get("models")
    model_capability = (
        capabilities.get(model) if isinstance(capabilities, dict) else None
    )
    output = (
        model_capability.get("output")
        if isinstance(model_capability, dict)
        else None
    )
    if (
        value.get("providerId") != provider_id
        or provider.get("protocol") != "openai"
        or not isinstance(models, list)
        or model not in models
        or not isinstance(model_capability, dict)
        or isinstance(output, bool)
        or not isinstance(output, int)
        or output != expected_output
        or model_capability.get("outputTokenField") != "max_completion_tokens"
    ):
        raise ValueError(
            f"{model_route_id} benchmark route must pin output={expected_output} "
            "and use max_completion_tokens"
        )


def task_agent_timeout(environment: BaseEnvironment) -> float:
    task_path = environment.environment_dir.parent / "task.toml"
    with task_path.open("rb") as handle:
        config = tomllib.load(handle)
    timeout = config.get("agent", {}).get("timeout_sec")
    if (
        isinstance(timeout, bool)
        or not isinstance(timeout, (int, float))
        or not math.isfinite(timeout)
        or timeout <= 0
        or timeout > MAX_TASK_AGENT_TIMEOUT_SEC
    ):
        raise RuntimeError("Terminal-Bench task timeout is unsupported by Pico")
    return float(timeout)


def task_verifier_timeout(environment: BaseEnvironment) -> float:
    task_path = environment.environment_dir.parent / "task.toml"
    with task_path.open("rb") as handle:
        config = tomllib.load(handle)
    timeout = config.get("verifier", {}).get("timeout_sec")
    if (
        isinstance(timeout, bool)
        or not isinstance(timeout, (int, float))
        or not math.isfinite(timeout)
        or timeout <= 0
        or timeout > MAX_TASK_VERIFIER_TIMEOUT_SEC
    ):
        raise RuntimeError("Terminal-Bench verifier timeout is unsupported by Pico")
    return float(timeout)


def task_allows_internet(environment: BaseEnvironment) -> bool:
    task_path = environment.environment_dir.parent / "task.toml"
    with task_path.open("rb") as handle:
        config = tomllib.load(handle)
    task_environment = config.get("environment")
    if not isinstance(task_environment, dict):
        raise RuntimeError("Terminal-Bench task environment policy is missing")
    allow_internet = task_environment.get("allow_internet")
    if type(allow_internet) is not bool:
        raise RuntimeError(
            "Terminal-Bench environment.allow_internet must be a boolean"
        )
    return allow_internet


def remaining_budget(deadline: float, now: float) -> float:
    remaining = deadline - now
    if remaining <= 0:
        raise RuntimeError("outer_timeout_budget_violation")
    return remaining


def bounded_attempt_identity(base: str, attempt: int) -> str:
    if attempt < 1:
        raise ValueError("attempt must be positive")
    suffix = "" if attempt == 1 else f".retry-{attempt - 1}"
    candidate = f"{base}{suffix}"
    if len(candidate) <= 128:
        return candidate
    digest = hashlib.sha256(base.encode()).hexdigest()[:16]
    prefix_limit = 128 - len(suffix) - len(digest) - 1
    return f"{base[:prefix_limit]}.{digest}{suffix}"


def benchmark_instruction(instruction: str, workspace: str) -> str:
    manifest_path = verifier_service_manifest_path(workspace)
    return (
        f"{instruction}\n\n"
        "[Terminal-Bench adapter note]\n"
        "When the task leaves locations and mechanisms open, keep temporary, "
        f"build, and install artifacts inside {workspace}/.pico-tmp or "
        f"{workspace}/.local, prefer write_file or edit_file over shell "
        "redirection, invoke executables with literal argv, and do not source/eval "
        "commands. Never replace a destination explicitly required by the task; "
        "follow that requirement only through operations allowed by the tool policy. "
        "Run pytest test files with pytest itself before finishing; do not execute "
        "them as plain Python scripts. If the verifier needs a persistent service "
        f"on port 8080, write {manifest_path} as strict JSON with exactly "
        'schemaVersion=1, argv, cwd, and port=8080. Prefer the guaranteed '
        "read-only Node runtime /installed-agent/pico-node/bin/node with a direct "
        ".cjs script inside cwd. System runtimes may be absent; only after "
        "confirming the executable exists may argv[0] instead be /usr/bin/python3, "
        "/usr/local/bin/python3, or /usr/bin/node. argv[1] must be the absolute "
        "non-symlink .py or .cjs script path matching the executable. Do not rely "
        "on shell background jobs. The adapter, not your process, launches the "
        "persistent service from this manifest after your run. You may temporarily "
        "start it for testing, but before finishing you must stop that exact process "
        "and confirm port 8080 is closed. Never stop or take over a listener you did "
        "not start."
    )


def is_zero_usage_terminal_failure(result: dict[str, Any]) -> bool:
    error = result.get("error")
    usage = result.get("usage")
    return (
        isinstance(error, dict)
        and (result.get("status"), error.get("code"))
        in {("failed", "RUNTIME_FAILED"), ("timed_out", "TIMEOUT")}
        and result.get("terminationConfirmed") is True
        and isinstance(usage, dict)
        and usage.get("promptTokens") == 0
        and usage.get("completionTokens") == 0
        and usage.get("costCNY") == 0
    )


def should_retry_runtime_failure(
    result: dict[str, Any],
    *,
    retries_used: int,
    retry_limit: int,
    remaining_sec: float,
    shutdown_grace_ms: int,
    result_flush_margin_ms: int,
) -> bool:
    error = result.get("error")
    required_remaining_ms = (
        shutdown_grace_ms
        + result_flush_margin_ms
        + _MIN_RUNTIME_RETRY_EXECUTION_MS
    )
    return (
        retries_used < retry_limit
        and result.get("status") == "failed"
        and isinstance(error, dict)
        and error.get("code") == "RUNTIME_FAILED"
        and result.get("terminationConfirmed") is True
        and "policyDenials" not in result
        and math.isfinite(remaining_sec)
        and remaining_sec * 1_000 >= required_remaining_ms
    )


def safe_trial_key(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]", "-", value).strip(".-")
    return normalized[:64] or "trial"


def write_private_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    data = (json.dumps(value, separators=(",", ":")) + "\n").encode()
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def write_private_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", closefd=True) as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def write_private_json_once(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    data = (json.dumps(value, separators=(",", ":")) + "\n").encode()
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        descriptor = os.open(
            temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
        )
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            if path.read_bytes() != data:
                raise ValueError("Gateway accounting receipt already changed")
            return
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def register_compose_project(path: Path, run_id: str, compose_project: str) -> None:
    record = json.dumps(
        {
            "schemaVersion": 1,
            "runId": run_id,
            "composeProject": compose_project,
        },
        separators=(",", ":"),
    )
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        with os.fdopen(descriptor, "a", encoding="utf-8", closefd=True) as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            handle.write(f"{record}\n")
            handle.flush()
            os.fsync(handle.fileno())
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        try:
            os.close(descriptor)
        except OSError:
            pass


def parse_single_json_line(raw: str) -> dict[str, Any]:
    lines = [line for line in raw.splitlines() if line.strip()]
    if len(lines) != 1:
        raise RuntimeError("Pico headless output must contain exactly one JSON line")
    value = json.loads(lines[0])
    if not isinstance(value, dict):
        raise RuntimeError("Pico headless output must be an object")
    return value


def parse_exit_code(raw: str | None) -> int:
    try:
        return int((raw or "").strip())
    except ValueError as error:
        raise RuntimeError("Pico exit code is missing") from error


def validate_headless_result(
    result: dict[str, Any], exit_code: int, request_id: str
) -> None:
    if result.get("schemaVersion") != 1 or result.get("requestId") != request_id:
        raise RuntimeError("Pico headless result identity is invalid")
    expected = {
        "completed": {0},
        "invalid_request": {2},
        "failed": {3},
        "policy_blocked": {4},
        "timed_out": {124},
        "canceled": {130, 143},
    }
    status = result.get("status")
    if status not in expected or exit_code not in expected[status]:
        raise RuntimeError("Pico headless status and exit code disagree")
    if not isinstance(result.get("usage"), dict):
        raise RuntimeError("Pico headless usage is missing")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

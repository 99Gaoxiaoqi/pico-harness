from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shlex
import tomllib
import uuid
from pathlib import Path, PurePosixPath
from typing import Any, override

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.environments.docker.docker import (
    DockerEnvironment,
    _sanitize_docker_compose_project_name,
)
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths


class PicoInstalledAgent(BaseInstalledAgent):
    """Harbor 0.20 adapter for Pico's internal Headless One-shot entry."""

    SUPPORTS_ATIF = False
    _REMOTE_ROOT = PurePosixPath("/installed-agent/pico")
    _BOOTSTRAP_RESULT = PurePosixPath(EnvironmentPaths.agent_dir / "bootstrap-result.json")
    _PICO_RESULT = PurePosixPath(EnvironmentPaths.agent_dir / "pico-result.json")
    _EXIT_CODE = PurePosixPath(EnvironmentPaths.agent_dir / "pico-exit-code.txt")
    _TRACE_EXPORT = PurePosixPath(EnvironmentPaths.agent_dir / "trace.json")
    _SECRET_ENV = "PICO_TB_PROVIDER_API_KEY"
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
        route_config_path: str,
        pico_commit: str,
        shutdown_grace_ms: int = 30_000,
        result_flush_margin_ms: int = 5_000,
        *args: Any,
        **kwargs: Any,
    ):
        super().__init__(*args, version=pico_commit[:12], **kwargs)
        if self._extra_env:
            raise ValueError("AgentConfig.env/--agent-env is forbidden for Pico benchmarks")
        self._bundle_path = require_file(bundle_path, "bundle_path")
        self._route_config_path = require_file(route_config_path, "route_config_path")
        self._pico_commit = require_hex(pico_commit, "pico_commit")
        self._shutdown_grace_ms = require_positive_int(
            shutdown_grace_ms, "shutdown_grace_ms"
        )
        self._result_flush_margin_ms = require_positive_int(
            result_flush_margin_ms, "result_flush_margin_ms"
        )
        self._route_config = load_route_config(self._route_config_path, self._SECRET_ENV)
        self._context_id = uuid.uuid4().hex
        self._provider_secret = os.environ.get(self._SECRET_ENV)
        if not self._provider_secret or "\n" in self._provider_secret:
            raise ValueError(f"{self._SECRET_ENV} must contain one non-empty line")
        if self.model_name != self._route_config["modelRouteId"]:
            raise ValueError("Harbor --model must exactly match route_config.modelRouteId")

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        assert_secure_docker_environment(environment)
        await self._install_node(environment)
        remote_bundle = "/installed-agent/pico-bundle.tar.gz"
        await environment.upload_file(self._bundle_path, remote_bundle)
        expected = sha256_file(self._bundle_path)
        await self.exec_as_root(
            environment,
            command=(
                "set -eu; "
                f"printf '%s  %s\\n' {shlex.quote(expected)} {shlex.quote(remote_bundle)} "
                "| sha256sum -c -; "
                f"mkdir -p {self._REMOTE_ROOT.as_posix()}; "
                f"tar -xzf {shlex.quote(remote_bundle)} -C {self._REMOTE_ROOT.as_posix()}; "
                f"chown -R {shlex.quote(str(environment.default_user or 'root'))} "
                f"{self._REMOTE_ROOT.as_posix()}"
            ),
        )

    async def _install_node(self, environment: BaseEnvironment) -> None:
        script = f"""
set -eu
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node')" = "{self._NODE_VERSION}" ]; then
  exit 0
fi
if ! command -v curl >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates
fi
case "$(uname -m)" in
  x86_64|amd64) arch=x64; expected={self._NODE_SHA256["x64"]} ;;
  aarch64|arm64) arch=arm64; expected={self._NODE_SHA256["arm64"]} ;;
  *) echo "unsupported architecture" >&2; exit 2 ;;
esac
archive="node-v{self._NODE_VERSION}-linux-${{arch}}.tar.gz"
curl -fsSLo "/tmp/${{archive}}" "https://nodejs.org/dist/v{self._NODE_VERSION}/${{archive}}"
printf '%s  %s\\n' "$expected" "/tmp/${{archive}}" | sha256sum -c -
tar -tzf "/tmp/${{archive}}" | awk '/^\\// || /(^|\\/)\\.\\.($|\\/)/ {{ exit 2 }}'
tar -xzf "/tmp/${{archive}}" -C /usr/local --strip-components=1
[ "$(node -p 'process.versions.node')" = "{self._NODE_VERSION}" ]
rm -f "/tmp/${{archive}}"
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
        await assert_running_container_policy(environment, self.logs_dir)
        workspace_result = await environment.exec(command="pwd -P")
        if workspace_result.return_code != 0 or not workspace_result.stdout:
            raise RuntimeError("Could not resolve the Harbor task workspace")
        workspace = workspace_result.stdout.strip()
        context_id = safe_trial_key(self._context_id)
        trial_key = safe_trial_key(f"{self.session_id or 'session'}-{context_id}")
        pico_home = f"/tmp/pico-tb21/{trial_key}/pico-home"
        outer_timeout_sec = task_agent_timeout(environment)
        inner_timeout_ms = int(
            outer_timeout_sec * 1000
            - self._shutdown_grace_ms
            - self._result_flush_margin_ms
        )
        if inner_timeout_ms < 1_000:
            raise RuntimeError("outer_timeout_budget_violation")
        request_id = f"tb21.{context_id}.{trial_key}"
        session_id = f"tb21-{context_id[:24]}-{trial_key[:24]}"
        route_config = self._route_config
        bootstrap_request = {
            "schemaVersion": 1,
            "workspacePath": workspace,
            "picoHome": pico_home,
            "route": {
                "id": route_config["modelRouteId"],
                "protocol": route_config["provider"]["protocol"],
                "baseURL": route_config["provider"]["baseURL"],
                "apiKeyEnv": self._SECRET_ENV,
            },
        }
        headless_request = {
            "schemaVersion": 1,
            "requestId": request_id,
            "workspacePath": workspace,
            "picoHome": pico_home,
            "sessionId": session_id,
            "prompt": instruction,
            "modelRouteId": route_config["modelRouteId"],
            **(
                {"thinkingEffort": route_config["thinkingEffort"]}
                if route_config.get("thinkingEffort")
                else {}
            ),
            "permissionMode": "yolo",
            "allowedTools": [
                "bash",
                "read_file",
                "write_file",
                "edit_file",
                "glob",
                "grep",
                "read_evidence",
            ],
            "timeoutMs": inner_timeout_ms,
            "shutdownGraceMs": self._shutdown_grace_ms,
            "trace": True,
        }
        write_private_json(self.logs_dir / "bootstrap-request.json", bootstrap_request)
        write_private_json(self.logs_dir / "headless-request.json", headless_request)

        bootstrap = await environment.exec(
            command=(
                "set -eu; umask 077; "
                f"mkdir -m 700 -p {shlex.quote(pico_home)}; "
                f"tmp={self._BOOTSTRAP_RESULT.as_posix()}.tmp.$$; "
                f"node {self._REMOTE_ROOT.as_posix()}/dist/internal/"
                "headless-bootstrap-main.js "
                f"< {EnvironmentPaths.agent_dir.as_posix()}/bootstrap-request.json "
                "> \"$tmp\"; status=$?; "
                f"chmod 600 \"$tmp\"; mv -f \"$tmp\" {self._BOOTSTRAP_RESULT.as_posix()}; "
                "exit \"$status\""
            ),
            timeout_sec=60,
        )
        if bootstrap.return_code != 0:
            raise RuntimeError("Pico isolated bootstrap failed")

        execution = await docker_exec_secret_stdin(
            environment,
            self._provider_secret.encode("utf-8"),
            timeout_sec=outer_timeout_sec,
            secret_env_names={self._SECRET_ENV},
        )
        if execution.returncode != 0:
            raise RuntimeError("Pico headless launcher did not return a terminal result")
        raw_result = await environment.exec(command=f"cat {self._PICO_RESULT.as_posix()}")
        raw_exit = await environment.exec(command=f"cat {self._EXIT_CODE.as_posix()}")
        if raw_result.return_code != 0 or not raw_result.stdout:
            raise RuntimeError("Pico headless result is missing")
        result = parse_single_json_line(raw_result.stdout)
        exit_code = parse_exit_code(raw_exit.stdout)
        validate_headless_result(result, exit_code, request_id)
        trace_path = result.get("tracePath")
        if isinstance(trace_path, str) and trace_path:
            copied = await environment.exec(
                command=(
                    f"test -f {shlex.quote(trace_path)} && "
                    f"cp -- {shlex.quote(trace_path)} {self._TRACE_EXPORT.as_posix()}"
                )
            )
            if copied.return_code != 0:
                raise RuntimeError("Pico trace export failed")
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
                "innerTimeoutMs": inner_timeout_ms,
                "outerTimeoutSec": outer_timeout_sec,
                "localCanaryOnly": True,
                "leaderboardComparable": False,
            }
        }
        if result["terminationConfirmed"] is not True:
            raise RuntimeError("Pico could not confirm runtime termination")


async def docker_exec_secret_stdin(
    environment: DockerEnvironment,
    secret: bytes,
    *,
    timeout_sec: float,
    secret_env_names: set[str],
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
            "main",
            "node",
            f"{PicoInstalledAgent._REMOTE_ROOT.as_posix()}/container-launcher.mjs",
        ]
    )
    child_env = environment._compose_env_vars(include_os_env=True)
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
    except TimeoutError:
        process.terminate()
        await process.wait()
        raise RuntimeError("outer_timeout_budget_violation") from None
    if secret in stdout or secret in stderr:
        raise RuntimeError("Secret launcher leaked its input")
    return process


def assert_secure_docker_environment(environment: BaseEnvironment) -> None:
    if type(environment) is not DockerEnvironment:
        raise RuntimeError("Pico benchmark requires the exact Harbor Docker backend")
    if environment._keep_containers:
        raise RuntimeError("Pico benchmark forbids keep_containers")
    if environment.extra_docker_compose_paths:
        raise RuntimeError("Pico benchmark forbids extra Docker compose overlays")


async def assert_running_container_policy(
    environment: DockerEnvironment, logs_dir: Path
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
    command.extend(["ps", "-q", "main"])
    probe = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=environment._compose_env_vars(include_os_env=True),
    )
    stdout, _ = await probe.communicate()
    container_id = stdout.decode().strip()
    if probe.returncode != 0 or not re.fullmatch(r"[0-9a-f]{12,64}", container_id):
        raise RuntimeError("Could not identify the isolated Harbor container")
    inspect = await asyncio.create_subprocess_exec(
        "docker",
        "inspect",
        container_id,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    raw, _ = await inspect.communicate()
    if inspect.returncode != 0:
        raise RuntimeError("Could not inspect the isolated Harbor container")
    value = json.loads(raw)[0]
    host = value.get("HostConfig") or {}
    if (
        host.get("Privileged")
        or host.get("NetworkMode") == "host"
        or host.get("CapAdd")
        or any("docker.sock" in item for item in host.get("Binds") or [])
    ):
        raise RuntimeError("Harbor container violates the Pico yolo isolation policy")
    allowed_roots = {
        environment.environment_dir.resolve(),
        logs_dir.resolve().parent,
    }
    for mount in value.get("Mounts") or []:
        source = mount.get("Source")
        if not source:
            continue
        source_path = Path(source).resolve()
        if not any(source_path == root or root in source_path.parents for root in allowed_roots):
            raise RuntimeError("Harbor container has an unexpected host mount")


def require_file(value: str, field: str) -> Path:
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise ValueError(f"{field} must be an existing file")
    return path


def require_hex(value: str, field: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{40}", value):
        raise ValueError(f"{field} must be a full lowercase git SHA")
    return value


def require_positive_int(value: Any, field: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise ValueError(f"{field} must be positive")
    return parsed


def load_route_config(path: Path, secret_env: str) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("route config must be an object")
    allowed = {"schemaVersion", "modelRouteId", "providerId", "provider", "thinkingEffort"}
    if set(value) - allowed or value.get("schemaVersion") != 1:
        raise ValueError("route config contains unsupported fields")
    provider = value.get("provider")
    if not isinstance(provider, dict) or "apiKey" in provider:
        raise ValueError("route config must contain a secret-free provider")
    required_provider = {"protocol", "baseURL", "apiKeyEnv", "models", "discoverModels"}
    if not required_provider.issubset(provider) or provider.get("apiKeyEnv") != secret_env:
        raise ValueError("route config provider must use the fixed benchmark credential env")
    return value


def task_agent_timeout(environment: BaseEnvironment) -> float:
    task_path = environment.environment_dir.parent / "task.toml"
    with task_path.open("rb") as handle:
        config = tomllib.load(handle)
    timeout = config.get("agent", {}).get("timeout_sec")
    if not isinstance(timeout, (int, float)) or timeout <= 0 or timeout > 7200:
        raise RuntimeError("Terminal-Bench task timeout is unsupported by Pico")
    return float(timeout)


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

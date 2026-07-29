from __future__ import annotations

import asyncio
import hashlib
import hmac
import http.client
import json
import os
import re
import shlex
import threading
import time
import tomllib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from typing import Any, override
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

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
    _REMOTE_NODE = PurePosixPath("/installed-agent/pico-node")
    _BOOTSTRAP_RESULT = PurePosixPath(EnvironmentPaths.agent_dir / "bootstrap-result.json")
    _PICO_RESULT = PurePosixPath(EnvironmentPaths.agent_dir / "pico-result.json")
    _EXIT_CODE = PurePosixPath(EnvironmentPaths.agent_dir / "pico-exit-code.txt")
    _TRACE_EXPORT = PurePosixPath(EnvironmentPaths.agent_dir / "trace.json")
    _HOST_SECRET_ENV = "PICO_TB_PROVIDER_API_KEY"
    _SECRET_ENV = "PICO_TB_GATEWAY_TOKEN"
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
        node_x64_path: str,
        node_arm64_path: str,
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
        self._bundle_sha256 = require_digest(bundle_sha256, "bundle_sha256")
        self._bundle_lockfile_sha256 = require_digest(
            bundle_lockfile_sha256, "bundle_lockfile_sha256"
        )
        if sha256_file(self._bundle_path) != self._bundle_sha256:
            raise ValueError("bundle_path does not match bundle_sha256")
        self._route_config_path = require_file(route_config_path, "route_config_path")
        self._node_archives = {
            "x64": require_file(node_x64_path, "node_x64_path"),
            "arm64": require_file(node_arm64_path, "node_arm64_path"),
        }
        self._pico_commit = require_hex(pico_commit, "pico_commit")
        self._shutdown_grace_ms = require_positive_int(
            shutdown_grace_ms, "shutdown_grace_ms"
        )
        self._result_flush_margin_ms = require_positive_int(
            result_flush_margin_ms, "result_flush_margin_ms"
        )
        self._route_config = load_route_config(self._route_config_path)
        self._provider_secret = os.environ.get(self._HOST_SECRET_ENV)
        if not self._provider_secret or "\n" in self._provider_secret:
            raise ValueError(f"{self._HOST_SECRET_ENV} must contain one non-empty line")
        if self.model_name != self._route_config["modelRouteId"]:
            raise ValueError("Harbor --model must exactly match route_config.modelRouteId")

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        assert_secure_docker_environment(environment)
        await assert_running_container_policy(environment, self.logs_dir)
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
                f"rm -rf {self._REMOTE_ROOT.as_posix()}; "
                f"mkdir -p {self._REMOTE_ROOT.as_posix()}; "
                f"tar -xzf {shlex.quote(remote_bundle)} -C {self._REMOTE_ROOT.as_posix()}; "
                f"printf '%s  %s\\n' {shlex.quote(self._bundle_lockfile_sha256)} "
                f"{self._REMOTE_ROOT.as_posix()}/package-lock.json | sha256sum -c -; "
                f"chmod -R a-w {self._REMOTE_ROOT.as_posix()}"
            ),
        )

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
        loop = asyncio.get_running_loop()
        started_at = loop.time()
        assert_secure_docker_environment(environment)
        outer_timeout_sec = task_agent_timeout(environment)
        outer_deadline = started_at + outer_timeout_sec
        await assert_running_container_policy(environment, self.logs_dir)
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
        gateway = ProviderGateway(
            provider=route_config["provider"],
            model=route_config["modelRouteId"].split("/", 1)[1],
            provider_secret=self._provider_secret,
            context_id=context_id,
            ttl_sec=outer_timeout_sec,
        )
        gateway.start()
        bootstrap_request = {
            "schemaVersion": 1,
            "workspacePath": workspace,
            "picoHome": pico_home,
            "route": {
                "id": route_config["modelRouteId"],
                "protocol": route_config["provider"]["protocol"],
                "baseURL": gateway.base_url,
                "apiKeyEnv": self._SECRET_ENV,
            },
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
            gateway.stop()
            raise RuntimeError("Pico isolated bootstrap failed")

        remaining_sec = remaining_budget(outer_deadline, loop.time())
        inner_timeout_ms = int(
            remaining_sec * 1000
            - self._shutdown_grace_ms
            - self._result_flush_margin_ms
        )
        if inner_timeout_ms < 1_000:
            raise RuntimeError("outer_timeout_budget_violation")
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
        write_private_json(self.logs_dir / "headless-request.json", headless_request)
        try:
            execution = await docker_exec_secret_stdin(
                environment,
                gateway.capability.encode("utf-8"),
                timeout_sec=remaining_budget(outer_deadline, loop.time()),
                secret_env_names={self._HOST_SECRET_ENV, self._SECRET_ENV},
            )
        finally:
            gateway.stop()
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


class ProviderGateway:
    def __init__(
        self,
        *,
        provider: dict[str, Any],
        model: str,
        provider_secret: str,
        context_id: str,
        ttl_sec: float,
    ):
        self._provider = provider
        self._model = model
        self._provider_secret = provider_secret
        self._expires_at = time.monotonic() + ttl_sec
        self._requests_remaining = 128
        self._request_lock = threading.Lock()
        self._request_slot = threading.BoundedSemaphore(1)
        self.capability = hmac.new(
            provider_secret.encode(),
            f"pico-terminal-bench:{context_id}".encode(),
            hashlib.sha256,
        ).hexdigest()
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self.base_url = ""

    def start(self) -> None:
        gateway = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_POST(self) -> None:
                gateway._proxy(self)

            def log_message(self, _format: str, *args: Any) -> None:
                del args

        self._server = ThreadingHTTPServer(("0.0.0.0", 0), Handler)
        self._server.daemon_threads = True
        port = self._server.server_address[1]
        self.base_url = f"http://host.docker.internal:{port}"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)

    def _proxy(self, handler: BaseHTTPRequestHandler) -> None:
        if not self._request_slot.acquire(blocking=False):
            handler.send_error(429, "Pico benchmark gateway concurrency limit")
            return
        try:
            with self._request_lock:
                if time.monotonic() >= self._expires_at or self._requests_remaining <= 0:
                    raise ValueError("gateway capability expired")
                self._requests_remaining -= 1
            length = int(handler.headers.get("content-length", "0"))
            if length < 1 or length > 8 * 1024 * 1024:
                raise ValueError("request body is outside the gateway limit")
            body = self._bound_request(handler.rfile.read(length), handler.path)
            upstream = urlsplit(self._provider["baseURL"])
            path = self._upstream_path(upstream.path, handler.path)
            headers = self._upstream_headers(handler)
            connection_class = (
                http.client.HTTPSConnection
                if upstream.scheme == "https"
                else http.client.HTTPConnection
            )
            connection = connection_class(upstream.hostname, upstream.port, timeout=120)
            try:
                connection.request("POST", path, body=body, headers=headers)
                response = connection.getresponse()
                handler.send_response(response.status)
                for name, value in response.getheaders():
                    if name.lower() in {
                        "content-type",
                        "retry-after",
                        "x-ratelimit-limit-requests",
                        "x-ratelimit-remaining-requests",
                        "x-ratelimit-reset-requests",
                    }:
                        handler.send_header(name, value)
                handler.send_header("Connection", "close")
                handler.end_headers()
                while chunk := response.read(64 * 1024):
                    handler.wfile.write(chunk)
                    handler.wfile.flush()
            finally:
                connection.close()
                handler.close_connection = True
        except Exception:
            handler.send_error(502, "Pico benchmark credential gateway rejected the request")
        finally:
            self._request_slot.release()

    def _bound_request(self, body: bytes, path: str) -> bytes:
        protocol = self._provider["protocol"]
        if protocol == "gemini":
            if f"/models/{self._model}:" not in urlsplit(path).path:
                raise ValueError("gateway model mismatch")
            value = json.loads(body)
            if not isinstance(value, dict):
                raise ValueError("gateway request must be an object")
            generation = value.setdefault("generationConfig", {})
            if not isinstance(generation, dict):
                raise ValueError("gateway generation config must be an object")
            requested = generation.get("maxOutputTokens", 8_192)
            generation["maxOutputTokens"] = min(int(requested), 8_192)
            return json.dumps(value, separators=(",", ":")).encode()
        value = json.loads(body)
        if not isinstance(value, dict) or value.get("model") != self._model:
            raise ValueError("gateway model mismatch")
        requested = value.get("max_tokens", value.get("max_completion_tokens", 8_192))
        limit = min(int(requested), 8_192)
        if protocol == "openai":
            field = "max_completion_tokens" if "max_completion_tokens" in value else "max_tokens"
            value[field] = limit
        else:
            value["max_tokens"] = limit
        return json.dumps(value, separators=(",", ":")).encode()

    def _upstream_headers(self, handler: BaseHTTPRequestHandler) -> dict[str, str]:
        protocol = self._provider["protocol"]
        if protocol == "openai":
            if handler.headers.get("authorization") != f"Bearer {self.capability}":
                raise ValueError("invalid gateway capability")
        elif protocol == "claude":
            if handler.headers.get("x-api-key") != self.capability:
                raise ValueError("invalid gateway capability")
        elif protocol == "gemini":
            query = dict(parse_qsl(urlsplit(handler.path).query, keep_blank_values=True))
            if query.get("key") != self.capability:
                raise ValueError("invalid gateway capability")
        else:
            raise ValueError("unsupported gateway protocol")
        headers = {
            "Content-Type": handler.headers.get("content-type", "application/json"),
            "Accept": handler.headers.get("accept", "*/*"),
        }
        if version := handler.headers.get("anthropic-version"):
            headers["anthropic-version"] = version
        if protocol == "openai":
            headers["Authorization"] = f"Bearer {self._provider_secret}"
        elif protocol == "claude":
            headers["x-api-key"] = self._provider_secret
        return headers

    def _upstream_path(self, base_path: str, incoming: str) -> str:
        split = urlsplit(incoming)
        query = parse_qsl(split.query, keep_blank_values=True)
        if self._provider["protocol"] == "gemini":
            query = [
                (name, self._provider_secret if name == "key" else value)
                for name, value in query
            ]
        path = f"{base_path.rstrip('/')}/{split.path.lstrip('/')}"
        return urlunsplit(("", "", path, urlencode(query), ""))


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
    except TimeoutError:
        await terminate_container_launcher(environment, child_env)
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except TimeoutError:
            process.kill()
            await process.wait()
        raise RuntimeError("outer_timeout_budget_violation") from None
    if secret in stdout or secret in stderr:
        raise RuntimeError("Secret launcher leaked its input")
    return process


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
    command.extend(["ps", "-q"])
    probe = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=compose_subprocess_env(environment),
    )
    stdout, _ = await probe.communicate()
    container_ids = stdout.decode().split()
    if probe.returncode != 0 or not container_ids or any(
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
        host = value.get("HostConfig") or {}
        if (
            host.get("Privileged")
            or host.get("NetworkMode") == "host"
            or host.get("CapAdd")
            or any("docker.sock" in item for item in host.get("Binds") or [])
        ):
            raise RuntimeError("Harbor container violates the Pico yolo isolation policy")
        for mount in value.get("Mounts") or []:
            source = mount.get("Source")
            if not source:
                continue
            source_path = Path(source).resolve()
            if not any(
                source_path == root or root in source_path.parents for root in allowed_roots
            ):
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


def require_digest(value: str, field: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{64}", value):
        raise ValueError(f"{field} must be a lowercase SHA-256 digest")
    return value


def require_positive_int(value: Any, field: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise ValueError(f"{field} must be positive")
    return parsed


def load_route_config(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("route config must be an object")
    allowed = {"schemaVersion", "modelRouteId", "providerId", "provider", "thinkingEffort"}
    if set(value) - allowed or value.get("schemaVersion") != 1:
        raise ValueError("route config contains unsupported fields")
    provider = value.get("provider")
    if not isinstance(provider, dict) or "apiKey" in provider:
        raise ValueError("route config must contain a secret-free provider")
    required_provider = {"protocol", "baseURL", "models", "discoverModels"}
    if not required_provider.issubset(provider):
        raise ValueError("route config provider is incomplete")
    return value


def task_agent_timeout(environment: BaseEnvironment) -> float:
    task_path = environment.environment_dir.parent / "task.toml"
    with task_path.open("rb") as handle:
        config = tomllib.load(handle)
    timeout = config.get("agent", {}).get("timeout_sec")
    if not isinstance(timeout, (int, float)) or timeout <= 0 or timeout > 7200:
        raise RuntimeError("Terminal-Bench task timeout is unsupported by Pico")
    return float(timeout)


def remaining_budget(deadline: float, now: float) -> float:
    remaining = deadline - now
    if remaining <= 0:
        raise RuntimeError("outer_timeout_budget_violation")
    return remaining


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

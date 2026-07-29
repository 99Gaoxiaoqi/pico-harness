from __future__ import annotations

import asyncio
import base64
import fcntl
import hashlib
import hmac
import http.client
import json
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
from typing import Any, override

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.environments.docker.docker import (
    DockerEnvironment,
    _sanitize_docker_compose_project_name,
)
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

_SUPERVISOR_CONFIG: dict[str, str] | None = None
_RELAY_IMAGE_ID = "sha256:5647be709086c696ff32edaaf1c70cd26d1da6ab2b39c32f3c7b4c4a31957e37"


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
        self._shutdown_grace_ms = require_positive_int(
            shutdown_grace_ms, "shutdown_grace_ms"
        )
        self._result_flush_margin_ms = require_positive_int(
            result_flush_margin_ms, "result_flush_margin_ms"
        )
        self._trial_network = ""
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
        self._trial_network = await isolate_container_network(
            environment,
            container_ids,
            self._supervisor_config["runId"],
        )
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
        gateway = ProviderGateway(
            protocol=route_config["provider"]["protocol"],
            supervisor_socket=self._supervisor_config["socketPath"],
            capability_seed=self._supervisor_config["capabilitySeed"],
            run_id=self._supervisor_config["runId"],
            network_name=self._trial_network,
            context_id=context_id,
            ttl_sec=outer_timeout_sec,
        )
        gateway.start()
        try:
            await gateway.start_relay(environment)
            await gateway.enroll(environment)
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
            )
        finally:
            try:
                gateway.stop()
            finally:
                await enable_verifier_network(environment)

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
    ) -> None:
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
            "providerRequestMode": "single_non_stream",
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
        await docker_exec_secret_stdin(
            environment,
            gateway.capability.encode("utf-8"),
            timeout_sec=remaining_budget(outer_deadline, loop.time()),
            secret_env_names={self._SECRET_ENV},
        )
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
        result_error = result.get("error")
        if (
            isinstance(result_error, dict)
            and result_error.get("code") == "RUNTIME_EMPTY_RESPONSE"
        ):
            raise RuntimeError("Pico provider returned an empty model response")


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
    ):
        self._protocol = protocol
        self._supervisor_socket = supervisor_socket
        self._run_id = run_id
        self._network_name = network_name
        self._context_id = context_id
        self._ttl_sec = ttl_sec
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

    def stop(self) -> None:
        with self._request_lock:
            self._revoked = True
        try:
            self._signed_supervisor_request(
                {
                    "action": "revoke",
                    "trialId": self._context_id,
                }
            )
        except Exception:
            pass
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
            "expiresAt": now + min(int(self._ttl_sec), 7_200),
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
) -> str:
    suffix = hashlib.sha256(environment.session_id.encode()).hexdigest()[:18]
    task_network = f"pico-tb-task-{suffix}"
    gateway_network = f"pico-tb-gw-{suffix}"
    for network_name in [task_network, gateway_network]:
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
        if (
            network_config.get("Internal") is not True
            or (network_config.get("Labels") or {}).get("pico.terminal-bench.run")
            != run_id
        ):
            raise RuntimeError("Trial network identity or isolation is invalid")
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
                ["network", "connect", "--alias", "main", gateway_network, container_id],
                environment,
                allowed_exit_codes={0, 1},
            )
    for value in values:
        container_id = value["Id"]
        for existing_network in (value.get("NetworkSettings", {}).get("Networks") or {}):
            if existing_network not in {task_network, gateway_network}:
                await run_docker(
                    ["network", "disconnect", existing_network, container_id],
                    environment,
                )
    _, verify_stdout, _ = await run_docker(["inspect", *container_ids], environment)
    for value in json.loads(verify_stdout):
        networks = set((value.get("NetworkSettings", {}).get("Networks") or {}))
        expected = (
            {task_network, gateway_network}
            if value["Id"] == main_id
            else {task_network}
        )
        if networks != expected:
            raise RuntimeError("Harbor container retained direct provider egress")
    return gateway_network


async def enable_verifier_network(environment: DockerEnvironment) -> None:
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
    process = await asyncio.create_subprocess_exec(
        *command,
        env=compose_subprocess_env(environment),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await process.communicate()
    main_id = stdout.decode().strip()
    if process.returncode != 0 or not re.fullmatch(r"[0-9a-f]{12,64}", main_id):
        raise RuntimeError("Could not identify the verifier main container")
    await run_docker(
        ["network", "connect", "bridge", main_id],
        environment,
        allowed_exit_codes={0, 1},
    )


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

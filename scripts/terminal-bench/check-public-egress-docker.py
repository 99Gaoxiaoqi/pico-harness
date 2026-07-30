from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import importlib.util
import ipaddress
import json
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


_DOCUMENTATION_GLOBAL_IP = "93.184.216.34"
_CONTAINER_HOLD_SCRIPT = "setInterval(()=>{},2147483647)"
_PROXY_REQUEST_SCRIPT = r"""
const net = require("node:net");
const targets = process.argv.slice(1);
const chunks = [];
process.stdin.on("data", chunk => chunks.push(chunk));
process.stdin.on("end", async () => {
  const authorization = Buffer.concat(chunks).toString("ascii").trim();
  const request = host => new Promise((resolve, reject) => {
    const response = [];
    let responseBytes = 0;
    const client = net.connect(8081, "pico-egress");
    client.setTimeout(5000);
    client.on("connect", () => {
      client.write(
        `GET http://${host}/fixture HTTP/1.1\r\n` +
        `Host: ${host}\r\n` +
        `Proxy-Authorization: Basic ${authorization}\r\n` +
        "Connection: close\r\n\r\n"
      );
    });
    client.on("data", chunk => {
      responseBytes += chunk.length;
      if (responseBytes > 65536) {
        client.destroy(new Error("response limit"));
        return;
      }
      response.push(chunk);
    });
    client.on("timeout", () => client.destroy(new Error("timeout")));
    client.on("error", reject);
    client.on("end", () => {
      const head = Buffer.concat(response).toString("latin1");
      const match = /^HTTP\/1\.[01] ([0-9]{3}) /.exec(head);
      if (!match) {
        reject(new Error("invalid response"));
        return;
      }
      resolve(Number(match[1]));
    });
  });
  try {
    const statuses = [];
    for (const target of targets) statuses.push(await request(target));
    process.stdout.write(JSON.stringify(statuses));
  } catch {
    process.exitCode = 1;
  }
});
"""
_EXPECT_CONNECTION_FAILURE_SCRIPT = r"""
const net = require("node:net");
const host = process.argv[1];
const port = Number(process.argv[2]);
const client = net.connect(port, host);
let finished = false;
const finish = code => {
  if (finished) return;
  finished = true;
  client.destroy();
  process.exit(code);
};
client.on("connect", () => finish(9));
client.on("error", () => finish(0));
setTimeout(() => finish(0), 2000);
"""
_APT_UPDATE_COMMAND = r"""
set -eu
lists=/tmp/pico-verifier-apt-lists
sources=/tmp/pico-verifier-sources.list
rm -rf "$lists"
mkdir -p "$lists/partial"
printf '%s\n' \
  'deb [trusted=yes] http://apt.test/debian stable main' >"$sources"
apt-get update \
  -o "Dir::Etc::sourcelist=$sources" \
  -o "Dir::Etc::sourceparts=-" \
  -o "Dir::State::lists=$lists" \
  -o "APT::Get::List-Cleanup=0" \
  -o "Acquire::Languages=none" \
  -o "Acquire::IndexTargets::deb::DEP-11::DefaultEnabled=false"
"""
_TOKEN_FILE_SCAN_SCRIPT = r"""
const fs = require("node:fs");
const path = require("node:path");
const chunks = [];
process.stdin.on("data", chunk => chunks.push(chunk));
process.stdin.on("end", () => {
  const token = Buffer.concat(chunks);
  const visit = candidate => {
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(candidate)) visit(path.join(candidate, name));
      return;
    }
    if (stat.isFile() && fs.readFileSync(candidate).includes(token)) process.exit(9);
  };
  for (const candidate of process.argv.slice(1)) visit(candidate);
});
"""


class DockerEnvironmentStub:
    def __init__(
        self,
        *,
        adapter: Any | None = None,
        main_name: str = "",
        workload_names: tuple[str, ...] = (),
        run_id: str = "",
    ) -> None:
        self._adapter = adapter
        self._main_name = main_name
        self._workload_names = workload_names
        self._run_id = run_id
        self._keep_containers = False
        self.extra_docker_compose_paths: list[Path] = []
        self._docker_compose_paths: list[Path] = []
        self._persistent_env: dict[str, str] = {}
        self._scoped_env_stack: list[dict[str, str]] = []
        self.original_stop_calls = 0
        self.host_compose_env_calls = 0

    def _compose_env_vars(self, *, include_os_env: bool) -> dict[str, str]:
        if include_os_env:
            raise AssertionError("Docker smoke must not inherit the full host env")
        self.host_compose_env_calls += 1
        return dict(self._persistent_env)

    @contextlib.contextmanager
    def scoped_exec_env(self, values: dict[str, str]) -> Any:
        scoped = dict(values)
        self._scoped_env_stack.append(scoped)
        try:
            yield
        finally:
            if not self._scoped_env_stack or self._scoped_env_stack[-1] != scoped:
                raise AssertionError("Docker smoke scoped env stack was corrupted")
            self._scoped_env_stack.pop()

    async def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> subprocess.CompletedProcess[bytes]:
        if self._adapter is None or not self._main_name:
            raise AssertionError("Docker smoke environment is not bound to main")
        merged_env = dict(self._persistent_env)
        if env is not None:
            merged_env.update(env)
        for scoped_env in self._scoped_env_stack:
            merged_env.update(scoped_env)
        args = ["exec"]
        if cwd is not None:
            args.extend(["--workdir", cwd])
        if user is not None:
            args.extend(["--user", str(user)])
        for name, value in sorted(merged_env.items()):
            args.extend(["--env", f"{name}={value}"])
        args.extend([self._main_name, "/bin/sh", "-lc", command])
        result = run_docker(
            self._adapter,
            args,
            allowed_exit_codes=set(range(256)),
            timeout_sec=float(timeout_sec or 30),
        )
        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", "replace")
            for value in merged_env.values():
                if len(value) > 1:
                    stderr = stderr.replace(value, "<redacted-env>")
            raise RuntimeError(
                f"Docker smoke container exec failed ({result.returncode}): "
                f"{stderr[-2_000:]}"
            )
        return result

    async def stop(self, *, delete: bool) -> None:
        self.original_stop_calls += 1
        if self.original_stop_calls != 1:
            raise AssertionError("original Docker environment stop ran more than once")
        if delete:
            if self._adapter is None or not self._run_id:
                raise AssertionError("Docker smoke environment cleanup is not configured")
            for container_name in self._workload_names:
                remove_owned_container(self._adapter, container_name, self._run_id)


# harbor_runtime deliberately refuses duck-typed or subclassed backends. Make
# this real-Docker stub present the exact identity imported by pico_agent.
DockerEnvironmentStub.__name__ = "DockerEnvironment"
DockerEnvironmentStub.__qualname__ = "DockerEnvironment"
DockerEnvironmentStub.__module__ = "harbor.environments.docker.docker"


class LocalFixture:
    def __init__(self) -> None:
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_GET(self) -> None:
                fixture.request_count += 1
                host = self.headers.get("Host")
                authorization_removed = (
                    self.headers.get("Proxy-Authorization") is None
                )
                fixture.requests.append((host or "", self.path))
                if host == "public.test" and self.path == "/fixture":
                    fixture.curl_request_count += 1
                    status = 200
                    payload = b"fixture-ok"
                    valid = authorization_removed
                elif host == "apt.test" and self.path.startswith("/debian/"):
                    fixture.apt_request_count += 1
                    valid = authorization_removed
                    if (
                        "/binary-" in self.path
                        and self.path.endswith("/Packages")
                    ):
                        fixture.apt_packages_request_count += 1
                        status = 200
                        payload = b""
                    else:
                        status = 404
                        payload = b"not-found"
                else:
                    status = 500
                    payload = b"invalid-request"
                    valid = False
                fixture.valid_request = fixture.valid_request and valid
                self.send_response_only(status)
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, _format: str, *args: Any) -> None:
                del args

        self.request_count = 0
        self.curl_request_count = 0
        self.apt_request_count = 0
        self.apt_packages_request_count = 0
        self.requests: list[tuple[str, str]] = []
        self.valid_request = True
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(
            target=self.server.serve_forever,
            name="pico-egress-docker-fixture",
            daemon=True,
        )

    @property
    def port(self) -> int:
        return int(self.server.server_address[1])

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        if self.thread.is_alive():
            raise RuntimeError("local HTTP fixture did not stop")


def install_harbor_stubs() -> None:
    module_names = [
        "harbor",
        "harbor.agents",
        "harbor.agents.installed",
        "harbor.agents.installed.base",
        "harbor.environments",
        "harbor.environments.base",
        "harbor.environments.docker",
        "harbor.environments.docker.docker",
        "harbor.models",
        "harbor.models.agent",
        "harbor.models.agent.context",
        "harbor.models.trial",
        "harbor.models.trial.paths",
    ]
    for name in module_names:
        sys.modules[name] = types.ModuleType(name)

    class BaseInstalledAgent:
        pass

    class BaseEnvironment:
        pass

    class AgentContext:
        pass

    class EnvironmentPaths:
        agent_dir = Path("/logs/agent")

    sys.modules["harbor.agents.installed.base"].BaseInstalledAgent = (
        BaseInstalledAgent
    )
    sys.modules["harbor.environments.base"].BaseEnvironment = BaseEnvironment
    docker_module = sys.modules["harbor.environments.docker.docker"]
    docker_module.DockerEnvironment = DockerEnvironmentStub
    docker_module._sanitize_docker_compose_project_name = lambda value: value
    sys.modules["harbor.models.agent.context"].AgentContext = AgentContext
    sys.modules["harbor.models.trial.paths"].EnvironmentPaths = EnvironmentPaths


def load_adapter() -> Any:
    install_harbor_stubs()
    project_root = Path(__file__).resolve().parents[2]
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))
    adapter_path = project_root / "benchmarks/terminal_bench_2_1/pico_agent.py"
    spec = importlib.util.spec_from_file_location(
        "pico_agent_public_egress_docker_smoke",
        adapter_path,
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def docker_env(adapter: Any) -> dict[str, str]:
    return adapter.compose_subprocess_env_from_host()


def run_docker(
    adapter: Any,
    args: list[str],
    *,
    input_bytes: bytes | None = None,
    allowed_exit_codes: set[int] = {0},
    timeout_sec: float = 20,
) -> subprocess.CompletedProcess[bytes]:
    try:
        result = subprocess.run(
            ["docker", *args],
            input=input_bytes,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=docker_env(adapter),
            timeout=timeout_sec,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as error:
        raise RuntimeError("Docker is unavailable for public egress smoke") from error
    if result.returncode not in allowed_exit_codes:
        operation = " ".join(args[:2])
        raise RuntimeError(
            f"Docker command failed during public egress smoke: {operation}"
        )
    return result


def require_docker_and_pinned_image(adapter: Any) -> None:
    run_docker(adapter, ["info"], timeout_sec=10)
    result = run_docker(
        adapter,
        [
            "image",
            "inspect",
            adapter._RELAY_IMAGE_ID,
            "--format",
            "{{.Id}}",
        ],
    )
    if result.stdout.decode().strip() != adapter._RELAY_IMAGE_ID:
        raise RuntimeError("pinned public egress relay image is unavailable")


def create_internal_network(adapter: Any, name: str, run_id: str) -> None:
    run_docker(
        adapter,
        [
            "network",
            "create",
            "--internal",
            "--label",
            f"pico.terminal-bench.run={run_id}",
            name,
        ],
    )


def start_workload_container(
    adapter: Any,
    *,
    name: str,
    role: str,
    network: str,
    alias: str,
    run_id: str,
) -> None:
    run_docker(
        adapter,
        [
            "run",
            "--detach",
            "--pull",
            "never",
            "--name",
            name,
            "--label",
            f"pico.terminal-bench.run={run_id}",
            "--label",
            f"pico.terminal-bench.role={role}",
            "--network",
            network,
            "--network-alias",
            alias,
            adapter._RELAY_IMAGE_ID,
            "node",
            "-e",
            _CONTAINER_HOLD_SCRIPT,
        ],
    )


def inspect_container(adapter: Any, name: str) -> dict[str, Any]:
    result = run_docker(adapter, ["inspect", name])
    values = json.loads(result.stdout)
    if len(values) != 1:
        raise AssertionError("Docker returned an invalid container inspection")
    return values[0]


def inspect_network(adapter: Any, name: str) -> dict[str, Any]:
    result = run_docker(adapter, ["network", "inspect", name])
    values = json.loads(result.stdout)
    if len(values) != 1:
        raise AssertionError("Docker returned an invalid network inspection")
    return values[0]


def assert_container_networks(
    adapter: Any,
    name: str,
    expected: set[str],
) -> dict[str, Any]:
    value = inspect_container(adapter, name)
    networks = set((value.get("NetworkSettings") or {}).get("Networks") or {})
    if networks != expected:
        raise AssertionError("container retained an unexpected network")
    if value.get("Image") != adapter._RELAY_IMAGE_ID:
        raise AssertionError("container did not use the pinned image")
    return value


def exec_proxy_requests(
    adapter: Any,
    main_name: str,
    token: str,
) -> list[int]:
    authorization = base64.b64encode(f"pico:{token}".encode("ascii"))
    result = run_docker(
        adapter,
        [
            "exec",
            "--interactive",
            main_name,
            "node",
            "-e",
            _PROXY_REQUEST_SCRIPT,
            "public.test",
            "private.test",
            "mixed.test",
            "metadata.google.internal",
        ],
        input_bytes=authorization,
        timeout_sec=30,
    )
    try:
        statuses = json.loads(result.stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AssertionError(
            "container returned invalid proxy status evidence"
        ) from error
    if not isinstance(statuses, list) or any(
        isinstance(value, bool) or not isinstance(value, int) for value in statuses
    ):
        raise AssertionError("container returned invalid proxy statuses")
    return statuses


def assert_connection_fails(
    adapter: Any,
    container_name: str,
    host: str,
    port: int,
) -> None:
    run_docker(
        adapter,
        [
            "exec",
            container_name,
            "node",
            "-e",
            _EXPECT_CONNECTION_FAILURE_SCRIPT,
            host,
            str(port),
        ],
        timeout_sec=10,
    )


def exec_agent_bash(
    adapter: Any,
    main_name: str,
    proxy_env: dict[str, str],
    command: str,
    *,
    timeout_sec: float,
) -> subprocess.CompletedProcess[bytes]:
    args = ["exec"]
    for name, value in proxy_env.items():
        args.extend(["--env", f"{name}={value}"])
    args.extend([main_name, "/bin/bash", "--noprofile", "--norc", "-c", command])
    return run_docker(adapter, args, timeout_sec=timeout_sec)


def assert_token_absent_from_agent_files(
    adapter: Any,
    main_name: str,
    token: str,
) -> None:
    run_docker(
        adapter,
        [
            "exec",
            "--interactive",
            main_name,
            "node",
            "-e",
            _TOKEN_FILE_SCAN_SCRIPT,
            "/tmp/pico-verifier-apt-lists",
            "/tmp/pico-verifier-sources.list",
        ],
        input_bytes=token.encode(),
        timeout_sec=20,
    )


def remove_owned_container(
    adapter: Any,
    name: str,
    run_id: str,
) -> None:
    result = run_docker(
        adapter,
        ["inspect", name],
        allowed_exit_codes={0, 1},
    )
    if result.returncode == 1:
        return
    values = json.loads(result.stdout)
    labels = ((values[0].get("Config") or {}).get("Labels") or {}) if values else {}
    if len(values) != 1 or labels.get("pico.terminal-bench.run") != run_id:
        raise RuntimeError("refusing to remove an unowned Docker smoke container")
    run_docker(
        adapter,
        ["rm", "--force", name],
        allowed_exit_codes={0, 1},
    )


def remove_owned_network(
    adapter: Any,
    name: str,
    run_id: str,
) -> None:
    result = run_docker(
        adapter,
        ["network", "inspect", name],
        allowed_exit_codes={0, 1},
    )
    if result.returncode == 1:
        return
    values = json.loads(result.stdout)
    labels = (values[0].get("Labels") or {}) if values else {}
    if len(values) != 1 or labels.get("pico.terminal-bench.run") != run_id:
        raise RuntimeError("refusing to remove an unowned Docker smoke network")
    run_docker(
        adapter,
        ["network", "rm", name],
        allowed_exit_codes={0, 1},
    )


def assert_no_residual_resources(
    adapter: Any,
    container_names: tuple[str, ...],
    network_names: tuple[str, ...],
) -> None:
    for name in container_names:
        result = run_docker(
            adapter,
            ["inspect", name],
            allowed_exit_codes={0, 1},
        )
        if result.returncode == 0:
            raise AssertionError("Docker smoke container cleanup was not confirmed")
    for name in network_names:
        result = run_docker(
            adapter,
            ["network", "inspect", name],
            allowed_exit_codes={0, 1},
        )
        if result.returncode == 0:
            raise AssertionError("Docker smoke network cleanup was not confirmed")


def assert_no_persisted_proxy_or_token(
    adapter: Any,
    *,
    environment: DockerEnvironmentStub,
    container_names: tuple[str, ...],
    proxy_env_names: tuple[str, ...],
    token: str,
) -> None:
    host_env = adapter.compose_subprocess_env(environment)
    if set(host_env) & set(proxy_env_names):
        raise AssertionError("verifier proxy leaked into the host compose env")
    if any(token in value for value in host_env.values()):
        raise AssertionError("verifier token leaked into the host compose env")
    for container_name in container_names:
        value = inspect_container(adapter, container_name)
        config_env = ((value.get("Config") or {}).get("Env") or [])
        config_names = {
            item.split("=", 1)[0]
            for item in config_env
            if isinstance(item, str) and "=" in item
        }
        if config_names & set(proxy_env_names):
            raise AssertionError("verifier proxy persisted in container Config.Env")
        if any(
            isinstance(item, str) and token in item
            for item in config_env
        ):
            raise AssertionError("verifier token persisted in container Config.Env")


async def run_smoke(adapter: Any) -> None:
    public_egress = importlib.import_module(
        "benchmarks.terminal_bench_2_1.public_egress"
    )
    suffix = secrets.token_hex(6)
    run_id = f"egress-docker-smoke-{suffix}"
    task_network = f"pico-smoke-task-{suffix}"
    gateway_network = f"pico-smoke-gw-{suffix}"
    main_name = f"pico-smoke-main-{suffix}"
    sidecar_name = f"pico-smoke-sidecar-{suffix}"
    relay_name = f"pico-smoke-egress-{suffix}"
    context_digest = hashlib.sha256(run_id.encode()).hexdigest()[:20]
    environment = DockerEnvironmentStub()
    fixture = LocalFixture()
    connector_calls: list[tuple[str, int]] = []
    token = secrets.token_hex(32)

    def resolver(host: str, _port: int) -> list[str]:
        return {
            "public.test": [_DOCUMENTATION_GLOBAL_IP],
            "apt.test": [_DOCUMENTATION_GLOBAL_IP],
            "private.test": ["127.0.0.1"],
            "mixed.test": [_DOCUMENTATION_GLOBAL_IP, "127.0.0.1"],
            "metadata.google.internal": ["169.254.169.254"],
        }[host]

    def connector(address: str, port: int, timeout_sec: float) -> socket.socket:
        connector_calls.append((address, port))
        return socket.create_connection(
            ("127.0.0.1", fixture.port),
            timeout=timeout_sec,
        )

    proxy = public_egress.PublicEgressProxy(token=token, ttl_sec=60)
    proxy._resolver = resolver
    proxy._connector = connector
    proxy_started = False
    relay_started = False
    fixture_started = False
    test_error: BaseException | None = None
    cleanup_errors: list[BaseException] = []
    receipt: dict[str, Any] | None = None

    try:
        fixture.start()
        fixture_started = True
        host_port = proxy.start()
        proxy_started = True

        create_internal_network(adapter, task_network, run_id)
        create_internal_network(adapter, gateway_network, run_id)
        start_workload_container(
            adapter,
            name=main_name,
            role="docker-smoke-main",
            network=task_network,
            alias="main",
            run_id=run_id,
        )
        run_docker(
            adapter,
            [
                "network",
                "connect",
                "--alias",
                "main",
                gateway_network,
                main_name,
            ],
        )
        start_workload_container(
            adapter,
            name=sidecar_name,
            role="docker-smoke-sidecar",
            network=task_network,
            alias="sidecar",
            run_id=run_id,
        )
        await adapter.start_public_egress_relay(
            environment,
            relay_name=relay_name,
            network_name=gateway_network,
            run_id=run_id,
            context_digest=context_digest,
            host_port=host_port,
        )
        relay_started = True

        task_value = inspect_network(adapter, task_network)
        gateway_value = inspect_network(adapter, gateway_network)
        if not adapter.is_owned_trial_network(task_value, run_id):
            raise AssertionError("task network is not an owned internal network")
        if not adapter.is_owned_trial_network(gateway_value, run_id):
            raise AssertionError("gateway network is not an owned internal network")
        assert_container_networks(
            adapter,
            main_name,
            {task_network, gateway_network},
        )
        assert_container_networks(adapter, sidecar_name, {task_network})
        relay_value = assert_container_networks(
            adapter,
            relay_name,
            {gateway_network, "bridge"},
        )
        if not adapter.is_valid_public_egress_relay(
            relay_value,
            relay_name=relay_name,
            network_name=gateway_network,
            run_id=run_id,
            context_digest=context_digest,
            host_port=host_port,
        ):
            raise AssertionError("relay does not match the production hardening policy")

        statuses = exec_proxy_requests(adapter, main_name, token)
        if statuses != [200, 403, 403, 403]:
            raise AssertionError("unexpected public egress allow/deny statuses")
        if fixture.request_count != 1 or not fixture.valid_request:
            raise AssertionError("local HTTP fixture received an invalid request")
        if connector_calls != [(_DOCUMENTATION_GLOBAL_IP, 80)]:
            raise AssertionError("denied proxy targets reached the connector")

        proxy_url = f"http://pico:{token}@pico-egress:8081"
        agent_proxy_env = {
            "HTTP_PROXY": proxy_url,
            "HTTPS_PROXY": proxy_url,
            "http_proxy": proxy_url,
            "https_proxy": proxy_url,
            "NO_PROXY": adapter._PUBLIC_EGRESS_NO_PROXY,
            "no_proxy": adapter._PUBLIC_EGRESS_NO_PROXY,
        }
        curl_result = exec_agent_bash(
            adapter,
            main_name,
            agent_proxy_env,
            (
                "curl --silent --show-error --fail --max-time 10 "
                "http://public.test/fixture"
            ),
            timeout_sec=20,
        )
        apt_result = exec_agent_bash(
            adapter,
            main_name,
            agent_proxy_env,
            _APT_UPDATE_COMMAND,
            timeout_sec=60,
        )
        token_bytes = token.encode()
        for result in (curl_result, apt_result):
            if token_bytes in result.stdout or token_bytes in result.stderr:
                raise AssertionError("agent Bash leaked the public proxy token")
        if curl_result.stdout != b"fixture-ok":
            raise AssertionError("agent Bash curl did not use the controlled proxy")
        if (
            fixture.curl_request_count != 2
            or fixture.apt_request_count < 1
            or fixture.apt_packages_request_count < 1
            or len(connector_calls) != fixture.request_count
            or any(
                address != _DOCUMENTATION_GLOBAL_IP or port != 80
                for address, port in connector_calls
            )
        ):
            raise AssertionError("agent Bash requests bypassed controlled proxy checks")
        assert_no_persisted_proxy_or_token(
            adapter,
            environment=environment,
            container_names=(main_name, sidecar_name, relay_name),
            proxy_env_names=adapter.PUBLIC_EGRESS_PROXY_ENV_NAMES,
            token=token,
        )
        assert_token_absent_from_agent_files(adapter, main_name, token)
        assert_connection_fails(
            adapter,
            main_name,
            _DOCUMENTATION_GLOBAL_IP,
            80,
        )
        assert_connection_fails(adapter, main_name, "1.1.1.1", 53)
        assert_connection_fails(adapter, sidecar_name, "pico-egress", 8081)

        receipt = proxy.stop()
        proxy_started = False
        if (
            receipt.get("schemaVersion") != 1
            or receipt.get("allowed", 0) < 3
            or receipt.get("allowed") != fixture.request_count
            or receipt.get("denied") != 3
        ):
            raise AssertionError("public egress proxy receipt counts are invalid")
    except BaseException as error:
        test_error = error
    finally:
        if proxy_started:
            try:
                receipt = proxy.stop()
            except BaseException as error:
                cleanup_errors.append(error)
        if relay_started:
            try:
                await adapter.remove_public_egress_relay(
                    environment,
                    relay_name=relay_name,
                    run_id=run_id,
                    context_digest=context_digest,
                )
            except BaseException as error:
                cleanup_errors.append(error)
        for container_name in (relay_name, main_name, sidecar_name):
            try:
                remove_owned_container(adapter, container_name, run_id)
            except BaseException as error:
                cleanup_errors.append(error)
        for network_name in (gateway_network, task_network):
            try:
                remove_owned_network(adapter, network_name, run_id)
            except BaseException as error:
                cleanup_errors.append(error)
        try:
            assert_no_residual_resources(
                adapter,
                (relay_name, main_name, sidecar_name),
                (task_network, gateway_network),
            )
        except BaseException as error:
            cleanup_errors.append(error)
        if fixture_started:
            try:
                fixture.stop()
            except BaseException as error:
                cleanup_errors.append(error)
        token = ""

    if cleanup_errors:
        raise RuntimeError(
            "public egress Docker smoke cleanup did not complete"
        ) from (test_error or cleanup_errors[0])
    if test_error is not None:
        raise test_error
    if receipt is None:
        raise AssertionError("public egress proxy did not return a receipt")


async def run_verifier_smoke(adapter: Any) -> None:
    harbor_runtime = importlib.import_module(
        "benchmarks.terminal_bench_2_1.harbor_runtime"
    )
    harbor_runtime.install_verifier_exec_env_overlay(DockerEnvironmentStub)

    suffix = secrets.token_hex(6)
    run_id = f"verifier-egress-docker-smoke-{suffix}"
    task_network = f"pico-verifier-task-{suffix}"
    gateway_network = f"pico-verifier-gw-{suffix}"
    main_name = f"pico-verifier-main-{suffix}"
    sidecar_name = f"pico-verifier-sidecar-{suffix}"
    networks = adapter.TrialNetworks(
        task=task_network,
        gateway=gateway_network,
    )
    environment = DockerEnvironmentStub(
        adapter=adapter,
        main_name=main_name,
        workload_names=(main_name, sidecar_name),
        run_id=run_id,
    )
    fixture = LocalFixture()
    connector_calls: list[tuple[str, int]] = []
    created_proxies: list[Any] = []
    original_create_proxy = adapter.create_public_egress_proxy
    receipt_payload: dict[str, Any] | None = None
    test_error: BaseException | None = None
    cleanup_errors: list[BaseException] = []
    fixture_started = False
    access: Any | None = None
    lifecycle_installed = False
    lifecycle_stopped = False

    def resolver(host: str, _port: int) -> list[str]:
        return {
            "apt.test": [_DOCUMENTATION_GLOBAL_IP],
            "public.test": [_DOCUMENTATION_GLOBAL_IP],
        }[host]

    def connector(address: str, port: int, timeout_sec: float) -> socket.socket:
        connector_calls.append((address, port))
        return socket.create_connection(
            ("127.0.0.1", fixture.port),
            timeout=timeout_sec,
        )

    def create_proxy(*, token: str, ttl_sec: float) -> Any:
        proxy = original_create_proxy(token=token, ttl_sec=ttl_sec)
        proxy._resolver = resolver
        proxy._connector = connector
        created_proxies.append(proxy)
        return proxy

    malicious_env = {
        name: (
            "*"
            if name in {"NO_PROXY", "no_proxy"}
            else "http://127.0.0.1:1"
        )
        for name in harbor_runtime.PUBLIC_EGRESS_PROXY_ENV_NAMES
    }

    with tempfile.TemporaryDirectory(prefix="pico-verifier-egress-") as temp_dir:
        receipt_path = Path(temp_dir) / "verifier-egress-receipt.json"
        try:
            fixture.start()
            fixture_started = True
            adapter.create_public_egress_proxy = create_proxy
            create_internal_network(adapter, task_network, run_id)
            create_internal_network(adapter, gateway_network, run_id)
            start_workload_container(
                adapter,
                name=main_name,
                role="verifier-docker-smoke-main",
                network=task_network,
                alias="main",
                run_id=run_id,
            )
            run_docker(
                adapter,
                [
                    "network",
                    "connect",
                    "--alias",
                    "main",
                    gateway_network,
                    main_name,
                ],
            )
            start_workload_container(
                adapter,
                name=sidecar_name,
                role="verifier-docker-smoke-sidecar",
                network=task_network,
                alias="sidecar",
                run_id=run_id,
            )

            access = adapter.PublicEgressAccess(
                run_id=run_id,
                network_name=gateway_network,
                context_id=f"{run_id}-verifier",
                ttl_sec=60,
                receipt_path=receipt_path,
            )
            token = access.scrub_secret
            adapter.install_verifier_egress_lifecycle(
                environment,
                networks=networks,
                run_id=run_id,
                verifier_egress=access,
            )
            lifecycle_installed = True

            relay_before_activation = run_docker(
                adapter,
                ["inspect", access.relay_name],
                allowed_exit_codes={0, 1},
            )
            if relay_before_activation.returncode != 1:
                raise AssertionError("verifier relay started before verifier phase")
            if hasattr(
                environment,
                "_pico_terminal_bench_verifier_exec_env",
            ):
                raise AssertionError("verifier exec overlay activated too early")
            assert_no_persisted_proxy_or_token(
                adapter,
                environment=environment,
                container_names=(main_name, sidecar_name),
                proxy_env_names=harbor_runtime.PUBLIC_EGRESS_PROXY_ENV_NAMES,
                token=token,
            )
            await environment.exec(
                (
                    "if curl --silent --show-error --fail --max-time 3 "
                    "http://public.test/fixture >/dev/null 2>&1; "
                    "then exit 9; else exit 0; fi"
                ),
                env=malicious_env,
                timeout_sec=10,
            )
            if fixture.request_count != 0:
                raise AssertionError("pre-verifier command reached public egress")

            await adapter.activate_verifier_egress(environment)
            if len(created_proxies) != 1:
                raise AssertionError("verifier egress proxy was not activated once")
            await adapter.assert_verifier_egress_topology(
                environment,
                networks=networks,
                run_id=run_id,
                verifier_egress=access,
            )
            assert_no_persisted_proxy_or_token(
                adapter,
                environment=environment,
                container_names=(
                    main_name,
                    sidecar_name,
                    access.relay_name,
                ),
                proxy_env_names=harbor_runtime.PUBLIC_EGRESS_PROXY_ENV_NAMES,
                token=token,
            )

            curl_result = await environment.exec(
                (
                    "curl --silent --show-error --fail --max-time 10 "
                    "http://public.test/fixture"
                ),
                env=malicious_env,
                timeout_sec=20,
            )
            if curl_result.stdout != b"fixture-ok":
                raise AssertionError("verifier curl did not use the egress overlay")
            apt_result = await environment.exec(
                _APT_UPDATE_COMMAND,
                env=malicious_env,
                timeout_sec=60,
            )
            token_bytes = token.encode()
            if token_bytes in curl_result.stdout or token_bytes in curl_result.stderr:
                raise AssertionError("verifier curl leaked the proxy token")
            if token_bytes in apt_result.stdout or token_bytes in apt_result.stderr:
                raise AssertionError("verifier apt leaked the proxy token")
            if (
                fixture.curl_request_count != 1
                or fixture.apt_request_count < 1
                or fixture.apt_packages_request_count < 1
                or not fixture.valid_request
            ):
                raise AssertionError(
                    "verifier fixture requests were incomplete: "
                    f"{fixture.requests!r}"
                )
            if (
                len(connector_calls) != fixture.request_count
                or any(
                    address != _DOCUMENTATION_GLOBAL_IP or port != 80
                    for address, port in connector_calls
                )
            ):
                raise AssertionError("verifier requests bypassed proxy target checks")
            assert_connection_fails(
                adapter,
                main_name,
                _DOCUMENTATION_GLOBAL_IP,
                80,
            )
            assert_connection_fails(adapter, sidecar_name, "pico-egress", 8081)
            assert_connection_fails(
                adapter,
                sidecar_name,
                _DOCUMENTATION_GLOBAL_IP,
                80,
            )

            await environment.stop(delete=True)
            lifecycle_stopped = True
            if environment.original_stop_calls != 1:
                raise AssertionError("original Harbor stop did not run exactly once")
            if hasattr(
                environment,
                "_pico_terminal_bench_verifier_exec_env",
            ) or hasattr(
                environment,
                "_pico_terminal_bench_verifier_activation",
            ):
                raise AssertionError("verifier lifecycle state survived Harbor stop")
            if not receipt_path.is_file():
                raise AssertionError("verifier egress receipt was not written")
            receipt_payload = json.loads(receipt_path.read_text(encoding="utf-8"))
            if (
                receipt_payload.get("schemaVersion") != 1
                or receipt_payload.get("allowed", 0) < 2
                or receipt_payload.get("allowed") != fixture.request_count
            ):
                raise AssertionError("verifier egress receipt counts are invalid")
            assert_no_residual_resources(
                adapter,
                (access.relay_name, main_name, sidecar_name),
                (task_network, gateway_network),
            )
        except BaseException as error:
            test_error = error
        finally:
            adapter.create_public_egress_proxy = original_create_proxy
            if lifecycle_installed and not lifecycle_stopped:
                try:
                    await environment.stop(delete=True)
                    lifecycle_stopped = True
                except BaseException as error:
                    cleanup_errors.append(error)
            if access is not None:
                try:
                    await access.stop(environment)
                except BaseException as error:
                    cleanup_errors.append(error)
            for container_name in (
                access.relay_name if access is not None else "",
                main_name,
                sidecar_name,
            ):
                if not container_name:
                    continue
                try:
                    remove_owned_container(adapter, container_name, run_id)
                except BaseException as error:
                    cleanup_errors.append(error)
            for network_name in (gateway_network, task_network):
                try:
                    remove_owned_network(adapter, network_name, run_id)
                except BaseException as error:
                    cleanup_errors.append(error)
            residual_container_names = tuple(
                name
                for name in (
                    access.relay_name if access is not None else "",
                    main_name,
                    sidecar_name,
                )
                if name
            )
            try:
                assert_no_residual_resources(
                    adapter,
                    residual_container_names,
                    (task_network, gateway_network),
                )
            except BaseException as error:
                cleanup_errors.append(error)
            if fixture_started:
                try:
                    fixture.stop()
                except BaseException as error:
                    cleanup_errors.append(error)

    if cleanup_errors:
        raise RuntimeError(
            "verifier egress Docker smoke cleanup did not complete"
        ) from (test_error or cleanup_errors[0])
    if test_error is not None:
        raise test_error
    if receipt_payload is None:
        raise AssertionError("verifier egress receipt was not captured")


async def main() -> None:
    adapter = load_adapter()
    require_docker_and_pinned_image(adapter)
    if not ipaddress.ip_address(_DOCUMENTATION_GLOBAL_IP).is_global:
        raise AssertionError("documentation target must be a global IP")
    await run_smoke(adapter)
    await run_verifier_smoke(adapter)
    print("Public and verifier egress Docker smoke passed.")


if __name__ == "__main__":
    asyncio.run(main())

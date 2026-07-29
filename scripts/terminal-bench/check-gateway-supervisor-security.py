from __future__ import annotations

import base64
import hashlib
import hmac
import http.client
import importlib.util
import json
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


class ProviderHandler(BaseHTTPRequestHandler):
    calls = 0
    read_started = threading.Event()
    release_read = threading.Event()

    def do_POST(self) -> None:
        type(self).calls += 1
        body = self.rfile.read(int(self.headers.get("content-length", "0")))
        request_body = json.loads(body)
        usage_case = request_body.get("usage_case")
        if usage_case == "missing":
            response = {"choices": [{"message": {"content": "ok"}}]}
        elif usage_case == "invalid":
            response = {
                "choices": [{"message": {"content": "ok"}}],
                "usage": {
                    "prompt_tokens": True,
                    "completion_tokens": 1,
                    "total_tokens": 2,
                },
            }
        else:
            input_tokens = (
                1_800_000
                if usage_case == "huge"
                else 5_000
                if usage_case == "supplement"
                else 2
            )
            response = {
                "choices": [{"message": {"content": "ok"}}],
                "usage": {
                    "prompt_tokens": input_tokens,
                    "completion_tokens": 1,
                    "total_tokens": input_tokens + 1,
                },
            }
        encoded = json.dumps(response, separators=(",", ":")).encode()
        status = 429 if usage_case == "retry" else 200
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if request_body.get("block_read"):
            self.wfile.write(encoded[:1])
            self.wfile.flush()
            type(self).read_started.set()
            type(self).release_read.wait(timeout=10)
            return
        self.wfile.write(encoded)

    def log_message(self, _format: str, *args: Any) -> None:
        del args


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path: str):
        super().__init__("localhost", timeout=5)
        self.path = path

    def connect(self) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


def sign(seed: str, run_id: str, trial_id: str, value: dict[str, Any]) -> dict[str, Any]:
    now = int(time.time())
    auth = {
        "runId": run_id,
        "trialId": trial_id,
        "nonce": secrets.token_hex(16),
        "issuedAt": now,
        "expiresAt": now + 60,
    }
    value = {**value, "trialId": trial_id, "auth": auth}
    signature = hmac.new(
        seed.encode(),
        json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode(),
        hashlib.sha256,
    ).hexdigest()
    value["auth"] = {**auth, "signature": signature}
    return value


def request(path: str, value: dict[str, Any]) -> tuple[int, dict[str, Any] | None]:
    body = json.dumps(value, separators=(",", ":")).encode()
    connection = UnixConnection(path)
    try:
        connection.request(
            "POST",
            "/",
            body=body,
            headers={"Content-Type": "application/json", "Content-Length": str(len(body))},
        )
        response = connection.getresponse()
        raw = response.read()
        return response.status, json.loads(raw) if response.status == 200 else None
    finally:
        connection.close()


def proxy_frame(body: dict[str, Any]) -> dict[str, Any]:
    return {
        "action": "proxy",
        "protocol": "openai",
        "path": "/chat/completions",
        "headers": {"content-type": "application/json"},
        "body": base64.b64encode(
            json.dumps({"model": "test-model", "max_tokens": 8, **body}).encode()
        ).decode(),
    }


def pricing_contract(provider_id: str, model: str) -> tuple[dict[str, Any], str]:
    pricing = {
        "schemaVersion": 1,
        "providerId": provider_id,
        "model": model,
        "currency": "CNY",
        "unit": "microCNYPerMillionTokens",
        "input": 7_200_000,
        "output": 21_600_000,
    }
    digest = hashlib.sha256(
        json.dumps(
            pricing,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode()
    ).hexdigest()
    return pricing, digest


def stall_tls_handshake(
    listener: socket.socket, entered: threading.Event, release: threading.Event
) -> None:
    connection, _ = listener.accept()
    try:
        connection.recv(1)
        entered.set()
        release.wait(timeout=10)
    finally:
        connection.close()


def assert_synthetic_stage_cancel(
    gateway: Any,
    route_config: dict[str, Any],
    root: Path,
    stage: str,
) -> None:
    marker = root / f"{stage}.entered"
    if stage == "dns":
        blocker = (
            "import socket,sys,time; from pathlib import Path; "
            "sys.stdin.buffer.read(); "
            f"marker=Path({str(marker)!r}); "
            "socket.getaddrinfo=lambda *_a,**_k:(marker.write_text('dns'),time.sleep(30))[1]; "
            "socket.getaddrinfo('blocked.test',443)"
        )
    elif stage == "connect":
        blocker = (
            "import socket,sys,time; from pathlib import Path; "
            "sys.stdin.buffer.read(); "
            f"marker=Path({str(marker)!r}); "
            "blocked=lambda *_a,**_k:(marker.write_text('connect'),time.sleep(30))[1]; "
            "socket.socket.connect=blocked; socket.create_connection(('127.0.0.1',9))"
        )
    else:
        raise AssertionError(f"unsupported synthetic stage: {stage}")
    state = gateway.GatewayState(
        route_config,
        "provider-secret-canary",
        f"synthetic-{stage}",
        "1" * 64,
    )
    state.upstream_request_factory = lambda: gateway.UpstreamRequest(
        [sys.executable, "-c", blocker]
    )
    trial_id = f"trial-{stage}"
    state.register(
        {
            "trialId": trial_id,
            "action": "register",
            "protocol": "openai",
            "ttlSec": 60,
        }
    )
    outcome: list[str] = []

    def run_proxy() -> None:
        try:
            state.proxy({"trialId": trial_id, **proxy_frame({})})
            outcome.append("success")
        except Exception:
            outcome.append("rejected")

    thread = threading.Thread(target=run_proxy)
    thread.start()
    deadline = time.monotonic() + 2
    while not marker.exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert marker.exists()
    revoke_started = time.monotonic()
    state.revoke(trial_id)
    revoke_elapsed = time.monotonic() - revoke_started
    thread.join(1)
    assert outcome == ["rejected"]
    assert revoke_elapsed < 1
    with state.lock:
        assert state.trials[trial_id]["active"] == set()


def assert_usage_parsers(gateway: Any) -> None:
    assert gateway.parse_usage(
        b'{"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}',
        "openai",
    ) == (2, 3)
    assert gateway.parse_usage(
        b'{"usage":{"input_tokens":2,"cache_creation_input_tokens":3,'
        b'"cache_read_input_tokens":5,"output_tokens":7}}',
        "claude",
    ) == (10, 7)
    assert gateway.parse_usage(
        b'{"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":3,'
        b'"thoughtsTokenCount":5,"totalTokenCount":10}}',
        "gemini",
    ) == (2, 8)
    invalid = (
        (b'{"usage":{"prompt_tokens":true,"completion_tokens":1}}', "openai"),
        (b'{"usage":{"input_tokens":-1,"output_tokens":1}}', "claude"),
        (
            b'{"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":3,'
            b'"thoughtsTokenCount":6,"totalTokenCount":10}}',
            "gemini",
        ),
    )
    for body, protocol in invalid:
        try:
            gateway.parse_usage(body, protocol)
        except ValueError:
            pass
        else:
            raise AssertionError(f"invalid {protocol} usage was accepted")
    assert gateway.token_cost_micro_cny(
        1, 0, {"input": 1, "output": 0}
    ) == 1


def assert_spawn_cancel_race(gateway: Any) -> None:
    original_popen = gateway.subprocess.Popen
    spawn_entered = threading.Event()
    release_spawn = threading.Event()

    def blocked_popen(*args: Any, **kwargs: Any) -> Any:
        spawn_entered.set()
        assert release_spawn.wait(timeout=2)
        return original_popen(*args, **kwargs)

    gateway.subprocess.Popen = blocked_popen
    active = gateway.UpstreamRequest(
        [sys.executable, "-c", "import sys; sys.stdin.buffer.read()"]
    )
    outcome: list[str] = []

    def execute() -> None:
        try:
            active.execute({"test": True})
            outcome.append("success")
        except Exception:
            outcome.append("rejected")

    thread = threading.Thread(target=execute)
    thread.start()
    assert spawn_entered.wait(timeout=1)
    cancel_started = time.monotonic()
    active.cancel(time.monotonic() + 0.5)
    cancel_elapsed = time.monotonic() - cancel_started
    release_spawn.set()
    thread.join(1)
    gateway.subprocess.Popen = original_popen
    assert cancel_elapsed < 0.1
    assert outcome == ["rejected"]


def assert_exact_reconciliation(
    gateway: Any, route_config: dict[str, Any]
) -> None:
    provider_response = json.dumps(
        {
            "choices": [{"message": {"content": "ok"}}],
            "usage": {
                "prompt_tokens": 5_000,
                "completion_tokens": 1,
                "total_tokens": 5_001,
            },
        },
        separators=(",", ":"),
    ).encode()
    worker_frame = json.dumps(
        {
            "status": 200,
            "headers": [["content-type", "application/json"]],
            "body": base64.b64encode(provider_response).decode(),
        },
        separators=(",", ":"),
    )
    command = [
        sys.executable,
        "-c",
        "import sys; sys.stdin.buffer.read(); sys.stdout.write(" + repr(worker_frame) + ")",
    ]
    state = gateway.GatewayState(
        route_config,
        "provider-secret-canary",
        "exact-reconciliation",
        "2" * 64,
    )
    state.upstream_request_factory = lambda: gateway.UpstreamRequest(command)
    state.register(
        {
            "trialId": "trial-exact",
            "action": "register",
            "protocol": "openai",
            "ttlSec": 60,
        }
    )
    assert state.proxy({"trialId": "trial-exact", **proxy_frame({})})["status"] == 200
    with state.lock:
        trial = state.trials["trial-exact"]
        assert trial["inputTokensRemaining"] == gateway.MAX_INPUT_TOKENS - 5_000
        assert trial["outputTokensRemaining"] == gateway.MAX_OUTPUT_TOKENS - 1
        assert trial["costMicroCNYRemaining"] == (
            gateway.MAX_COST_MICRO_CNY
            - gateway.token_cost_micro_cny(5_000, 1, state.pricing)
        )


def main() -> None:
    project_root = Path(__file__).resolve().parents[2]
    provider = ThreadingHTTPServer(("127.0.0.1", 0), ProviderHandler)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    run_id = "security-e2e"
    seed = secrets.token_hex(32)
    pricing, pricing_sha256 = pricing_contract("test", "test-model")
    with tempfile.TemporaryDirectory(prefix="pico-gateway-security-") as directory:
        root = Path(directory)
        socket_path = root / "gateway.sock"
        route_path = root / "route.json"
        route_config = {
            "schemaVersion": 1,
            "modelRouteId": "test/test-model",
            "providerId": "test",
            "provider": {
                "protocol": "openai",
                "baseURL": f"http://127.0.0.1:{provider.server_port}",
            },
            "pricing": pricing,
            "pricingSha256": pricing_sha256,
        }
        route_path.write_text(json.dumps(route_config))
        supervisor_path = (
            project_root / "benchmarks/terminal_bench_2_1/gateway_supervisor.py"
        )
        spec = importlib.util.spec_from_file_location("gateway_supervisor", supervisor_path)
        if spec is None or spec.loader is None:
            raise AssertionError("unable to load gateway supervisor")
        gateway = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(gateway)
        assert_usage_parsers(gateway)
        assert_spawn_cancel_race(gateway)
        assert_exact_reconciliation(gateway, route_config)
        assert_synthetic_stage_cancel(gateway, route_config, root, "dns")
        assert_synthetic_stage_cancel(gateway, route_config, root, "connect")
        bad_route_path = root / "bad-route.json"
        bad_route = json.loads(route_path.read_text())
        bad_route["pricingSha256"] = "0" * 64
        bad_route_path.write_text(json.dumps(bad_route))
        bad_process = subprocess.Popen(
            [
                sys.executable,
                str(
                    project_root
                    / "benchmarks/terminal_bench_2_1/gateway_supervisor.py"
                ),
                "--socket",
                str(root / "bad-gateway.sock"),
                "--route-config",
                str(bad_route_path),
            ],
            cwd=root,
            env={"PATH": str(Path(sys.executable).parent)},
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        bad_secret = json.dumps(
            {
                "providerSecret": "provider-secret-canary",
                "runId": run_id,
                "capabilitySeed": seed,
            }
        ).encode()
        bad_stdout, _ = bad_process.communicate(input=bad_secret, timeout=5)
        assert bad_process.returncode != 0
        assert b"READY" not in bad_stdout
        process = subprocess.Popen(
            [
                sys.executable,
                str(
                    project_root
                    / "benchmarks/terminal_bench_2_1/gateway_supervisor.py"
                ),
                "--socket",
                str(socket_path),
                "--route-config",
                str(route_path),
            ],
            cwd=root,
            env={"PATH": str(Path(sys.executable).parent)},
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        assert process.stdin is not None
        process.stdin.write(
            json.dumps(
                {
                    "providerSecret": "provider-secret-canary",
                    "runId": run_id,
                    "capabilitySeed": seed,
                }
            ).encode()
        )
        process.stdin.close()
        assert process.stdout is not None
        if process.stdout.readline() != b"READY\n":
            raise AssertionError(process.stderr.read().decode() if process.stderr else "")

        assert request(
            str(socket_path), {"action": "proxy", "trialId": "forged", **proxy_frame({})}
        )[0] == 502
        assert ProviderHandler.calls == 0

        register = sign(
            seed,
            run_id,
            "trial-a",
            {"action": "register", "protocol": "openai", "ttlSec": 60},
        )
        assert request(str(socket_path), register)[0] == 200
        assert request(str(socket_path), register)[0] == 502
        assert request(
            str(socket_path), sign(seed, run_id, "trial-b", proxy_frame({}))
        )[0] == 502
        assert request(
            str(socket_path), sign(seed, run_id, "trial-a", proxy_frame({}))
        )[0] == 200
        assert ProviderHandler.calls == 1

        assert request(
            str(socket_path),
            sign(seed, run_id, "trial-revoked", {"action": "revoke"}),
        )[0] == 200
        assert request(
            str(socket_path),
            sign(
                seed,
                run_id,
                "trial-revoked",
                {"action": "register", "protocol": "openai", "ttlSec": 60},
            ),
        )[0] == 502

        assert request(
            str(socket_path),
            sign(
                seed,
                run_id,
                "trial-large",
                {"action": "register", "protocol": "openai", "ttlSec": 60},
            ),
        )[0] == 200
        assert request(
            str(socket_path),
            sign(seed, run_id, "trial-large", proxy_frame({"padding": "x" * 1_100_000})),
        )[0] == 502
        assert ProviderHandler.calls == 1

        assert request(
            str(socket_path),
            sign(
                seed,
                run_id,
                "trial-refund",
                {"action": "register", "protocol": "openai", "ttlSec": 60},
            ),
        )[0] == 200
        refund_body = {"padding": "x" * 900_000}
        assert request(
            str(socket_path),
            sign(seed, run_id, "trial-refund", proxy_frame(refund_body)),
        )[0] == 200

        assert request(
            str(socket_path),
            sign(
                seed,
                run_id,
                "trial-supplement",
                {"action": "register", "protocol": "openai", "ttlSec": 60},
            ),
        )[0] == 200
        assert request(
            str(socket_path),
            sign(
                seed,
                run_id,
                "trial-supplement",
                proxy_frame({"usage_case": "supplement"}),
            ),
        )[0] == 200
        assert request(
            str(socket_path),
            sign(seed, run_id, "trial-refund", proxy_frame(refund_body)),
        )[0] == 200

        for trial_id, usage_case in (
            ("trial-huge-usage", "huge"),
            ("trial-missing-usage", "missing"),
            ("trial-invalid-usage", "invalid"),
            ("trial-no-retry", "retry"),
        ):
            assert request(
                str(socket_path),
                sign(
                    seed,
                    run_id,
                    trial_id,
                    {"action": "register", "protocol": "openai", "ttlSec": 60},
                ),
            )[0] == 200
            calls_before = ProviderHandler.calls
            assert request(
                str(socket_path),
                sign(
                    seed,
                    run_id,
                    trial_id,
                    proxy_frame({"usage_case": usage_case}),
                ),
            )[0] == 502
            assert ProviderHandler.calls == calls_before + 1
            assert request(
                str(socket_path),
                sign(seed, run_id, trial_id, proxy_frame({})),
            )[0] == 502
            assert ProviderHandler.calls == calls_before + 1

        assert request(
            str(socket_path),
            sign(
                seed,
                run_id,
                "trial-stream",
                {"action": "register", "protocol": "openai", "ttlSec": 60},
            ),
        )[0] == 200
        calls_before = ProviderHandler.calls
        assert request(
            str(socket_path),
            sign(seed, run_id, "trial-stream", proxy_frame({"stream": True})),
        )[0] == 502
        assert ProviderHandler.calls == calls_before

        assert request(
            str(socket_path),
            sign(
                seed,
                run_id,
                "trial-in-flight",
                {"action": "register", "protocol": "openai", "ttlSec": 60},
            ),
        )[0] == 200
        result: list[int] = []
        thread = threading.Thread(
            target=lambda: result.append(
                request(
                    str(socket_path),
                    sign(
                        seed,
                        run_id,
                        "trial-in-flight",
                        proxy_frame({"block_read": True}),
                    ),
                )[0]
            )
        )
        thread.start()
        assert ProviderHandler.read_started.wait(timeout=2)
        assert request(
            str(socket_path),
            sign(seed, run_id, "trial-in-flight", proxy_frame({})),
        )[0] == 502
        calls_before_revoke = ProviderHandler.calls
        revoked_at = time.monotonic()
        assert request(
            str(socket_path),
            sign(seed, run_id, "trial-in-flight", {"action": "revoke"}),
        )[0] == 200
        revoke_elapsed = time.monotonic() - revoked_at
        thread.join(1)
        ProviderHandler.release_read.set()
        assert result == [502]
        assert revoke_elapsed < 1
        assert ProviderHandler.calls == calls_before_revoke

        assert request(
            str(socket_path),
            sign(
                seed,
                run_id,
                "trial-ambiguous",
                {"action": "register", "protocol": "openai", "ttlSec": 60},
            ),
        )[0] == 200
        assert request(
            str(socket_path),
            sign(
                seed,
                run_id,
                "trial-ambiguous",
                proxy_frame({"max_tokens": 8, "max_completion_tokens": 1_000_000}),
            ),
        )[0] == 502
        process.terminate()
        process.wait(timeout=5)

        tls_listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        tls_listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        tls_listener.bind(("127.0.0.1", 0))
        tls_listener.listen(1)
        tls_entered = threading.Event()
        tls_release = threading.Event()
        threading.Thread(
            target=stall_tls_handshake,
            args=(tls_listener, tls_entered, tls_release),
            daemon=True,
        ).start()
        tls_route_path = root / "tls-route.json"
        tls_route_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "modelRouteId": "test/test-model",
                    "providerId": "test",
                    "provider": {
                        "protocol": "openai",
                        "baseURL": f"https://127.0.0.1:{tls_listener.getsockname()[1]}",
                    },
                    "pricing": pricing,
                    "pricingSha256": pricing_sha256,
                }
            )
        )
        tls_socket_path = root / "tls-gateway.sock"
        tls_process = subprocess.Popen(
            [
                sys.executable,
                str(
                    project_root
                    / "benchmarks/terminal_bench_2_1/gateway_supervisor.py"
                ),
                "--socket",
                str(tls_socket_path),
                "--route-config",
                str(tls_route_path),
            ],
            cwd=root,
            env={"PATH": str(Path(sys.executable).parent)},
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        assert tls_process.stdin is not None
        tls_process.stdin.write(
            json.dumps(
                {
                    "providerSecret": "provider-secret-canary",
                    "runId": run_id,
                    "capabilitySeed": seed,
                }
            ).encode()
        )
        tls_process.stdin.close()
        assert tls_process.stdout is not None
        if tls_process.stdout.readline() != b"READY\n":
            raise AssertionError(
                tls_process.stderr.read().decode() if tls_process.stderr else ""
            )
        assert request(
            str(tls_socket_path),
            sign(
                seed,
                run_id,
                "trial-tls",
                {"action": "register", "protocol": "openai", "ttlSec": 60},
            ),
        )[0] == 200
        tls_result: list[int] = []
        tls_thread = threading.Thread(
            target=lambda: tls_result.append(
                request(
                    str(tls_socket_path),
                    sign(seed, run_id, "trial-tls", proxy_frame({})),
                )[0]
            )
        )
        tls_thread.start()
        assert tls_entered.wait(timeout=2)
        tls_revoke_started = time.monotonic()
        assert request(
            str(tls_socket_path),
            sign(seed, run_id, "trial-tls", {"action": "revoke"}),
        )[0] == 200
        tls_revoke_elapsed = time.monotonic() - tls_revoke_started
        tls_thread.join(1)
        tls_release.set()
        assert tls_result == [502]
        assert tls_revoke_elapsed < 1
        tls_process.terminate()
        tls_process.wait(timeout=5)
        tls_listener.close()
    provider.shutdown()
    provider.server_close()
    print("Gateway supervisor security E2E passed")


if __name__ == "__main__":
    main()

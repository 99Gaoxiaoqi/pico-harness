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
    last_request_body: dict[str, Any] | None = None
    read_started = threading.Event()
    release_read = threading.Event()

    def do_POST(self) -> None:
        type(self).calls += 1
        body = self.rfile.read(int(self.headers.get("content-length", "0")))
        request_body = json.loads(body)
        type(self).last_request_body = request_body
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


def sign(
    seed: str,
    run_id: str,
    trial_id: str,
    value: dict[str, Any],
    auth_ttl_sec: int = 60,
) -> dict[str, Any]:
    now = int(time.time())
    auth = {
        "runId": run_id,
        "trialId": trial_id,
        "nonce": secrets.token_hex(16),
        "issuedAt": now,
        "expiresAt": now + auth_ttl_sec,
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


def proxy_frame(
    body: dict[str, Any], *, output_token_field: str = "max_tokens"
) -> dict[str, Any]:
    return {
        "action": "proxy",
        "protocol": "openai",
        "path": "/chat/completions",
        "headers": {"content-type": "application/json"},
        "body": base64.b64encode(
            json.dumps(
                {"model": "test-model", output_token_field: 8, **body}
            ).encode()
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
    invalid = (
        (b'{"usage":{"prompt_tokens":true,"completion_tokens":1}}', "openai"),
        (b'{"usage":{"input_tokens":-1,"output_tokens":1}}', "claude"),
        (b"{}", "gemini"),
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


def assert_removed_provider_protocol_is_rejected(
    gateway: Any, route_config: dict[str, Any]
) -> None:
    candidate = json.loads(json.dumps(route_config))
    candidate["provider"]["protocol"] = "gemini"
    try:
        gateway.GatewayState(
            candidate,
            "provider-secret-canary",
            "removed-provider-protocol",
            "9" * 64,
        )
    except ValueError as error:
        assert str(error) == "gateway provider protocol is unsupported"
    else:
        raise AssertionError("removed provider protocol was accepted")


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
    assert active.reaped()


def assert_spawn_revoke_race(
    gateway: Any, route_config: dict[str, Any]
) -> None:
    original_popen = gateway.subprocess.Popen
    spawn_entered = threading.Event()
    release_spawn = threading.Event()

    def blocked_popen(*args: Any, **kwargs: Any) -> Any:
        spawn_entered.set()
        assert release_spawn.wait(timeout=2)
        return original_popen(*args, **kwargs)

    gateway.subprocess.Popen = blocked_popen
    state = gateway.GatewayState(
        route_config,
        "provider-secret-canary",
        "spawn-revoke",
        "4" * 64,
    )
    active = gateway.UpstreamRequest(
        [sys.executable, "-c", "import sys; sys.stdin.buffer.read()"]
    )
    state.upstream_request_factory = lambda: active
    state.register(
        {
            "trialId": "trial-spawn-revoke",
            "action": "register",
            "protocol": "openai",
            "ttlSec": 60,
        }
    )
    proxy_outcome: list[str] = []
    revoke_outcome: list[dict[str, Any]] = []

    def execute_proxy() -> None:
        try:
            state.proxy({"trialId": "trial-spawn-revoke", **proxy_frame({})})
            proxy_outcome.append("success")
        except Exception:
            proxy_outcome.append("rejected")

    def execute_revoke() -> None:
        revoke_outcome.append(state.revoke("trial-spawn-revoke"))

    proxy_thread = threading.Thread(target=execute_proxy)
    revoke_thread = threading.Thread(target=execute_revoke)
    try:
        proxy_thread.start()
        assert spawn_entered.wait(timeout=1)
        revoke_thread.start()
        time.sleep(0.05)
        assert revoke_thread.is_alive()
        release_spawn.set()
        proxy_thread.join(1)
        revoke_thread.join(1)
    finally:
        gateway.subprocess.Popen = original_popen
        release_spawn.set()
    assert proxy_outcome == ["rejected"]
    assert len(revoke_outcome) == 1
    assert revoke_outcome[0]["status"] == "unreconciled"
    assert active.reaped()
    with state.lock:
        assert state.trials["trial-spawn-revoke"]["active"] == set()


def assert_stubborn_worker_revoke_fails_closed(
    gateway: Any, route_config: dict[str, Any]
) -> None:
    class StubbornProcess:
        def __init__(self) -> None:
            self.terminate_calls = 0
            self.kill_calls = 0

        def poll(self) -> None:
            return None

        def terminate(self) -> None:
            self.terminate_calls += 1

        def kill(self) -> None:
            self.kill_calls += 1

        def wait(self, timeout: float) -> None:
            raise subprocess.TimeoutExpired("stubborn-worker", timeout)

    state = gateway.GatewayState(
        route_config,
        "provider-secret-canary",
        "stubborn-worker",
        "3" * 64,
    )
    state.register(
        {
            "trialId": "trial-stubborn",
            "action": "register",
            "protocol": "openai",
            "ttlSec": 60,
        }
    )
    active = gateway.UpstreamRequest()
    process = StubbornProcess()
    active.process = process
    with state.lock:
        state.trials["trial-stubborn"]["active"].add(active)
    try:
        state.revoke("trial-stubborn")
    except ValueError as error:
        assert "termination was not confirmed" in str(error)
    else:
        raise AssertionError("revoke succeeded before the worker was reaped")
    with state.lock:
        assert active in state.trials["trial-stubborn"]["active"]
    assert process.poll() is None
    assert process.terminate_calls == 1
    assert process.kill_calls == 1


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
    assert state.proxy({"trialId": "trial-exact", **proxy_frame({})})["status"] == 200
    with state.lock:
        trial = state.trials["trial-exact"]
        assert trial["inputTokensRemaining"] == gateway.MAX_INPUT_TOKENS - 10_000
        assert trial["outputTokensRemaining"] == gateway.MAX_OUTPUT_TOKENS - 2
        assert trial["costMicroCNYRemaining"] == (
            gateway.MAX_COST_MICRO_CNY
            - 2 * gateway.token_cost_micro_cny(5_000, 1, state.pricing)
        )
    receipt = state.revoke("trial-exact")
    assert receipt == state.revoke("trial-exact")
    actual_cost = gateway.token_cost_micro_cny(5_000, 1, state.pricing)
    assert receipt["status"] == "reconciled"
    assert receipt["withinBudget"] is True
    assert receipt["requests"] == {
        "attempted": 2,
        "reconciled": 2,
        "unreconciled": 0,
    }
    assert receipt["actual"] == {
        "inputTokens": 10_000,
        "outputTokens": 2,
        "costMicroCNY": actual_cost * 2,
        "costCNY": actual_cost * 2 / 1_000_000,
    }
    assert len(receipt["requestEntries"]) == 2
    for sequence, entry in enumerate(receipt["requestEntries"], start=1):
        assert entry["sequence"] == sequence
        assert entry["status"] == "reconciled"
        assert entry["actual"] == {
            "inputTokens": 5_000,
            "outputTokens": 1,
            "costMicroCNY": actual_cost,
        }
    for field in ("inputTokens", "outputTokens", "costMicroCNY"):
        assert (
            receipt["reservation"][field]
            + receipt["supplement"][field]
            - receipt["refund"][field]
            - receipt["unreconciledReservation"][field]
            == receipt["actual"][field]
        )
    assert receipt["receiptSha256"] == hashlib.sha256(
        gateway.canonical_accounting_receipt(receipt, include_auth=True)
    ).hexdigest()
    assert receipt["auth"]["tag"] == hmac.new(
        ("2" * 64).encode(),
        b"pico-gateway-accounting-receipt-v1\0"
        + gateway.canonical_accounting_receipt(receipt, include_auth=False),
        "sha256",
    ).hexdigest()


def request_reservation_cost(
    gateway: Any,
    state: Any,
    frame: dict[str, Any],
) -> int:
    body = base64.b64decode(frame["body"], validate=True)
    bounded_body, output_limit = gateway.bound_request(
        body,
        frame["path"],
        frame["protocol"],
        state.model,
        strict_output_limit=state.strict_request_output_limit,
    )
    return gateway.token_cost_micro_cny(
        len(bounded_body) + gateway.INPUT_RESERVATION_MARGIN_TOKENS,
        output_limit,
        state.pricing,
    )


def upstream_result(input_tokens: int, output_tokens: int) -> dict[str, Any]:
    response_body = json.dumps(
        {
            "choices": [{"message": {"content": "ok"}}],
            "usage": {
                "prompt_tokens": input_tokens,
                "completion_tokens": output_tokens,
                "total_tokens": input_tokens + output_tokens,
            },
        },
        separators=(",", ":"),
    ).encode()
    return {
        "status": 200,
        "headers": [["content-type", "application/json"]],
        "body": base64.b64encode(response_body).decode(),
    }


def assert_run_budget_contract(
    gateway: Any,
    route_config: dict[str, Any],
) -> None:
    invalid_budgets: tuple[Any, ...] = (
        None,
        {},
        {"currency": "USD", "maxCostMicroCNY": 1},
        {"currency": "CNY", "maxCostMicroCNY": 1, "extra": True},
        {"currency": "CNY", "maxCostMicroCNY": True},
        {"currency": "CNY", "maxCostMicroCNY": -1},
        {"currency": "CNY", "maxCostMicroCNY": 1.5},
        {"currency": "CNY", "maxCostMicroCNY": "1"},
        {
            "currency": "CNY",
            "maxCostMicroCNY": gateway.MAX_RUN_COST_MICRO_CNY + 1,
        },
    )
    for index, run_budget in enumerate(invalid_budgets):
        candidate = json.loads(json.dumps(route_config))
        if run_budget is None:
            candidate.pop("runBudget")
        else:
            candidate["runBudget"] = run_budget
        try:
            gateway.GatewayState(
                candidate,
                "provider-secret-canary",
                f"invalid-run-budget-{index}",
                "5" * 64,
            )
        except ValueError:
            pass
        else:
            raise AssertionError(f"invalid run budget was accepted: {run_budget!r}")

    zero_budget = json.loads(json.dumps(route_config))
    zero_budget["runBudget"]["maxCostMicroCNY"] = 0
    state = gateway.GatewayState(
        zero_budget,
        "provider-secret-canary",
        "zero-run-budget",
        "6" * 64,
    )
    assert state.run_budget_max_cost_micro_cny == 0
    assert state.run_cost_micro_cny_remaining == 0


def assert_benchmark_output_capability_contract(
    gateway: Any,
    route_config: dict[str, Any],
) -> None:
    def benchmark_route(model: str) -> dict[str, Any]:
        pricing, pricing_sha256 = pricing_contract("codex-oauth", model)
        pinned_route = json.loads(json.dumps(route_config))
        pinned_route["modelRouteId"] = f"codex-oauth/{model}"
        pinned_route["providerId"] = "codex-oauth"
        pinned_route["provider"] = {
            "protocol": "openai",
            "baseURL": route_config["provider"]["baseURL"],
            "models": [model],
            "discoverModels": False,
            "modelCapabilities": {
                model: {
                    "output": gateway.MAX_REQUEST_OUTPUT_TOKENS,
                    "outputTokenField": "max_completion_tokens",
                    "toolCall": True,
                }
            },
        }
        pinned_route["pricing"] = pricing
        pinned_route["pricingSha256"] = pricing_sha256
        return pinned_route

    invalid_capabilities: tuple[dict[str, Any] | None, ...] = (
        None,
        {"outputTokenField": "max_completion_tokens"},
        {"output": 4_096, "outputTokenField": "max_completion_tokens"},
        {"output": 8_193, "outputTokenField": "max_completion_tokens"},
        {"output": 8_192, "outputTokenField": "max_tokens"},
    )
    for model in ("gpt-5.4", "gpt-5.6-terra"):
        pinned_route = benchmark_route(model)
        state = gateway.GatewayState(
            pinned_route,
            "provider-secret-canary",
            f"valid-benchmark-output-capability-{model}",
            "6" * 64,
        )
        assert (
            state.provider["modelCapabilities"][model]["output"]
            == gateway.MAX_REQUEST_OUTPUT_TOKENS
            == 8_192
        )
        assert state.strict_request_output_limit is True
        bounded_body, output_limit = gateway.bound_request(
            json.dumps(
                {
                    "model": model,
                    "max_completion_tokens": 8_192,
                }
            ).encode(),
            "/chat/completions",
            "openai",
            state.model,
            strict_output_limit=state.strict_request_output_limit,
        )
        assert output_limit == 8_192
        assert json.loads(bounded_body)["max_completion_tokens"] == 8_192
        try:
            gateway.bound_request(
                json.dumps(
                    {
                        "model": model,
                        "max_completion_tokens": 8_193,
                    }
                ).encode(),
                "/chat/completions",
                "openai",
                state.model,
                strict_output_limit=state.strict_request_output_limit,
            )
        except ValueError as error:
            assert str(error) == "gateway output token limit is invalid"
        else:
            raise AssertionError(
                f"{model} pinned route accepted output above its hard limit"
            )

        for index, capability in enumerate(invalid_capabilities):
            candidate = json.loads(json.dumps(pinned_route))
            if capability is None:
                candidate["provider"].pop("modelCapabilities")
            else:
                candidate["provider"]["modelCapabilities"][model] = capability
            try:
                gateway.GatewayState(
                    candidate,
                    "provider-secret-canary",
                    f"invalid-benchmark-output-capability-{model}-{index}",
                    "6" * 64,
                )
            except ValueError as error:
                assert str(error) == (
                    f"codex-oauth/{model} benchmark route must pin output=8192 "
                    "and use max_completion_tokens"
                )
            else:
                raise AssertionError(
                    "invalid benchmark output capability was accepted: "
                    f"{model!r}, {capability!r}"
                )

    compatible = gateway.GatewayState(
        route_config,
        "provider-secret-canary",
        "compatible-output-capability",
        "6" * 64,
    )
    assert compatible.strict_request_output_limit is False
    bounded_body, output_limit = gateway.bound_request(
        json.dumps(
            {
                "model": compatible.model,
                "max_tokens": 32_768,
            }
        ).encode(),
        "/chat/completions",
        "openai",
        compatible.model,
        strict_output_limit=compatible.strict_request_output_limit,
    )
    assert output_limit == 8_192
    assert json.loads(bounded_body)["max_tokens"] == 8_192
    for invalid_output in (0, -1, True, "8192", 8_192.0, None):
        try:
            gateway.bound_request(
                json.dumps(
                    {
                        "model": compatible.model,
                        "max_tokens": invalid_output,
                    }
                ).encode(),
                "/chat/completions",
                "openai",
                compatible.model,
                strict_output_limit=compatible.strict_request_output_limit,
            )
        except ValueError as error:
            assert str(error) == "gateway output token limit is invalid"
        else:
            raise AssertionError(
                f"compatible route accepted invalid output limit: {invalid_output!r}"
            )


def assert_atomic_run_budget_and_refund(
    gateway: Any,
    route_config: dict[str, Any],
) -> None:
    frame = proxy_frame({})
    probe = gateway.GatewayState(
        route_config,
        "provider-secret-canary",
        "run-budget-probe",
        "7" * 64,
    )
    reservation_cost = request_reservation_cost(gateway, probe, frame)
    actual_cost = gateway.token_cost_micro_cny(2, 1, probe.pricing)
    assert reservation_cost > actual_cost

    budgeted_route = json.loads(json.dumps(route_config))
    budgeted_route["runBudget"]["maxCostMicroCNY"] = (
        reservation_cost + actual_cost
    )
    state = gateway.GatewayState(
        budgeted_route,
        "provider-secret-canary",
        "atomic-run-budget",
        "8" * 64,
    )
    entered = threading.Event()
    release = threading.Event()
    execute_lock = threading.Lock()
    execute_calls: list[dict[str, Any]] = []

    class ControlledUpstream:
        def execute(self, payload: dict[str, Any]) -> dict[str, Any]:
            with execute_lock:
                sequence = len(execute_calls)
                execute_calls.append(payload)
            if sequence == 0:
                entered.set()
                assert release.wait(timeout=2)
            return upstream_result(2, 1)

        def cancel(self, _deadline: float | None = None) -> None:
            release.set()

    state.upstream_request_factory = ControlledUpstream
    for trial_id in ("trial-atomic-a", "trial-atomic-b"):
        state.register(
            {
                "trialId": trial_id,
                "action": "register",
                "protocol": "openai",
                "ttlSec": 60,
            }
        )

    first_outcome: list[str] = []

    def execute_first() -> None:
        try:
            state.proxy({"trialId": "trial-atomic-a", **frame})
            first_outcome.append("success")
        except Exception:
            first_outcome.append("rejected")

    first_thread = threading.Thread(target=execute_first)
    first_thread.start()
    assert entered.wait(timeout=1)
    try:
        state.proxy({"trialId": "trial-atomic-b", **frame})
    except ValueError as error:
        assert str(error) == "gateway run budget exhausted"
    else:
        raise AssertionError("overlapping trials oversold the aggregate run budget")
    assert len(execute_calls) == 1
    denied_receipt = state.revoke("trial-atomic-b")
    assert denied_receipt["withinBudget"] is False
    assert denied_receipt["requests"]["attempted"] == 0

    release.set()
    first_thread.join(1)
    assert first_outcome == ["success"]
    state.register(
        {
            "trialId": "trial-after-refund",
            "action": "register",
            "protocol": "openai",
            "ttlSec": 60,
        }
    )
    assert state.proxy({"trialId": "trial-after-refund", **frame})["status"] == 200
    assert len(execute_calls) == 2
    with state.lock:
        assert state.run_cost_micro_cny_remaining == (
            reservation_cost - actual_cost
        )
        assert state.run_budget_closed is False
    assert state.revoke("trial-atomic-a")["withinBudget"] is True
    assert state.revoke("trial-after-refund")["withinBudget"] is True


def assert_run_budget_overrun_closes_run(
    gateway: Any,
    route_config: dict[str, Any],
) -> None:
    frame = proxy_frame({})
    probe = gateway.GatewayState(
        route_config,
        "provider-secret-canary",
        "run-budget-overrun-probe",
        "9" * 64,
    )
    reservation_cost = request_reservation_cost(gateway, probe, frame)
    actual_cost = gateway.token_cost_micro_cny(5_000, 1, probe.pricing)
    assert actual_cost > reservation_cost

    budgeted_route = json.loads(json.dumps(route_config))
    budgeted_route["runBudget"]["maxCostMicroCNY"] = reservation_cost
    state = gateway.GatewayState(
        budgeted_route,
        "provider-secret-canary",
        "run-budget-overrun",
        "a" * 64,
    )
    execute_calls = 0

    class SupplementingUpstream:
        def execute(self, _payload: dict[str, Any]) -> dict[str, Any]:
            nonlocal execute_calls
            execute_calls += 1
            return upstream_result(5_000, 1)

        def cancel(self, _deadline: float | None = None) -> None:
            pass

    state.upstream_request_factory = SupplementingUpstream
    state.register(
        {
            "trialId": "trial-run-overrun",
            "action": "register",
            "protocol": "openai",
            "ttlSec": 60,
        }
    )
    try:
        state.proxy({"trialId": "trial-run-overrun", **frame})
    except ValueError as error:
        assert str(error) == "gateway response usage exceeds quota"
    else:
        raise AssertionError("aggregate run budget supplement was accepted")
    with state.lock:
        assert state.run_budget_closed is True
        assert state.run_cost_micro_cny_remaining == (
            reservation_cost - actual_cost
        )

    state.register(
        {
            "trialId": "trial-after-overrun",
            "action": "register",
            "protocol": "openai",
            "ttlSec": 60,
        }
    )
    try:
        state.proxy({"trialId": "trial-after-overrun", **frame})
    except ValueError as error:
        assert str(error) == "gateway run budget exhausted"
    else:
        raise AssertionError("closed aggregate run budget sent another request")
    assert execute_calls == 1

    overrun_receipt = state.revoke("trial-run-overrun")
    assert overrun_receipt["status"] == "reconciled"
    assert overrun_receipt["withinBudget"] is False
    assert overrun_receipt["actual"]["costMicroCNY"] == actual_cost
    denied_receipt = state.revoke("trial-after-overrun")
    assert denied_receipt["withinBudget"] is False
    assert denied_receipt["requests"]["attempted"] == 0


def main() -> None:
    project_root = Path(__file__).resolve().parents[2]
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))
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
            "runBudget": {
                "currency": "CNY",
                "maxCostMicroCNY": 10_000_000_000,
            },
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
        assert_removed_provider_protocol_is_rejected(gateway, route_config)
        assert_spawn_cancel_race(gateway)
        assert_spawn_revoke_race(gateway, route_config)
        assert_stubborn_worker_revoke_fails_closed(gateway, route_config)
        assert_exact_reconciliation(gateway, route_config)
        assert_run_budget_contract(gateway, route_config)
        assert_benchmark_output_capability_contract(gateway, route_config)
        assert_atomic_run_budget_and_refund(gateway, route_config)
        assert_run_budget_overrun_closes_run(gateway, route_config)
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

        assert gateway.MAX_TRIAL_TTL_SEC == 12_000
        assert request(
            str(socket_path),
            sign(
                seed,
                run_id,
                "trial-maximum-ttl",
                {
                    "action": "register",
                    "protocol": "openai",
                    "ttlSec": gateway.MAX_TRIAL_TTL_SEC,
                },
                auth_ttl_sec=gateway.MAX_TRIAL_TTL_SEC,
            ),
        )[0] == 200
        assert request(
            str(socket_path),
            sign(
                seed,
                run_id,
                "trial-over-maximum-ttl",
                {
                    "action": "register",
                    "protocol": "openai",
                    "ttlSec": gateway.MAX_TRIAL_TTL_SEC + 1,
                },
            ),
        )[0] == 502
        assert request(
            str(socket_path),
            sign(
                seed,
                run_id,
                "trial-over-maximum-auth-ttl",
                {"action": "register", "protocol": "openai", "ttlSec": 60},
                auth_ttl_sec=gateway.MAX_TRIAL_TTL_SEC + 30,
            ),
        )[0] == 502

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
            sign(
                seed,
                run_id,
                "trial-completion-limit",
                {"action": "register", "protocol": "openai", "ttlSec": 60},
            ),
        )[0] == 200
        assert request(
            str(socket_path),
            sign(
                seed,
                run_id,
                "trial-completion-limit",
                proxy_frame({}, output_token_field="max_completion_tokens"),
            ),
        )[0] == 200
        assert ProviderHandler.calls == 2
        assert ProviderHandler.last_request_body is not None
        assert ProviderHandler.last_request_body["max_completion_tokens"] == 8
        assert "max_tokens" not in ProviderHandler.last_request_body

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
        assert ProviderHandler.calls == 2

        assert request(
            str(socket_path),
            sign(
                seed,
                run_id,
                "trial-output-hard-limit",
                {"action": "register", "protocol": "openai", "ttlSec": 60},
            ),
        )[0] == 200
        calls_before_output_limit = ProviderHandler.calls
        assert request(
            str(socket_path),
            sign(
                seed,
                run_id,
                "trial-output-hard-limit",
                proxy_frame(
                    {"max_completion_tokens": 8_192},
                    output_token_field="max_completion_tokens",
                ),
            ),
        )[0] == 200
        assert ProviderHandler.calls == calls_before_output_limit + 1
        assert ProviderHandler.last_request_body is not None
        assert ProviderHandler.last_request_body["max_completion_tokens"] == 8_192
        assert request(
            str(socket_path),
            sign(
                seed,
                run_id,
                "trial-output-hard-limit",
                proxy_frame(
                    {"max_completion_tokens": 32_768},
                    output_token_field="max_completion_tokens",
                ),
            ),
        )[0] == 200
        assert ProviderHandler.calls == calls_before_output_limit + 2
        assert ProviderHandler.last_request_body is not None
        assert ProviderHandler.last_request_body["max_completion_tokens"] == 8_192
        for invalid_output in (0, "8192"):
            assert request(
                str(socket_path),
                sign(
                    seed,
                    run_id,
                    "trial-output-hard-limit",
                    proxy_frame(
                        {"max_completion_tokens": invalid_output},
                        output_token_field="max_completion_tokens",
                    ),
                ),
            )[0] == 502
        assert ProviderHandler.calls == calls_before_output_limit + 2

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
                    "runBudget": {
                        "currency": "CNY",
                        "maxCostMicroCNY": 10_000_000_000,
                    },
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

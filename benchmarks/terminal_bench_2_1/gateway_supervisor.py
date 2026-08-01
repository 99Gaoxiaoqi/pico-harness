from __future__ import annotations

import argparse
import base64
import ctypes
import hashlib
import hmac
import http.client
import json
import math
import os
import re
import signal
import socket
import socketserver
import struct
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

try:
    from benchmarks.terminal_bench_2_1.runtime_limits import (
        MAX_TASK_AGENT_TIMEOUT_SEC,
    )
except ModuleNotFoundError:
    from runtime_limits import MAX_TASK_AGENT_TIMEOUT_SEC

MAX_FRAME_BYTES = 16 * 1024 * 1024
MAX_RESPONSE_BYTES = 64 * 1024 * 1024
MAX_REQUEST_BODY_BYTES = 1_000_000
AUTH_WINDOW_SEC = 300
MAX_TRIAL_TTL_SEC = MAX_TASK_AGENT_TIMEOUT_SEC
MAX_REQUESTS = 128
MAX_INPUT_TOKENS = 1_000_000
MAX_OUTPUT_TOKENS = 65_536
MAX_REQUEST_OUTPUT_TOKENS = 8_192
MAX_COST_MICRO_CNY = 250_000_000
MAX_RUN_COST_MICRO_CNY = 1_000_000_000_000
MAX_PRICE_MICRO_CNY_PER_MILLION = 1_000_000_000_000
INPUT_ESTIMATION_ASCII_CHARS_PER_TOKEN = 4
INPUT_RESERVATION_MARGIN_TOKENS = 1_024
UPSTREAM_TIMEOUT_SEC = 120
REVOKE_DEADLINE_SEC = 0.75
_PINNED_BENCHMARK_OUTPUT_CAPABILITIES = {
    "codex-oauth/gpt-5.4": ("max_completion_tokens", MAX_REQUEST_OUTPUT_TOKENS),
    "codex-oauth/gpt-5.6-terra": (
        "max_completion_tokens",
        MAX_REQUEST_OUTPUT_TOKENS,
    ),
}


class GatewayError(ValueError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


class GatewayQuotaError(GatewayError):
    pass


class UpstreamRequest:
    def __init__(self, worker_command: list[str] | None = None):
        self.lock = threading.Lock()
        self.process: subprocess.Popen[bytes] | None = None
        self.cancelled = False
        self.worker_command = worker_command

    def execute(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self.lock:
            if self.cancelled:
                raise ValueError("gateway upstream request was cancelled")
        process = subprocess.Popen(
            self.worker_command
            or [sys.executable, str(Path(__file__).resolve()), "--upstream-worker"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env={
                "PATH": str(Path(sys.executable).parent),
                "PYTHONUNBUFFERED": "1",
            },
            start_new_session=True,
        )
        with self.lock:
            cancelled = self.cancelled
            self.process = process
        if cancelled:
            if not terminate_process(process, time.monotonic() + 0.4):
                raise ValueError("gateway upstream worker termination was not confirmed")
            raise ValueError("gateway upstream request was cancelled")
        try:
            try:
                stdout, _ = process.communicate(
                    input=canonical_json(payload), timeout=UPSTREAM_TIMEOUT_SEC
                )
            except subprocess.TimeoutExpired as error:
                self.cancel()
                raise ValueError("gateway upstream request timed out") from error
            with self.lock:
                cancelled = self.cancelled
            if cancelled:
                raise ValueError("gateway upstream request was cancelled")
            if process.returncode != 0 or len(stdout) > MAX_RESPONSE_BYTES * 2:
                raise ValueError("gateway upstream worker failed")
            value = json.loads(stdout)
            if not isinstance(value, dict) or set(value) != {
                "status",
                "headers",
                "body",
            }:
                raise ValueError("gateway upstream worker returned an invalid frame")
            return value
        finally:
            with self.lock:
                if self.process is process and process.poll() is not None:
                    self.process = None

    def cancel(self, deadline: float | None = None) -> None:
        with self.lock:
            self.cancelled = True
            process = self.process
        if process is None or process.poll() is not None:
            return
        if not terminate_process(process, deadline):
            raise ValueError("gateway upstream worker termination was not confirmed")

    def reaped(self) -> bool:
        with self.lock:
            process = self.process
        return process is None or process.poll() is not None


class GatewayState:
    def __init__(
        self,
        route_config: dict[str, Any],
        provider_secret: str,
        run_id: str,
        capability_seed: str,
    ):
        require_benchmark_route_contract(route_config)
        provider = route_config.get("provider")
        if (
            not isinstance(provider, dict)
            or provider.get("protocol") not in {"openai", "claude"}
        ):
            raise ValueError("gateway provider protocol is unsupported")
        self.provider = provider
        self.model = route_config["modelRouteId"].split("/", 1)[1]
        self.pricing, self.pricing_sha256 = require_pricing(route_config, self.model)
        self.pricing_descriptor = dict(route_config["pricing"])
        self.run_budget_max_cost_micro_cny = require_run_budget(route_config)
        self.run_cost_micro_cny_remaining = self.run_budget_max_cost_micro_cny
        self.run_budget_closed = False
        self.model_route_id = route_config["modelRouteId"]
        self.strict_request_output_limit = (
            self.model_route_id in _PINNED_BENCHMARK_OUTPUT_CAPABILITIES
        )
        self.provider_secret = provider_secret
        self.run_id = run_id
        self.capability_seed = capability_seed
        self.owner_uid = os.getuid()
        self.lock = threading.Lock()
        self.condition = threading.Condition(self.lock)
        self.upstream_request_factory = UpstreamRequest
        self.trials: dict[str, dict[str, Any]] = {}
        self.nonces: set[str] = set()

    def authenticate(self, request: dict[str, Any], peer_uid: int) -> None:
        if peer_uid != self.owner_uid:
            raise ValueError("gateway supervisor peer identity mismatch")
        auth = request.get("auth")
        if not isinstance(auth, dict) or set(auth) != {
            "runId",
            "trialId",
            "nonce",
            "issuedAt",
            "expiresAt",
            "signature",
        }:
            raise ValueError("invalid supervisor authentication frame")
        if auth["runId"] != self.run_id or auth["trialId"] != request.get("trialId"):
            raise ValueError("supervisor authentication identity mismatch")
        now = int(time.time())
        issued_at = int(auth["issuedAt"])
        expires_at = int(auth["expiresAt"])
        if (
            issued_at > now + 5
            or issued_at < now - AUTH_WINDOW_SEC
            or expires_at < now
            or expires_at > now + MAX_TRIAL_TTL_SEC
            or not re.fullmatch(r"[0-9a-f]{32}", str(auth["nonce"]))
        ):
            raise ValueError("expired supervisor authentication")
        signature = str(auth["signature"])
        unsigned = dict(request)
        unsigned_auth = dict(auth)
        unsigned_auth.pop("signature")
        unsigned["auth"] = unsigned_auth
        expected = hmac.new(
            self.capability_seed.encode(),
            canonical_json(unsigned),
            "sha256",
        ).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise ValueError("invalid supervisor authentication")
        with self.lock:
            if auth["nonce"] in self.nonces:
                raise ValueError("replayed supervisor authentication")
            self.nonces.add(auth["nonce"])

    def register(self, request: dict[str, Any]) -> None:
        trial_id = require_trial_id(request.get("trialId"))
        ttl_sec = request.get("ttlSec")
        if (
            request.get("protocol") != self.provider["protocol"]
            or isinstance(ttl_sec, bool)
            or not isinstance(ttl_sec, (int, float))
            or not math.isfinite(ttl_sec)
            or ttl_sec <= 0
            or ttl_sec > MAX_TRIAL_TTL_SEC
        ):
            raise ValueError("gateway route mismatch")
        with self.lock:
            if trial_id in self.trials:
                raise ValueError("gateway trial is already registered")
            self.trials[trial_id] = {
                "expiresAt": time.monotonic() + ttl_sec,
                "requestsRemaining": MAX_REQUESTS,
                "inputTokensRemaining": MAX_INPUT_TOKENS,
                "outputTokensRemaining": MAX_OUTPUT_TOKENS,
                "costMicroCNYRemaining": MAX_COST_MICRO_CNY,
                "pricingSha256": self.pricing_sha256,
                "revoked": False,
                "active": set(),
                "accounting": new_accounting(),
                "withinBudget": True,
                "receipt": None,
            }

    def proxy(self, request: dict[str, Any]) -> dict[str, Any]:
        trial_id = require_trial_id(request.get("trialId"))
        protocol = request.get("protocol")
        if protocol != self.provider["protocol"]:
            raise ValueError("gateway route mismatch")
        body = base64.b64decode(request.get("body", ""), validate=True)
        if len(body) > MAX_REQUEST_BODY_BYTES:
            raise GatewayError(
                "request_body_too_large",
                "gateway request exceeds body limit",
            )
        path = require_path(request.get("path"), protocol)
        bounded_body, output_limit = bound_request(
            body,
            path,
            protocol,
            self.model,
            strict_output_limit=self.strict_request_output_limit,
        )
        if len(bounded_body) > MAX_REQUEST_BODY_BYTES:
            raise GatewayError(
                "request_body_too_large",
                "gateway request exceeds body limit",
            )
        estimated_input_tokens = estimate_request_input_tokens(bounded_body)
        required_input_reservation = (
            estimated_input_tokens + INPUT_RESERVATION_MARGIN_TOKENS
        )
        active = self.upstream_request_factory()
        with self.lock:
            trial = self.trials.get(trial_id)
            if trial is None:
                raise ValueError("gateway trial is not registered")
            input_reservation = min(
                trial["inputTokensRemaining"],
                required_input_reservation,
            )
            cost_input_reservation = (
                len(bounded_body) + INPUT_RESERVATION_MARGIN_TOKENS
            )
            cost_reservation = token_cost_micro_cny(
                cost_input_reservation, output_limit, self.pricing
            )
            if trial["revoked"]:
                raise GatewayQuotaError(
                    "trial_revoked",
                    "gateway trial quota exhausted",
                )
            if time.monotonic() >= trial["expiresAt"]:
                raise GatewayQuotaError(
                    "trial_expired",
                    "gateway trial quota exhausted",
                )
            if trial["requestsRemaining"] <= 0:
                raise GatewayQuotaError(
                    "trial_request_quota_exhausted",
                    "gateway trial quota exhausted",
                )
            if input_reservation < required_input_reservation:
                raise GatewayQuotaError(
                    "trial_input_quota_exhausted",
                    "gateway trial quota exhausted",
                )
            if trial["outputTokensRemaining"] < output_limit:
                raise GatewayQuotaError(
                    "trial_output_quota_exhausted",
                    "gateway trial quota exhausted",
                )
            if trial["costMicroCNYRemaining"] < cost_reservation:
                raise GatewayQuotaError(
                    "trial_cost_quota_exhausted",
                    "gateway trial quota exhausted",
                )
            if trial["active"]:
                raise GatewayQuotaError(
                    "trial_request_in_flight",
                    "gateway trial quota exhausted",
                )
            if (
                self.run_budget_closed
                or self.run_cost_micro_cny_remaining < cost_reservation
            ):
                trial["revoked"] = True
                trial["withinBudget"] = False
                raise GatewayQuotaError(
                    "run_cost_quota_exhausted",
                    "gateway run budget exhausted",
                )
            trial["requestsRemaining"] -= 1
            trial["inputTokensRemaining"] -= input_reservation
            trial["outputTokensRemaining"] -= output_limit
            trial["costMicroCNYRemaining"] -= cost_reservation
            self.run_cost_micro_cny_remaining -= cost_reservation
            trial["active"].add(active)
            accounting = trial["accounting"]
            accounting["requests"]["attempted"] += 1
            request_accounting = {
                "sequence": accounting["requests"]["attempted"],
                "status": "pending",
                "reservation": accounting_bucket(
                    input_reservation, output_limit, cost_reservation
                ),
                "actual": zero_accounting_bucket(),
                "refund": zero_accounting_bucket(),
                "supplement": zero_accounting_bucket(),
                "unreconciledReservation": zero_accounting_bucket(),
            }
            accounting["requestEntries"].append(request_accounting)
            add_accounting(
                accounting["reservation"],
                input_reservation,
                output_limit,
                cost_reservation,
            )
        try:
            upstream = active.execute(
                {
                    "baseURL": self.provider["baseURL"],
                    "protocol": protocol,
                    "providerSecret": self.provider_secret,
                    "path": path,
                    "body": base64.b64encode(bounded_body).decode(),
                    "headers": request.get("headers"),
                }
            )
            status, response_headers, response_body = decode_upstream_result(upstream)
            if status < 200 or status >= 300:
                raise ValueError("gateway does not retry upstream responses")
            actual_input, actual_output = parse_usage(response_body, protocol)
            actual_cost = token_cost_micro_cny(
                actual_input, actual_output, self.pricing
            )
            response = {
                "status": status,
                "headers": [
                    [name, value]
                    for name, value in response_headers
                    if name.lower()
                    in {
                        "content-type",
                        "retry-after",
                        "x-ratelimit-limit-requests",
                        "x-ratelimit-remaining-requests",
                        "x-ratelimit-reset-requests",
                    }
                ],
                "body": base64.b64encode(response_body).decode(),
            }
            with self.condition:
                trial["inputTokensRemaining"] += input_reservation - actual_input
                trial["outputTokensRemaining"] += output_limit - actual_output
                trial["costMicroCNYRemaining"] += cost_reservation - actual_cost
                self.run_cost_micro_cny_remaining += (
                    cost_reservation - actual_cost
                )
                accounting = trial["accounting"]
                accounting["requests"]["reconciled"] += 1
                request_accounting["status"] = "reconciled"
                request_accounting["actual"] = accounting_bucket(
                    actual_input, actual_output, actual_cost
                )
                request_accounting["refund"] = accounting_bucket(
                    max(input_reservation - actual_input, 0),
                    max(output_limit - actual_output, 0),
                    max(cost_reservation - actual_cost, 0),
                )
                request_accounting["supplement"] = accounting_bucket(
                    max(actual_input - input_reservation, 0),
                    max(actual_output - output_limit, 0),
                    max(actual_cost - cost_reservation, 0),
                )
                add_accounting(
                    accounting["actual"],
                    actual_input,
                    actual_output,
                    actual_cost,
                )
                add_accounting(
                    accounting["refund"],
                    max(input_reservation - actual_input, 0),
                    max(output_limit - actual_output, 0),
                    max(cost_reservation - actual_cost, 0),
                )
                add_accounting(
                    accounting["supplement"],
                    max(actual_input - input_reservation, 0),
                    max(actual_output - output_limit, 0),
                    max(actual_cost - cost_reservation, 0),
                )
                run_budget_overrun = self.run_cost_micro_cny_remaining < 0
                if run_budget_overrun:
                    self.run_budget_closed = True
                over_quota = (
                    actual_input > MAX_INPUT_TOKENS
                    or actual_output > output_limit
                    or trial["inputTokensRemaining"] < 0
                    or trial["outputTokensRemaining"] < 0
                    or trial["costMicroCNYRemaining"] < 0
                    or run_budget_overrun
                )
                if over_quota:
                    trial["revoked"] = True
                    trial["withinBudget"] = False
                revoked = trial["revoked"]
                trial["active"].discard(active)
                self.condition.notify_all()
            if over_quota:
                raise GatewayQuotaError(
                    "response_usage_exceeds_quota",
                    "gateway response usage exceeds quota",
                )
            if revoked:
                raise ValueError("gateway trial revoked during upstream request")
            return response
        except Exception:
            active.cancel()
            with self.condition:
                if active in trial["active"]:
                    accounting = trial["accounting"]
                    accounting["requests"]["unreconciled"] += 1
                    request_accounting["status"] = "unreconciled"
                    request_accounting["unreconciledReservation"] = dict(
                        request_accounting["reservation"]
                    )
                    add_accounting(
                        accounting["unreconciledReservation"],
                        input_reservation,
                        output_limit,
                        cost_reservation,
                    )
                    trial["revoked"] = True
                    trial["withinBudget"] = False
                    trial["active"].discard(active)
                    self.condition.notify_all()
            raise

    def revoke(self, trial_id: Any) -> dict[str, Any]:
        key = require_trial_id(trial_id)
        deadline = time.monotonic() + REVOKE_DEADLINE_SEC
        with self.lock:
            trial = self.trials.get(key)
            if trial is None:
                self.trials[key] = {
                    "expiresAt": 0.0,
                    "requestsRemaining": 0,
                    "inputTokensRemaining": 0,
                    "outputTokensRemaining": 0,
                    "costMicroCNYRemaining": 0,
                    "pricingSha256": self.pricing_sha256,
                    "revoked": True,
                    "active": set(),
                    "accounting": new_accounting(),
                    "withinBudget": True,
                    "receipt": None,
                }
                trial = self.trials[key]
            trial["revoked"] = True
            if trial["receipt"] is not None:
                return trial["receipt"]
            active = list(trial["active"])
        for connection in active:
            connection.cancel(deadline)
        with self.condition:
            while trial["active"]:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ValueError("gateway revoke deadline exceeded")
                self.condition.wait(timeout=min(remaining, 0.05))
            receipt = freeze_accounting_receipt(
                run_id=self.run_id,
                trial_id=key,
                protocol=self.provider["protocol"],
                model_route_id=self.model_route_id,
                pricing=self.pricing_descriptor,
                pricing_sha256=self.pricing_sha256,
                accounting=trial["accounting"],
                within_budget=trial["withinBudget"],
                capability_seed=self.capability_seed,
            )
            trial["receipt"] = receipt
            return receipt


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: "SupervisorServer"

    def do_POST(self) -> None:
        try:
            length = int(self.headers.get("content-length", "0"))
            if length < 1 or length > MAX_FRAME_BYTES:
                raise ValueError("invalid supervisor frame")
            request = json.loads(self.rfile.read(length))
            self.server.state.authenticate(request, peer_uid(self.connection))
            if request.get("action") == "register":
                self.server.state.register(request)
                response = {"status": 204, "headers": [], "body": ""}
            elif request.get("action") == "proxy":
                response = self.server.state.proxy(request)
            elif request.get("action") == "revoke":
                receipt = self.server.state.revoke(request.get("trialId"))
                response = {
                    "status": 204,
                    "headers": [],
                    "body": "",
                    "accountingReceipt": receipt,
                }
            else:
                raise ValueError("unsupported supervisor action")
            data = json.dumps(response, separators=(",", ":")).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)
        except GatewayError as error:
            data = canonical_json({"error": {"code": error.code}})
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(data)
        except Exception:
            self.send_error(502, "Gateway supervisor rejected the request")
        finally:
            self.close_connection = True

    def log_message(self, _format: str, *args: Any) -> None:
        del args


class SupervisorServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def __init__(self, path: str, state: GatewayState):
        self.state = state
        super().__init__(path, Handler)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket")
    parser.add_argument("--route-config")
    parser.add_argument("--upstream-worker", action="store_true")
    args = parser.parse_args()
    if args.upstream_worker:
        run_upstream_worker()
        return
    if not args.socket or not args.route_config:
        parser.error("--socket and --route-config are required")
    route_config = json.loads(Path(args.route_config).read_text(encoding="utf-8"))
    secret_frame = json.loads(read_pipe_frame(0))
    if (
        not isinstance(secret_frame, dict)
        or set(secret_frame) != {"providerSecret", "runId", "capabilitySeed"}
        or not isinstance(secret_frame["providerSecret"], str)
        or not isinstance(secret_frame["runId"], str)
        or not isinstance(secret_frame["capabilitySeed"], str)
    ):
        raise ValueError("invalid gateway supervisor secret frame")
    provider_secret = secret_frame["providerSecret"]
    run_id = secret_frame["runId"]
    capability_seed = secret_frame["capabilitySeed"]
    if (
        not provider_secret
        or "\n" in provider_secret
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", run_id)
        or not re.fullmatch(r"[0-9a-f]{64}", capability_seed)
    ):
        raise ValueError("invalid provider credential descriptor")
    for name, value in os.environ.items():
        if value == provider_secret or name == "PICO_TB_PROVIDER_API_KEY":
            raise ValueError("provider credential leaked into supervisor environment")
    socket_path = Path(args.socket)
    socket_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        socket_path.unlink()
    except FileNotFoundError:
        pass
    server = SupervisorServer(
        str(socket_path),
        GatewayState(route_config, provider_secret, run_id, capability_seed),
    )
    os.chmod(socket_path, 0o600)
    parent_pid = os.getppid()
    threading.Thread(
        target=stop_when_parent_exits,
        args=(server, parent_pid),
        daemon=True,
    ).start()
    signal.signal(
        signal.SIGTERM,
        lambda *_args: threading.Thread(target=server.shutdown, daemon=True).start(),
    )
    print("READY", flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        try:
            socket_path.unlink()
        except FileNotFoundError:
            pass


def stop_when_parent_exits(server: SupervisorServer, parent_pid: int) -> None:
    while True:
        time.sleep(1)
        if os.getppid() != parent_pid:
            server.shutdown()
            return


def require_trial_id(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > 128:
        raise ValueError("invalid trial identity")
    return value


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode()


def estimate_request_input_tokens(body: bytes) -> int:
    """Estimate token-quota admission without treating transport bytes as tokens.

    ASCII uses the usual four-character heuristic. Non-ASCII reserves its full
    UTF-8 width. This estimate is not a monetary upper bound: cost quotas
    separately reserve one token per request byte, while signed provider usage
    authoritatively reconciles both dimensions. An input-token overrun revokes the
    trial before another call.
    """
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError("gateway request is not valid UTF-8") from error
    ascii_characters = 0
    non_ascii_utf8_bytes = 0
    for character in text:
        if character.isascii():
            ascii_characters += 1
        else:
            code_point = ord(character)
            non_ascii_utf8_bytes += (
                2
                if code_point <= 0x7FF
                else 3
                if code_point <= 0xFFFF
                else 4
            )
    conservative_ascii_tokens = (
        ascii_characters + INPUT_ESTIMATION_ASCII_CHARS_PER_TOKEN - 1
    ) // INPUT_ESTIMATION_ASCII_CHARS_PER_TOKEN
    return max(1, conservative_ascii_tokens + non_ascii_utf8_bytes)


def remaining_cancel_time(deadline: float | None, maximum: float) -> float:
    if deadline is None:
        return maximum
    return max(0.0, min(maximum, deadline - time.monotonic()))


def terminate_process(
    process: subprocess.Popen[bytes], deadline: float | None
) -> bool:
    if process.poll() is not None:
        return True
    process.terminate()
    try:
        process.wait(timeout=remaining_cancel_time(deadline, 0.2))
    except subprocess.TimeoutExpired:
        process.kill()
        try:
            process.wait(timeout=remaining_cancel_time(deadline, 0.2))
        except subprocess.TimeoutExpired:
            return False
    return process.poll() is not None


def new_accounting() -> dict[str, Any]:
    return {
        "requests": {"attempted": 0, "reconciled": 0, "unreconciled": 0},
        "requestEntries": [],
        "reservation": zero_accounting_bucket(),
        "actual": zero_accounting_bucket(),
        "refund": zero_accounting_bucket(),
        "supplement": zero_accounting_bucket(),
        "unreconciledReservation": zero_accounting_bucket(),
    }


def zero_accounting_bucket() -> dict[str, int]:
    return {"inputTokens": 0, "outputTokens": 0, "costMicroCNY": 0}


def accounting_bucket(
    input_tokens: int, output_tokens: int, cost_micro_cny: int
) -> dict[str, int]:
    return {
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "costMicroCNY": cost_micro_cny,
    }


def add_accounting(
    bucket: dict[str, int],
    input_tokens: int,
    output_tokens: int,
    cost_micro_cny: int,
) -> None:
    bucket["inputTokens"] += input_tokens
    bucket["outputTokens"] += output_tokens
    bucket["costMicroCNY"] += cost_micro_cny


def freeze_accounting_receipt(
    *,
    run_id: str,
    trial_id: str,
    protocol: str,
    model_route_id: str,
    pricing: dict[str, Any],
    pricing_sha256: str,
    accounting: dict[str, Any],
    within_budget: bool,
    capability_seed: str,
) -> dict[str, Any]:
    actual = dict(accounting["actual"])
    actual["costCNY"] = actual["costMicroCNY"] / 1_000_000
    receipt = {
        "schemaVersion": 1,
        "runId": run_id,
        "trialId": trial_id,
        "protocol": protocol,
        "modelRouteId": model_route_id,
        "pricing": pricing,
        "pricingSha256": pricing_sha256,
        "rounding": "ceil-per-request",
        "status": (
            "reconciled"
            if accounting["requests"]["unreconciled"] == 0
            else "unreconciled"
        ),
        "withinBudget": within_budget,
        "requests": dict(accounting["requests"]),
        "requestEntries": json.loads(
            json.dumps(accounting["requestEntries"], separators=(",", ":"))
        ),
        "reservation": dict(accounting["reservation"]),
        "actual": actual,
        "refund": dict(accounting["refund"]),
        "supplement": dict(accounting["supplement"]),
        "unreconciledReservation": dict(
            accounting["unreconciledReservation"]
        ),
    }
    receipt["auth"] = {
        "algorithm": "hmac-sha256",
        "keyId": "run-capability-v1",
        "tag": hmac.new(
            capability_seed.encode(),
            b"pico-gateway-accounting-receipt-v1\0"
            + canonical_accounting_receipt(receipt, include_auth=False),
            "sha256",
        ).hexdigest(),
    }
    receipt["receiptSha256"] = hashlib.sha256(
        canonical_accounting_receipt(receipt, include_auth=True)
    ).hexdigest()
    return receipt


def canonical_accounting_receipt(
    value: dict[str, Any], *, include_auth: bool
) -> bytes:
    payload = json.loads(json.dumps(value, separators=(",", ":")))
    payload.pop("receiptSha256", None)
    if not include_auth:
        payload.pop("auth", None)
    payload["actual"].pop("costCNY", None)
    return canonical_json(payload)


def require_pricing(
    route_config: dict[str, Any], model: str
) -> tuple[dict[str, int], str]:
    pricing = route_config.get("pricing")
    provider_id = route_config.get("providerId")
    expected_keys = {
        "schemaVersion",
        "providerId",
        "model",
        "currency",
        "unit",
        "input",
        "output",
    }
    if (
        not isinstance(provider_id, str)
        or not provider_id
        or not isinstance(model, str)
        or not model
        or route_config.get("modelRouteId") != f"{provider_id}/{model}"
        or not isinstance(pricing, dict)
        or set(pricing) != expected_keys
    ):
        raise ValueError("gateway pricing contract is invalid")
    if (
        pricing["schemaVersion"] != 1
        or pricing["providerId"] != provider_id
        or pricing["model"] != model
        or pricing["currency"] != "CNY"
        or pricing["unit"] != "microCNYPerMillionTokens"
    ):
        raise ValueError("gateway pricing route mismatch")
    for field in ("input", "output"):
        value = pricing[field]
        if (
            isinstance(value, bool)
            or not isinstance(value, int)
            or value < 0
            or value > MAX_PRICE_MICRO_CNY_PER_MILLION
        ):
            raise ValueError("gateway pricing rate is invalid")
    digest = route_config.get("pricingSha256")
    expected = hashlib.sha256(canonical_json(pricing)).hexdigest()
    if (
        not isinstance(digest, str)
        or not re.fullmatch(r"[0-9a-f]{64}", digest)
        or not hmac.compare_digest(digest, expected)
    ):
        raise ValueError("gateway pricing digest mismatch")
    return {"input": pricing["input"], "output": pricing["output"]}, digest


def require_run_budget(route_config: dict[str, Any]) -> int:
    run_budget = route_config.get("runBudget")
    if (
        not isinstance(run_budget, dict)
        or set(run_budget) != {"currency", "maxCostMicroCNY"}
        or run_budget["currency"] != "CNY"
    ):
        raise ValueError("gateway run budget contract is invalid")
    maximum = run_budget["maxCostMicroCNY"]
    if (
        isinstance(maximum, bool)
        or not isinstance(maximum, int)
        or maximum < 0
        or maximum > MAX_RUN_COST_MICRO_CNY
    ):
        raise ValueError("gateway run budget limit is invalid")
    return maximum


def require_benchmark_route_contract(route_config: dict[str, Any]) -> None:
    model_route_id = route_config.get("modelRouteId")
    if not isinstance(model_route_id, str):
        return
    expected = _PINNED_BENCHMARK_OUTPUT_CAPABILITIES.get(model_route_id)
    if expected is None:
        return
    expected_field, expected_output = expected
    provider = route_config.get("provider")
    provider_id, model = model_route_id.split("/", 1)
    capabilities = (
        provider.get("modelCapabilities") if isinstance(provider, dict) else None
    )
    model_capability = (
        capabilities.get(model) if isinstance(capabilities, dict) else None
    )
    models = provider.get("models") if isinstance(provider, dict) else None
    output = (
        model_capability.get("output")
        if isinstance(model_capability, dict)
        else None
    )
    if (
        route_config.get("providerId") != provider_id
        or not isinstance(provider, dict)
        or provider.get("protocol") != "openai"
        or not isinstance(models, list)
        or model not in models
        or not isinstance(model_capability, dict)
        or isinstance(output, bool)
        or not isinstance(output, int)
        or output != expected_output
        or model_capability.get("outputTokenField") != expected_field
    ):
        raise ValueError(
            f"{model_route_id} benchmark route must pin output={expected_output} "
            f"and use {expected_field}"
        )


def token_cost_micro_cny(
    input_tokens: int, output_tokens: int, pricing: dict[str, int]
) -> int:
    numerator = input_tokens * pricing["input"] + output_tokens * pricing["output"]
    return (numerator + 999_999) // 1_000_000


def require_usage_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"gateway usage field {field} is invalid")
    return value


def parse_usage(response_body: bytes, protocol: str) -> tuple[int, int]:
    try:
        value = json.loads(response_body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("gateway response is not valid JSON") from error
    if not isinstance(value, dict):
        raise ValueError("gateway response must be an object")
    if protocol == "openai":
        usage = value.get("usage")
        if not isinstance(usage, dict):
            raise ValueError("gateway response is missing usage")
        input_tokens = require_usage_int(usage.get("prompt_tokens"), "prompt_tokens")
        output_tokens = require_usage_int(
            usage.get("completion_tokens"), "completion_tokens"
        )
        if "total_tokens" in usage and require_usage_int(
            usage["total_tokens"], "total_tokens"
        ) != input_tokens + output_tokens:
            raise ValueError("gateway response usage total is inconsistent")
        return input_tokens, output_tokens
    if protocol == "claude":
        usage = value.get("usage")
        if not isinstance(usage, dict):
            raise ValueError("gateway response is missing usage")
        input_tokens = require_usage_int(usage.get("input_tokens"), "input_tokens")
        for field in ("cache_creation_input_tokens", "cache_read_input_tokens"):
            if field in usage:
                input_tokens += require_usage_int(usage[field], field)
        return input_tokens, require_usage_int(
            usage.get("output_tokens"), "output_tokens"
        )
    raise ValueError("gateway usage protocol is unsupported")


def decode_upstream_result(
    value: dict[str, Any]
) -> tuple[int, list[tuple[str, str]], bytes]:
    status = value.get("status")
    headers = value.get("headers")
    encoded_body = value.get("body")
    if (
        isinstance(status, bool)
        or not isinstance(status, int)
        or status < 100
        or status > 599
        or not isinstance(headers, list)
        or len(headers) > 256
        or not isinstance(encoded_body, str)
    ):
        raise ValueError("gateway upstream worker returned an invalid response")
    parsed_headers: list[tuple[str, str]] = []
    for header in headers:
        if (
            not isinstance(header, list)
            or len(header) != 2
            or not all(isinstance(part, str) for part in header)
            or any(len(part) > 8_192 for part in header)
        ):
            raise ValueError("gateway upstream worker returned invalid headers")
        parsed_headers.append((header[0], header[1]))
    body = base64.b64decode(encoded_body, validate=True)
    if len(body) > MAX_RESPONSE_BYTES:
        raise ValueError("gateway response exceeds limit")
    return status, parsed_headers, body


def run_upstream_worker() -> None:
    parent_pid = os.getppid()
    threading.Thread(
        target=exit_when_parent_exits,
        args=(parent_pid,),
        daemon=True,
    ).start()
    raw = sys.stdin.buffer.read(MAX_FRAME_BYTES * 2 + 1)
    if not raw or len(raw) > MAX_FRAME_BYTES * 2:
        raise ValueError("gateway upstream worker frame is invalid")
    request = json.loads(raw)
    if not isinstance(request, dict) or set(request) != {
        "baseURL",
        "protocol",
        "providerSecret",
        "path",
        "body",
        "headers",
    }:
        raise ValueError("gateway upstream worker frame is invalid")
    base_url = request["baseURL"]
    protocol = request["protocol"]
    secret = request["providerSecret"]
    path = request["path"]
    encoded_body = request["body"]
    if not all(
        isinstance(item, str)
        for item in (base_url, protocol, secret, path, encoded_body)
    ):
        raise ValueError("gateway upstream worker fields are invalid")
    upstream = urlsplit(base_url)
    if upstream.scheme not in {"http", "https"} or not upstream.hostname:
        raise ValueError("gateway upstream URL is invalid")
    body = base64.b64decode(encoded_body, validate=True)
    connection_class = (
        http.client.HTTPSConnection
        if upstream.scheme == "https"
        else http.client.HTTPConnection
    )
    connection = connection_class(upstream.hostname, upstream.port, timeout=UPSTREAM_TIMEOUT_SEC)
    try:
        connection.request(
            "POST",
            upstream_path(upstream.path, path),
            body=body,
            headers=upstream_headers(protocol, secret, request.get("headers")),
        )
        response = connection.getresponse()
        response_body = response.read(MAX_RESPONSE_BYTES + 1)
        if len(response_body) > MAX_RESPONSE_BYTES:
            raise ValueError("gateway response exceeds limit")
        result = {
            "status": response.status,
            "headers": [[name, value] for name, value in response.getheaders()],
            "body": base64.b64encode(response_body).decode(),
        }
        sys.stdout.buffer.write(canonical_json(result))
        sys.stdout.buffer.flush()
    finally:
        connection.close()


def exit_when_parent_exits(parent_pid: int) -> None:
    while True:
        time.sleep(0.05)
        if os.getppid() != parent_pid:
            os._exit(1)


def read_pipe_frame(descriptor: int) -> bytes:
    chunks: list[bytes] = []
    size = 0
    try:
        while True:
            chunk = os.read(descriptor, min(8 * 1024, 64 * 1024 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size >= 64 * 1024:
                raise ValueError("gateway supervisor secret frame is too large")
    finally:
        os.close(descriptor)
    if size == 0:
        raise ValueError("gateway supervisor secret frame is empty")
    return b"".join(chunks)


def peer_uid(connection: Any) -> int:
    if hasattr(connection, "getpeereid"):
        return int(connection.getpeereid()[0])
    if hasattr(os, "uname") and os.uname().sysname == "Darwin":
        uid = ctypes.c_uint()
        gid = ctypes.c_uint()
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.getpeereid(connection.fileno(), ctypes.byref(uid), ctypes.byref(gid)) != 0:
            raise OSError(ctypes.get_errno(), "getpeereid failed")
        return int(uid.value)
    if hasattr(__import__("socket"), "SO_PEERCRED"):
        credentials = connection.getsockopt(
            __import__("socket").SOL_SOCKET,
            __import__("socket").SO_PEERCRED,
            struct.calcsize("3i"),
        )
        return int(struct.unpack("3i", credentials)[1])
    raise RuntimeError("peer credential verification is unavailable")


def require_path(value: Any, protocol: str) -> str:
    if not isinstance(value, str):
        raise ValueError("invalid gateway path")
    split = urlsplit(value)
    if protocol == "openai" and split.path != "/chat/completions":
        raise ValueError("gateway path mismatch")
    if protocol == "claude" and split.path != "/messages":
        raise ValueError("gateway path mismatch")
    if protocol not in {"openai", "claude"}:
        raise ValueError("gateway path protocol is unsupported")
    return value


def bound_request(
    body: bytes,
    path: str,
    protocol: str,
    model: str,
    *,
    strict_output_limit: bool,
) -> tuple[bytes, int]:
    value = json.loads(body)
    if not isinstance(value, dict):
        raise ValueError("gateway request must be an object")
    if value.get("stream") not in {None, False}:
        raise ValueError("gateway streaming requests are unsupported")
    if value.get("model") != model:
        raise ValueError("gateway model mismatch")
    if protocol == "openai" and {
        "max_tokens",
        "max_completion_tokens",
    }.issubset(value):
        raise ValueError("gateway request has ambiguous output token limits")
    requested_output_limit = require_request_output_limit(
        value.get(
            "max_tokens",
            value.get("max_completion_tokens", MAX_REQUEST_OUTPUT_TOKENS),
        )
    )
    if strict_output_limit and requested_output_limit > MAX_REQUEST_OUTPUT_TOKENS:
        raise ValueError("gateway output token limit is invalid")
    output_limit = min(requested_output_limit, MAX_REQUEST_OUTPUT_TOKENS)
    if protocol == "openai":
        field = (
            "max_completion_tokens"
            if "max_completion_tokens" in value
            else "max_tokens"
        )
        value[field] = output_limit
    else:
        value["max_tokens"] = output_limit
    return json.dumps(value, separators=(",", ":")).encode(), output_limit


def require_request_output_limit(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError("gateway output token limit is invalid")
    return value


def upstream_headers(
    protocol: str, provider_secret: str, incoming: Any
) -> dict[str, str]:
    incoming_headers = incoming if isinstance(incoming, dict) else {}
    for field in ("x-stainless-retry-count", "x-retry-count"):
        if field in incoming_headers and str(incoming_headers[field]) not in {"", "0"}:
            raise ValueError("gateway retried requests are unsupported")
    headers = {
        "Content-Type": str(incoming_headers.get("content-type", "application/json")),
        "Accept": str(incoming_headers.get("accept", "*/*")),
    }
    if version := incoming_headers.get("anthropic-version"):
        headers["anthropic-version"] = str(version)
    if protocol == "openai":
        headers["Authorization"] = f"Bearer {provider_secret}"
    elif protocol == "claude":
        headers["x-api-key"] = provider_secret
    else:
        raise ValueError("gateway header protocol is unsupported")
    return headers


def upstream_path(base_path: str, incoming: str) -> str:
    split = urlsplit(incoming)
    query = parse_qsl(split.query, keep_blank_values=True)
    path = f"{base_path.rstrip('/')}/{split.path.lstrip('/')}"
    return urlunsplit(("", "", path, urlencode(query), ""))


if __name__ == "__main__":
    main()

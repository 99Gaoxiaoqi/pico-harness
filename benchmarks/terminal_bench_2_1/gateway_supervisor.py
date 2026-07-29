from __future__ import annotations

import argparse
import base64
import ctypes
import hmac
import http.client
import json
import os
import re
import signal
import socketserver
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

MAX_FRAME_BYTES = 16 * 1024 * 1024
MAX_RESPONSE_BYTES = 64 * 1024 * 1024
AUTH_WINDOW_SEC = 300
MAX_TRIAL_TTL_SEC = 7_200
MAX_REQUESTS = 128
MAX_INPUT_TOKENS = 1_000_000
MAX_OUTPUT_TOKENS = 65_536
MAX_COST_MICRO_CNY = 250_000_000
WORST_CASE_MICRO_CNY_PER_TOKEN = 1_000


class GatewayState:
    def __init__(
        self,
        route_config: dict[str, Any],
        provider_secret: str,
        run_id: str,
        capability_seed: str,
    ):
        self.provider = route_config["provider"]
        self.model = route_config["modelRouteId"].split("/", 1)[1]
        self.provider_secret = provider_secret
        self.run_id = run_id
        self.capability_seed = capability_seed
        self.owner_uid = os.getuid()
        self.lock = threading.Lock()
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
        ttl_sec = min(float(request.get("ttlSec", 0)), MAX_TRIAL_TTL_SEC)
        if request.get("protocol") != self.provider["protocol"] or ttl_sec <= 0:
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
                "revoked": False,
                "active": set(),
            }

    def proxy(self, request: dict[str, Any]) -> dict[str, Any]:
        trial_id = require_trial_id(request.get("trialId"))
        protocol = request.get("protocol")
        if protocol != self.provider["protocol"]:
            raise ValueError("gateway route mismatch")
        body = base64.b64decode(request.get("body", ""), validate=True)
        path = require_path(request.get("path"), protocol, self.model)
        bounded_body, output_limit = bound_request(body, path, protocol, self.model)
        input_limit = len(bounded_body)
        cost_reservation = (
            input_limit + output_limit
        ) * WORST_CASE_MICRO_CNY_PER_TOKEN
        upstream = urlsplit(self.provider["baseURL"])
        connection_class = (
            http.client.HTTPSConnection
            if upstream.scheme == "https"
            else http.client.HTTPConnection
        )
        connection = connection_class(upstream.hostname, upstream.port, timeout=120)
        with self.lock:
            trial = self.trials.get(trial_id)
            if trial is None:
                raise ValueError("gateway trial is not registered")
            if (
                trial["revoked"]
                or time.monotonic() >= trial["expiresAt"]
                or trial["requestsRemaining"] <= 0
                or trial["inputTokensRemaining"] < input_limit
                or trial["outputTokensRemaining"] < output_limit
                or trial["costMicroCNYRemaining"] < cost_reservation
                or trial["active"]
            ):
                raise ValueError("gateway trial quota exhausted")
            trial["requestsRemaining"] -= 1
            trial["inputTokensRemaining"] -= input_limit
            trial["outputTokensRemaining"] -= output_limit
            trial["costMicroCNYRemaining"] -= cost_reservation
            trial["active"].add(connection)
        try:
            connection.request(
                "POST",
                upstream_path(upstream.path, path, protocol, self.provider_secret),
                body=bounded_body,
                headers=upstream_headers(protocol, self.provider_secret, request.get("headers")),
            )
            response = connection.getresponse()
            response_body = response.read(MAX_RESPONSE_BYTES + 1)
            if len(response_body) > MAX_RESPONSE_BYTES:
                raise ValueError("gateway response exceeds limit")
            with self.lock:
                if trial["revoked"]:
                    raise ValueError("gateway trial revoked during upstream request")
            return {
                "status": response.status,
                "headers": [
                    [name, value]
                    for name, value in response.getheaders()
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
        finally:
            with self.lock:
                trial["active"].discard(connection)
            connection.close()

    def revoke(self, trial_id: Any) -> None:
        key = require_trial_id(trial_id)
        with self.lock:
            trial = self.trials.get(key)
            if trial is None:
                self.trials[key] = {
                    "expiresAt": 0.0,
                    "requestsRemaining": 0,
                    "inputTokensRemaining": 0,
                    "outputTokensRemaining": 0,
                    "costMicroCNYRemaining": 0,
                    "revoked": True,
                    "active": set(),
                }
                return
            trial["revoked"] = True
            active = list(trial["active"])
        for connection in active:
            connection.close()


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
                self.server.state.revoke(request.get("trialId"))
                response = {"status": 204, "headers": [], "body": ""}
            else:
                raise ValueError("unsupported supervisor action")
            data = json.dumps(response, separators=(",", ":")).encode()
            self.send_response(200)
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
    parser.add_argument("--socket", required=True)
    parser.add_argument("--route-config", required=True)
    args = parser.parse_args()
    route_config = json.loads(Path(args.route_config).read_text(encoding="utf-8"))
    secret_frame = json.loads(os.read(0, 64 * 1024))
    os.close(0)
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


def require_path(value: Any, protocol: str, model: str) -> str:
    if not isinstance(value, str):
        raise ValueError("invalid gateway path")
    split = urlsplit(value)
    if protocol == "openai" and split.path != "/chat/completions":
        raise ValueError("gateway path mismatch")
    if protocol == "claude" and split.path != "/messages":
        raise ValueError("gateway path mismatch")
    if protocol == "gemini" and split.path not in {
        f"/v1beta/models/{model}:generateContent",
        f"/v1beta/models/{model}:streamGenerateContent",
    }:
        raise ValueError("gateway path mismatch")
    return value


def bound_request(body: bytes, path: str, protocol: str, model: str) -> tuple[bytes, int]:
    value = json.loads(body)
    if not isinstance(value, dict):
        raise ValueError("gateway request must be an object")
    if protocol == "gemini":
        generation = value.setdefault("generationConfig", {})
        if not isinstance(generation, dict):
            raise ValueError("gateway generation config must be an object")
        output_limit = min(int(generation.get("maxOutputTokens", 8_192)), 8_192)
        generation["maxOutputTokens"] = output_limit
    else:
        if value.get("model") != model:
            raise ValueError("gateway model mismatch")
        output_limit = min(
            int(value.get("max_tokens", value.get("max_completion_tokens", 8_192))),
            8_192,
        )
        if protocol == "openai":
            field = (
                "max_completion_tokens"
                if "max_completion_tokens" in value
                else "max_tokens"
            )
            value[field] = output_limit
        else:
            value["max_tokens"] = output_limit
    if output_limit < 1:
        raise ValueError("gateway output token limit is invalid")
    return json.dumps(value, separators=(",", ":")).encode(), output_limit


def upstream_headers(
    protocol: str, provider_secret: str, incoming: Any
) -> dict[str, str]:
    incoming_headers = incoming if isinstance(incoming, dict) else {}
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
    return headers


def upstream_path(
    base_path: str, incoming: str, protocol: str, provider_secret: str
) -> str:
    split = urlsplit(incoming)
    query = parse_qsl(split.query, keep_blank_values=True)
    if protocol == "gemini":
        query = [
            (name, provider_secret if name == "key" else value) for name, value in query
        ]
    path = f"{base_path.rstrip('/')}/{split.path.lstrip('/')}"
    return urlunsplit(("", "", path, urlencode(query), ""))


if __name__ == "__main__":
    main()

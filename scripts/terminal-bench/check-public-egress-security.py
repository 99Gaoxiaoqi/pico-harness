from __future__ import annotations

import base64
import http.client
import importlib.util
import json
import socket
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any


def load_public_egress() -> Any:
    project_root = Path(__file__).resolve().parents[2]
    module_path = project_root / "benchmarks/terminal_bench_2_1/public_egress.py"
    spec = importlib.util.spec_from_file_location(
        "pico_public_egress_security_test", module_path
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def basic_auth(token: str, username: str = "pico") -> str:
    encoded = base64.b64encode(f"{username}:{token}".encode()).decode()
    return f"Basic {encoded}"


def wait_until(predicate: Callable[[], bool], timeout_sec: float = 2.0) -> None:
    deadline = time.monotonic() + timeout_sec
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError("timed out waiting for local proxy state")
        time.sleep(0.005)


def http_request(
    port: int,
    target: str,
    *,
    auth: str | None,
    method: str = "GET",
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, bytes, dict[str, str]]:
    request_headers = dict(headers or {})
    if auth is not None:
        request_headers["Proxy-Authorization"] = auth
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
    try:
        connection.request(
            method,
            target,
            body=body,
            headers=request_headers,
        )
        response = connection.getresponse()
        response_body = response.read()
        return response.status, response_body, dict(response.getheaders())
    finally:
        connection.close()


def connect_request(port: int, target: str, auth: str) -> tuple[int, socket.socket]:
    client = socket.create_connection(("127.0.0.1", port), timeout=2)
    request = (
        f"CONNECT {target} HTTP/1.1\r\n"
        f"Host: {target}\r\n"
        f"Proxy-Authorization: {auth}\r\n"
        "\r\n"
    ).encode()
    client.sendall(request)
    response = receive_until(client, b"\r\n\r\n")
    status = int(response.split(b" ", 2)[1])
    if status == 200:
        assert b"Connection: close" not in response
    return status, client


def raw_request_status(port: int, request: bytes) -> int:
    client = socket.create_connection(("127.0.0.1", port), timeout=2)
    try:
        client.sendall(request)
        response = receive_until(client, b"\r\n\r\n")
        return int(response.split(b" ", 2)[1])
    finally:
        client.close()


def receive_until(
    connection: socket.socket, marker: bytes, max_bytes: int = 16 * 1024
) -> bytes:
    result = bytearray()
    while marker not in result:
        chunk = connection.recv(4096)
        if not chunk:
            break
        result.extend(chunk)
        if len(result) > max_bytes:
            raise AssertionError("local response exceeded test bound")
    return bytes(result)


class MappingResolver:
    def __init__(self, values: dict[str, list[str]]):
        self.values = values
        self.calls: list[tuple[str, int]] = []

    def __call__(self, host: str, port: int) -> list[str]:
        self.calls.append((host, port))
        return self.values[host]


class RebindingResolver:
    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, _host: str, _port: int) -> list[str]:
        self.calls += 1
        return ["93.184.216.34"] if self.calls == 1 else ["127.0.0.1"]


class SocketPairConnector:
    def __init__(self, responder: Callable[[socket.socket], None]):
        self.responder = responder
        self.calls: list[tuple[str, int, float]] = []
        self.threads: list[threading.Thread] = []

    def __call__(self, ip: str, port: int, timeout: float) -> socket.socket:
        self.calls.append((ip, port, timeout))
        proxy_side, peer = socket.socketpair()
        thread = threading.Thread(
            target=self._run_responder,
            args=(peer,),
            name="pico-public-egress-test-upstream",
            daemon=True,
        )
        self.threads.append(thread)
        thread.start()
        return proxy_side

    def _run_responder(self, peer: socket.socket) -> None:
        try:
            self.responder(peer)
        finally:
            peer.close()

    def join(self) -> None:
        for thread in self.threads:
            thread.join(timeout=2)
            assert not thread.is_alive()


class HoldingConnector:
    def __init__(self) -> None:
        self.calls: list[tuple[str, int, float]] = []
        self.peers: list[socket.socket] = []

    def __call__(self, ip: str, port: int, timeout: float) -> socket.socket:
        self.calls.append((ip, port, timeout))
        proxy_side, peer = socket.socketpair()
        self.peers.append(peer)
        return proxy_side

    def close(self) -> None:
        for peer in self.peers:
            peer.close()


class FakeClock:
    def __init__(self) -> None:
        self.value = 1_000.0

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


def encoded_doh_response(
    module: Any,
    payload: Any,
    *,
    status: int = 200,
    content_type: str = "application/dns-json",
) -> Any:
    body = json.dumps(payload, separators=(",", ":")).encode()
    return module._DoHResponse(
        status,
        (
            ("Content-Type", content_type),
            ("Content-Length", str(len(body))),
        ),
        body,
    )


def fake_doh_response(
    module: Any,
    host: str,
    record_name: str,
    addresses: list[str],
) -> Any:
    record_code = 1 if record_name == "A" else 28
    return encoded_doh_response(
        module,
        {
            "Status": 0,
            "TC": False,
            "Question": [{"name": f"{host}.", "type": record_code}],
            "Answer": [
                {
                    "name": f"{host}.",
                    "type": record_code,
                    "TTL": 60,
                    "data": address,
                }
                for address in addresses
            ],
        },
    )


def read_http_request(peer: socket.socket) -> bytes:
    received = bytearray()
    while b"\r\n\r\n" not in received:
        chunk = peer.recv(4096)
        if not chunk:
            return bytes(received)
        received.extend(chunk)
    header_end = received.index(b"\r\n\r\n") + 4
    headers = received[:header_end].decode("latin-1")
    content_length = 0
    for line in headers.split("\r\n"):
        if line.lower().startswith("content-length:"):
            content_length = int(line.split(":", 1)[1].strip())
    while len(received) - header_end < content_length:
        chunk = peer.recv(4096)
        if not chunk:
            break
        received.extend(chunk)
    return bytes(received)


def http_responder(
    capture: list[bytes], body: bytes = b"ok"
) -> Callable[[socket.socket], None]:
    def respond(peer: socket.socket) -> None:
        request = read_http_request(peer)
        capture.append(request)
        if not request:
            return
        response = (
            b"HTTP/1.1 200 OK\r\n"
            + f"Content-Length: {len(body)}\r\n".encode()
            + b"Connection: close\r\n\r\n"
            + body
        )
        peer.sendall(response)

    return respond


def echo_responder(peer: socket.socket) -> None:
    while True:
        chunk = peer.recv(4096)
        if not chunk:
            return
        peer.sendall(chunk)


def assert_http_and_audit(module: Any) -> None:
    token = "http-token-query-secret"
    header_secret = "header-secret-never-audit"
    body_secret = b"body-secret-never-audit"
    capture: list[bytes] = []
    resolver = RebindingResolver()
    connector = SocketPairConnector(http_responder(capture))
    proxy = module.PublicEgressProxy(token, 60)
    proxy._resolver = resolver
    proxy._connector = connector
    port = proxy.start()
    try:
        status, body, _headers = http_request(
            port,
            "http://public.test/download?credential=query-secret-never-audit",
            auth=basic_auth(token),
            method="POST",
            body=body_secret,
            headers={
                "X-Test-Secret": header_secret,
                "Proxy-Connection": "keep-alive",
            },
        )
        assert status == 200
        assert body == b"ok"
    finally:
        receipt = proxy.stop()
        connector.join()

    assert resolver.calls == 1
    assert len(connector.calls) == 1
    assert connector.calls[0][0] == "93.184.216.34"
    request = capture[0]
    assert b"POST /download?credential=query-secret-never-audit HTTP/1.1" in request
    assert body_secret in request
    assert header_secret.encode() in request
    assert b"Proxy-Authorization" not in request
    assert b"Proxy-Connection" not in request

    encoded_receipt = json.dumps(receipt, sort_keys=True)
    for secret in (
        token,
        "query-secret-never-audit",
        header_secret,
        body_secret.decode(),
    ):
        assert secret not in encoded_receipt
    assert receipt["schemaVersion"] == 1
    assert receipt["started"] is not None
    assert receipt["stopped"] is not None
    assert receipt["allowed"] == 1
    assert receipt["denied"] == 0
    assert receipt["bytes"]["total"] > 0
    assert receipt["decisions"] == [
        {
            "host": "public.test",
            "port": 80,
            "decision": "allow",
            "reason": "completed",
            "bytes": receipt["bytes"]["total"],
        }
    ]


def assert_connect(module: Any) -> None:
    token = "connect-token"
    resolver = MappingResolver({"tunnel.test": ["2606:2800:220:1:248:1893:25c8:1946"]})
    connector = SocketPairConnector(echo_responder)
    proxy = module.PublicEgressProxy(token, 60)
    proxy._resolver = resolver
    proxy._connector = connector
    port = proxy.start()
    client: socket.socket | None = None
    try:
        status, client = connect_request(port, "tunnel.test:443", basic_auth(token))
        assert status == 200
        client.sendall(b"tunnel-payload")
        assert client.recv(len(b"tunnel-payload")) == b"tunnel-payload"
    finally:
        if client is not None:
            client.close()
        receipt = proxy.stop()
        connector.join()
    assert resolver.calls == [("tunnel.test", 443)]
    assert connector.calls[0][0] == "2606:2800:220:1:248:1893:25c8:1946"
    assert receipt["allowed"] == 1
    assert receipt["bytes"]["clientToUpstream"] == len(b"tunnel-payload")
    assert receipt["bytes"]["upstreamToClient"] == len(b"tunnel-payload")


def assert_policy_denials(module: Any) -> None:
    token = "policy-token"
    resolver = MappingResolver(
        {
            "private.test": ["10.0.0.1"],
            "mixed.test": ["93.184.216.34", "127.0.0.1"],
            "mapped.test": ["::ffff:5db8:d822"],
            "nat64-well-known.test": ["64:ff9b::5db8:d822"],
            "nat64-local.test": ["64:ff9b:1::5db8:d822"],
            "six-to-four.test": ["2002:5db8:d822::"],
            "teredo.test": ["2001:0:4136:e378:8000:63bf:3fff:fdd2"],
            "site-local.test": ["fec0::1"],
            "isatap-public.test": ["2001:4860:4860:0:200:5efe:808:808"],
            "isatap-private.test": ["2001:4860:4860:0:0:5efe:a00:1"],
        }
    )

    def unexpected_connector(_ip: str, _port: int, _timeout: float) -> socket.socket:
        raise AssertionError("a denied target reached the connector")

    proxy = module.PublicEgressProxy(token, 60)
    proxy._resolver = resolver
    proxy._connector = unexpected_connector
    port = proxy.start()
    try:
        targets = (
            "http://private.test/",
            "http://mixed.test/",
            "http://mapped.test/",
            "http://nat64-well-known.test/",
            "http://nat64-local.test/",
            "http://six-to-four.test/",
            "http://teredo.test/",
            "http://site-local.test/",
            "http://isatap-public.test/",
            "http://isatap-private.test/",
            "http://localhost/",
            "http://service.local/",
            "http://service.internal/",
            "http://host.docker.internal/",
            "http://metadata.google.internal/",
            "http://93.184.216.34/",
            "http://public.test:81/",
            "https://public.test/",
            "ftp://public.test/",
        )
        for target in targets:
            status, _body, _headers = http_request(port, target, auth=basic_auth(token))
            assert status == 403, (target, status)
        status, client = connect_request(port, "public.test:80", basic_auth(token))
        client.close()
        assert status == 403
    finally:
        receipt = proxy.stop()

    assert resolver.calls == [
        ("private.test", 80),
        ("mixed.test", 80),
        ("mapped.test", 80),
        ("nat64-well-known.test", 80),
        ("nat64-local.test", 80),
        ("six-to-four.test", 80),
        ("teredo.test", 80),
        ("site-local.test", 80),
        ("isatap-public.test", 80),
        ("isatap-private.test", 80),
    ]
    reasons = {decision["reason"] for decision in receipt["decisions"]}
    assert {
        "non_public_address",
        "transition_address",
        "site_local_address",
        "isatap_address",
        "localhost",
        "local_name",
        "internal_name",
        "docker_internal",
        "metadata_name",
        "ip_literal",
        "port",
        "https_requires_connect",
        "invalid_scheme",
    } <= reasons
    assert receipt["allowed"] == 0
    assert receipt["denied"] == len(targets) + 1


def assert_authentication(module: Any) -> None:
    token = "authentication-token"
    resolver = MappingResolver({"public.test": ["93.184.216.34"]})
    capture: list[bytes] = []
    connector = SocketPairConnector(http_responder(capture))
    proxy = module.PublicEgressProxy(token, 60)
    proxy._resolver = resolver
    proxy._connector = connector
    port = proxy.start()
    try:
        attempts = (
            None,
            basic_auth("wrong-password"),
            basic_auth("pässword"),
            basic_auth(token, username="wrong-user"),
            "Bearer unsupported",
            "Basic !!!",
        )
        for auth in attempts:
            status, _body, headers = http_request(
                port, "http://public.test/", auth=auth
            )
            assert status == 407
            assert headers["Proxy-Authenticate"] == 'Basic realm="pico-egress"'
        status, body, _headers = http_request(
            port, "http://public.test/", auth=basic_auth(token)
        )
        assert (status, body) == (200, b"ok")
    finally:
        receipt = proxy.stop()
        connector.join()
    assert resolver.calls == [("public.test", 80)]
    assert len(connector.calls) == 1
    assert receipt["denied"] == len(attempts)
    assert receipt["allowed"] == 1


def assert_header_smuggling_rejected(module: Any) -> None:
    token = "header-validation-token"
    resolver = MappingResolver({"public.test": ["93.184.216.34"]})

    def unexpected_connector(_ip: str, _port: int, _timeout: float) -> socket.socket:
        raise AssertionError("an invalid header reached the connector")

    proxy = module.PublicEgressProxy(token, 60)
    proxy._resolver = resolver
    proxy._connector = unexpected_connector
    port = proxy.start()
    try:
        status = raw_request_status(
            port,
            (
                "GET http://public.test/ HTTP/1.1\r\n"
                "Host: public.test\r\n"
                f"Proxy-Authorization: {basic_auth(token)}\r\n"
                "X-Test: accepted-prefix\r\n"
                " injected: rejected-fold\r\n"
                "\r\n"
            ).encode(),
        )
        assert status == 403
        expectation_status = raw_request_status(
            port,
            (
                "POST http://public.test/ HTTP/1.1\r\n"
                "Host: public.test\r\n"
                f"Proxy-Authorization: {basic_auth(token)}\r\n"
                "Content-Length: 4\r\n"
                "Expect: 100-continue\r\n"
                "\r\n"
            ).encode(),
        )
        assert expectation_status == 417
    finally:
        receipt = proxy.stop()
    assert resolver.calls == []
    assert [decision["reason"] for decision in receipt["decisions"]] == [
        "headers",
        "expectation",
    ]


def assert_doh_parser(module: Any) -> None:
    host = "example.com"
    a_response = fake_doh_response(
        module,
        host,
        "A",
        ["93.184.216.34"],
    )
    assert module._parse_doh_response(host, 1, 4, a_response) == ("93.184.216.34",)
    aaaa_response = fake_doh_response(
        module,
        host,
        "AAAA",
        ["2606:2800:220:1:248:1893:25c8:1946"],
    )
    assert module._parse_doh_response(host, 28, 6, aaaa_response) == (
        "2606:2800:220:1:248:1893:25c8:1946",
    )

    cname_response = encoded_doh_response(
        module,
        {
            "Status": 0,
            "TC": False,
            "Question": [{"name": "example.com.", "type": 1}],
            "Answer": [
                {
                    "name": "example.com.",
                    "type": 5,
                    "TTL": 60,
                    "data": "edge.example.net.",
                },
                {
                    "name": "edge.example.net.",
                    "type": 1,
                    "TTL": 30,
                    "data": "93.184.216.34",
                },
            ],
        },
    )
    assert module._parse_doh_response(host, 1, 4, cname_response) == ("93.184.216.34",)

    invalid_payloads = (
        module._DoHResponse(
            503,
            (("Content-Type", "application/dns-json"),),
            b"{}",
        ),
        module._DoHResponse(
            200,
            (("Content-Type", "text/plain"),),
            b"{}",
        ),
        module._DoHResponse(
            200,
            (("Content-Type", "application/dns-json"),),
            b"x" * (module.DOH_MAX_RESPONSE_BYTES + 1),
        ),
        module._DoHResponse(
            200,
            (("Content-Type", "application/dns-json"),),
            b"{invalid-json",
        ),
        module._DoHResponse(
            200,
            (("Content-Type", "application/dns-json"),),
            (
                b'{"Status":0,"Status":0,"TC":false,'
                b'"Question":[{"name":"example.com.","type":1}]}'
            ),
        ),
        encoded_doh_response(
            module,
            {
                "Status": 2,
                "TC": False,
                "Question": [{"name": "example.com.", "type": 1}],
            },
        ),
        encoded_doh_response(
            module,
            {
                "Status": 0,
                "TC": True,
                "Question": [{"name": "example.com.", "type": 1}],
            },
        ),
        encoded_doh_response(
            module,
            {
                "Status": 0,
                "TC": False,
                "Question": [{"name": "other.example.", "type": 1}],
            },
        ),
        fake_doh_response(module, host, "A", ["198.18.0.14"]),
        fake_doh_response(module, host, "A", ["10.0.0.1"]),
    )
    for response in invalid_payloads:
        try:
            module._parse_doh_response(host, 1, 4, response)
        except module.ProxyRequestError:
            pass
        else:
            raise AssertionError("invalid DoH response was accepted")


def assert_doh_fallback_and_fail_closed(module: Any) -> None:
    original_request = module._doh_https_request
    original_getaddrinfo = module.socket.getaddrinfo
    calls: list[tuple[str, str, str]] = []

    def forbidden_system_dns(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("default resolver used system DNS")

    def fallback_request(endpoint_ip: str, host: str, record_name: str) -> Any:
        calls.append((endpoint_ip, host, record_name))
        if endpoint_ip == "1.1.1.1":
            raise OSError("synthetic primary DoH failure")
        addresses = (
            ["93.184.216.34"]
            if record_name == "A"
            else ["2606:2800:220:1:248:1893:25c8:1946"]
        )
        return fake_doh_response(module, host, record_name, addresses)

    try:
        module.socket.getaddrinfo = forbidden_system_dns
        module._doh_https_request = fallback_request
        addresses = tuple(module._default_resolver("example.com", 443))
        assert addresses == (
            "93.184.216.34",
            "2606:2800:220:1:248:1893:25c8:1946",
        )
        assert calls == [
            ("1.1.1.1", "example.com", "A"),
            ("1.0.0.1", "example.com", "A"),
            ("1.0.0.1", "example.com", "AAAA"),
        ]

        calls.clear()

        def failed_request(endpoint_ip: str, host: str, record_name: str) -> Any:
            calls.append((endpoint_ip, host, record_name))
            raise OSError("synthetic pinned DoH outage")

        module._doh_https_request = failed_request
        try:
            tuple(module._default_resolver("example.com", 443))
        except module.ProxyRequestError as error:
            assert error.reason == "resolution_failed"
        else:
            raise AssertionError("DoH outage fell back or failed open")
        assert calls == [
            ("1.1.1.1", "example.com", "A"),
            ("1.0.0.1", "example.com", "A"),
        ]

        calls.clear()

        def empty_request(endpoint_ip: str, host: str, record_name: str) -> Any:
            calls.append((endpoint_ip, host, record_name))
            return fake_doh_response(module, host, record_name, [])

        module._doh_https_request = empty_request
        try:
            tuple(module._default_resolver("example.com", 443))
        except module.ProxyRequestError as error:
            assert error.reason == "resolution_failed"
        else:
            raise AssertionError("empty A and AAAA answers were accepted")
        assert calls == [
            ("1.1.1.1", "example.com", "A"),
            ("1.1.1.1", "example.com", "AAAA"),
            ("1.0.0.1", "example.com", "A"),
            ("1.0.0.1", "example.com", "AAAA"),
        ]

        calls.clear()

        def fake_ip_request(endpoint_ip: str, host: str, record_name: str) -> Any:
            calls.append((endpoint_ip, host, record_name))
            addresses = ["198.18.0.14"] if record_name == "A" else []
            return fake_doh_response(module, host, record_name, addresses)

        module._doh_https_request = fake_ip_request
        try:
            tuple(module._default_resolver("example.com", 443))
        except module.ProxyRequestError:
            pass
        else:
            raise AssertionError("Fake-IP DoH answer was accepted")
        assert calls == [
            ("1.1.1.1", "example.com", "A"),
            ("1.0.0.1", "example.com", "A"),
        ]
    finally:
        module._doh_https_request = original_request
        module.socket.getaddrinfo = original_getaddrinfo


def assert_ttl(module: Any) -> None:
    token = "ttl-token"
    clock = FakeClock()
    resolver = MappingResolver({"public.test": ["93.184.216.34"]})
    proxy = module.PublicEgressProxy(token, 10)
    proxy._monotonic = clock
    proxy._resolver = resolver
    port = proxy.start()
    clock.advance(11)
    try:
        status, _body, _headers = http_request(
            port, "http://public.test/", auth=basic_auth(token)
        )
        assert status == 403
    finally:
        receipt = proxy.stop()
    assert resolver.calls == []
    assert receipt["decisions"][0]["reason"] == "ttl"


def assert_connection_limit(module: Any) -> None:
    proxy = module.PublicEgressProxy("connection-limit-token", 60, max_connections=1)
    port = proxy.start()
    holding_client = socket.create_connection(("127.0.0.1", port), timeout=2)
    try:
        wait_until(lambda: len(proxy._active_sockets) == 1)
        rejected_client = socket.create_connection(("127.0.0.1", port), timeout=2)
        try:
            response = receive_until(rejected_client, b"\r\n\r\n")
            assert b" 503 " in response
        finally:
            rejected_client.close()
    finally:
        holding_client.close()
        receipt = proxy.stop()
    assert receipt["denied"] == 1
    assert receipt["decisions"][0]["reason"] == "connection_limit"


def assert_byte_limit(module: Any) -> None:
    token = "byte-limit-token"
    resolver = MappingResolver({"public.test": ["93.184.216.34"]})
    capture: list[bytes] = []
    connector = SocketPairConnector(http_responder(capture, body=b"x" * 1_024))
    proxy = module.PublicEgressProxy(token, 60, max_total_bytes=512)
    proxy._resolver = resolver
    proxy._connector = connector
    port = proxy.start()
    try:
        try:
            http_request(port, "http://public.test/", auth=basic_auth(token))
        except (http.client.HTTPException, OSError):
            pass
    finally:
        receipt = proxy.stop()
        connector.join()
    assert receipt["bytes"]["total"] <= 512
    assert receipt["decisions"][0]["reason"] == "byte_limit"

    preflight_proxy = module.PublicEgressProxy(token, 60, max_total_bytes=512)
    preflight_proxy._resolver = resolver
    preflight_proxy._connector = connector
    preflight_port = preflight_proxy.start()
    try:
        status, _body, _headers = http_request(
            preflight_port,
            "http://public.test/",
            auth=basic_auth(token),
            method="POST",
            body=b"x" * 513,
        )
        assert status == 413
    finally:
        preflight_receipt = preflight_proxy.stop()
    assert preflight_receipt["bytes"]["total"] == 0
    assert preflight_receipt["decisions"][0]["reason"] == "byte_limit"


def assert_connection_timeout(module: Any) -> None:
    token = "connection-timeout-token"
    clock = FakeClock()
    resolver = MappingResolver({"tunnel.test": ["93.184.216.34"]})
    connector = HoldingConnector()
    proxy = module.PublicEgressProxy(token, 1_000)
    proxy._monotonic = clock
    proxy._resolver = resolver
    proxy._connector = connector
    port = proxy.start()
    client: socket.socket | None = None
    try:
        status, client = connect_request(port, "tunnel.test:443", basic_auth(token))
        assert status == 200
        clock.advance(module.PUBLIC_EGRESS_CONNECTION_TIMEOUT_SEC + 1)
        wait_until(lambda: client.recv(1) == b"", timeout_sec=2)
    finally:
        if client is not None:
            client.close()
        receipt = proxy.stop()
        connector.close()
    assert receipt["decisions"][0]["reason"] == "connection_timeout"


def assert_bounded_audit(module: Any) -> None:
    proxy = module.PublicEgressProxy("bounded-audit-token", 60)
    proxy.start()
    server_thread = proxy._server_thread
    expiry_thread = proxy._expiry_thread
    for sequence in range(module.MAX_AUDIT_DECISIONS + 44):
        proxy._record_decision(
            host=f"host-{sequence}.test",
            port=80,
            decision="deny",
            reason="test",
            byte_count=0,
        )
    receipt = proxy.stop()
    assert server_thread is not None and not server_thread.is_alive()
    assert expiry_thread is not None and not expiry_thread.is_alive()
    assert len(receipt["decisions"]) == module.MAX_AUDIT_DECISIONS
    assert receipt["decisionsTruncated"] == 44


def assert_constructor_contract(module: Any) -> None:
    assert module.PROXY_POLICY_VERSION == 1
    assert module.DEFAULT_MAX_CONNECTIONS == 32
    assert module.DEFAULT_MAX_TOTAL_BYTES == 1_073_741_824
    assert module.ALLOWED_HTTP_PORTS == (80,)
    assert module.ALLOWED_CONNECT_PORTS == (443,)
    assert module.DOH_HOST == "cloudflare-dns.com"
    assert module.DOH_ENDPOINT_IPS == ("1.1.1.1", "1.0.0.1")
    for args in (
        ("", 60),
        ("token with space", 60),
        ("令牌", 60),
        ("token", 0),
        ("token", float("inf")),
        ("token", 60, 0),
        ("token", 60, 32, 0),
    ):
        try:
            module.PublicEgressProxy(*args)
        except ValueError:
            pass
        else:
            raise AssertionError(f"invalid constructor values were accepted: {args!r}")


def main() -> None:
    module = load_public_egress()
    assert_constructor_contract(module)
    assert_http_and_audit(module)
    assert_connect(module)
    assert_policy_denials(module)
    assert_authentication(module)
    assert_header_smuggling_rejected(module)
    assert_doh_parser(module)
    assert_doh_fallback_and_fail_closed(module)
    assert_ttl(module)
    assert_connection_limit(module)
    assert_byte_limit(module)
    assert_connection_timeout(module)
    assert_bounded_audit(module)
    print(
        json.dumps(
            {
                "ok": True,
                "proxyPolicyVersion": module.PROXY_POLICY_VERSION,
                "checks": 13,
                "maxConnections": module.DEFAULT_MAX_CONNECTIONS,
                "maxTotalBytes": module.DEFAULT_MAX_TOTAL_BYTES,
                "allowedHttpPorts": list(module.ALLOWED_HTTP_PORTS),
                "allowedConnectPorts": list(module.ALLOWED_CONNECT_PORTS),
                "connectionTimeoutSec": (module.PUBLIC_EGRESS_CONNECTION_TIMEOUT_SEC),
                "dnsMode": "pinned-doh",
                "dohHost": module.DOH_HOST,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
